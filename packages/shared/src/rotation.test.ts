import { test, expect } from 'bun:test';
import { rotate, assignSeqs, applyAndReseq, isTerminal } from './rotation';
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

// ── applyAndReseq: the shared client+server mutation (Findings #2, #3a) ──────────
test('applyAndReseq on add reseqs to fair round-robin (NOT append) — the no-flicker guarantee', () => {
	// Maya has 2 queued; Sam adds his first. Fair order interleaves Sam's pick to slot 1,
	// NOT the bottom. This is exactly what the client must predict so the row doesn't jump.
	const base = assignSeqs([e('maya1', 'maya', 1), e('maya2', 'maya', 2)]);
	const out = applyAndReseq(base, {
		op: 'add',
		entry: { id: 'sam1', mediaId: 'm-sam1', singerId: 'sam', status: 'queued', rotationSeq: Number.MAX_SAFE_INTEGER, addedAt: 3 }
	});
	expect(out.map((x) => x.id)).toEqual(['maya1', 'sam1', 'maya2']);
	expect(out.map((x) => x.rotationSeq)).toEqual([0, 1, 2]); // contiguous, server-owned
});

test('applyAndReseq drops terminal entries (Finding #3a — no unbounded growth)', () => {
	const base = assignSeqs([e('a', 'a', 1), e('b', 'b', 2)]);
	// mark a done; it should be pruned, not linger
	const out = applyAndReseq(base, { op: 'status', id: 'a', status: 'done' });
	expect(out.find((x) => x.id === 'a')).toBeUndefined();
	expect(out.map((x) => x.id)).toEqual(['b']);
	expect(out[0]!.rotationSeq).toBe(0); // reseq'd after prune
});

test('applyAndReseq move permutes addedAt within singer + survives reseq', () => {
	// a:[a1,a2,a3], move a3 to index 0 within a's picks -> a3,a1,a2
	const base = assignSeqs([e('a1', 'a', 1), e('a2', 'a', 2), e('a3', 'a', 3)]);
	const out = applyAndReseq(base, { op: 'move', id: 'a3', toSeq: 0 });
	expect(out.map((x) => x.id)).toEqual(['a3', 'a1', 'a2']);
});

test('CLIENT==SERVER: applyAndReseq is deterministic for identical input (the contract)', () => {
	const base = assignSeqs([e('a1', 'a', 1), e('b1', 'b', 2)]);
	const op = { op: 'add' as const, entry: { id: 'a2', mediaId: 'm-a2', singerId: 'a', status: 'queued' as const, rotationSeq: 9e15, addedAt: 3 } };
	expect(applyAndReseq(base, op)).toEqual(applyAndReseq(base, op)); // pure + deterministic
});

test('isTerminal classifies done/skipped vs live', () => {
	expect(isTerminal(e('x', 'a', 1))).toBe(false); // queued
	expect(isTerminal({ ...e('x', 'a', 1), status: 'playing' })).toBe(false);
	expect(isTerminal({ ...e('x', 'a', 1), status: 'done' })).toBe(true);
	expect(isTerminal({ ...e('x', 'a', 1), status: 'skipped' })).toBe(true);
});
