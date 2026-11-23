// "Sing" — ONE action for a song that still has its vocals: take a turn AND start the process. Either half alone is
// a dead end: a turn with no process is never ready, so the rotation holds it and skips it on every pass; a process
// with no turn fills the library and gives the singer nothing. The held-slot rule exists for this pairing.

/** `/?replace=<entryId>`: the Sing tab in "pick another" mode, where the queue step swaps that turn's song instead of
 * adding a turn, so a singer whose song could not be made keeps their spot. */
export const REPLACE_PARAM = 'replace';
/** The link to that mode for one turn. `home` is the caller's `resolve('/')`: this module is shared with the server and
 *  the probes, so it cannot import `$app/paths` itself. */
export const pickAnotherHref = (home: string, entryId: string) =>
	`${home}?${REPLACE_PARAM}=${encodeURIComponent(entryId)}`;

export interface ProcessAndQueueSteps {
	/** The song tapped. A second Sing on it while its process is still in flight is ignored: one turn per tap. */
	mediaId: string;
	/** Songs whose process is in flight, owned by the caller so it outlives one call. */
	inFlight: Set<string>;
	/** Request separation. Runs FIRST — see the ordering note below. Resolves true only when the process started. */
	process: () => Promise<boolean>;
	/** Add the turn. Runs SECOND, and only if the process started: a turn nothing is working on is a dead end. */
	queue: () => void;
	/** The singer ALREADY holds a queued turn, so the queue step is skipped and only the process runs — both steps
	 * would leave them holding two queued turns of one song, which the one-turn-per-song rule forbids. Skipping the
	 * queue step costs the process no priority: priority comes from the rotation position of the turns pointing at it. */
	hasQueuedTurn?: boolean;
}

/** PROCESS, THEN QUEUE — an ordering requirement, not a style. The process POST marks the song `queued` and
 * broadcasts its first `media:status` before it answers, so the add that follows reaches every phone already
 * carrying a song being made: no phone, live or just reloaded, ever reads the new turn as a dead one ("Couldn't
 * make karaoke") for the round trip between the two. The job's priority is not lost by filing it first: the hub's
 * `onEntryAdded` reprioritise pulls it up to the new turn's rotation position when the add lands. */
export async function processAndQueue(steps: ProcessAndQueueSteps): Promise<void> {
	if (steps.inFlight.has(steps.mediaId)) return;
	steps.inFlight.add(steps.mediaId);
	try {
		const started = await steps.process();
		if (started && !steps.hasQueuedTurn) steps.queue();
	} finally {
		steps.inFlight.delete(steps.mediaId);
	}
}
