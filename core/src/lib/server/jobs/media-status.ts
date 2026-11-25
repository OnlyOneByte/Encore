// A JOB's state → the phone-facing `media:status`. NOT a 1:1 map: a process is THREE jobs, each reporting
// its OWN stage, against one five-stop line. So a job may report a stage LATER than where the line stands
// but never earlier, and only the MEDIA's own gates may report 'ready' — a job's completion alone would let
// `entryPlayable` call a song singable after one of three steps finished.
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

/** A FLOOR, not a passthrough: a `stems` job legitimately downloads too, but the SONG has finished
 *  fetching by then, so a job may report later than its floor and never earlier. */
const JOB_STAGE_FLOOR: Record<JobType, MediaStage> = {
	fetch: 'downloading',
	stems: 'separating',
	// Matches `stems` for the rare case where it IS what the song waits on; an already-singable song's
	// broadcasts are suppressed entirely.
	'stems-upgrade': 'separating',
	'stems-remake': 'separating',
	align: 'aligning',
	'align-remake': 'aligning'
};

/** The media-level stage a running job of this type is at, at the earliest. */
export function jobStageFloor(jobType: JobType): MediaStage {
	return JOB_STAGE_FLOOR[jobType];
}

/** The LATER of floor and reported stage, except that a queued `fetch` reports 'queued': claiming
 *  'downloading' would tick the chip for a song no worker has picked up. Every later step is only queued
 *  because its predecessor completed, so its floor is already earned. */
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
			// 'ready' here says nothing about the SONG: a caller holding the media wants completedStatusFor.
			return jobStageFloor(job.jobType);
		case 'failed':
		case 'canceled':
			return 'failed';
	}
}

/** Only the media's own gates decide 'ready'; short of that, `pendingGates`'s first outstanding entry is
 *  the honest waiting-on position. The stage comes off the GATE rather than a lookup table here, because
 *  gates.ts promises adding a step is one entry and a second registration site would break that. */
export function completedStatusFor(job: Job, media: Media | undefined): MediaStatus {
	if (!media) return jobStageFloor(job.jobType);
	if (readyToSing(media)) return 'ready';
	const nextStatus: MediaStage = pendingGates(media)[0]!.stage; // readyToSing false ⇒ never empty
	const floor = jobStageFloor(job.jobType); // never report earlier than the step that just finished
	return stagePosition(nextStatus) > stagePosition(floor) ? nextStatus : floor;
}

/** An upgrade or a remake runs on an ALREADY singable song, so without this its accept flips every phone's ready
 *  row back to "Making karaoke" for the length of the background work. */
export function shouldBroadcastProcess(job: Job, media: Media | undefined): boolean {
	if (job.jobType !== 'stems-upgrade' && job.jobType !== 'stems-remake' && job.jobType !== 'align-remake') return true;
	return !media || !readyToSing(media);
}
