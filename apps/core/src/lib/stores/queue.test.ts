// M1-C6 done-when: add renders pre-broadcast, reconciles with zero reorder; reject rolls back.
import { test, expect } from 'bun:test';
import { QueueStore } from './queue';
import type { ClientCommand, ServerEvent, QueueEntry } from '@encore/shared';

// deterministic id minting: first mint = entry id, second = clientOpId, ... (addSong mints 2)
function makeStore() {
	const sent: ClientCommand[] = [];
	let n = 0;
	const ids: string[] = [];
	const store = new QueueStore({
		sendCommand: (c) => sent.push(c),
		singerId: 'me',
		mintId: () => {
			const id = `id${n++}`;
			ids.push(id);
			return id;
		}
	});
	return { store, sent, ids };
}

test('optimistic add renders immediately, BEFORE any server broadcast', () => {
	const { store, sent } = makeStore();
	const id = store.addSong('m1');
	expect(store.entries.map((e) => e.id)).toEqual([id]); // rendered this frame
	expect(store.pendingCount).toBe(1);
	expect(sent).toHaveLength(1);
	expect(sent[0]!.op.op).toBe('add');
	expect(store.rev).toBe(0); // server hasn't responded yet
});

test('server echo (causedBy) clears pending; reconcile adopts server seq with zero duplicate', () => {
	const { store } = makeStore();
	const id = store.addSong('m1');
	const cmd = (store as unknown as { _: 0 }) && id; // id is the entry id

	// server confirms: patch echoes our clientOpId, sync carries the authoritative entry w/ seq 0
	const clientOpId = 'id1'; // addSong mints id0=entryId, id1=clientOpId
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 1, ops: [], causedBy: clientOpId } });
	store.onServerEvent({
		type: 'queue:sync',
		rev: 1,
		entries: [{ id, mediaId: 'm1', singerId: 'me', status: 'queued', rotationSeq: 0, addedAt: 1 }]
	});

	expect(store.pendingCount).toBe(0); // confirmed
	expect(store.entries).toHaveLength(1); // NOT duplicated (matched by id)
	expect(store.entries[0]!.rotationSeq).toBe(0); // adopted server seq
	expect(store.rev).toBe(1);
});

test('reject rolls back the optimistic add via the recorded inverse', () => {
	const { store } = makeStore();
	store.addSong('m1');
	expect(store.entries).toHaveLength(1);

	store.onServerEvent({ type: 'op:reject', clientOpId: 'id1', reason: 'unknown media' });
	expect(store.entries).toHaveLength(0); // rolled back
	expect(store.pendingCount).toBe(0);
});

test('observer applies a remote add (no pending, just inserts)', () => {
	const { store } = makeStore();
	const remote: QueueEntry = { id: 'other', mediaId: 'm2', singerId: 'sam', status: 'queued', rotationSeq: 0, addedAt: 1 };
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 1, ops: [{ op: 'add', entry: remote }] } });
	expect(store.entries.map((e) => e.id)).toEqual(['other']);
});

test('resync REBASE: authoritative truth + still-pending local ops re-applied on top', () => {
	const { store } = makeStore();
	// pending local add (not yet confirmed)
	const myId = store.addSong('m1');
	expect(store.pendingCount).toBe(1);

	// a resync arrives carrying someone else's entry but NOT my pending one
	store.onServerEvent({
		type: 'queue:sync',
		rev: 4,
		entries: [{ id: 'sam1', mediaId: 'm2', singerId: 'sam', status: 'queued', rotationSeq: 0, addedAt: 1 }]
	});

	// my optimistic entry must survive the resync (rebased on top)
	const ids = store.entries.map((e) => e.id);
	expect(ids).toContain('sam1');
	expect(ids).toContain(myId);
	expect(store.rev).toBe(4);
});

test('resendPending re-sends all in-flight commands (reconnect replay)', () => {
	const { store, sent } = makeStore();
	store.addSong('m1'); // 1 pending
	store.addSong('m2'); // 2 pending
	const sentBefore = sent.length;
	expect(store.pendingCount).toBe(2);
	store.resendPending();
	expect(sent.length).toBe(sentBefore + 2); // both re-sent
	// re-sent commands carry the SAME clientOpIds (so the server dedupes them)
	const ids = sent.slice(sentBefore).map((c) => c.clientOpId);
	const originalIds = sent.slice(0, sentBefore).map((c) => c.clientOpId);
	expect(new Set(ids)).toEqual(new Set(originalIds));
});

test('subscribe fires on mutation', () => {
	const { store } = makeStore();
	const seen: number[] = [];
	store.subscribe((entries) => seen.push(entries.length));
	store.addSong('m1');
	expect(seen).toEqual([0, 1]); // initial emit, then after add
});
