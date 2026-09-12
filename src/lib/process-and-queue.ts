// "Sing" — ONE action for a song that still has its vocals: take a turn AND start the process.
//
// It used to be two buttons, and picking either one alone was a dead end:
//
//   • `＋ Turn` alone  → the entry joins the rotation, nothing ever starts a process, so
//                        `isEntryReady` is false forever and `nextPlayable` pushes it onto `held` on
//                        every pass. The row said "✓ Queued", the singer waited, and their turn was
//                        silently skipped for the rest of the night.
//   • `✨ Karaoke` alone → the song processes into the library, but the singer never got a turn.
//
// Only doing both did what the person meant, and the bigger, more familiar affordance was the one
// that trapped them. So the row offers the whole intent as a single primary action.
//
// The held-slot rule already existed for exactly this: `nextPlayable` keeps a processing entry's
// `rotationSeq` and moves on to whoever is ready, so the singer holds their fair position while the
// song processes. The UI simply never wired the two halves together.

export interface ProcessAndQueueSteps<T> {
	/** Add the turn. Runs FIRST — see the ordering note below. */
	queue: () => T;
	/** Request separation. Runs SECOND, so it inherits the priority of the turn just added. */
	process: () => T;
	/**
	 * The singer ALREADY holds a queued turn for this media, so the queue step is SKIPPED and only the
	 * process runs.
	 *
	 * This is what makes the RETRY the app advertises honest. A process that dies terminally
	 * settles the media back to un-processed, so the row goes on offering Sing — and the group header
	 * says "one didn't work — tap Sing to try again" in as many words. Taking that advice ran both
	 * steps, so the singer ended up holding TWO queued turns of one song and the room played it twice
	 * back to back. The app's own rule forbids exactly that: with a turn already queued the Add button
	 * is disabled, titled "Already in the queue". A dead process is the only state that renders the Sing
	 * branch while a queued turn exists (a process in flight renders Add), so this is the one window
	 * where the two steps must come apart.
	 *
	 * Skipping the queue step does NOT cost the process its priority, which is the reason the order below
	 * exists: `soonestSeqFor` reads the rotation position of the turns pointing at that media, and the
	 * turn the singer already holds is one of them. So the retry process is filed at that existing turn's
	 * position — the same place a queue-then-process would have put it — rather than at NO_QUEUE_PRIORITY.
	 */
	hasQueuedTurn?: boolean;
}

/**
 * Run the two steps in the ONE order that is correct: queue, then process.
 *
 * This is not stylistic. The core derives a process's job priority from the rotation position of the
 * queue entries pointing at that media (`soonestSeqFor`), falling back to `NO_QUEUE_PRIORITY`
 * (MAX_SAFE_INTEGER, i.e. "nobody is waiting") when there are none. Process first and the job is filed
 * at the bottom of the queue — behind the lyrics backfill — even though a singer is standing there
 * waiting for it. Queue first and the same process is filed at that singer's rotation position.
 *
 * Returned as an array so a caller can await both; the queue step is optimistic and local, so it
 * never needs awaiting before the process request goes out. With `hasQueuedTurn` the array holds the
 * process alone — a caller counting the results can tell a retry from a first tap.
 */
export function processAndQueue<T>(steps: ProcessAndQueueSteps<T>): T[] {
	// The retry window: a turn for this media is already queued, so adding another would break
	// the app's own one-queued-turn-per-song rule. Process only. The existing turn is what the process's
	// priority is derived from, so nothing is lost by not adding a second one.
	if (steps.hasQueuedTurn) return [steps.process()];
	const queued = steps.queue();
	const processed = steps.process();
	return [queued, processed];
}
