// XR-PH-17 / XR-PH-18 / XR-PH-19 (; drag rewired to the whole queue in) — the reorder
// mode, tested where its logic actually lives. These are the "pure predicate" checks the requirements
// name: `bunfig.toml` cannot mount a component importing `$app` (lib/tv/wake-lock.test.ts:18-27,
// restated as XR-PH-21), so a predicate inlined in `routes/+page.svelte` could only be tested by
// RECONSTRUCTING it here — which pins the copy in the test rather than the code the page runs. Every
// assertion below imports the same function `+page.svelte` calls.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { gripVisible, queueSlots, ordinal, dropTarget, modeInvalidation } from '$lib/reorder-mode';
import { at } from '@encore/test-support';

const PAGE = at('src/routes/+page.svelte');

// The both-true case, so each test below can negate exactly one condition.
const OK = { queuedCount: 2, reorderMeaningful: true };

// ── XR-PH-17 · the grip appears ONLY where a reorder is real ──────────────────────────────────────

test('XR-PH-17 · a grip renders when two or more songs are queued under a reordering policy', () => {
	expect(gripVisible(OK)).toBe(true);
});

test('XR-PH-17 · the grip renders on ANY queued row, not only the guest\u2019s own', () => {
	// Under `move-to-index` any queued row can be dragged to any global slot (the server gates a
	// non-owner on `queue:reorder-any`), so the grip no longer takes a `mine` argument at all. The old
	// regression (a grip that was the SOLE affordance on another guest's row) cannot return: the row
	// still carries its up/down buttons, so the grip is an addition. `gripVisible` has no `mine` param
	// — this test documents that widening rather than asserting a value.
	expect(gripVisible({ queuedCount: 2, reorderMeaningful: true })).toBe(true);
});

test('XR-PH-17 · no grip with fewer than two songs queued', () => {
	// One song has no second position to move it to; zero is empty.
	expect(gripVisible({ ...OK, queuedCount: 1 })).toBe(false);
	expect(gripVisible({ ...OK, queuedCount: 0 })).toBe(false);
});

test('XR-PH-17 · no grip under an ordering that ignores addedAt — a move there is a legal no-op', () => {
	// `shuffle` ranks by entry id (`respectsAddedAt: false`), so a move changes nothing and a grip
	// would promise a reorder the reducer discards. Constant-true under the stored-list model today.
	expect(gripVisible({ ...OK, reorderMeaningful: false })).toBe(false);
});

// ── XR-PH-18 · legal slots span the WHOLE queued list ─────────────────────────────────────────────

test('XR-PH-18 · the slot count equals the queued list length', () => {
	// Every queued position is a legal target now, so 6 queued entries → exactly 6 drop targets.
	expect(queueSlots(2)).toHaveLength(2);
	expect(queueSlots(6)).toHaveLength(6);
	expect(queueSlots(0)).toHaveLength(0);
});

test('XR-PH-18 · each slot is labelled with the queue position it commits', () => {
	const slots = queueSlots(3);
	expect(slots.map((s) => s.ordinal)).toEqual(['1st', '2nd', '3rd']);
	expect(slots.map((s) => s.index)).toEqual([0, 1, 2]);
	// The accessible name says what activating it DOES, and names the GLOBAL queue position — the index
	// space `move-to-index` uses.
	expect(slots[0]!.label).toBe('Move to 1st in queue');
	for (const s of slots) expect(s.label).toContain('in queue');
});

test('XR-PH-18 · ordinals stay correct past the irregular teens', () => {
	expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
		'1st',
		'2nd',
		'3rd',
		'4th',
		'11th',
		'12th',
		'13th',
		'21st',
		'22nd',
		'23rd',
		'101st',
		'111th'
	]);
});

test('XR-PH-18 · a release that is not over a legal slot commits NOTHING — it is not clamped', () => {
	// The distinction is the whole requirement. `moveToIndex` clamps an out-of-range toIdx into the
	// queued range, so passing an illegal drop through would commit some OTHER position the guest never
	// chose. `dropTarget` declines instead, over the whole-queue count.
	expect(dropTarget(null, 3)).toBeNull(); // released over no slot at all
	expect(dropTarget(3, 3)).toBeNull(); // one past the last slot
	expect(dropTarget(-1, 3)).toBeNull();
	expect(dropTarget(7, 3)).toBeNull();
	expect(dropTarget(1.5, 3)).toBeNull(); // a hit-test that read a non-integer dataset value
	// …and a legal one passes through unchanged.
	expect(dropTarget(0, 3)).toBe(0);
	expect(dropTarget(2, 3)).toBe(2);
});

// ── XR-PH-19 · the queue moves underneath the mode ────────────────────────────────────────────────

test('XR-PH-19 · a valid open mode reports no reason to close', () => {
	expect(modeInvalidation([{ id: 'a' }, { id: 'b' }], 'a', 'queued')).toBeNull();
});

test('XR-PH-19 · no mode open means nothing to invalidate', () => {
	expect(modeInvalidation([], null, undefined)).toBeNull();
});

test('XR-PH-19 · the mode closes with a reason when the moving song begins playing', () => {
	const reason = modeInvalidation([{ id: 'a' }, { id: 'b' }], 'a', 'playing');
	expect(reason).toBe('That song started playing — nothing was moved.');
});

test('XR-PH-19 · the mode closes with a reason when the moving song leaves the queue', () => {
	// Removed elsewhere: the entry is gone from `entries`, so its status is undefined.
	expect(modeInvalidation([{ id: 'b' }], 'a', undefined)).toBe('That song left the queue — nothing was moved.');
});

test('XR-PH-19 · the mode closes with a reason when the queue drops below two songs', () => {
	// The last other song is removed elsewhere, leaving one queued entry — nothing left to reorder.
	expect(modeInvalidation([{ id: 'a' }], 'a', 'queued')).toBe(
		'Only one song is queued now — there is nothing to reorder.'
	);
});

test('XR-PH-19 · every close reason states what happened AND that nothing moved, or why', () => {
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

test('XR-PH-19 · the moving song can be ANY guest\u2019s now, not only the actor\u2019s', () => {
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
	for (const fn of ['gripVisible(', 'queueSlots(', 'dropTarget(', 'modeInvalidation(']) {
		expect(src).toContain(fn);
	}
});
