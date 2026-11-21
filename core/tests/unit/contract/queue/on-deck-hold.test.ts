// Proposal 14: the shared On deck hold rule (`heldEntryId`) and the add clamp in `insertEntry`, which make an add land
// behind the held entry under EVERY queue order. Each `raw` assertion pins that the policy alone WOULD have put the new
// song in front, so the clamp, not the fixture, is what keeps it behind.
import { test, expect } from 'bun:test';
import { heldEntryId, insertEntry, insertIndexFor, type Ordering, type QueueEntry } from '$lib/contract';

let _t = 0;
const e = (id: string, singerId: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
	id,
	mediaId: `m-${id}`,
	singerId,
	status: 'queued',
	rotationSeq: 0,
	addedAt: ++_t,
	...over
});
const seq = (list: QueueEntry[]) => list.map((x, i) => ({ ...x, rotationSeq: i }));
const queuedIds = (list: QueueEntry[]) => list.filter((x) => x.status === 'queued').map((x) => x.id);
const never = () => false;

// ---- heldEntryId ------------------------------------------------------------------------------------------------

test('the held entry is the next playable one while someone ELSE sings', () => {
	expect(heldEntryId({ id: 'theo-1', singerId: 'theo' }, 'maya', never)).toBe('theo-1');
});

test('nothing is held in an idle room, with nothing next, or while its singer is away', () => {
	expect(heldEntryId({ id: 'theo-1', singerId: 'theo' }, undefined, never)).toBeNull();
	expect(heldEntryId(null, 'maya', never)).toBeNull();
	expect(heldEntryId({ id: 'theo-1', singerId: 'theo' }, 'maya', (id) => id === 'theo')).toBeNull();
});

test('back to back: the singer`s own next song while they sing shows no card, so it is not held', () => {
	expect(heldEntryId({ id: 'theo-2', singerId: 'theo' }, 'theo', never)).toBeNull();
});

// ---- the add clamp, per queue order -----------------------------------------------------------------------------

/** Insert `entry` with and without the hold, and report where it landed against the held entry. */
function addUnder(
	order: Ordering['order'],
	queue: QueueEntry[],
	entry: QueueEntry,
	heldId: string,
	extra: Ordering = {}
) {
	const ordering: Ordering = { order, ...extra };
	const queued = queue.filter((x) => x.status === 'queued');
	const raw = insertIndexFor(queued, entry, ordering);
	const after = queuedIds(insertEntry(queue, entry, { ...ordering, heldId }));
	return { raw, heldAt: queued.findIndex((x) => x.id === heldId), at: after.indexOf(entry.id), after };
}

test('longest-ago: a guest who never sang would go first, and lands right behind On deck instead', () => {
	const queue = seq([e('playing', 'maya', { status: 'playing' }), e('theo-1', 'theo'), e('ana-1', 'ana')]);
	const lastSungAt = new Map([
		['maya', 3],
		['theo', 1],
		['ana', 2]
	]);
	const r = addUnder('least-recently-sung', queue, e('zoe-1', 'zoe'), 'theo-1', { lastSungAt });
	expect(r.raw).toBeLessThanOrEqual(r.heldAt);
	expect(r.after).toEqual(['theo-1', 'zoe-1', 'ana-1']);
});

test('shuffle: no add of twenty lands ahead of On deck, and some would have without the hold', () => {
	let ahead = 0;
	for (let i = 0; i < 20; i++) {
		const queue = seq([e('theo-1', 'theo'), e('ana-1', 'ana'), e('bob-1', 'bob')]);
		const r = addUnder('shuffle', queue, e(`new-${i}`, `guest-${i}`), 'theo-1', { shuffleSeed: 'room-1' });
		if (r.raw <= r.heldAt) ahead++;
		expect(r.at, `add ${i}`).toBeGreaterThan(r.after.indexOf('theo-1'));
	}
	expect(ahead).toBeGreaterThan(0);
});

test('fair: a held 2nd pick behind its singer`s cooking 1st is not jumped by a newcomer`s 1st pick', () => {
	// theo-1 is still being made, so On deck is theo-2.
	const queue = seq([e('theo-1', 'theo'), e('theo-2', 'theo'), e('ana-1', 'ana')]);
	const r = addUnder('fair', queue, e('zoe-1', 'zoe'), 'theo-2');
	expect(r.raw).toBeLessThanOrEqual(r.heldAt);
	expect(r.at).toBe(r.heldAt + 1);
	// The cooking song keeps its place in front: the clamp only ever moves an add DOWN.
	expect(r.after[0]).toBe('theo-1');
});

test('fcfs and manual append already: the hold changes nothing for them', () => {
	for (const order of ['fcfs', 'manual'] as const) {
		const queue = seq([e('theo-1', 'theo'), e('ana-1', 'ana')]);
		const r = addUnder(order, queue, e('zoe-1', 'zoe'), 'theo-1');
		expect(r.after, order).toEqual(['theo-1', 'ana-1', 'zoe-1']);
	}
});

test('no hold, no clamp: the policy`s own position stands', () => {
	const queue = seq([e('theo-1', 'theo'), e('ana-1', 'ana')]);
	const lastSungAt = new Map([
		['theo', 1],
		['ana', 2]
	]);
	const after = queuedIds(insertEntry(queue, e('zoe-1', 'zoe'), { order: 'least-recently-sung', lastSungAt }));
	expect(after[0]).toBe('zoe-1');
});
