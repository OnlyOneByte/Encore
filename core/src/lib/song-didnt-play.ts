// "Your song didn't play": the singer's half of a failed song (proposal 11). Pure, so a bun test can decide it. See
// routes/+layout.svelte.

import type { QueueEntry } from '$lib/contract';

/** One failure of one turn. A second failure of the same song is a new key, so a dismissed sheet comes back for it
 *  (now with Pick another alone). */
export function didntPlayKey(e: Pick<QueueEntry, 'id' | 'playFailures'>): string {
	return `${e.id}:${e.playFailures ?? 0}`;
}

/** The held turn of MINE to show the sheet for, or null: the earliest in the rotation whose failure I have not
 *  dismissed. Not edge-triggered like "You're up": a phone that was asleep when the song failed, or reloads, still
 *  hears about a turn that is waiting on it. Other phones never get one (proposal 11, principle 3). */
export function didntPlayTurn(
	entries: readonly QueueEntry[],
	meId: string | null,
	dismissed: readonly string[]
): QueueEntry | null {
	if (!meId) return null;
	return (
		entries
			.filter(
				(e) => e.singerId === meId && e.status === 'queued' && e.playFailed && !dismissed.includes(didntPlayKey(e))
			)
			.sort((a, b) => a.rotationSeq - b.rotationSeq)[0] ?? null
	);
}
