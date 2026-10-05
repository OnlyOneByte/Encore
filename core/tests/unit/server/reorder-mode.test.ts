// The reorder mode's pure predicates, tested where the logic lives. `bunfig.toml` cannot mount a component
// importing `$app`, so a predicate inlined in a route could only be tested by RECONSTRUCTING it here — pinning
// the copy rather than the code the page runs. Every assertion imports the function it calls.
//
// THE CALLER IS /queue, NOT `/`. The machinery moved with its rows when the phone grew tabs: a queue is the Queue
// tab's subject, and leaving the reorder state on a page that renders no queue is how a drag quietly stops working.
// The non-vacuity test at the bottom is what holds this file to the surface that actually runs it.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	gripVisible,
	ordinal,
	liveSortTarget,
	keyboardMoveTarget,
	rowShift,
	liveSeq,
	modeInvalidation
} from '$lib/reorder-mode';
import { at } from '$test';

const PAGE = at('src/routes/queue/+page.svelte');

const OK = { queuedCount: 2, reorderMeaningful: true };

test('a grip renders when two or more songs are queued under a reordering policy', () => {
	expect(gripVisible(OK)).toBe(true);
});

test('the grip renders on ANY queued row, not only the guest\u2019s own', () => {
	// Under `move-to-index` any queued row can be dragged to any global slot (the server gates a non-owner on
	// `queue:reorder-any`), so `gripVisible` takes no `mine` argument at all.
	expect(gripVisible({ queuedCount: 2, reorderMeaningful: true })).toBe(true);
});

test('no grip with fewer than two songs queued', () => {
	expect(gripVisible({ ...OK, queuedCount: 1 })).toBe(false);
	expect(gripVisible({ ...OK, queuedCount: 0 })).toBe(false);
});

test('no grip under an ordering that ignores addedAt — a move there is a legal no-op', () => {
	// `shuffle` ranks by entry id, so a move changes nothing and a grip would promise a reorder the reducer discards.
	expect(gripVisible({ ...OK, reorderMeaningful: false })).toBe(false);
});

// The boxes a real render would report: five 60px rows from y=0, uniform so the hand-over points are the same
// numbers the single-row-height arms were written against.
const UNIFORM = [0, 60, 120, 180, 240].map((top) => ({ top, height: 60 }));

test('the target follows the finger, a row at a time', () => {
	const at = (offsetPx: number) => liveSortTarget({ fromIndex: 1, offsetPx, rowBoundsPx: UNIFORM, count: 5 });
	expect(at(0)).toBe(1);
	// HALF a row is the hand-over point, stated as geometry: the leading edge clears the next row's midpoint.
	expect(at(29)).toBe(1);
	expect(at(31)).toBe(2);
	expect(at(-31)).toBe(0);
	expect(at(120)).toBe(3);
	expect(at(180)).toBe(4);
});

test('a MIXED list is exact — one tall card among short rows, in both directions', () => {
	// THE DEFECT THE BOXES FIXED: the queue holds a ~65px queued row and a ~104px processing card, so dividing the
	// travel by ONE height was wrong both ways round — a card dragged two short rows read 130/104 = 1.25 (one
	// position) and a short row dragged past a card read 104/65 = 1.6 (two).
	// Geometry: 65, 104 (the card, index 1), 65, 65 from y=0. Midpoints 32.5, 117, 201.5, 266.5.
	const MIXED = [
		{ top: 0, height: 65 },
		{ top: 65, height: 104 },
		{ top: 169, height: 65 },
		{ top: 234, height: 65 }
	];
	// The CARD dragged down clears index 2's midpoint (201.5) after 32.5px — HALF OF THE ROW IT IS PASSING, not
	// half of its own 104. A single height demanded 52.
	const card = (offsetPx: number) => liveSortTarget({ fromIndex: 1, offsetPx, rowBoundsPx: MIXED, count: 4 });
	expect(card(30)).toBe(1);
	expect(card(40)).toBe(2);
	expect(card(90)).toBe(2);
	expect(card(100)).toBe(3);
	// A SHORT ROW dragged UP passes the card's midpoint (117) after 117px — half of the CARD, not of itself.
	const row = (offsetPx: number) => liveSortTarget({ fromIndex: 3, offsetPx, rowBoundsPx: MIXED, count: 4 });
	expect(row(-30)).toBe(3);
	expect(row(-40)).toBe(2);
	expect(row(-110)).toBe(2);
	expect(row(-120)).toBe(1);
});

test('dragging past either end lands on the end, never outside the list', () => {
	const bounds = [0, 60, 120].map((top) => ({ top, height: 60 }));
	const at = (fromIndex: number, offsetPx: number) =>
		liveSortTarget({ fromIndex, offsetPx, rowBoundsPx: bounds, count: 3 });
	// Clamping is right HERE and only here: the finger has left the list, and the row is visibly at the nearest end.
	expect(at(0, -600)).toBe(0);
	expect(at(2, 600)).toBe(2);
	expect(at(1, 6000)).toBe(2);
});

test('a measurement that cannot answer moves nothing', () => {
	// Boxes that do not cover the list they describe cannot say where a row travelled: no movement, not a guess.
	// An empty list has no position to name; 0 rather than -1 so no caller can index with it.
	expect(liveSortTarget({ fromIndex: 1, offsetPx: 400, rowBoundsPx: [], count: 4 })).toBe(1);
	expect(liveSortTarget({ fromIndex: 1, offsetPx: 400, rowBoundsPx: UNIFORM.slice(0, 2), count: 4 })).toBe(1);
	expect(liveSortTarget({ fromIndex: 0, offsetPx: 0, rowBoundsPx: [], count: 0 })).toBe(0);
});

test('the rows between the two positions shift exactly one place, and no others', () => {
	expect([0, 1, 2, 3, 4].map((i) => rowShift(i, 1, 3))).toEqual([0, 0, -1, -1, 0]);
	expect([0, 1, 2, 3, 4].map((i) => rowShift(i, 3, 1))).toEqual([0, 1, 1, 0, 0]);
	expect([0, 1, 2, 3, 4].map((i) => rowShift(i, 2, 2))).toEqual([0, 0, 0, 0, 0]);
	expect(rowShift(1, 1, 4)).toBe(0);
});

test('the position NUMBERS follow the rows mid-drag, and are a permutation at every step', () => {
	// THE DEFECT: the rows animated and the numbers did not — every bubble rendered `sourceIndex + 1` until the
	// server patch landed, so a drag showed 2 above 1 and then corrected every number in one jump. Asserted as a
	// PERMUTATION because that is what makes the label trustworthy: at any point in the gesture the five rows show
	// 1..5 in some order, where a number derived separately from the placement could print two 3s.
	const seqs = (from: number, to: number) => [0, 1, 2, 3, 4].map((i) => liveSeq(i, from, to));

	expect(seqs(1, 3)).toEqual([1, 4, 2, 3, 5]);
	expect(seqs(3, 1)).toEqual([1, 3, 4, 2, 5]);
	expect(seqs(1, 0)).toEqual([2, 1, 3, 4, 5]);
	expect(seqs(2, 2)).toEqual([1, 2, 3, 4, 5]);
	// -1 is how the page spells "no drag in flight"; each falls back to source order, never a 0th row.
	expect(seqs(-1, -1)).toEqual([1, 2, 3, 4, 5]);
	expect(seqs(0, -1)).toEqual([1, 2, 3, 4, 5]);
	expect(seqs(-1, 2)).toEqual([1, 2, 3, 4, 5]);

	for (let from = 0; from < 5; from++) {
		for (let to = 0; to < 5; to++) {
			expect(
				seqs(from, to)
					.slice()
					.sort((a, b) => a - b),
				`from ${from} to ${to}`
			).toEqual([1, 2, 3, 4, 5]);
		}
	}
});

test('the keyboard step moves one place and DECLINES at the ends', () => {
	expect(keyboardMoveTarget(1, -1, 4)).toBe(0);
	expect(keyboardMoveTarget(1, 1, 4)).toBe(2);
	// NULL, NOT A CLAMP, at either end: a clamp would emit a move to the position the row already occupies, which
	// the server accepts as a real mutation and broadcasts, for a keypress that did nothing.
	expect(keyboardMoveTarget(0, -1, 4)).toBeNull();
	expect(keyboardMoveTarget(3, 1, 4)).toBeNull();
	expect(keyboardMoveTarget(-1, 1, 4)).toBeNull();
	expect(keyboardMoveTarget(4, -1, 4)).toBeNull();
	expect(keyboardMoveTarget(1.5, 1, 4)).toBeNull();
});

test('the ordinals the keyboard path announces stay correct past the irregular teens', () => {
	expect(ordinal(1)).toBe('1st');
	expect(ordinal(2)).toBe('2nd');
	expect(ordinal(3)).toBe('3rd');
	expect(ordinal(4)).toBe('4th');
	expect(ordinal(11)).toBe('11th');
	expect(ordinal(12)).toBe('12th');
	expect(ordinal(13)).toBe('13th');
	expect(ordinal(21)).toBe('21st');
	expect(ordinal(22)).toBe('22nd');
	expect(ordinal(23)).toBe('23rd');
	expect(ordinal(111)).toBe('111th');
});

test('a valid open mode reports no reason to close', () => {
	expect(modeInvalidation([{ id: 'a' }, { id: 'b' }], 'a', 'queued')).toBeNull();
});

test('no mode open means nothing to invalidate', () => {
	expect(modeInvalidation([], null, undefined)).toBeNull();
});

test('the mode closes with a reason when the moving song begins playing', () => {
	const reason = modeInvalidation([{ id: 'a' }, { id: 'b' }], 'a', 'playing');
	expect(reason).toBe('That song started playing — nothing was moved.');
});

test('the mode closes with a reason when the moving song leaves the queue', () => {
	expect(modeInvalidation([{ id: 'b' }], 'a', undefined)).toBe('That song left the queue — nothing was moved.');
});

test('the mode closes with a reason when the queue drops below two songs', () => {
	expect(modeInvalidation([{ id: 'a' }], 'a', 'queued')).toBe(
		'Only one song is queued now — there is nothing to reorder.'
	);
});

test('every close reason states what happened AND that nothing moved, or why', () => {
	// A mode that dissolves silently is the defect, and a reason that does not say the move was dropped is half of
	// one. Enumerated so a future reason cannot be added without a consequence in it.
	const reasons = [
		modeInvalidation([{ id: 'a' }, { id: 'b' }], 'a', 'playing'),
		modeInvalidation([{ id: 'b' }], 'a', undefined),
		modeInvalidation([{ id: 'a' }], 'a', 'queued')
	];
	for (const r of reasons) {
		expect(r).toBeTruthy();
		expect(r!.length).toBeGreaterThan(20);
		expect(/nothing was moved|nothing to reorder/.test(r!)).toBe(true);
	}
});

test('the moving song can be ANY guest\u2019s now, not only the actor\u2019s', () => {
	expect(modeInvalidation([{ id: 'x' }, { id: 'y' }], 'x', 'queued')).toBeNull();
	expect(modeInvalidation([{ id: 'x' }, { id: 'y' }, { id: 'z' }], 'z', 'queued')).toBeNull();
});

test('non-vacuity · the Queue tab imports and calls every predicate asserted here', () => {
	// Without this, all of the above could pass against a module no surface had left. Each name is checked as a
	// CALL, not just an import — and it is pointed at /queue, which is where the rows are.
	const src = readFileSync(PAGE, 'utf8');
	expect(src).toContain("from '$lib/reorder-mode'");
	for (const fn of [
		'gripVisible(',
		'liveSortTarget(',
		'keyboardMoveTarget(',
		'rowShift(',
		'ordinal(',
		'modeInvalidation('
	]) {
		expect(src).toContain(fn);
	}
});
