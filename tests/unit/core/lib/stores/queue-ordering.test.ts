// The client half of the ordering contract: the optimistic reducer must predict with the ROOM's
// algorithm, not with fair rotation. A prediction made under the wrong algorithm renders the new row
// in the wrong place and then snaps when the server patch arrives — the exact flicker `applyAndReseq`
// is shared between the phone and the server to prevent.
import { test, expect } from 'bun:test';
import { QueueStore } from '$lib/stores/queue';
import type { ClientCommand, Ordering, QueueEntry } from '@encore/shared';

function makeStore(ordering?: () => Ordering) {
	const sent: ClientCommand[] = [];
	let n = 0;
	const store = new QueueStore({
		sendCommand: (c) => sent.push(c),
		singerId: 'me',
		mintId: () => `id${n++}`,
		ordering
	});
	return { store, sent };
}

/** Someone else's two songs, already in the room, as the server would have sent them. */
const theirs = (): QueueEntry[] => [
	{ id: 'them1', mediaId: 'm9', singerId: 'them', status: 'queued', rotationSeq: 0, addedAt: 1 },
	{ id: 'them2', mediaId: 'm9', singerId: 'them', status: 'queued', rotationSeq: 1, addedAt: 2 }
];

test('fair rotation: my new song slots in AHEAD of their second', () => {
	const { store } = makeStore(() => ({ order: 'fair' }));
	store.onServerEvent({ type: 'queue:sync', rev: 1, entries: theirs() });
	const mine = store.addSong('m1');
	expect(store.entries.map((e) => e.id)).toEqual(['them1', mine, 'them2']);
});

test('first come, first served: the same add lands at the BACK', () => {
	const { store } = makeStore(() => ({ order: 'fcfs' }));
	store.onServerEvent({ type: 'queue:sync', rev: 1, entries: theirs() });
	const mine = store.addSong('m1');
	// Not a rotation any more: they asked first, they sing both.
	expect(store.entries.map((e) => e.id)).toEqual(['them1', 'them2', mine]);
});

test('no ordering supplied = fair rotation, the pre-setting behaviour', () => {
	const { store } = makeStore();
	store.onServerEvent({ type: 'queue:sync', rev: 1, entries: theirs() });
	const mine = store.addSong('m1');
	expect(store.entries.map((e) => e.id)).toEqual(['them1', mine, 'them2']);
});

test('the ordering is read AT APPLY TIME, so a mid-party change takes effect on the next tap', () => {
	// The getter exists for this: the room can switch algorithm while the phone is open, and the
	// snapshot the store captured at construction would be wrong from then on.
	let order: Ordering['order'] = 'fair';
	const { store } = makeStore(() => ({ order }));
	store.onServerEvent({ type: 'queue:sync', rev: 1, entries: theirs() });
	const first = store.addSong('m1');
	expect(store.entries.map((e) => e.id)).toEqual(['them1', first, 'them2']);

	order = 'fcfs';
	store.onServerEvent({ type: 'queue:sync', rev: 2, entries: theirs() });
	const second = store.addSong('m2');
	// Both of mine are at the back now: the first add is still pending, so the resync re-applies it —
	// under the NEW ordering, which is the point. Fair would have interleaved them.
	expect(store.entries.map((e) => e.id)).toEqual(['them1', 'them2', first, second]);
});

test('a rebase after resync re-applies pending ops under the room ordering, not fair', () => {
	// The resync path re-applies still-pending ops on top of server truth. It has its own
	// applyAndReseq call, and an ordering passed to the optimistic path but forgotten here would make
	// a reconnect quietly reorder the queue.
	const { store } = makeStore(() => ({ order: 'fcfs' }));
	const mine = store.addSong('m1'); // pending, not yet confirmed
	store.onServerEvent({ type: 'queue:sync', rev: 5, entries: theirs() });
	expect(store.entries.map((e) => e.id)).toEqual(['them1', 'them2', mine]);
});

test('least-recently-sung: the sing history from the roster changes where my add lands', () => {
	// `them` sang recently and I have not sung at all, so my pick leads the round even though theirs
	// was queued first. Under fair this would be ['them1', mine, 'them2'].
	const { store } = makeStore(() => ({
		order: 'least-recently-sung',
		lastSungAt: new Map([['them', 900]])
	}));
	store.onServerEvent({ type: 'queue:sync', rev: 1, entries: theirs() });
	const mine = store.addSong('m1');
	expect(store.entries.map((e) => e.id)).toEqual([mine, 'them1', 'them2']);
});
