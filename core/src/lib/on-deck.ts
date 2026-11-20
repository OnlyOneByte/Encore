// The on-deck card's decisions, out of the route so a bun test can reach them. See routes/queue/+page.svelte.

import type { QueueEntry } from '$lib/contract';

/** Seconds left in the current song at which the card turns into "You're next". */
export const HEADS_UP_SEC = 30;
/** Android only — iOS Safari has no `navigator.vibrate`, so there the colour change is the whole heads-up. */
export const HEADS_UP_BUZZ = [60, 40, 60];

/**
 * Where "Not yet" moves `id` (an index into the whole QUEUED list, for `not-yet`), and who goes first instead —
 * or null, which HIDES the button. The singer let through is the next one whose song can actually play: stepping
 * behind a song still cooking would leave this entry next anyway. The op (`letThroughTo`) moves this entry AND my
 * picks between it and the target behind the target, so my next pick cannot slide into the turn instead.
 */
export function notYetTarget(
	queued: QueueEntry[],
	id: string,
	playable: (e: QueueEntry) => boolean
): { toIdx: number; singerId: string } | null {
	const from = queued.findIndex((e) => e.id === id);
	const me = queued[from];
	if (!me || me.deferred) return null;
	const toIdx = queued.findIndex((e, i) => i > from && e.singerId !== me.singerId && playable(e));
	return toIdx < 0 ? null : { toIdx, singerId: queued[toIdx]!.singerId };
}

/**
 * The entry the on-deck card is for: MY entry that plays next, while SOMEONE ELSE sings. Never during my own song —
 * the card would sit under my own "Singing now" and tell me to grab the mic I am holding — and never in an idle room,
 * where the server starts a ready song at once and the card would only flash.
 */
export function deckEntryOf(
	queued: QueueEntry[],
	nextPlayableId: string | null,
	nowSingerId: string | undefined,
	meId: string | undefined
): QueueEntry | undefined {
	if (!nowSingerId || !meId || nowSingerId === meId) return undefined;
	return queued.find((e) => e.id === nextPlayableId && e.singerId === meId);
}

/** "~2 min" until the current song ends; null when its length is unknown. */
export function minutesLeft(remainSec: number | null): string | null {
	if (remainSec === null) return null;
	return remainSec < 60 ? 'under a minute' : `~${Math.round(remainSec / 60)} min`;
}

// MODULE scope, not component state: /queue unmounts on every tab switch, and a heads-up must buzz once per
// ENTRY, not once per visit to the tab.
const buzzed = new Set<string>();
/** Buzz once for this entry. Returns whether it did. */
export function buzzOnce(entryId: string, vibrate: ((p: number[]) => boolean) | undefined): boolean {
	if (buzzed.has(entryId) || !vibrate) return false;
	buzzed.add(entryId);
	return vibrate(HEADS_UP_BUZZ);
}
