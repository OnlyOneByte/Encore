import { test, expect } from 'bun:test';
import { applyOp, applyAndReseq, type QueueEntry } from '$lib/contract';

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

test('move-to-index in applyOp is a raw-seq fallback (real path is applyAndReseq → moveToIndex)', () => {
	// The cross-singer reducer is rotation.ts moveToIndex; this only pins that applyOp stays exhaustive.
	const out = applyOp([e('a', 0), e('b', 1)], { op: 'move-to-index', id: 'a', toIdx: 2 });
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

// applyAndReseq's purity is what makes snapshot rollback total: #onReject restores a reference to the pre-op
// array, so the forward op must not have mutated the objects that array held. `move` is the case that
// matters — it routes through reorderWithinSinger, which rewrites addedAt.
test('applyAndReseq(move) does not mutate the input entries (snapshot stays intact)', () => {
	// Two picks by the SAME singer, so reorderWithinSinger really permutes addedAt in the forward step.
	const before = [e('a', 0), e('b', 1)];
	const frozenView = JSON.stringify(before);
	const after = applyAndReseq(before, { op: 'move', id: 'b', toSeq: 0 });
	expect(after.map((x) => x.id)).toEqual(['b', 'a']); // the op is non-trivial …
	// … yet order, rotationSeq AND addedAt of every input entry are unchanged, so a snapshot captured before
	// the call is a faithful rollback target.
	expect(JSON.stringify(before)).toBe(frozenView);
	expect(after).not.toBe(before); // a fresh array, not the same reference
});

test('applyAndReseq(add) and (remove) also leave the input untouched', () => {
	const add0 = [e('a', 0)];
	const addFrozen = JSON.stringify(add0);
	applyAndReseq(add0, { op: 'add', entry: e('b', 1) });
	expect(JSON.stringify(add0)).toBe(addFrozen);

	const rem0 = [e('a', 0), e('b', 1)];
	const remFrozen = JSON.stringify(rem0);
	applyAndReseq(rem0, { op: 'remove', id: 'b' });
	expect(JSON.stringify(rem0)).toBe(remFrozen);
});

// `move-to-index` is a TYPE-only member, so nothing runtime-observable reds if it vanishes from the wire
// contract — hence a source-scan guard for the vocabulary itself.
import { read } from '$test';
const opsSrc = read('src/lib/contract/core/ops.ts')
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
test('step 4: the QueueOp union carries move-to-index (id + numeric toIdx)', () => {
	const m = opsSrc.match(/export type QueueOp =[\s\S]*?status: EntryStatus \};/);
	expect(m).not.toBeNull(); // non-vacuous: the union must exist
	expect(m![0]).toContain("op: 'move-to-index'");
	expect(m![0]).toMatch(/'move-to-index';\s*id: string;\s*toIdx: number/);
});
