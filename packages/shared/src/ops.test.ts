import { test, expect } from 'bun:test';
import { applyOp, inverseOp, type QueueOp } from './ops';
import type { QueueEntry } from './types';

const e = (id: string, seq: number, singerId = 's1'): QueueEntry => ({
	id,
	mediaId: 'm-' + id,
	singerId,
	status: 'queued',
	rotationSeq: seq,
	addedAt: seq
});

test('add appends and keeps sorted by rotationSeq', () => {
	const out = applyOp([e('a', 0)], { op: 'add', entry: e('b', 1) });
	expect(out.map((x) => x.id)).toEqual(['a', 'b']);
});

test('add matches existing id -> update in place (zero-flicker reconcile), no duplicate', () => {
	const optimistic = [e('a', 0)];
	// server echoes the same id but with the authoritative seq assigned
	const out = applyOp(optimistic, { op: 'add', entry: { ...e('a', 5) } });
	expect(out).toHaveLength(1); // not duplicated
	expect(out[0]!.rotationSeq).toBe(5); // adopted server seq
});

test('remove drops by id; unknown id is a no-op (idempotent)', () => {
	expect(applyOp([e('a', 0), e('b', 1)], { op: 'remove', id: 'a' }).map((x) => x.id)).toEqual(['b']);
	expect(applyOp([e('a', 0)], { op: 'remove', id: 'zzz' }).map((x) => x.id)).toEqual(['a']);
});

test('move updates rotationSeq and re-sorts', () => {
	const out = applyOp([e('a', 0), e('b', 1)], { op: 'move', id: 'a', toSeq: 2 });
	expect(out.map((x) => x.id)).toEqual(['b', 'a']);
});

test('status updates only the targeted entry', () => {
	const out = applyOp([e('a', 0), e('b', 1)], { op: 'status', id: 'b', status: 'playing' });
	expect(out.find((x) => x.id === 'b')!.status).toBe('playing');
	expect(out.find((x) => x.id === 'a')!.status).toBe('queued');
});

test('applyOp does not mutate its input (pure)', () => {
	const input = [e('a', 0)];
	const snapshot = JSON.stringify(input);
	applyOp(input, { op: 'add', entry: e('b', 1) });
	expect(JSON.stringify(input)).toBe(snapshot);
});

// ── inverseOp: round-trip restores prior state (the rollback contract) ──────────
test('inverse(add) = remove; applying it restores prior state', () => {
	const before = [e('a', 0)];
	const op: QueueOp = { op: 'add', entry: e('b', 1) };
	const after = applyOp(before, op);
	const inv = inverseOp(after, op)!;
	expect(applyOp(after, inv)).toEqual(before);
});

test('inverse(remove) = add-back; applying it restores prior state', () => {
	const before = [e('a', 0), e('b', 1)];
	const op: QueueOp = { op: 'remove', id: 'b' };
	const inv = inverseOp(before, op)!; // computed against prior state (has the row)
	const after = applyOp(before, op);
	expect(applyOp(after, inv)).toEqual(before);
});

test('inverse(move) restores prior rotationSeq', () => {
	const before = [e('a', 0), e('b', 1)];
	const op: QueueOp = { op: 'move', id: 'a', toSeq: 9 };
	const inv = inverseOp(before, op)!;
	const after = applyOp(before, op);
	expect(applyOp(after, inv)).toEqual(before);
});
