import { test, expect } from 'bun:test';
import { storedOrder, assignSeqs, insertEntry, applyAndReseq, isTerminal, reorderWithinSinger } from './rotation';
import type { QueueEntry } from './types';

// `rotationSeq` is the STORED position and is what every read goes through. `addedAt` no longer
// decides a position; it only breaks a tie for a row the server has not numbered yet.
const e = (id: string, singerId: string, addedAt: number, rotationSeq = addedAt): QueueEntry => ({
	id,
	mediaId: 'm-' + id,
	singerId,
	status: 'queued',
	rotationSeq,
	addedAt
});

const ids = (entries: QueueEntry[]) => entries.map((x) => x.id);
/** Add each entry through the reducer under `order` — the only path that assigns a position. */
const build = (adds: QueueEntry[], order?: 'fair' | 'fcfs' | 'shuffle' | 'least-recently-sung' | 'manual') =>
	adds.reduce<QueueEntry[]>((q, entry) => applyAndReseq(q, { op: 'add', entry }, { order }), []);

// ── the stored list is the truth ─────────────────────────────────────────────
test('storedOrder reads the stored position, not addedAt', () => {
	// addedAt says a,b,c; the stored positions say c,a,b — the stored positions win.
	const entries = [e('a', 'a', 1, 1), e('b', 'b', 2, 2), e('c', 'c', 3, 0)];
	expect(ids(storedOrder(entries))).toEqual(['c', 'a', 'b']);
});

test('storedOrder is TOTAL and stable when positions tie or are unset', () => {
	const entries = [e('z', 'a', 5, 0), e('y', 'b', 2, 0), e('x', 'c', 2, 0)];
	expect(ids(storedOrder(entries))).toEqual(['x', 'y', 'z']); // addedAt then id break the tie
	const shuffled = [entries[2]!, entries[0]!, entries[1]!];
	expect(ids(storedOrder(shuffled))).toEqual(['x', 'y', 'z']); // independent of input order
});

test('assignSeqs RENUMBERS the stored order and never re-sorts it', () => {
	// A queue somebody has rearranged: b sits ahead of a. assignSeqs must preserve that.
	const entries = [e('a', 'a', 1, 7), e('b', 'b', 2, 3)];
	const out = assignSeqs(entries);
	expect(out.map((x) => [x.id, x.rotationSeq])).toEqual([
		['b', 0],
		['a', 1]
	]);
	// idempotent: running it again changes nothing
	expect(assignSeqs(out).map((x) => [x.id, x.rotationSeq])).toEqual([
		['b', 0],
		['a', 1]
	]);
});

test('assignSeqs does NOT re-derive when the policy changes', () => {
	const stored = build([e('a1', 'a', 1), e('a2', 'a', 2), e('b1', 'b', 3)], 'fcfs');
	expect(ids(stored)).toEqual(['a1', 'a2', 'b1']);
	// the room switches to fair — the queue already standing is untouched; only future adds interleave
	expect(ids(assignSeqs(stored, { order: 'fair' }))).toEqual(['a1', 'a2', 'b1']);
});

// ── insert-time fairness (what `rotate` used to do as a full sort) ───────────
test("fair insert: everyone's 1st pick before anyone's 2nd", () => {
	// Maya queues 2, then Sam queues 1, then Maya queues another.
	expect(
		ids(build([e('maya1', 'maya', 1), e('maya2', 'maya', 2), e('sam1', 'sam', 3), e('maya3', 'maya', 4)], 'fair'))
	).toEqual(['maya1', 'sam1', 'maya2', 'maya3']);
});

test('fair insert: three singers interleave by pick-index', () => {
	expect(
		ids(build([e('a1', 'a', 1), e('a2', 'a', 2), e('b1', 'b', 3), e('c1', 'c', 4), e('b2', 'b', 5)], 'fair'))
	).toEqual(['a1', 'b1', 'c1', 'a2', 'b2']);
});

test('fair insert: a new joiner slots into the next gap, not the end', () => {
	expect(ids(build([e('a1', 'a', 1), e('a2', 'a', 2), e('a3', 'a', 3), e('b1', 'b', 4)], 'fair'))).toEqual([
		'a1',
		'b1',
		'a2',
		'a3'
	]);
});

test('NON-VACUOUS: fair insertion differs from naive append', () => {
	const adds = [e('a1', 'a', 1), e('a2', 'a', 2), e('b1', 'b', 3)];
	expect(ids(build(adds, 'fcfs'))).toEqual(['a1', 'a2', 'b1']); // append
	expect(ids(build(adds, 'fair'))).toEqual(['a1', 'b1', 'a2']); // interleave — genuinely different
});

test('insertEntry places one entry and renumbers contiguously', () => {
	const stored = build([e('a1', 'a', 1), e('a2', 'a', 2)], 'fcfs');
	const out = insertEntry(stored, e('b1', 'b', 3), { order: 'fair' });
	expect(ids(out)).toEqual(['a1', 'b1', 'a2']);
	expect(out.map((x) => x.rotationSeq)).toEqual([0, 1, 2]);
});

// ── ops on the stored list ──────────────────────────────────────────────────
test('a move permutes the singer’s own slots and leaves other singers put', () => {
	let q = build([e('a1', 'a', 1), e('b1', 'b', 2), e('a2', 'a', 3)], 'fair'); // a1, b1, a2
	q = applyAndReseq(q, { op: 'move', id: 'a2', toSeq: 0 });
	expect(ids(q)).toEqual(['a2', 'b1', 'a1']); // a's two songs swapped slots; b1 never moved
	expect(q.map((x) => x.rotationSeq)).toEqual([0, 1, 2]);
});

test('a move is a no-op when the target is where the song already is', () => {
	const q = build([e('a1', 'a', 1), e('a2', 'a', 2)], 'fcfs');
	expect(ids(reorderWithinSinger(q, 'a1', 0))).toEqual(['a1', 'a2']);
});

test('a move clamps out-of-range targets instead of throwing or dropping a row', () => {
	const q = build([e('a1', 'a', 1), e('a2', 'a', 2)], 'fcfs');
	expect(ids(reorderWithinSinger(q, 'a1', 99))).toEqual(['a2', 'a1']);
	expect(ids(reorderWithinSinger(q, 'a2', -5))).toEqual(['a2', 'a1']);
});

test('an unknown id is an idempotent no-op', () => {
	const q = build([e('a1', 'a', 1)], 'fcfs');
	expect(ids(applyAndReseq(q, { op: 'move', id: 'nope', toSeq: 0 }))).toEqual(['a1']);
	expect(ids(applyAndReseq(q, { op: 'remove', id: 'nope' }))).toEqual(['a1']);
});

test('a playing entry holds its slot: an insert cannot displace the song on stage', () => {
	let q = build([e('a1', 'a', 1), e('b1', 'b', 2)], 'fair');
	q = q.map((x) => (x.id === 'a1' ? { ...x, status: 'playing' as const } : x));
	q = applyAndReseq(q, { op: 'add', entry: e('c1', 'c', 3) }, { order: 'fair' });
	expect(q[0]!.id).toBe('a1'); // still on stage, still first
	expect(q.map((x) => x.rotationSeq)).toEqual(q.map((_, i) => i));
});

test('applyAndReseq prunes terminal entries and renumbers what is left', () => {
	let q = build([e('a1', 'a', 1), e('b1', 'b', 2), e('a2', 'a', 3)], 'fair');
	q = applyAndReseq(q, { op: 'status', id: 'a1', status: 'done' });
	expect(ids(q)).toEqual(['b1', 'a2']);
	expect(q.map((x) => x.rotationSeq)).toEqual([0, 1]);
});

test('isTerminal is true only for done', () => {
	expect(isTerminal({ ...e('x', 'a', 1), status: 'done' })).toBe(true);
	for (const status of ['queued', 'playing'] as const) {
		expect(isTerminal({ ...e('x', 'a', 1), status })).toBe(false);
	}
});

test('nothing mutates its input', () => {
	const q = build([e('a1', 'a', 1), e('b1', 'b', 2)], 'fair');
	const before = JSON.stringify(q);
	storedOrder(q);
	assignSeqs(q);
	insertEntry(q, e('c1', 'c', 3), { order: 'fair' });
	reorderWithinSinger(q, 'a1', 1);
	applyAndReseq(q, { op: 'remove', id: 'b1' });
	expect(JSON.stringify(q)).toBe(before);
});
