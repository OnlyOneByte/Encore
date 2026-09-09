// Issue #638: a HOST can drag any song to any GLOBAL queue position — not just reorder their own
// picks among themselves. The pre-#638 `move` op deliberately CANNOT express this: it permutes one
// singer's addedAt stamps, so a drag can never jump another singer under any ordering (rotation.ts).
//
// The mechanism is a durable `pinnedSeq` on the entry (set by `move-global`, cleared by `unpin`) that
// the ordering layer honours as a post-pass AFTER any of the four policies runs (placePins), so the
// pin means the same thing under fair/fcfs/least-recently-sung/shuffle AND survives assignSeqs
// re-derivation and the next add. These tests are RED on base: base has no `move-global` op (applyOp
// no-ops the unknown op, leaving the policy order untouched) and no pinnedSeq column for a manual
// position to survive in.

import { test, expect } from 'bun:test';
import { applyAndReseq, assignSeqs } from './rotation';
import type { QueueEntry } from './types';
import type { Ordering } from './queue-order';

const e = (id: string, singerId: string, addedAt: number, pinnedSeq?: number | null): QueueEntry => ({
	id,
	mediaId: 'm-' + id,
	singerId,
	status: 'queued',
	rotationSeq: -1,
	addedAt,
	...(pinnedSeq === undefined ? {} : { pinnedSeq })
});

/**
 * A PLAYING entry (issue #790). Every roster in this file was queued-only, which is exactly why the
 * pin's base went unnoticed: with nothing playing, the queued list IS the whole non-terminal list, so
 * a pin indexed over either one lands in the same place.
 */
const playing = (id: string, singerId: string, addedAt: number, pinnedSeq?: number | null): QueueEntry => ({
	...e(id, singerId, addedAt, pinnedSeq),
	status: 'playing'
});

// Fair order for these three-singer sets is first-appearance interleave; asserting the BASE order
// first makes each pin test show exactly what moved.
test('baseline fair order (sanity, so the pin deltas below are legible)', () => {
	const entries = [e('a1', 'a', 1), e('b1', 'b', 2), e('c1', 'c', 3)];
	expect(assignSeqs(entries).map((x) => x.id)).toEqual(['a1', 'b1', 'c1']);
});

test('move-global pins a song across singers to a global slot (the power `move` cannot express)', () => {
	// c1 belongs to singer c and sits last in fair order. A host drags it to the FRONT (global index 0).
	const entries = [e('a1', 'a', 1), e('b1', 'b', 2), e('c1', 'c', 3)];
	const out = applyAndReseq(entries, { op: 'move-global', id: 'c1', toSeq: 0 });
	expect(out.map((x) => x.id)).toEqual(['c1', 'a1', 'b1']);
	// and rotationSeq is contiguous 0-based over the new order
	expect(out.map((x) => x.rotationSeq)).toEqual([0, 1, 2]);
	// the pin is recorded on the entry (durable), not just reflected in this frame's order
	expect(out.find((x) => x.id === 'c1')!.pinnedSeq).toBe(0);
});

test('a pin SURVIVES a later add — the durability the issue turns on', () => {
	// Pin c1 to the front, then someone adds a new song. The pin must hold at slot 0.
	const pinned = applyAndReseq([e('a1', 'a', 1), e('b1', 'b', 2), e('c1', 'c', 3)], {
		op: 'move-global',
		id: 'c1',
		toSeq: 0
	});
	const afterAdd = applyAndReseq(pinned, {
		op: 'add',
		entry: e('d1', 'd', 4)
	});
	// c1 is STILL first despite the add re-deriving the whole ordering
	expect(afterAdd[0]!.id).toBe('c1');
	expect(afterAdd.find((x) => x.id === 'c1')!.pinnedSeq).toBe(0);
});

test('a pin holds under ALL four orderings', () => {
	const base = [e('a1', 'a', 1), e('b1', 'b', 2), e('c1', 'c', 3)];
	const lastSungAt = new Map([['a', 100]]); // a sang most recently → sorts last under least-recently-sung
	for (const order of ['fair', 'fcfs', 'shuffle', 'least-recently-sung'] as const) {
		const ordering: Ordering = { order, lastSungAt };
		// pin b1 to the front under this policy
		const out = applyAndReseq(base, { op: 'move-global', id: 'b1', toSeq: 0 }, ordering);
		expect(out[0]!.id).toBe(`b1`);
		// the other two remain in THIS policy's relative order around the pin (pin is a post-pass, not a
		// policy input), so the pin composes with rather than replaces the room's fairness rule.
		expect(out.map((x) => x.id).filter((id) => id !== 'b1').length).toBe(2);
	}
});

test('unpin clears the pin, and the row keeps the position it is standing in', () => {
	const pinned = applyAndReseq([e('a1', 'a', 1), e('b1', 'b', 2), e('c1', 'c', 3)], {
		op: 'move-global',
		id: 'c1',
		toSeq: 0
	});
	expect(pinned[0]!.id).toBe('c1');
	const released = applyAndReseq(pinned, { op: 'unpin', id: 'c1' });
	// The pin is gone (null), not merely ignored. Under the STORED-LIST model (#856) releasing it does
	// NOT spring the row back to a derived order — the stored list is the truth, so c1 stays at the
	// head it now occupies. Nothing re-derives a position for it to return to.
	expect(released.map((x) => x.id)).toEqual(['c1', 'a1', 'b1']);
	expect(released.find((x) => x.id === 'c1')!.pinnedSeq ?? null).toBeNull();
});

test('assignSeqs honours a pin (proves the placePins post-pass runs inside it, not just the reducer)', () => {
	// Feed entries whose pinnedSeq is ALREADY set (as a hydrate would), so this bites on assignSeqs →
	// placePins directly, independent of the move-global reducer. Reverting the placePins wiring reds it.
	const entries = [e('a1', 'a', 1), e('b1', 'b', 2), e('c1', 'c', 3, 0)];
	expect(assignSeqs(entries).map((x) => x.id)).toEqual(['c1', 'a1', 'b1']);
	// and the unpinned case is unchanged
	expect(assignSeqs([e('a1', 'a', 1), e('b1', 'b', 2)]).map((x) => x.id)).toEqual(['a1', 'b1']);
});

test('multiple pins settle deterministically, lowest target first', () => {
	// Pin c1→0 and a1→2. Applied lowest-target-first over the unpinned remainder [b1].
	const entries = [e('a1', 'a', 1, 2), e('b1', 'b', 2), e('c1', 'c', 3, 0)];
	// remainder after removing pins: [b1]; place c1@0 -> [c1,b1]; place a1@2 (clamped to len) -> [c1,b1,a1]
	expect(assignSeqs(entries).map((x) => x.id)).toEqual(['c1', 'b1', 'a1']);
});

test('a pin index past the end clamps to the tail rather than dropping the entry', () => {
	const entries = [e('a1', 'a', 1), e('b1', 'b', 2, 99)];
	const out = assignSeqs(entries);
	expect(out.map((x) => x.id)).toEqual(['a1', 'b1']);
	expect(out.length).toBe(2); // never lost
});

// ---------------------------------------------------------------------------------------------
// Issue #790 — the pin's BASE while a song is playing.
//
// The phone computes a reorder target from `queued` (the playing entry excluded) and placePins used
// to apply it to `rotate(entries)` (the playing entry INCLUDED). One entry playing therefore made
// every target one short: `move down` sent the row's own index (inert forever) and `move up` sent two
// below it (jumping the playing song). Same off-by-one #637 fixed for the sibling `move` op, at the
// pin. These three drive the REAL client arithmetic, so they are about the reported taps.
// ---------------------------------------------------------------------------------------------

/**
 * The arithmetic `apps/core/src/routes/+page.svelte` performs on one reorder tap, replayed verbatim:
 * `queued` is `entries.filter((x) => x.status === 'queued')` sorted by rotationSeq (:627), `globalIdx`
 * is the index in THAT list (:689-692), and `moveGlobal` sends `i + delta` clamped to
 * `queued.length - 1` (:698-705) through `store.pinEntry` → the `move-global` op (queue.ts:139).
 *
 * Deriving the target the way the caller does — rather than hand-picking a toSeq — is what makes these
 * guards pin the CONTRACT between the two sides instead of one side's arithmetic.
 */
function tap(entries: QueueEntry[], id: string, delta: number, ordering: Ordering = {}): QueueEntry[] {
	const queued = entries.filter((x) => x.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq);
	const i = queued.findIndex((x) => x.id === id);
	if (i < 0) return entries.slice();
	const to = Math.max(0, Math.min(i + delta, queued.length - 1));
	if (to === i) return entries.slice();
	return applyAndReseq(entries, { op: 'move-global', id, toSeq: to }, ordering);
}

test('#790 F1 — move down on a queued row MOVES it while a song is playing (was inert)', () => {
	// One playing + two queued, the room the issue reproduces on. Seeded through assignSeqs so the
	// rotationSeq the client sorts by is the real one.
	const base = assignSeqs([playing('p1', 'a', 1), e('a1', 'a', 2), e('a2', 'a', 3)]);
	expect(base.map((x) => x.id)).toEqual(['p1', 'a1', 'a2']); // sanity: the base order the tap starts from

	// Tap `move down` on the top queued row. Expected order is hard-coded, NOT recomputed from the
	// same splice the code performs.
	const out = tap(base, 'a1', 1);
	expect(out.map((x) => x.id)).toEqual(['p1', 'a2', 'a1']);
	// Base received ['p1','a1','a2'] — toSeq 1 was a1's OWN slot in the pinned list, so placePins put
	// it back where it started, on every press, forever.
	expect(out.map((x) => x.rotationSeq)).toEqual([0, 1, 2]);
});

test('#790 F2 — move up does NOT jump the playing entry', () => {
	const base = assignSeqs([playing('p1', 'a', 1), e('a1', 'a', 2), e('a2', 'a', 3)]);
	const out = tap(base, 'a2', -1);
	// One slot up means above a1, not above the song on stage. Base received ['a2','p1','a1'], which
	// ranked two queued entries ahead of the playing song and made later adds land behind both.
	expect(out.map((x) => x.id)).toEqual(['p1', 'a2', 'a1']);
	expect(out.find((x) => x.id === 'p1')!.rotationSeq).toBe(0); // the playing song keeps the stage slot
});

test('#790 — a pin carried BY a playing entry does not displace it from its policy slot', () => {
	// A pin is durable, so an entry pinned while queued still carries `pinnedSeq` once it starts
	// playing. A playing entry is not a reorder target, so its stale pin must not move it: base
	// spliced it to index 1 and produced ['a1','p1','a2'].
	const out = assignSeqs([playing('p1', 'a', 1, 1), e('a1', 'a', 2), e('a2', 'a', 3)]);
	expect(out.map((x) => x.id)).toEqual(['p1', 'a1', 'a2']);
});

test('#790 control — with NOTHING playing the same tap reorders on base too (non-vacuity)', () => {
	// The only difference from F1 is that no entry is playing. This case passes both before and after
	// the fix, which is what proves the two guards above are about the playing entry and not about the
	// tap arithmetic being wrong in general.
	const base = assignSeqs([e('a1', 'a', 1), e('a2', 'a', 2), e('a3', 'a', 3)]);
	expect(base.map((x) => x.id)).toEqual(['a1', 'a2', 'a3']);
	expect(tap(base, 'a1', 1).map((x) => x.id)).toEqual(['a2', 'a1', 'a3']);
});
