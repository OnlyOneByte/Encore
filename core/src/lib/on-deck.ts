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

/**
 * MY entry WAS On deck and is not now, though it is still queued, someone else still sings, and I did not cause it — the
 * moment a guest who set their key is owed one line (proposal 14). "I" is any of my tabs: a reorder of this tab's still
 * in flight (`selfCaused`), or my entry's "Not yet" flag newly set (`wasDeferred` false, `deferred` now true), which only
 * its owner can do, from any tab. Returns who is On deck instead and whether mine is the next song after theirs; null
 * means say nothing. `nextPlayableOf` MUST be the app's one next-playable rule (`nextPlayableEntryId`), used for both
 * answers, so a song the room will skip (one still cooking, one that failed on the TV) can never be "next".
 */
export function deckBump(o: {
	wasDeckId: string | null;
	wasDeferred: boolean;
	queued: QueueEntry[];
	nextPlayableOf: (list: QueueEntry[]) => string | null;
	nowSingerId: string | undefined;
	meId: string | undefined;
	selfCaused: boolean;
}): { singerId: string; youreNext: boolean } | null {
	const { wasDeckId, wasDeferred, queued, nextPlayableOf, nowSingerId, meId, selfCaused } = o;
	if (!wasDeckId || selfCaused || !nowSingerId || nowSingerId === meId) return null;
	const mine = queued.find((e) => e.id === wasDeckId);
	if (!mine) return null; // it started playing, or it was removed
	if (mine.deferred && !wasDeferred) return null; // my own Not yet, maybe from another tab
	const nextPlayableId = nextPlayableOf(queued);
	if (deckEntryOf(queued, nextPlayableId, nowSingerId, meId)?.id === wasDeckId) return null;
	const at = queued.findIndex((e) => e.id === nextPlayableId);
	const now = queued[at];
	if (!now || now.singerId === meId) return null;
	return { singerId: now.singerId, youreNext: nextPlayableOf(queued.slice(at + 1)) === wasDeckId };
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
/** The entry lost On deck while still queued: its heads-up has to buzz again when its turn comes back round. */
export function rearmBuzz(entryId: string): void {
	buzzed.delete(entryId);
}
