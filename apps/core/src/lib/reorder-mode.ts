// The own-picks reorder MODE, as pure functions (XR-PH-17 … XR-PH-20, issue #836).
//
// WHY A MODE AT ALL. `move`'s `toSeq` is an index into the singer's own QUEUED picks, not a
// `rotationSeq` (packages/shared/src/ops.ts:12, `reorderWithinSinger` at rotation.ts:127). The op
// therefore CANNOT express "put my song above someone else's" — round-robin owns cross-singer order,
// and a drop that appeared to cross singers would be clamped back, which reads as a bug rather than
// as a rule. A guest's picks are also NOT adjacent in the flat list, so the list cannot imply the
// legal positions: the mode has to DRAW them.
//
// WHY THE LOGIC IS HERE AND NOT IN THE COMPONENT. XR-PH-17's and XR-PH-18's acceptance are claims
// about a predicate and a count, and `bunfig.toml` cannot mount a component that imports `$app`
// (see lib/tv/wake-lock.test.ts:18-27, restated as XR-PH-21). A predicate extracted into a real
// module is testable against the code the page actually calls; a predicate inlined in the template
// can only be tested by reconstructing it in the test, which pins nothing.

import type { EntryStatus } from '@encore/shared';

/** The fields of a queued entry this module reads. Structural, so a QueueEntry satisfies it. */
export interface OwnPick {
	id: string;
	/**
	 * A durable global pin (`move-global`). Read because a pin OUTRANKS this mode's op: `assignSeqs`
	 * is `placePins(rotate(…))`, so `placePins` re-seats a pinned entry AFTER the ordering policy has
	 * honoured the `move`. Measured: with my pick `a` pinned to slot 0, moving it below my pick `b`
	 * returns it to index 0 — the drag snaps back on screen. See `gripVisible`.
	 */
	pinnedSeq?: number | null;
}

/**
 * XR-PH-17 — the grip renders ONLY where a reorder is real.
 *
 * Four conditions, each of which is a way for a drag to be a lie:
 *  • `mine` — `move` permutes the MOVING singer's own addedAt stamps, so it can never place another
 *    guest's song. `QueueRow.svelte` records that a grip once rendered only on another guest's row,
 *    where it was the sole affordance; that exact regression is what this argument forbids.
 *  • `ownQueuedCount > 1` — with one pick there is no second position to move it to.
 *  • `reorderMeaningful` — under `shuffle` (`respectsAddedAt: false`) rank comes from the entry id, so
 *    permuting addedAt is a legal NO-OP and a grip would promise a reorder the reducer discards.
 *  • `!ownPicksPinned` — see `OwnPick.pinnedSeq`. A pinned pick is re-seated by `placePins` after the
 *    move, so the row springs back. Gating is the whole of the fix: no new op becomes reachable and
 *    no new word enters the UI (the up/down buttons on that row keep working, so nothing is lost).
 *    When pinning is removed (#856) `ownPicksPinned` is constant false and this clause is vacuous.
 */
export function gripVisible(opts: {
	mine: boolean;
	ownQueuedCount: number;
	reorderMeaningful: boolean;
	ownPicksPinned: boolean;
}): boolean {
	return opts.mine && opts.ownQueuedCount > 1 && opts.reorderMeaningful && !opts.ownPicksPinned;
}

/** True when ANY of the guest's queued picks carries a durable pin — see `gripVisible`. */
export function ownPicksPinned(ownQueued: readonly OwnPick[]): boolean {
	// ANY, not just the dragged one: `placePins` re-seats every pinned entry, so one pinned sibling is
	// enough for the order the slots promised to differ from the order that lands.
	return ownQueued.some((e) => typeof e.pinnedSeq === 'number' && Number.isFinite(e.pinnedSeq));
}

/** A legal drop position: one per own queued pick, in the guest's own index space. */
export interface Slot {
	/** The `toSeq` this slot commits — an index into the guest's own queued picks. */
	index: number;
	/** The ordinal this slot represents among the guest's picks, for the accessible name. */
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
 * XR-PH-18 — the legal slots, derived from the guest's OWN queued picks and nothing else.
 *
 * The count comes from `ownQueuedCount`, never from the visible list length: that is exactly the
 * property that makes another guest's add harmless mid-drag. `assignSeqs` re-derives `rotationSeq` on
 * every mutation, so the flat list DOES move underneath an open mode — but it cannot move these,
 * because a stranger's entry is not one of the guest's picks (XR-PH-19).
 */
export function ownSlots(ownQueuedCount: number): Slot[] {
	const out: Slot[] = [];
	for (let i = 0; i < ownQueuedCount; i++) {
		const ord = ordinal(i + 1);
		out.push({ index: i, ordinal: ord, label: `Move to ${ord} of your songs` });
	}
	return out;
}

/**
 * XR-PH-18 — a release that is not over a legal slot commits NOTHING.
 *
 * Returned as a nullable target rather than a clamp on purpose. `reorderWithinSinger` clamps an
 * out-of-range `toIdx` into the singer's own range, so passing an illegal drop through would emit a
 * `move` to some OTHER position — a commit the guest did not choose, which is the failure XR-PH-18
 * exists to prevent. The mode must decline, not approximate.
 */
export function dropTarget(slotIndex: number | null, ownQueuedCount: number): number | null {
	if (slotIndex === null) return null;
	if (!Number.isInteger(slotIndex)) return null;
	if (slotIndex < 0 || slotIndex >= ownQueuedCount) return null;
	return slotIndex;
}

/**
 * XR-PH-19 — has a concurrent change invalidated the open mode? Returns the reason to STATE, or null
 * while the mode is still valid.
 *
 * The two invalidating shapes the requirement names, plus the one it implies (the moving song being
 * removed elsewhere — its own acceptance case). Checked most-specific first: a pick that starts
 * playing also drops the count, and "your song started" is the reason a guest can act on.
 *
 * There is deliberately NO "the moving id is not among my picks" branch. It looks like the obvious
 * third guard and it is unreachable: `ownQueued` is the queued entries filtered by MY singerId, so an
 * entry that is both `queued` and mine is in it by construction, and the two cases where it is not
 * (gone, or no longer queued) are already the two branches above. A mutation pass confirmed it —
 * deleting that branch changed no test result, which is the signal that it was dead rather than
 * defensive.
 */
export function modeInvalidation(
	ownQueued: readonly { id: string }[],
	movingId: string | null,
	movingStatus: EntryStatus | undefined
): string | null {
	if (!movingId) return null; // no mode open
	if (movingStatus === undefined) return 'That song left the queue — nothing was moved.';
	if (movingStatus !== 'queued') return 'That song started playing — nothing was moved.';
	if (ownQueued.length < 2) return 'You have one song queued now — there is nothing to reorder.';
	return null;
}
