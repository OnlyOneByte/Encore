// "Sing" — ONE action for a song that still has its vocals: take a turn AND start the cook.
//
// It used to be two buttons, and picking either one alone was a dead end:
//
//   • `＋ Turn` alone  → the entry joins the rotation, nothing ever starts a cook, so
//                        `isEntryReady` is false forever and `nextPlayable` pushes it onto `held` on
//                        every pass. The row said "✓ Queued", the singer waited, and their turn was
//                        silently skipped for the rest of the night.
//   • `✨ Karaoke` alone → the song cooks into the library, but the singer never got a turn.
//
// Only doing both did what the person meant, and the bigger, more familiar affordance was the one
// that trapped them. So the row offers the whole intent as a single primary action.
//
// The held-slot rule already existed for exactly this: `nextPlayable` keeps a cooking entry's
// `rotationSeq` and moves on to whoever is ready, so the singer holds their fair position while the
// song cooks. The UI simply never wired the two halves together.

export interface CookAndQueueSteps<T> {
	/** Add the turn. Runs FIRST — see the ordering note below. */
	queue: () => T;
	/** Request separation. Runs SECOND, so it inherits the priority of the turn just added. */
	cook: () => T;
}

/**
 * Run the two steps in the ONE order that is correct: queue, then cook.
 *
 * This is not stylistic. The core derives a cook's job priority from the rotation position of the
 * queue entries pointing at that media (`soonestSeqFor`), falling back to `NO_QUEUE_PRIORITY`
 * (MAX_SAFE_INTEGER, i.e. "nobody is waiting") when there are none. Cook first and the job is filed
 * at the bottom of the queue — behind the lyrics backfill — even though a singer is standing there
 * waiting for it. Queue first and the same cook is filed at that singer's rotation position.
 *
 * Returned as an array so a caller can await both; the queue step is optimistic and local, so it
 * never needs awaiting before the cook request goes out.
 */
export function cookAndQueue<T>(steps: CookAndQueueSteps<T>): T[] {
	const queued = steps.queue();
	const cooked = steps.cook();
	return [queued, cooked];
}
