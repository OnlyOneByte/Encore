// / / (; drag rewired to the whole queue in) — the reorder
// mode, tested where its logic actually lives. These are the "pure predicate" checks the requirements
// name: `bunfig.toml` cannot mount a component importing `$app` (lib/tv/wake-lock.test.ts:18-27,
// restated as), so a predicate inlined in `routes/+page.svelte` could only be tested by
// RECONSTRUCTING it here — which pins the copy in the test rather than the code the page runs. Every
// assertion below imports the same function `+page.svelte` calls.
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
import { at } from '@encore/test-support';

const PAGE = at('src/routes/+page.svelte');

// The both-true case, so each test below can negate exactly one condition.
const OK = { queuedCount: 2, reorderMeaningful: true };

// ── the grip appears ONLY where a reorder is real ──────────────────────────────────────

test('a grip renders when two or more songs are queued under a reordering policy', () => {
	expect(gripVisible(OK)).toBe(true);
});

test('the grip renders on ANY queued row, not only the guest\u2019s own', () => {
	// Under `move-to-index` any queued row can be dragged to any global slot (the server gates a
	// non-owner on `queue:reorder-any`), so the grip no longer takes a `mine` argument at all. The old
	// regression (a grip that was the SOLE affordance on another guest's row) cannot return: the row
	// still carries its up/down buttons, so the grip is an addition. `gripVisible` has no `mine` param
	// — this test documents that widening rather than asserting a value.
	expect(gripVisible({ queuedCount: 2, reorderMeaningful: true })).toBe(true);
});

test('no grip with fewer than two songs queued', () => {
	// One song has no second position to move it to; zero is empty.
	expect(gripVisible({ ...OK, queuedCount: 1 })).toBe(false);
	expect(gripVisible({ ...OK, queuedCount: 0 })).toBe(false);
});

test('no grip under an ordering that ignores addedAt — a move there is a legal no-op', () => {
	// `shuffle` ranks by entry id (`respectsAddedAt: false`), so a move changes nothing and a grip
	// would promise a reorder the reducer discards. Constant-true under the stored-list model today.
	expect(gripVisible({ ...OK, reorderMeaningful: false })).toBe(false);
});

// ── legal slots span the WHOLE queued list ─────────────────────────────────────────────

/*
 * the standard's SLOT ARMS BECAME LIVE-SORT ARMS (2026-09-21). They pinned `queueSlots` (one labelled target per
 * queued position) and `dropTarget` (a release off a target commits nothing). Both are deleted with the mode
 * — see the header of `$lib/reorder-mode` — and the requirement they served, "a release cannot commit
 * somewhere the guest did not choose", is now met by identity: one expression places the rows and commits.
 * So these arms test that expression instead, including the two rounding edges a drawn target never had.
 */
/*
 * A UNIFORM LIST, as the boxes a real render would report: five 60px rows stacked from y=0. Uniform on
 * purpose for the arms that were written against one row height — the hand-over points are UNCHANGED by the
 * move to boxes, which is the claim those arms now carry.
 */
const UNIFORM = [0, 60, 120, 180, 240].map((top) => ({ top, height: 60 }));

test('the target follows the finger, a row at a time', () => {
	const at = (offsetPx: number) => liveSortTarget({ fromIndex: 1, offsetPx, rowBoundsPx: UNIFORM, count: 5 });
	// Not moved: still where it started, so a release commits nothing (the page early-returns on same-index).
	expect(at(0)).toBe(1);
	// HALF a row is the hand-over point — that is where the gap has visibly opened on screen. Stated in the
	// geometry now (the leading edge clears the next row's midpoint) rather than as a rounding of the travel,
	// and for a uniform list the two are the same number.
	expect(at(29)).toBe(1);
	expect(at(31)).toBe(2);
	expect(at(-31)).toBe(0);
	// …and it keeps counting, one row per row of travel.
	expect(at(120)).toBe(3);
	expect(at(180)).toBe(4);
});

test('a MIXED list is exact — one tall card among short rows, in both directions', () => {
	/*
	 * THE DEFECT THE BOXES FIXED. The queue holds two row kinds: a ~65px queued row and a ~104px processing
	 * card. Dividing the travel by ONE height was wrong both ways round — a card dragged two short rows read
	 * 130/104 = 1.25 → one position, and a short row dragged past a card read 104/65 = 1.6 → two. The old
	 * design avoided half of that by refusing the card a grip, which is what was reported ("songs being
	 * processed aren't currently draggable").
	 *
	 * Geometry: 65, 104 (the card, index 1), 65, 65 stacked from y=0. Midpoints 32.5, 117, 201.5, 266.5.
	 */
	const MIXED = [
		{ top: 0, height: 65 },
		{ top: 65, height: 104 },
		{ top: 169, height: 65 },
		{ top: 234, height: 65 }
	];
	// The CARD dragged down. Its bottom edge starts at 169, so it clears index 2's midpoint (201.5) after
	// 32.5px — HALF OF THE ROW IT IS PASSING, not half of its own 104. A single height demanded 52.
	const card = (offsetPx: number) => liveSortTarget({ fromIndex: 1, offsetPx, rowBoundsPx: MIXED, count: 4 });
	expect(card(30)).toBe(1);
	expect(card(40)).toBe(2);
	// …and on to the next, at 266.5 − 169 = 97.5px.
	expect(card(90)).toBe(2);
	expect(card(100)).toBe(3);
	// A SHORT ROW dragged UP past the card: its top edge starts at 234 and passes the card's midpoint (117)
	// after 117px — half of the CARD. Dividing by 65 would have called that 1.8 rows and landed a position early.
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
	// Clamping is right HERE and only here: the finger has left the list, and the nearest end is
	// unambiguously what the guest is aiming at — the row is visibly sitting there when they let go. That is
	// not the "commits somewhere unchosen" case, which was about a target the guest could not see.
	expect(at(0, -600)).toBe(0);
	expect(at(2, 600)).toBe(2);
	expect(at(1, 6000)).toBe(2);
});

test('a measurement that cannot answer moves nothing', () => {
	// A detached node measures nothing, and a list of boxes that does not cover the list it claims to describe
	// cannot say where a row has travelled to. Both are "no movement" rather than a guess at an end.
	expect(liveSortTarget({ fromIndex: 1, offsetPx: 400, rowBoundsPx: [], count: 4 })).toBe(1);
	expect(liveSortTarget({ fromIndex: 1, offsetPx: 400, rowBoundsPx: UNIFORM.slice(0, 2), count: 4 })).toBe(1);
	// An empty list has no position to name; 0 rather than -1 so no caller can index with it.
	expect(liveSortTarget({ fromIndex: 0, offsetPx: 0, rowBoundsPx: [], count: 0 })).toBe(0);
});

test('the rows between the two positions shift exactly one place, and no others', () => {
	// Dragging row 1 down to 3: rows 2 and 3 come up one, everything else stays.
	expect([0, 1, 2, 3, 4].map((i) => rowShift(i, 1, 3))).toEqual([0, 0, -1, -1, 0]);
	// Dragging row 3 up to 1: rows 1 and 2 go down one.
	expect([0, 1, 2, 3, 4].map((i) => rowShift(i, 3, 1))).toEqual([0, 1, 1, 0, 0]);
	// Not moved: nothing shifts, so an idle list cannot be left displaced.
	expect([0, 1, 2, 3, 4].map((i) => rowShift(i, 2, 2))).toEqual([0, 0, 0, 0, 0]);
	// The dragged row is placed by the finger, never by this.
	expect(rowShift(1, 1, 4)).toBe(0);
});

test('the position NUMBERS follow the rows mid-drag, and are a permutation at every step', () => {
	/*
	 * THE DEFECT: the rows animated and the numbers did not. Every bubble rendered `sourceIndex + 1`
	 * until the server patch landed, so a drag showed 2 above 1 and then every number in the list
	 * corrected itself in one jump — reported as "a flash where everything changes".
	 *
	 * Asserted as a PERMUTATION rather than row by row, because that is the property that makes the
	 * label trustworthy: at any point in the gesture the five rows must show 1..5 in some order, with
	 * nothing duplicated and nothing missing. A number derived separately from the placement could
	 * satisfy every individual case and still print two 3s.
	 */
	const seqs = (from: number, to: number) => [0, 1, 2, 3, 4].map((i) => liveSeq(i, from, to));

	// Dragging row 1 (the 2nd) down to index 3 (the 4th): 2 becomes 4, and 3 and 4 each come up one.
	expect(seqs(1, 3)).toEqual([1, 4, 2, 3, 5]);
	// And back the other way: dragging the 4th up to 2nd pushes 2 and 3 down.
	expect(seqs(3, 1)).toEqual([1, 3, 4, 2, 5]);
	// The two-row swap the report described: sliding 2 above 1 shows 1 become 2 and 2 become 1.
	expect(seqs(1, 0)).toEqual([2, 1, 3, 4, 5]);
	// A gesture that has not left its row numbers the list exactly as the server does.
	expect(seqs(2, 2)).toEqual([1, 2, 3, 4, 5]);
	// -1 is how the page spells "no drag in flight" — for `dragFrom`, for `dragTo`, or for both. Each
	// falls back to the source order rather than producing a 0th row (`targetIndex + 1` on -1).
	expect(seqs(-1, -1)).toEqual([1, 2, 3, 4, 5]);
	expect(seqs(0, -1)).toEqual([1, 2, 3, 4, 5]);
	expect(seqs(-1, 2)).toEqual([1, 2, 3, 4, 5]);

	// The permutation property itself, over every (from, to) pair a 5-row list admits.
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
	// The non-drag path (SC 2.5.7 / 2.1.1), which replaced the move up / move down buttons.
	expect(keyboardMoveTarget(1, -1, 4)).toBe(0);
	expect(keyboardMoveTarget(1, 1, 4)).toBe(2);
	/*
	 * NULL, NOT A CLAMP, at either end. A clamp would emit a move to the position the row already occupies —
	 * which the server accepts as a real mutation and broadcasts to every other client, for a keypress that
	 * did nothing. The page returns early on null and says nothing.
	 */
	expect(keyboardMoveTarget(0, -1, 4)).toBeNull();
	expect(keyboardMoveTarget(3, 1, 4)).toBeNull();
	// A row that is not in the list cannot be stepped.
	expect(keyboardMoveTarget(-1, 1, 4)).toBeNull();
	expect(keyboardMoveTarget(4, -1, 4)).toBeNull();
	expect(keyboardMoveTarget(1.5, 1, 4)).toBeNull();
});

test('the ordinals the keyboard path announces stay correct past the irregular teens', () => {
	// The announcement is "Moved to Nth in the queue", so these are read aloud rather than drawn.
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
	// Removed elsewhere: the entry is gone from `entries`, so its status is undefined.
	expect(modeInvalidation([{ id: 'b' }], 'a', undefined)).toBe('That song left the queue — nothing was moved.');
});

test('the mode closes with a reason when the queue drops below two songs', () => {
	// The last other song is removed elsewhere, leaving one queued entry — nothing left to reorder.
	expect(modeInvalidation([{ id: 'a' }], 'a', 'queued')).toBe(
		'Only one song is queued now — there is nothing to reorder.'
	);
});

test('every close reason states what happened AND that nothing moved, or why', () => {
	// A mode that dissolves silently is the defect; a reason that does not say the move was dropped is
	// half of one. Enumerated so a future reason cannot be added without a consequence in it.
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
	// The collection is the whole queued list, and `movingId` need only still be a queued entry — it
	// does not have to be one of the actor's picks. A drag on another guest's song stays valid while
	// that song is queued and two or more songs remain.
	expect(modeInvalidation([{ id: 'x' }, { id: 'y' }], 'x', 'queued')).toBeNull();
	// The count guard reads the whole queue: three queued songs keep the mode open regardless of owner.
	expect(modeInvalidation([{ id: 'x' }, { id: 'y' }, { id: 'z' }], 'z', 'queued')).toBeNull();
});

// ── the page really calls these, so the tests above are not testing a spare part ──────────────────

test('non-vacuity · +page.svelte imports and calls every predicate asserted here', () => {
	// Without this, all of the above could pass against a module the page had stopped using — the
	// failure mode exists to make loud. Each name is checked as a CALL, not just as an import.
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
