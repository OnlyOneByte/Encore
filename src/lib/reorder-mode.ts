// Reordering the queue, as pure functions.
//
// THE DRAG IS A LIVE SORT: the row follows the finger, the rows it passes shift out of its way, and the
// release commits where it visibly is. Nothing to open, draw or cancel — the gesture IS the transaction, and
// A RELEASE CANNOT COMMIT SOMEWHERE THE GUEST DID NOT CHOOSE because `liveSortTarget` is the same arithmetic
// that positions the rows on screen, so the committed index and the rendered order cannot disagree.
//
// SC 2.5.7 / 2.1.1 ARE CARRIED BY THE GRIP ITSELF: it is a real button, so Arrow Up/Down moves the row one
// place and commits, which makes every ordering reachable by dragging reachable without a pointer.
// `keyboardMoveTarget` is that path's whole logic.
//
// The logic lives in a module rather than the component because the test runner cannot mount a component
// that imports `$app` — a predicate extracted here is testable against the code the page actually calls.

import type { EntryStatus } from '$lib/contract';

/**
 * The grip renders ONLY where a reorder is real, which is the difference between an affordance and a lie.
 *
 *  • `queuedCount > 1` — with one song queued there is no second position to move it to.
 *  • `reorderMeaningful` — true under the stored-list model, because the queue IS the stored list and a move
 *    rewrites it, so no policy can discard a reorder. The parameter is kept so the caller states the claim
 *    explicitly rather than assuming it.
 *
 * There is deliberately no `mine` clause: `move-to-index` places any queued row at any global slot (the
 * server gates a non-owner entry on its own permission), so the grip is legitimate on every queued row.
 */
export function gripVisible(opts: { queuedCount: number; reorderMeaningful: boolean }): boolean {
	return opts.queuedCount > 1 && opts.reorderMeaningful;
}

/** "1st", "2nd", "3rd", "4th" … English ordinals, for the announcements the keyboard path makes. */
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
 * Where the dragged row currently IS, as a queued index — the one arithmetic, read twice: once to place the
 * rows on screen and once to commit on release.
 *
 * THE INPUT IS EVERY ROW'S OWN BOX, never one row height. The queue holds two row kinds of different
 * heights, so dividing the travel by a single height is wrong in BOTH directions the moment a taller
 * processing card is in the list. The rule is stated in the geometry instead: a row is passed once the
 * dragged row's LEADING EDGE clears that row's midpoint — bottom edge going down, top edge going up.
 *
 * ONE GEOMETRY READ, TAKEN AT PRESS TIME. Re-measuring mid-gesture is the hazard: rows change height while a
 * drag is in flight (a byline gains a badge, another guest queues a card) and a stale table then points at
 * the wrong position. Reading once cannot drift that way.
 *
 * CLAMPED TO THE LIST, which is the one place clamping is right: a finger can leave the list in either
 * direction, and the nearest end is unambiguously what the guest is aiming at.
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
	// No usable measurement is "no movement" rather than a guess: a detached node measures nothing, and a
	// list of boxes that does not cover this row cannot say where the row has travelled to.
	if (!own || rowBoundsPx.length !== count) return clampIndex(fromIndex, count);
	const centre = (i: number) => rowBoundsPx[i]!.top + rowBoundsPx[i]!.height / 2;
	const draggedTop = own.top + offsetPx;
	const draggedBottom = draggedTop + own.height;
	let target = fromIndex;
	// Downward: the LEADING edge is the bottom, and a row is passed once that edge clears the midpoint of the
	// row it is entering. Scanning on and keeping the last match is what lets one gesture cross several rows.
	if (offsetPx > 0) {
		for (let i = fromIndex + 1; i < count; i++) if (centre(i) < draggedBottom) target = i;
	} else if (offsetPx < 0) {
		// Upward: the leading edge is the top, and the scan runs the other way for the same reason.
		for (let i = fromIndex - 1; i >= 0; i--) if (centre(i) > draggedTop) target = i;
	}
	return clampIndex(target, count);
}

/**
 * The non-drag path: one step of the same reorder, -1 for Arrow Up and +1 for Arrow Down.
 *
 * NULL at the ends of the list, never a clamp: a clamp emits a move to the position the row already occupies,
 * which the server accepts as a real mutation and broadcasts to every other client.
 */
export function keyboardMoveTarget(fromIndex: number, delta: number, count: number): number | null {
	if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= count) return null;
	const to = fromIndex + delta;
	if (to < 0 || to >= count) return null;
	return to;
}

/**
 * How far row `index` must shift, in ROWS, while `fromIndex` is being dragged to `targetIndex`: the rows
 * between the two positions move exactly one place and everything outside that span stays put. The page
 * multiplies by a row height and hands the result to a transform, which is why nothing here knows pixels.
 *
 * The dragged row returns 0: it is positioned by the finger, not by this.
 */
export function rowShift(index: number, fromIndex: number, targetIndex: number): -1 | 0 | 1 {
	if (index === fromIndex) return 0;
	if (targetIndex > fromIndex && index > fromIndex && index <= targetIndex) return -1;
	if (targetIndex < fromIndex && index < fromIndex && index >= targetIndex) return 1;
	return 0;
}

/**
 * The 1-based POSITION NUMBER row `index` shows while a drag is in flight — without it the rows slide and the
 * numbers do not, so a drag shows 2 sitting above 1 until the patch lands.
 *
 * It is `rowShift` plus one deliberately: the same arithmetic that PLACES a row is what NUMBERS it, so a row
 * cannot be drawn in one position and labelled with another. The dragged row is the one case `rowShift`
 * cannot answer, so its number is `targetIndex` — where it visibly sits and what a release commits.
 *
 * Returns the plain source number when either index is -1, which is how the page spells "no drag".
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
 * Has a concurrent change invalidated the DRAG IN FLIGHT? Returns the reason to STATE, or null while it is
 * still valid. A drag is a transaction held open across other guests' mutations, and the requirement is: state
 * what happened, commit nothing, put focus back.
 *
 * CHECKED MOST-SPECIFIC FIRST, which is an ordering requirement: a song that starts playing also drops the
 * queued count, and "that song started" is the more useful reason to give.
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
