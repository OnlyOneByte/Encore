// Reordering the queue, as pure functions. THE DRAG IS A LIVE SORT, and a release cannot commit somewhere the
// guest did not choose because `liveSortTarget` is the same arithmetic that positions the rows on screen. SC 2.5.7 /
// 2.1.1 are carried by the grip itself, through `keyboardMoveTarget`. See docs/FRONTEND.md#the-three-tabs.

import type { EntryStatus } from '$lib/contract';
import { ordinalWord } from '$lib/phrasing/position-sentence';

/** The keyboard path announces a position, so it needs an ordinal — and there is ONE of those, in
 *  `$lib/phrasing`. Re-exported rather than re-implemented: the two copies disagreed on a fractional and a
 *  negative index, which is exactly the drift a second English-ordinals table invites. */
export { ordinalWord as ordinal };

/**
 * The grip renders ONLY where a reorder is real, which is the difference between an affordance and a lie:
 * `queuedCount > 1` (one song has no second position) and `reorderMeaningful`, kept as a parameter so the caller
 * states the claim rather than assuming it. No `mine` clause, deliberately — `move-to-index` places any queued row
 * at any global slot, and the server gates a non-owner entry on its own permission.
 */
export function gripVisible(opts: { queuedCount: number; reorderMeaningful: boolean }): boolean {
	return opts.queuedCount > 1 && opts.reorderMeaningful;
}

/**
 * Where the dragged row currently IS, as a queued index — the one arithmetic, read twice: once to place the rows
 * and once to commit on release. THE INPUT IS EVERY ROW'S OWN BOX, never one row height, because the queue holds
 * two row kinds of different heights; a row is passed once the dragged row's LEADING EDGE clears that row's
 * midpoint. ONE GEOMETRY READ, TAKEN AT PRESS TIME: rows change height mid-drag, and a stale table points at the
 * wrong position. CLAMPED TO THE LIST, which is the one place clamping is right.
 */
export function liveSortTarget(opts: {
	fromIndex: number;
	offsetPx: number;
	/** Every row's box in DOM (= queued) order, measured ONCE at press time, dragged row included. */
	rowBoundsPx: readonly { top: number; height: number }[];
	count: number;
}): number {
	const { fromIndex, offsetPx, rowBoundsPx, count } = opts;
	if (count <= 0) return 0;
	const own = rowBoundsPx[fromIndex];
	// No usable measurement is "no movement" rather than a guess: a detached node measures nothing, and a list of
	// boxes that does not cover this row cannot say where the row has travelled to.
	if (!own || rowBoundsPx.length !== count) return clampIndex(fromIndex, count);
	const centre = (i: number) => rowBoundsPx[i]!.top + rowBoundsPx[i]!.height / 2;
	const draggedTop = own.top + offsetPx;
	const draggedBottom = draggedTop + own.height;
	let target = fromIndex;
	// Downward the LEADING edge is the bottom; scanning on and keeping the last match lets one gesture cross several.
	if (offsetPx > 0) {
		for (let i = fromIndex + 1; i < count; i++) if (centre(i) < draggedBottom) target = i;
	} else if (offsetPx < 0) {
		// Upward: the leading edge is the top, and the scan runs the other way for the same reason.
		for (let i = fromIndex - 1; i >= 0; i--) if (centre(i) > draggedTop) target = i;
	}
	return clampIndex(target, count);
}

/**
 * The non-drag path: one step of the same reorder, -1 for Arrow Up and +1 for Arrow Down. NULL at the ends of the
 * list, never a clamp — a clamp emits a move to the position the row already occupies, which the server accepts as
 * a real mutation and broadcasts to every other client.
 */
export function keyboardMoveTarget(fromIndex: number, delta: number, count: number): number | null {
	if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= count) return null;
	const to = fromIndex + delta;
	if (to < 0 || to >= count) return null;
	return to;
}

/**
 * How far row `index` must shift, in ROWS, while `fromIndex` is being dragged to `targetIndex`. The page
 * multiplies by a row height, which is why nothing here knows pixels. The dragged row returns 0: the finger
 * positions it, not this.
 */
export function rowShift(index: number, fromIndex: number, targetIndex: number): -1 | 0 | 1 {
	if (index === fromIndex) return 0;
	if (targetIndex > fromIndex && index > fromIndex && index <= targetIndex) return -1;
	if (targetIndex < fromIndex && index < fromIndex && index >= targetIndex) return 1;
	return 0;
}

/**
 * The 1-based POSITION NUMBER row `index` shows mid-drag — without it the rows slide and the numbers do not. It is
 * `rowShift` plus one deliberately, so a row cannot be drawn in one position and labelled with another; the dragged
 * row is the case `rowShift` cannot answer, so its number is `targetIndex`. Either index -1 means no drag.
 */
export function liveSeq(index: number, fromIndex: number, targetIndex: number): number {
	if (fromIndex < 0 || targetIndex < 0) return index + 1;
	if (index === fromIndex) return targetIndex + 1;
	return index + rowShift(index, fromIndex, targetIndex) + 1;
}

function clampIndex(i: number, count: number): number {
	return Math.max(0, Math.min(count - 1, i));
}

/**
 * Has a concurrent change invalidated the DRAG IN FLIGHT? Returns the reason to STATE, or null while it is still
 * valid: state what happened, commit nothing, put focus back. CHECKED MOST-SPECIFIC FIRST — a song that starts
 * playing also drops the queued count, and "that song started" is the more useful reason to give.
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
