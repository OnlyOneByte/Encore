// "Sing" — ONE action for a song that still has its vocals: take a turn AND start the process. Either half
// alone is a dead end: a turn with no process is never ready, so the rotation holds it and skips it on every
// pass for the rest of the night; a process with no turn fills the library and gives the singer nothing.
//
// The held-slot rule exists for exactly this pairing — the rotation keeps a processing entry's position and
// moves on to whoever is ready, so the singer holds their fair place while the song processes.

export interface ProcessAndQueueSteps<T> {
	/** Add the turn. Runs FIRST — see the ordering note below. */
	queue: () => T;
	/** Request separation. Runs SECOND, so it inherits the priority of the turn just added. */
	process: () => T;
	/**
	 * The singer ALREADY holds a queued turn, so the queue step is skipped and only the process runs. This is
	 * what makes the advertised RETRY honest: running both steps leaves the singer holding two queued turns of
	 * one song and the room plays it twice back to back, which the app's own one-turn-per-song rule forbids.
	 *
	 * Skipping the queue step costs the process no priority, because the job's priority is derived from the
	 * rotation position of the turns pointing at that media — and the turn the singer already holds is one.
	 */
	hasQueuedTurn?: boolean;
}

/**
 * QUEUE, THEN PROCESS — an ordering requirement, not a style. The job's priority is derived from the rotation
 * position of the queue entries pointing at that media, falling back to "nobody is waiting" when there are
 * none: process first and the job is filed at the bottom of the queue, behind the lyrics backfill, with a
 * singer standing there waiting for it.
 *
 * Returned as an array so a caller can await both, and so a caller counting the results can tell a retry
 * (process alone) from a first tap.
 */
export function processAndQueue<T>(steps: ProcessAndQueueSteps<T>): T[] {
	if (steps.hasQueuedTurn) return [steps.process()];
	const queued = steps.queue();
	const processed = steps.process();
	return [queued, processed];
}
