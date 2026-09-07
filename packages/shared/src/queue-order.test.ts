import { test, expect } from 'bun:test';
import {
	QUEUE_ORDERS,
	DEFAULT_QUEUE_ORDER,
	getQueueOrder,
	isQueueOrder,
	orderQueue,
	queueOrderLabel,
	reorderIsMeaningful,
	singHistoryFrom,
	type QueueOrderId
} from './queue-order';
import { applyAndReseq, rotate } from './rotation';
import type { QueueEntry } from './types';

const e = (id: string, singerId: string, addedAt: number): QueueEntry => ({
	id,
	mediaId: 'm-' + id,
	singerId,
	status: 'queued',
	rotationSeq: -1,
	addedAt
});

const ids = (entries: QueueEntry[]) => entries.map((x) => x.id);

// ── the registry itself ─────────────────────────────────────────────────────
test('every policy has a label and a note, and the default is one of them', () => {
	for (const p of QUEUE_ORDERS) {
		expect(p.label.length).toBeGreaterThan(0);
		expect(p.note.length).toBeGreaterThan(0);
	}
	expect(getQueueOrder(DEFAULT_QUEUE_ORDER)).toBeDefined();
	expect(new Set(QUEUE_ORDERS.map((p) => p.id)).size).toBe(QUEUE_ORDERS.length);
});

test('isQueueOrder accepts every registered id and nothing else', () => {
	for (const p of QUEUE_ORDERS) expect(isQueueOrder(p.id)).toBe(true);
	for (const bad of ['', 'round-robin', 'FAIR', null, undefined, 3, {}]) expect(isQueueOrder(bad)).toBe(false);
});

test('an unknown or absent order degrades to the default rather than throwing', () => {
	const entries = [e('a1', 'a', 1), e('a2', 'a', 2), e('b1', 'b', 3)];
	const fair = ids(orderQueue(entries, { order: 'fair' }));
	expect(ids(orderQueue(entries))).toEqual(fair);
	expect(ids(orderQueue(entries, { order: 'no-such-policy' as QueueOrderId }))).toEqual(fair);
});

test('no policy mutates its input', () => {
	for (const p of QUEUE_ORDERS) {
		const entries = [e('a1', 'a', 3), e('b1', 'b', 1), e('a2', 'a', 2)];
		const before = JSON.stringify(entries);
		p.order(entries, { lastSungAt: new Map([['a', 10]]) });
		expect(JSON.stringify(entries)).toBe(before);
	}
});

test('every policy is total — it returns exactly the entries it was given', () => {
	const entries = [e('a1', 'a', 1), e('a2', 'a', 2), e('b1', 'b', 3), e('c1', 'c', 4)];
	for (const p of QUEUE_ORDERS) {
		const out = p.order(entries, { lastSungAt: new Map([['b', 5]]) });
		expect(out.length).toBe(entries.length);
		expect([...ids(out)].sort()).toEqual([...ids(entries)].sort());
	}
});

// ── fair: today's behaviour, pinned ─────────────────────────────────────────
test("fair is unchanged: everyone's 1st pick before anyone's 2nd", () => {
	const entries = [e('maya1', 'maya', 1), e('maya2', 'maya', 2), e('sam1', 'sam', 3), e('maya3', 'maya', 4)];
	expect(ids(orderQueue(entries, { order: 'fair' }))).toEqual(['maya1', 'sam1', 'maya2', 'maya3']);
	// and the un-parameterised call — the pre-setting default — agrees
	expect(ids(rotate(entries))).toEqual(['maya1', 'sam1', 'maya2', 'maya3']);
});

// ── fcfs ────────────────────────────────────────────────────────────────────
test('fcfs is strict queue order — three picks in a row, no interleave', () => {
	const entries = [e('maya1', 'maya', 1), e('maya2', 'maya', 2), e('sam1', 'sam', 3), e('maya3', 'maya', 4)];
	expect(ids(orderQueue(entries, { order: 'fcfs' }))).toEqual(['maya1', 'maya2', 'sam1', 'maya3']);
});

test('fcfs ignores who queued, ordering purely by addedAt', () => {
	const entries = [e('late', 'a', 90), e('early', 'b', 10), e('mid', 'a', 50)];
	expect(ids(orderQueue(entries, { order: 'fcfs' }))).toEqual(['early', 'mid', 'late']);
});

// ── shuffle ─────────────────────────────────────────────────────────────────
test('shuffle is STABLE: an entry keeps its rank as the queue changes around it', () => {
	const base = [e('a1', 'a', 1), e('b1', 'b', 2), e('c1', 'c', 3), e('d1', 'd', 4)];
	const first = ids(orderQueue(base, { order: 'shuffle' }));
	// removing an unrelated entry must not re-rank the survivors
	const minus = base.filter((x) => x.id !== first[1]);
	expect(ids(orderQueue(minus, { order: 'shuffle' }))).toEqual(first.filter((id) => id !== first[1]));
	// and the same input always yields the same output (no clock, no randomness)
	expect(ids(orderQueue(base, { order: 'shuffle' }))).toEqual(first);
});

test('shuffle actually reorders — it is not addedAt order wearing a hat', () => {
	// 12 entries: the chance a hash ranking reproduces insertion order is negligible, and this is a
	// FIXED input, so this either passes forever or the hash changed.
	const entries = Array.from({ length: 12 }, (_, i) => e(`e${i}`, `s${i}`, i + 1));
	expect(ids(orderQueue(entries, { order: 'shuffle' }))).not.toEqual(ids(entries));
});

// ── least-recently-sung ─────────────────────────────────────────────────────
test('least-recently-sung with no history is exactly fair', () => {
	const entries = [e('a1', 'a', 1), e('a2', 'a', 2), e('b1', 'b', 3), e('c1', 'c', 4)];
	expect(ids(orderQueue(entries, { order: 'least-recently-sung' }))).toEqual(
		ids(orderQueue(entries, { order: 'fair' }))
	);
});

test('least-recently-sung puts the singer who sang longest ago first', () => {
	const entries = [e('a1', 'a', 1), e('b1', 'b', 2), e('c1', 'c', 3)];
	// a sang most recently, c longest ago
	const lastSungAt = new Map([
		['a', 300],
		['b', 200],
		['c', 100]
	]);
	expect(ids(orderQueue(entries, { order: 'least-recently-sung', lastSungAt }))).toEqual(['c1', 'b1', 'a1']);
});

test('least-recently-sung puts anyone yet to sing ahead of everyone who has', () => {
	const entries = [e('veteran1', 'v', 1), e('newcomer1', 'n', 99)];
	// The veteran queued first AND has sung; the newcomer just walked in. Fair would seat the veteran
	// first (first appearance); this policy is the whole point of the difference.
	const lastSungAt = new Map([['v', 500]]);
	expect(ids(orderQueue(entries, { order: 'least-recently-sung', lastSungAt }))).toEqual(['newcomer1', 'veteran1']);
	expect(ids(orderQueue(entries, { order: 'fair' }))).toEqual(['veteran1', 'newcomer1']);
});

test('least-recently-sung still interleaves — one singer cannot take the whole queue', () => {
	const entries = [e('c1', 'c', 1), e('c2', 'c', 2), e('c3', 'c', 3), e('a1', 'a', 4)];
	const lastSungAt = new Map([
		['a', 300],
		['c', 100]
	]);
	// c is up first, but a's single pick still lands in round 0
	expect(ids(orderQueue(entries, { order: 'least-recently-sung', lastSungAt }))).toEqual(['c1', 'a1', 'c2', 'c3']);
});

test('two singers with the identical stamp fall back to first-appearance order', () => {
	const entries = [e('b1', 'b', 20), e('a1', 'a', 10)];
	const lastSungAt = new Map([
		['a', 100],
		['b', 100]
	]);
	expect(ids(orderQueue(entries, { order: 'least-recently-sung', lastSungAt }))).toEqual(['a1', 'b1']);
});

test('singHistoryFrom omits singers with no stamp rather than zeroing them', () => {
	const map = singHistoryFrom([
		{ id: 'a', lastSungAt: 42 },
		{ id: 'b', lastSungAt: null },
		{ id: 'c' },
		{ id: 'd', lastSungAt: Number.NaN }
	]);
	expect(map.get('a')).toBe(42);
	expect(map.has('b')).toBe(false);
	expect(map.has('c')).toBe(false);
	// NaN would sort unpredictably against every real stamp, so it must not enter the map
	expect(map.has('d')).toBe(false);
});

// ── the property that must hold under EVERY policy ──────────────────────────
// A drag-reorder permutes the singer's OWN addedAt stamps. If any policy let that change the set of
// SLOTS the singer holds, a singer could drag their way past someone else — the fairness hole this
// whole feature could most easily open without anyone noticing.
test("a singer reordering their own picks never changes another singer's position", () => {
	const lastSungAt = new Map([
		['a', 200],
		['b', 100]
	]);
	for (const p of QUEUE_ORDERS) {
		const entries = [e('a1', 'a', 1), e('b1', 'b', 2), e('a2', 'a', 3), e('b2', 'b', 4)];
		const before = applyAndReseq(entries, { op: 'status', id: 'a1', status: 'queued' }, { order: p.id, lastSungAt });
		// a drags their second pick to the front of their own two
		const after = applyAndReseq(entries, { op: 'move', id: 'a2', toSeq: 0 }, { order: p.id, lastSungAt });

		const posOf = (list: QueueEntry[], id: string) => list.findIndex((x) => x.id === id);
		for (const other of ['b1', 'b2']) {
			expect(posOf(after, other)).toBe(posOf(before, other));
		}
		// and a still holds the same slots, whatever order their own songs sit in
		const slots = (list: QueueEntry[]) => list.map((x, i) => (x.singerId === 'a' ? i : null)).filter((i) => i !== null);
		expect(slots(after)).toEqual(slots(before));
	}
});

test('reorderIsMeaningful is false only for shuffle', () => {
	expect(reorderIsMeaningful('fair')).toBe(true);
	expect(reorderIsMeaningful('fcfs')).toBe(true);
	expect(reorderIsMeaningful('least-recently-sung')).toBe(true);
	expect(reorderIsMeaningful('shuffle')).toBe(false);
	// unknown / absent must not hide a working control
	expect(reorderIsMeaningful(null)).toBe(true);
});

test('applyAndReseq assigns contiguous 0-based seqs under every policy', () => {
	for (const p of QUEUE_ORDERS) {
		const entries = [e('a1', 'a', 1), e('b1', 'b', 2), e('a2', 'a', 3)];
		const out = applyAndReseq(entries, { op: 'add', entry: e('c1', 'c', 4) }, { order: p.id });
		expect(out.map((x) => x.rotationSeq)).toEqual([0, 1, 2, 3]);
	}
});

test('every policy names its own order, and the label never leaks an id', () => {
	// EYES-ON DEFECT: the phone's list heading said "Up next · rotation" with the room on
	// first-come-first-served. The noun has to come from the policy, so a new algorithm cannot
	// inherit a previous one's word.
	for (const p of QUEUE_ORDERS) {
		expect(p.queueLabel.length).toBeGreaterThan(0);
		expect(p.queueLabel).toBe(p.queueLabel.toLowerCase()); // it sits mid-sentence in a heading
		expect(p.queueLabel).not.toBe(p.id); // a word for people, not the stored token
	}
	expect(queueOrderLabel('fcfs')).toBe('in order');
	expect(queueOrderLabel('fair')).toBe('rotation');
	// unknown / absent falls back to the default's word, never to a bare id
	expect(queueOrderLabel(null)).toBe('rotation');
	expect(queueOrderLabel('nope' as QueueOrderId)).toBe('rotation');
});
