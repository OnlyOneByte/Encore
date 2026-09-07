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

test('unpin releases the entry back to the room policy (a pin never auto-clears)', () => {
	const pinned = applyAndReseq([e('a1', 'a', 1), e('b1', 'b', 2), e('c1', 'c', 3)], {
		op: 'move-global',
		id: 'c1',
		toSeq: 0
	});
	expect(pinned[0]!.id).toBe('c1');
	const released = applyAndReseq(pinned, { op: 'unpin', id: 'c1' });
	// back to fair order; the pin is gone (null), not merely ignored
	expect(released.map((x) => x.id)).toEqual(['a1', 'b1', 'c1']);
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
