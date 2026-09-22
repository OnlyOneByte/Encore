// Reordering the queue, as pure functions.
//
// ── FROM A MODE WITH DRAWN SLOTS TO A LIVE SORT (2026-09-21) ──────────────────────────────────────
//
// This file used to serve a MODE: a press on the grip opened it, the page drew one labelled drop target
// per queued position, a release over a target committed and a release anywhere else committed nothing,
// and a bar offered Done/Cancel. Its reasoning was sound for the op it was written against — under
// `move`, a guest's picks were not adjacent in the flat list, so the list genuinely could not imply the
// legal positions by proximity and the mode had to draw them.
//
// TWO THINGS MADE IT THE WRONG SHAPE. The op widened to `move-to-index` (a GLOBAL queued index; hub.ts
// gates a non-owner entry on `queue:reorder-any`), so every position became legal and "draw the legal
// ones" stopped distinguishing anything — the slots were one per row, which is what the list already
// implies. And it was reported on sight: four controls per row plus a bar plus a target between every
// pair of rows, to move one song one place.
//
// SO THE DRAG IS A LIVE SORT. The row follows the finger, the rows it passes shift out of its way, and
// the release commits where it visibly is. No mode to open, nothing to draw, nothing to cancel — the
// gesture IS the transaction.
//
//'S SUBSTANCE SURVIVES, which is the part that mattered: "a release cannot commit somewhere the
// guest did not choose." It was satisfied by declining a release outside a drawn target; it is now
// satisfied by the target being WHAT THE GUEST CAN SEE — `liveSortTarget` is the same arithmetic that
// positions the rows on screen, so the committed index and the rendered order cannot disagree.
//
// IS A CONFORMANCE ROW (SC 2.5.7 / 2.1.1) AND IS NOT WEAKENED. The up/down buttons are gone —
// two 44px controls per row, which is what the report was about — and the non-drag path moved ONTO THE
// GRIP: it is a real button, so focus it and Arrow Up/Down move the row one place each, committing
// immediately. Every ordering reachable by dragging is reachable that way, it costs no layout, and it
// covers keyboard users as the arrows did. `keyboardMoveTarget` is that path's whole logic.
//
// WHY THE LOGIC IS HERE AND NOT IN THE COMPONENT. the and the acceptance are claims about a
// predicate and an index, and `bunfig.toml` cannot mount a component that imports `$app` (see
// lib/tv/wake-lock.test.ts:18-27, restated as). A predicate extracted into a real module is
// testable against the code the page actually calls; one inlined in a template can only be tested by
// reconstructing it, which pins nothing.

import type { EntryStatus } from '$lib/contract';

/**
 * the grip renders ONLY where a reorder is real.
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
 * still carries a remove button, and the grip itself IS the non-drag path (Arrow Up/Down while focused),
 * so it never promises something the row cannot do.
 *
 * (The `!ownPicksPinned` clause was removed with pinning in an earlier change step 3: with no durable pin there is
 * nothing left to re-seat a moved row, so the clause was constant-true and its predicate dead.)
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
 * Where the dragged row currently IS, as a queued index.
 *
 * THE ONE ARITHMETIC, READ TWICE: once to place the rows on screen and once to commit on release. That is
 * what replaced the drawn drop targets, and it is a stronger guarantee rather than a looser one — the old
 * mode could in principle render a target the release resolved differently; here "what the guest sees" and
 * "what is committed" are the same expression, so they cannot disagree.
 *
 * ── FROM ONE ROW HEIGHT TO THE ROWS' OWN CENTRES (2026-09-22) ─────────────────────────────────────
 *
 * This took a single `rowHeightPx` and divided the travel by it, which is exact only while every row in the
 * list is the same height. The queue contains TWO row kinds — a queued row and a taller processing card with
 * a progress block — so the moment one song is being made, the arithmetic is wrong in both directions: a
 * card dragged two 65px rows (130px) read 130/104 = 1.25 → ONE position, and a row dragged past a 104px card
 * read 104/65 = 1.6 → TWO. The old design dodged this by refusing the processing card a grip at all, which
 * is the defect that made it visible ("songs being processed aren't currently draggable") and which did not
 * even fix the other direction.
 *
 * So the input is the rows' own BOXES rather than one height, and the rule is stated in the geometry: a row
 * is passed once the dragged row's LEADING EDGE clears that row's midpoint — its bottom edge going down, its
 * top edge going up. That is exact for any mix of heights, and it is the SAME hand-over the old `Math.round`
 * expressed ("half a row of travel") with the half belonging to the row being passed rather than to the row
 * doing the passing, which is the only reading that survives two different heights.
 *
 * ONE GEOMETRY READ, TAKEN AT PRESS TIME — the property the single height was chosen for, kept. The recorded
 * hazard was re-measuring MID-GESTURE: rows change height while a drag is in flight (a byline gains an
 * `away` badge, another guest queues a card) and a stale table then points at the wrong position. Reading
 * once at press cannot drift that way, and a list that reshapes under the finger moves the whole thing
 * together (see the `modeInvalidation` note on why that case needs no handling).
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
 * the non-drag path, as one step of the same reorder.
 *
 * `delta` is -1 for Arrow Up and +1 for Arrow Down. Returns the index to commit, or NULL at the ends of
 * the list — null rather than a clamp so the caller can leave the row where it is and say nothing, rather
 * than emitting a move to the position the row already occupies, which the server would accept as a real
 * mutation and broadcast to every other client.
 */
export function keyboardMoveTarget(fromIndex: number, delta: number, count: number): number | null {
	if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= count) return null;
	const to = fromIndex + delta;
	if (to < 0 || to >= count) return null;
	return to;
}

/**
 * How far row `index` must shift, in ROWS, while `fromIndex` is being dragged to `targetIndex`.
 *
 * -1, 0 or +1: the rows between the two positions move exactly one place to open the gap, and everything
 * outside that span stays put. The page multiplies this by the row height and hands it to a `transform`,
 * which is why the animation is composited and why nothing here knows about pixels.
 *
 * The dragged row itself returns 0: it is positioned by the finger, not by this.
 */
export function rowShift(index: number, fromIndex: number, targetIndex: number): -1 | 0 | 1 {
	if (index === fromIndex) return 0;
	if (targetIndex > fromIndex && index > fromIndex && index <= targetIndex) return -1;
	if (targetIndex < fromIndex && index < fromIndex && index >= targetIndex) return 1;
	return 0;
}

/**
 * The 1-based POSITION NUMBER row `index` shows WHILE A DRAG IS IN FLIGHT.
 *
 * ── THE DEFECT THIS EXISTS FOR ────────────────────────────────────────────────────────────────────
 *
 * The rows animated and the numbers did not. `rowShift` slid every row out of the dragged row's way in
 * real time, but each row's bubble kept rendering `sourceIndex + 1` — the order the SERVER last sent —
 * so a drag showed 2 sitting above 1, and the numbers all corrected themselves at once when the patch
 * landed. Reported as "a sort of flash on screen where everything changes": the flash was the only
 * moment the numbers moved, and it happened after the gesture rather than during it.
 *
 * ── WHY IT IS THIS EXPRESSION AND NOT A SECOND ONE ────────────────────────────────────────────────
 *
 * It is `rowShift` plus one, and that is the point — the same arithmetic that PLACES a row is what
 * NUMBERS it, so a row cannot be drawn in one position and labelled with another. A separate
 * "what number goes here" pass is exactly how the two would drift, which is the hazard
 * `liveSortTarget`'s own note argues about commits: one expression, read everywhere.
 *
 * The dragged row is the one case `rowShift` cannot answer (it returns 0 for it, because the finger
 * positions that row rather than the shift doing it), so its number is `targetIndex` — the position it
 * is visibly sitting in and the position a release commits.
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
 * has a concurrent change invalidated the DRAG IN FLIGHT? Returns the reason to STATE, or null
 * while it is still valid.
 *
 * "Mode" in this function's name and prose is historical: there is no mode to exit any more (see the
 * header), but a pointer drag is still a transaction held open across other guests' mutations, and
 * `assignSeqs` re-derives `rotationSeq` on every one of them. The three invalidating shapes are unchanged,
 * and so is the requirement: state what happened, commit nothing, put focus back.
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
