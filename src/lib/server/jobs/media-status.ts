// A JOB's state → the phone-facing `media:status`. Pure, shared by the worker hub's live broadcasts
// and /api/library's answer for a client that loaded with no broadcast yet. NOT a 1:1 map: a process is
// THREE jobs (fetch → stems → align), each reporting its OWN stage, but the phone renders one five-stop
// line (queued → downloading → separating → aligning → ready) — so a job may report a stage later than
// where the line already stands, never earlier, and only the MEDIA's own gates may report 'ready'.
// Letting a job's completion alone say 'ready' would let `entryPlayable` call a song singable after only
// one of three steps finished. Monotonicity is enforced by media-status.test.ts driving a full chain.
import {
	mediaStagePosition as stagePosition,
	pendingGates,
	readyToSing,
	type Job,
	type JobType,
	type Media,
	type MediaStage,
	type MediaStatus
} from '../../contract';

/** Where on the media's line a job of this type sits WHILE IT RUNS — a FLOOR, not a passthrough. A
 *  `stems` or `align` job legitimately downloads too, but the SONG has already finished fetching by
 *  then, so a job may report a stage later than its floor but never one earlier. */
const JOB_STAGE_FLOOR: Record<JobType, MediaStage> = {
	fetch: 'downloading',
	stems: 'separating',
	// Matches `stems` for the rare case where it IS what the song is waiting on; broadcasts for an
	// already-singable song are suppressed entirely (shouldBroadcastProcess).
	'stems-upgrade': 'separating',
	align: 'aligning'
};

/** The media-level stage a running job of this type is at, at the earliest. */
export function jobStageFloor(jobType: JobType): MediaStage {
	return JOB_STAGE_FLOOR[jobType];
}

/** Status for a job in flight (queued/assigned/running), given the worker's last-reported stage
 *  (absent before its first `job:progress`). Reports the LATER of floor and reported stage, except a
 *  queued `fetch` reports 'queued' rather than its floor — claiming 'downloading' would tick the Queued
 *  chip for a song no worker has picked up yet; every later step is only ever queued because its
 *  predecessor completed, so its floor is already earned. */
export function mediaStatusFor(job: Job, stage?: MediaStatus): MediaStatus {
	switch (job.status) {
		case 'queued':
		case 'assigned':
			return job.jobType === 'fetch' ? 'queued' : jobStageFloor(job.jobType);
		case 'running': {
			const floor = jobStageFloor(job.jobType);
			if (!stage) return floor; // an unrecognised stage can't be compared, so the floor wins
			return stagePosition(stage) > stagePosition(floor) ? stage : floor;
		}
		case 'ready':
			// Reaching 'ready' says nothing about the SONG — callers holding the media should use
			// completedStatusFor instead; this is just the step's own finished position.
			return jobStageFloor(job.jobType);
		case 'failed':
		case 'canceled':
			return 'failed';
	}
}

/** Status to broadcast when a job COMPLETES. Only the media's own process gates decide 'ready';
 *  short of that, `pendingGates`'s first outstanding entry gives the honest waiting-on position (a
 *  finished fetch reports 'separating', not briefly claiming done). The stage comes off the gate itself
 *  rather than a lookup table here, since gates.ts promises adding a step is one entry in GATES and
 *  nothing else moves — a second registration site would break that. `media` may be absent (catalog
 *  has since dropped it); then the completed step's own position is the most we can honestly say. */
export function completedStatusFor(job: Job, media: Media | undefined): MediaStatus {
	if (!media) return jobStageFloor(job.jobType);
	if (readyToSing(media)) return 'ready';
	const nextStatus: MediaStage = pendingGates(media)[0]!.stage; // readyToSing false ⇒ never empty
	const floor = jobStageFloor(job.jobType); // never report earlier than the step that just finished
	return stagePosition(nextStatus) > stagePosition(floor) ? nextStatus : floor;
}

/** Suppresses broadcasts for a `stems-upgrade`, which runs on an ALREADY singable song — without this,
 *  its accept would flip every phone's ready row back to "Making karaoke" for the length of a background
 *  re-separation; the song keeps playing, and `markMediaReady` refuses the upgrade unless it outranks
 *  what's published. */
export function shouldBroadcastProcess(job: Job, media: Media | undefined): boolean {
	if (job.jobType !== 'stems-upgrade') return true;
	return !media || !readyToSing(media);
}
