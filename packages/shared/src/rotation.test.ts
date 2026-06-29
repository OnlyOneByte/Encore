import { test, expect } from 'bun:test';
import { rotate, assignSeqs } from './rotation';
import type { QueueEntry } from './types';

// addedAt encodes queue order; singerId drives the round-robin grouping.
const e = (id: string, singerId: string, addedAt: number): QueueEntry => ({
	id,
	mediaId: 'm-' + id,
	singerId,
	status: 'queued',
	rotationSeq: -1,
	addedAt
});

test('round-robin: everyone\'s 1st pick before anyone\'s 2nd', () => {
	// Maya queues 2, then Sam queues 1, then Maya queues another.
	const entries = [
		e('maya1', 'maya', 1),
		e('maya2', 'maya', 2),
		e('sam1', 'sam', 3),
		e('maya3', 'maya', 4)
	];
	// fair order: maya1 (M #1), sam1 (S #1), maya2 (M #2), maya3 (M #3)
	expect(rotate(entries).map((x) => x.id)).toEqual(['maya1', 'sam1', 'maya2', 'maya3']);
});

test('three singers interleave by pick-index', () => {
	const entries = [
		e('a1', 'a', 1),
		e('a2', 'a', 2),
		e('b1', 'b', 3),
		e('c1', 'c', 4),
		e('b2', 'b', 5)
	];
	// round0: a1,b1,c1 · round1: a2,b2 · round2: (none)
	expect(rotate(entries).map((x) => x.id)).toEqual(['a1', 'b1', 'c1', 'a2', 'b2']);
});

test('singer order = first appearance (earliest addedAt), not alphabetical', () => {
	const entries = [e('z1', 'zoe', 1), e('a1', 'amy', 2)];
	// zoe appeared first -> zoe before amy
	expect(rotate(entries).map((x) => x.id)).toEqual(['z1', 'a1']);
});

test('new joiner slots into the next gap (does not jump the current round)', () => {
	// a has 3 queued; b joins after. b\'s first pick comes after a\'s first, not last.
	const entries = [e('a1', 'a', 1), e('a2', 'a', 2), e('a3', 'a', 3), e('b1', 'b', 4)];
	expect(rotate(entries).map((x) => x.id)).toEqual(['a1', 'b1', 'a2', 'a3']);
});

test('assignSeqs yields contiguous 0-based rotationSeq in fair order', () => {
	const entries = [e('a1', 'a', 1), e('b1', 'b', 2), e('a2', 'a', 3)];
	const seqs = assignSeqs(entries);
	expect(seqs.map((x) => [x.id, x.rotationSeq])).toEqual([
		['a1', 0],
		['b1', 1],
		['a2', 2]
	]);
});

// non-vacuity: a naive FIFO would FAIL the fairness test above, proving it asserts something real.
test('NON-VACUOUS: fair order differs from naive FIFO', () => {
	const entries = [e('a1', 'a', 1), e('a2', 'a', 2), e('b1', 'b', 3)];
	const fifo = [...entries].sort((x, y) => x.addedAt - y.addedAt).map((x) => x.id);
	const fair = rotate(entries).map((x) => x.id);
	expect(fifo).toEqual(['a1', 'a2', 'b1']); // what FIFO would do
	expect(fair).toEqual(['a1', 'b1', 'a2']); // round-robin is different -> test is meaningful
	expect(fair).not.toEqual(fifo);
});

test('rotate does not mutate input', () => {
	const input = [e('a1', 'a', 1)];
	const snap = JSON.stringify(input);
	rotate(input);
	expect(JSON.stringify(input)).toBe(snap);
});
