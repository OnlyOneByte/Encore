// XR-PH-17 / XR-PH-18 / XR-PH-19 — the own-picks reorder mode, tested where its logic
// actually lives. These are the "pure predicate" checks the requirements name: `bunfig.toml` cannot
// mount a component importing `$app` (lib/tv/wake-lock.test.ts:18-27, restated as XR-PH-21), so a
// predicate inlined in `routes/+page.svelte` could only be tested by RECONSTRUCTING it here — which
// pins the copy in the test rather than the code the page runs. Every assertion below imports the
// same function `+page.svelte` calls.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gripVisible, ownSlots, ordinal, dropTarget, modeInvalidation } from './reorder-mode';

const PAGE = join(import.meta.dir, '..', 'routes', '+page.svelte');

// The three-true case, so each test below can negate exactly one condition.
const OK = { mine: true, ownQueuedCount: 2, reorderMeaningful: true };

// ── XR-PH-17 · the grip appears ONLY where a reorder is real ──────────────────────────────────────

test('XR-PH-17 · a grip renders for a guest with two of their own picks under a reordering policy', () => {
	expect(gripVisible(OK)).toBe(true);
});

test('XR-PH-17 · no grip on another guest\u2019s row — `move` cannot place their song', () => {
	// The exact regression QueueRow.svelte's comment records: a grip that rendered on a row whose
	// singer is not the actor, where it was the sole affordance.
	expect(gripVisible({ ...OK, mine: false })).toBe(false);
});

test('XR-PH-17 · no grip with exactly ONE of the guest\u2019s picks queued', () => {
	// The issue's first acceptance case. One pick has no second position to occupy.
	expect(gripVisible({ ...OK, ownQueuedCount: 1 })).toBe(false);
	expect(gripVisible({ ...OK, ownQueuedCount: 0 })).toBe(false);
});

test('XR-PH-17 · no grip under an ordering that ignores addedAt — a `move` there is a legal no-op', () => {
	// `shuffle` ranks by entry id (`respectsAddedAt: false`), so permuting addedAt changes nothing and
	// a grip would promise a reorder the reducer discards.
	expect(gripVisible({ ...OK, reorderMeaningful: false })).toBe(false);
});

// ── XR-PH-18 · legal slots come from the guest's OWN picks ────────────────────────────────────────

test('XR-PH-18 · the slot count equals the guest\u2019s own pick count, never the visible list length', () => {
	// The issue's acceptance: 6 queued entries of which 2 are the guest's → exactly 2 drop targets.
	// `ownSlots` is not even given the list length, which is what makes that true by construction.
	expect(ownSlots(2)).toHaveLength(2);
	expect(ownSlots(3)).toHaveLength(3);
	expect(ownSlots(0)).toHaveLength(0);
});

test('XR-PH-18 · each slot is labelled with the ordinal it represents among the guest\u2019s picks', () => {
	const slots = ownSlots(3);
	expect(slots.map((s) => s.ordinal)).toEqual(['1st', '2nd', '3rd']);
	expect(slots.map((s) => s.index)).toEqual([0, 1, 2]);
	// The accessible name says what activating it DOES, and names the guest's own index space — never
	// a queue position, which is not what `toSeq` means.
	expect(slots[0]!.label).toBe('Move to 1st of your songs');
	for (const s of slots) expect(s.label).toContain('your songs');
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
	// The distinction is the whole requirement. `reorderWithinSinger` clamps an out-of-range toIdx into
	// the singer's range, so passing an illegal drop through would emit a `move` to some OTHER
	// position — a commit the guest never chose. `dropTarget` declines instead.
	expect(dropTarget(null, 2)).toBeNull(); // released over no slot at all
	expect(dropTarget(2, 2)).toBeNull(); // one past the last own slot
	expect(dropTarget(-1, 2)).toBeNull();
	expect(dropTarget(7, 2)).toBeNull();
	expect(dropTarget(1.5, 2)).toBeNull(); // a hit-test that read a non-integer dataset value
	// …and a legal one passes through unchanged.
	expect(dropTarget(0, 2)).toBe(0);
	expect(dropTarget(1, 2)).toBe(1);
});

// ── XR-PH-19 · the queue moves underneath the mode ────────────────────────────────────────────────

test('XR-PH-19 · a valid open mode reports no reason to close', () => {
	expect(modeInvalidation([{ id: 'a' }, { id: 'b' }], 'a', 'queued')).toBeNull();
});

test('XR-PH-19 · no mode open means nothing to invalidate', () => {
	expect(modeInvalidation([], null, undefined)).toBeNull();
});

test('XR-PH-19 · the mode closes with a reason when the guest\u2019s pick begins playing', () => {
	const reason = modeInvalidation([{ id: 'a' }, { id: 'b' }], 'a', 'playing');
	expect(reason).toBe('That song started playing — nothing was moved.');
});

test('XR-PH-19 · the mode closes with a reason when the moving song leaves the queue', () => {
	// Removed elsewhere: the entry is gone from `entries`, so its status is undefined.
	expect(modeInvalidation([{ id: 'b' }], 'a', undefined)).toBe('That song left the queue — nothing was moved.');
});

test('XR-PH-19 · the mode closes with a reason when the guest drops below two picks', () => {
	// The issue's acceptance: the guest's second pick is removed elsewhere.
	expect(modeInvalidation([{ id: 'a' }], 'a', 'queued')).toBe(
		'You have one song queued now — there is nothing to reorder.'
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

test('XR-PH-19 · another guest\u2019s add is NOT an invalidation — the slots are indexed over my picks', () => {
	// `assignSeqs` re-derives every rotationSeq on every mutation, so the flat list DOES move under an
	// open drag. It must not disturb the mode: a stranger's entry is not one of my picks, so neither
	// my slot count nor what each slot commits changes. This is the property that makes the "another
	// guest queues a song mid-drag" acceptance case require no handling at all.
	const mine = [{ id: 'a' }, { id: 'b' }];
	const before = ownSlots(mine.length);
	expect(modeInvalidation(mine, 'a', 'queued')).toBeNull();
	// The stranger's entry never enters `mine`, so the derivation is bit-identical.
	expect(ownSlots(mine.length)).toEqual(before);
	expect(dropTarget(1, mine.length)).toBe(1);
});

// ── the page really calls these, so the tests above are not testing a spare part ──────────────────

test('non-vacuity · +page.svelte imports and calls every predicate asserted here', () => {
	// Without this, all of the above could pass against a module the page had stopped using — the
	// failure mode this non-vacuity arm exists to make loud. Each name is checked as a CALL, not just as an import.
	const src = readFileSync(PAGE, 'utf8');
	expect(src).toContain("from '$lib/reorder-mode'");
	for (const fn of ['gripVisible(', 'ownSlots(', 'dropTarget(', 'modeInvalidation(']) {
		expect(src).toContain(fn);
	}
});
