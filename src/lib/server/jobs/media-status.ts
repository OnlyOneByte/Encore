// A JOB's state → the phone-facing `media:status`. Pure, and shared by the three places that need it:
// the worker hub broadcasting live lifecycle changes, and /api/library answering "what is processing
// right now?" for a client that just loaded and has received no broadcast yet.
//
// WHY THIS IS NOT A 1:1 MAP, which it used to claim to be. A process is THREE jobs — fetch → stems →
// align — and each one reports its OWN stages: `vocabulary.py`'s STAGE_PLANS gives fetch
// [downloading], stems [downloading, separating] and align [downloading, aligning]. The phone renders
// a single five-stop line (ProcessingCard's chip strip: queued → downloading → separating → aligning
// → ready), so forwarding each job's stage verbatim walked that line BACKWARDS twice per process: a song
// on "Making karaoke" jumped back to "Fetched" the moment stems began decoding, and again when align
// pulled its captions. Measured on the real hub, one process broadcast this:
//
//   separating@0 → downloading@0 → downloading@100 → ready@100      (fetch)
//   separating@0 → downloading@10 → separating@68 → ready@100       (stems)
//   separating@0 → downloading@5 → aligning@50 → ready@100          (align)
//
// Six backward jumps, un-ticking chips and resetting the bar to 0% each time. Three separate causes,
// all of them fixed here:
//
//   1. `running` mapped to a generic 'separating', so EVERY job opened on "Making karaoke" and then
//      fell back to whatever it was actually doing one message later.
//   2. A job's own stage was forwarded as the media's stage, so stems' decode and align's caption
//      pull re-reported 'downloading' after the song had passed it.
//   3. A completed job mapped to 'ready' regardless of TYPE, so a finished fetch told every phone the
//      song was singable. That one was not merely cosmetic: readiness.ts lets a live 'ready' override
//      the catalog, so `entryPlayable` said yes for a song with no instrumental on disk.
//
// The rule now: a job reports the position of the STEP IT IS, never earlier, and only the MEDIA's own
// gates can say 'ready'. Monotonicity is enforced by media-status.test.ts driving a full chain.
import {
	mediaStagePosition as stagePosition,
	pendingGates,
	readyToSing,
	type Job,
	type JobType,
	type Media,
	type MediaStage,
	type MediaStatus
} from '$lib/contract';

/**
 * Where on the media's line a job of this type sits WHILE IT RUNS — its floor.
 *
 * This is the fix for cause 2, and the reason it is a floor rather than a passthrough. A `stems` job
 * legitimately downloads (it decodes the retained source to WAV) and an `align` job legitimately
 * downloads (captions, and the vocals stem), and both say so on the wire because that is true of the
 * JOB. It is not true of the SONG: a song whose separation is running has finished fetching, so
 * reporting 'downloading' for it is a lie in the only frame the guest can see. A job may therefore
 * report a stage LATER than its floor (a future step that genuinely advances the song) but never one
 * earlier.
 */
const JOB_STAGE_FLOOR: Record<JobType, MediaStage> = {
	fetch: 'downloading',
	stems: 'separating',
	// Background re-separation of an already-finished song. Its floor matches `stems` for the rare case
	// where it IS the separation the song is waiting on; the hub suppresses its broadcasts entirely for
	// a song that is already singable (see shouldBroadcastProcess).
	'stems-upgrade': 'separating',
	align: 'aligning'
};

/** The media-level stage a running job of this type is at, at the earliest. */
export function jobStageFloor(jobType: JobType): MediaStage {
	return JOB_STAGE_FLOOR[jobType];
}

/**
 * The status to broadcast for a job in flight (queued / assigned / running), given the stage the
 * worker last reported (absent before its first `job:progress`).
 *
 * A running job reports the later of its floor and its own reported stage. A job that has not started
 * reports its floor too — "waiting on separation" — with ONE exception: a queued `fetch` reports
 * 'queued', because it is the first step of the process and claiming 'downloading' would tick the Queued
 * chip for a song no worker has picked up yet. Every later step is only ever queued BECAUSE its
 * predecessor completed, so its floor is already earned.
 */
export function mediaStatusFor(job: Job, stage?: MediaStatus): MediaStatus {
	switch (job.status) {
		case 'queued':
		case 'assigned':
			return job.jobType === 'fetch' ? 'queued' : jobStageFloor(job.jobType);
		case 'running': {
			const floor = jobStageFloor(job.jobType);
			// A stage the worker reports that is NOT on the line (or that we do not recognise) cannot be
			// compared, so the floor wins — the type is the thing we are certain about.
			if (!stage) return floor;
			return stagePosition(stage) > stagePosition(floor) ? stage : floor;
		}
		case 'ready':
			// A job reaching 'ready' says nothing about the SONG. Callers that hold the media should use
			// completedStatusFor; without one, the honest answer is the position this step occupied — the
			// step finished, the song did not.
			return jobStageFloor(job.jobType);
		case 'failed':
		case 'canceled':
			return 'failed';
	}
}

/**
 * The status to broadcast when a job COMPLETES — cause 3's fix.
 *
 * Only the media's own process gates decide 'ready'. Anything short of that is still processing, and the
 * honest position is the step it is now WAITING on: `pendingGates` gives the first outstanding one in
 * pipeline order, so a finished fetch reports 'separating' ("Making karaoke") and a finished
 * separation reports 'aligning' ("Adding lyrics") rather than briefly claiming the song is done.
 *
 * The stage comes off the GATE ITSELF (`ProcessGate.stage`) rather than a lookup table here. A table
 * keyed by gate id was the obvious shape and it was wrong: gates.ts promises that adding a step is one
 * entry in GATES and nothing else moves, and a second registration site here would have made that
 * false for the one surface a guest actually watches.
 *
 * `media` may be absent (a completion for a media the runtime catalog has since dropped); then the
 * completed step's own position is the most we can honestly say.
 */
export function completedStatusFor(job: Job, media: Media | undefined): MediaStatus {
	if (!media) return jobStageFloor(job.jobType);
	if (readyToSing(media)) return 'ready';
	// Not finished, so there is always at least one outstanding gate — `readyToSing` is exactly
	// "pendingGates is empty", which the branch above has already ruled out.
	const nextStatus: MediaStage = pendingGates(media)[0]!.stage;
	// Never walk backwards past the step that just finished (an align that completes without satisfying
	// its gate must not report 'separating').
	const floor = jobStageFloor(job.jobType);
	return stagePosition(nextStatus) > stagePosition(floor) ? nextStatus : floor;
}

/**
 * Should a process broadcast for this job reach the ROOM at all?
 *
 * A `stems-upgrade` runs on a song that is ALREADY singable, and its accept would otherwise flip every
 * phone's ready row back to "Making karaoke" for the length of a background re-separation — the exact
 * regress-a-ready-song bug the hub's unservable branch already guards against, arriving by a second
 * door. Silence is right here: the song plays throughout, and `markMediaReady` refuses the upgrade
 * outright unless it outranks what is published.
 */
export function shouldBroadcastProcess(job: Job, media: Media | undefined): boolean {
	if (job.jobType !== 'stems-upgrade') return true;
	return !media || !readyToSing(media);
}
