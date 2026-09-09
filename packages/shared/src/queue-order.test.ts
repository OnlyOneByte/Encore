import { test, expect } from 'bun:test';
import {
	QUEUE_ORDERS,
	DEFAULT_QUEUE_ORDER,
	getQueueOrder,
	isQueueOrder,
	insertIndexFor,
	queueOrderLabel,
	singHistoryFrom,
	type QueueOrderId
} from './queue-order';
import { applyAndReseq, storedOrder } from './rotation';
import type { QueueEntry } from './types';

/** A queued entry at a known STORED position — position is what the model reads now. */
const e = (id: string, singerId: string, addedAt: number, rotationSeq = addedAt): QueueEntry => ({
	id,
	mediaId: 'm-' + id,
	singerId,
	status: 'queued',
	rotationSeq,
	addedAt
});

const ids = (entries: QueueEntry[]) => entries.map((x) => x.id);
/** Build a stored list by ADDING each entry through the reducer — the only way a position is set. */
const build = (adds: QueueEntry[], order?: QueueOrderId, lastSungAt?: ReadonlyMap<string, number>) =>
	adds.reduce<QueueEntry[]>((q, entry) => applyAndReseq(q, { op: 'add', entry }, { order, lastSungAt }), []);

// ── the registry itself ─────────────────────────────────────────────────────
test('every policy has a label, a note and its own order noun', () => {
	for (const p of QUEUE_ORDERS) {
		expect(p.label.length).toBeGreaterThan(0);
		expect(p.note.length).toBeGreaterThan(0);
		expect(p.queueLabel.length).toBeGreaterThan(0);
		expect(p.queueLabel).toBe(p.queueLabel.toLowerCase()); // it sits mid-sentence in a heading
		expect(p.queueLabel).not.toBe(p.id); // a word for people, not the stored token
	}
	expect(getQueueOrder(DEFAULT_QUEUE_ORDER)).toBeDefined();
	expect(new Set(QUEUE_ORDERS.map((p) => p.id)).size).toBe(QUEUE_ORDERS.length);
});

test('isQueueOrder accepts every registered id and nothing else', () => {
	for (const p of QUEUE_ORDERS) expect(isQueueOrder(p.id)).toBe(true);
	for (const bad of ['', 'round-robin', 'FAIR', null, undefined, 3, {}]) expect(isQueueOrder(bad)).toBe(false);
});

test('queueOrderLabel falls back to the default policy word, never a bare id', () => {
	expect(queueOrderLabel('fcfs')).toBe('in order');
	expect(queueOrderLabel('fair')).toBe('rotation');
	expect(queueOrderLabel(null)).toBe('rotation');
	expect(queueOrderLabel('nope' as QueueOrderId)).toBe('rotation');
});

// ── the insert-position contract ────────────────────────────────────────────
test('every insert rule is TOTAL — an index inside [0, queued.length] for any queue', () => {
	const queued = [e('a1', 'a', 1), e('b1', 'b', 2), e('a2', 'a', 3)];
	for (const p of QUEUE_ORDERS) {
		for (const entry of [e('new', 'a', 9), e('new', 'zz', 9)]) {
			const at = p.insertIndex(queued, entry, { lastSungAt: new Map([['a', 10]]), shuffleSeed: 's' });
			expect(Number.isInteger(at)).toBe(true);
			expect(at).toBeGreaterThanOrEqual(0);
			expect(at).toBeLessThanOrEqual(queued.length);
		}
		// and on an empty queue the only legal answer is 0
		expect(p.insertIndex([], e('new', 'a', 9), {})).toBe(0);
	}
});

test('no insert rule mutates the queue it is given', () => {
	for (const p of QUEUE_ORDERS) {
		const queued = [e('a1', 'a', 1), e('b1', 'b', 2)];
		const before = JSON.stringify(queued);
		p.insertIndex(queued, e('new', 'c', 3), { lastSungAt: new Map([['a', 10]]), shuffleSeed: 's' });
		expect(JSON.stringify(queued)).toBe(before);
	}
});

test('an insert rule is DETERMINISTIC — same inputs, same index, every call', () => {
	const queued = [e('a1', 'a', 1), e('b1', 'b', 2), e('c1', 'c', 3)];
	for (const p of QUEUE_ORDERS) {
		const ord = { lastSungAt: new Map([['b', 5]]), shuffleSeed: 'seed-1' };
		const first = p.insertIndex(queued, e('new', 'a', 4), ord);
		for (let i = 0; i < 5; i++) expect(p.insertIndex(queued, e('new', 'a', 4), ord)).toBe(first);
	}
});

test('insertIndexFor degrades an unknown or absent policy to the default, and clamps', () => {
	const queued = [e('a1', 'a', 1), e('b1', 'b', 2)];
	const entry = e('new', 'c', 3);
	const dflt = insertIndexFor(queued, entry, { order: 'fair' });
	expect(insertIndexFor(queued, entry)).toBe(dflt);
	expect(insertIndexFor(queued, entry, { order: 'no-such-policy' as QueueOrderId })).toBe(dflt);
});

// ── what each policy actually does at add-time ──────────────────────────────
test('fcfs appends: three of my songs play back to back', () => {
	expect(ids(build([e('a1', 'a', 1), e('b1', 'b', 2), e('a2', 'a', 3)], 'fcfs'))).toEqual(['a1', 'b1', 'a2']);
	expect(ids(build([e('a1', 'a', 1), e('a2', 'a', 2), e('a3', 'a', 3)], 'fcfs'))).toEqual(['a1', 'a2', 'a3']);
});

test('fair interleaves at insert: everyone’s first pick before anyone’s second', () => {
	// a queues three in a row, then b joins — b's first pick jumps ahead of a's second and third
	expect(ids(build([e('a1', 'a', 1), e('a2', 'a', 2), e('a3', 'a', 3), e('b1', 'b', 4)], 'fair'))).toEqual([
		'a1',
		'b1',
		'a2',
		'a3'
	]);
	// three singers round-robin
	expect(
		ids(
			build(
				[e('a1', 'a', 1), e('a2', 'a', 2), e('b1', 'b', 3), e('c1', 'c', 4), e('b2', 'b', 5)],
				'fair'
			)
		)
	).toEqual(['a1', 'b1', 'c1', 'a2', 'b2']);
});

test('manual appends and never interleaves — the room asked for no rule', () => {
	expect(ids(build([e('a1', 'a', 1), e('a2', 'a', 2), e('b1', 'b', 3)], 'manual'))).toEqual([
		'a1',
		'a2',
		'b1'
	]);
});

test('least-recently-sung puts a never-sung singer ahead of one who just sang', () => {
	// b sang recently, c has never sung: c's first pick outranks b's next
	const sung = new Map([['b', 100]]);
	const out = ids(build([e('b1', 'b', 1), e('b2', 'b', 2), e('c1', 'c', 3)], 'least-recently-sung', sung));
	expect(out.indexOf('c1')).toBeLessThan(out.indexOf('b2'));
});

test('least-recently-sung with no history inserts exactly like fair', () => {
	const adds = [e('a1', 'a', 1), e('a2', 'a', 2), e('b1', 'b', 3)];
	expect(ids(build(adds, 'least-recently-sung'))).toEqual(ids(build(adds, 'fair')));
});

test('shuffle is stable and seed-driven, never rolled per call', () => {
	const adds = [e('a1', 'a', 1), e('b1', 'b', 2), e('c1', 'c', 3), e('d1', 'd', 4)];
	const once = ids(build(adds, 'shuffle'));
	expect(ids(build(adds, 'shuffle'))).toEqual(once); // identical across runs — no local randomness
	expect(once.slice().sort()).toEqual(['a1', 'b1', 'c1', 'd1']); // total: nothing lost or duplicated
});

// ── the property the whole model exists for ─────────────────────────────────
test('a move is DURABLE: a later add does not undo it, under every policy', () => {
	for (const p of QUEUE_ORDERS) {
		// a queues two songs, then drags the second above the first
		let q = build([e('a1', 'a', 1), e('a2', 'a', 2)], p.id);
		q = applyAndReseq(q, { op: 'move', id: 'a2', toSeq: 0 }, { order: p.id });
		const movedOrder = ids(q.filter((x) => x.singerId === 'a'));
		expect(movedOrder).toEqual(['a2', 'a1']);
		// somebody else adds — the drag must still hold
		q = applyAndReseq(q, { op: 'add', entry: e('z1', 'z', 9) }, { order: p.id });
		expect(ids(q.filter((x) => x.singerId === 'a'))).toEqual(['a2', 'a1']);
	}
});

test('positions stay contiguous and 0-based after any op, under every policy', () => {
	for (const p of QUEUE_ORDERS) {
		let q = build([e('a1', 'a', 1), e('b1', 'b', 2), e('a2', 'a', 3)], p.id);
		q = applyAndReseq(q, { op: 'move', id: 'a2', toSeq: 0 }, { order: p.id });
		q = applyAndReseq(q, { op: 'add', entry: e('c1', 'c', 4) }, { order: p.id });
		q = applyAndReseq(q, { op: 'remove', id: 'b1' }, { order: p.id });
		expect(q.map((x) => x.rotationSeq)).toEqual(q.map((_, i) => i));
		// and the stored order IS what the list reports — no hidden re-sort
		expect(ids(storedOrder(q))).toEqual(ids(q));
	}
});

test('singHistoryFrom omits singers with no stamp rather than zeroing them', () => {
	const map = singHistoryFrom([
		{ id: 'a', lastSungAt: 10 },
		{ id: 'b', lastSungAt: null },
		{ id: 'c' }
	]);
	expect(map.get('a')).toBe(10);
	expect(map.has('b')).toBe(false);
	expect(map.has('c')).toBe(false);
});
