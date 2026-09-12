// The reorder MODE, as pure functions (XR-PH-17 … XR-PH-20, issue an earlier change; drag rewired to the whole
// queue in an earlier change — the drag half of an earlier change Q4-A).
//
// WHY A MODE AT ALL. Even under `move-to-index` (a global slot, src/lib/contract/core/ops.ts:21),
// a guest's picks are NOT adjacent in the flat list, and now the drag can target ANY position — so the
// list still cannot imply the legal positions by proximity. The mode DRAWS one slot per queued
// position so the drag has an explicit, hit-testable target for every place a song can land.
//
// WHAT an earlier change CHANGED. The op the drag commits moved from `move` (an index into the singer's OWN queued
// picks, which cannot cross singers) to `move-to-index` (a global queued index, gated server-side by
// `queue:reorder-any`, hub.ts:225). So the index space these functions speak widened from "the guest's
// own picks" to "the whole queued list": the grip renders on ANY queued row, the slots span the whole
// queue, and a drop commits a global slot. The a11y CONTRACT is unchanged — grip only where a reorder
// is real, one labelled slot per legal position, a release off a legal slot commits NOTHING, and the
// mode states why it closed — only its index space is wider.
//
// WHY THE LOGIC IS HERE AND NOT IN THE COMPONENT. XR-PH-17's and XR-PH-18's acceptance are claims
// about a predicate and a count, and `bunfig.toml` cannot mount a component that imports `$app`
// (see lib/tv/wake-lock.test.ts:18-27, restated as XR-PH-21). A predicate extracted into a real
// module is testable against the code the page actually calls; a predicate inlined in the template
// can only be tested by reconstructing it in the test, which pins nothing.

import type { EntryStatus } from '$lib/contract';

/**
 * XR-PH-17 — the grip renders ONLY where a reorder is real.
 *
 * Two conditions, each a way for a drag to be a lie:
 *  • `queuedCount > 1` — with one song queued there is no second position to move it to.
 *  • `reorderMeaningful` — always true under the stored-list model: the queue IS the stored
 *    list and a move rewrites it, so no policy can discard a reorder. It was false under `shuffle`,
 *    which ranked by entry id and re-derived over any move; nothing re-derives a position now. The
 *    parameter is kept so the caller states the claim explicitly rather than assuming it.
 *
 * The `mine` clause was REMOVED in an earlier change. Under `move`, a grip on another guest's row was a lie —
 * `move` permutes only the actor's own picks, so it could never place that song. Under `move-to-index`
 * any queued row can be dragged to any global slot (the server gates a non-owner entry on
 * `queue:reorder-any`), so the grip is legitimate on every queued row. The regression QueueRow.svelte
 * once recorded (a grip that was the SOLE affordance on another guest's row) does not return: the row
 * still carries its up/down move buttons, so the grip is an addition, never the only control.
 *
 * (The `!ownPicksPinned` clause was removed with pinning in an earlier change step 3: with no durable pin there is
 * nothing left to re-seat a moved row, so the clause was constant-true and its predicate dead.)
 */
export function gripVisible(opts: { queuedCount: number; reorderMeaningful: boolean }): boolean {
	return opts.queuedCount > 1 && opts.reorderMeaningful;
}

/** A legal drop position: one per queued entry, in the WHOLE queued index space. */
export interface Slot {
	/** The global queued index this slot commits — the `toIdx` `move-to-index` uses. */
	index: number;
	/** The ordinal this slot represents in the queue, for the accessible name. */
	ordinal: string;
	/** The accessible name XR-PH-18 requires the target to carry. */
	label: string;
}

/** "1st", "2nd", "3rd", "4th" … English ordinals for the slot labels. */
export function ordinal(n: number): string {
	const rem100 = n % 100;
	if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
	switch (n % 10) {
		case 1:
			return `${n}st`;
		case 2:
			return `${n}nd`;
		case 3:
			return `${n}rd`;
		default:
			return `${n}th`;
	}
}

/**
 * XR-PH-18 — the legal slots, one per position in the WHOLE queued list.
 *
 * The count is `queuedCount`, the length of the queued list the page renders. Under `move-to-index`
 * every position is a legal target, so a drop can land a song anywhere in the queue — which is the
 * whole point of the drag half of an earlier change Q4-A. `assignSeqs` re-derives `rotationSeq` on every mutation,
 * so the flat list moves underneath an open mode; the slot COUNT tracks the queued length, and
 * modeInvalidation closes the mode when the moving song itself leaves or starts playing (XR-PH-19).
 */
export function queueSlots(queuedCount: number): Slot[] {
	const out: Slot[] = [];
	for (let i = 0; i < queuedCount; i++) {
		const ord = ordinal(i + 1);
		out.push({ index: i, ordinal: ord, label: `Move to ${ord} in queue` });
	}
	return out;
}

/**
 * XR-PH-18 — a release that is not over a legal slot commits NOTHING.
 *
 * Returned as a nullable target rather than a clamp on purpose. `moveToIndex` clamps an out-of-range
 * `toIdx` into the queued range, so passing an illegal drop through would emit a move to some OTHER
 * position — a commit the guest did not choose, which is the failure XR-PH-18 exists to prevent. The
 * mode must decline, not approximate.
 */
export function dropTarget(slotIndex: number | null, queuedCount: number): number | null {
	if (slotIndex === null) return null;
	if (!Number.isInteger(slotIndex)) return null;
	if (slotIndex < 0 || slotIndex >= queuedCount) return null;
	return slotIndex;
}

/**
 * XR-PH-19 — has a concurrent change invalidated the open mode? Returns the reason to STATE, or null
 * while the mode is still valid.
 *
 * The two invalidating shapes the requirement names, plus the one it implies (the moving song being
 * removed elsewhere — its own acceptance case). Checked most-specific first: a song that starts
 * playing also drops the queued count, and "that song started" is the more specific reason.
 *
 * an earlier change widened the collection from the guest's own picks to the WHOLE queued list: any queued row can
 * now be the moving one, so the "fewer than two queued" guard reads the whole queue. `movingId` need
 * not be one of the actor's picks any more; it only has to still be a queued entry.
 */
export function modeInvalidation(
	queued: readonly { id: string }[],
	movingId: string | null,
	movingStatus: EntryStatus | undefined
): string | null {
	if (!movingId) return null; // no mode open
	if (movingStatus === undefined) return 'That song left the queue — nothing was moved.';
	if (movingStatus !== 'queued') return 'That song started playing — nothing was moved.';
	if (queued.length < 2) return 'Only one song is queued now — there is nothing to reorder.';
	return null;
}
