// "Sing" — ONE action for a song that still has its vocals: take a turn AND start the process. Either half alone is
// a dead end: a turn with no process is never ready, so the rotation holds it and skips it on every pass; a process
// with no turn fills the library and gives the singer nothing. The held-slot rule exists for this pairing.

/** `/?replace=<entryId>`: the Sing tab in "pick another" mode, where the queue step swaps that turn's song instead of
 * adding a turn, so a singer whose song could not be made keeps their spot. */
export const REPLACE_PARAM = 'replace';

export interface ProcessAndQueueSteps<T> {
	/** Add the turn. Runs FIRST — see the ordering note below. */
	queue: () => T;
	/** Request separation. Runs SECOND, so it inherits the priority of the turn just added. */
	process: () => T;
	/** The singer ALREADY holds a queued turn, so the queue step is skipped and only the process runs — both steps
	 * would leave them holding two queued turns of one song, which the one-turn-per-song rule forbids. Skipping the
	 * queue step costs the process no priority: priority comes from the rotation position of the turns pointing at it. */
	hasQueuedTurn?: boolean;
}

/** QUEUE, THEN PROCESS — an ordering requirement, not a style: the job's priority is derived from the rotation
 * position of the queue entries pointing at that media, so process-first files the job at the bottom of the queue,
 * behind the lyrics backfill, with a singer waiting. Returned as an array, so a caller can tell a retry from a tap. */
export function processAndQueue<T>(steps: ProcessAndQueueSteps<T>): T[] {
	if (steps.hasQueuedTurn) return [steps.process()];
	const queued = steps.queue();
	const processed = steps.process();
	return [queued, processed];
}
