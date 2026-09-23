import { ClientCommand, Ordering, QueueEntry } from '$lib/contract';
import { QueueStore } from '$lib/stores/queue';
import { expect, test } from 'bun:test';
// done-when: add renders pre-broadcast, reconciles with zero reorder; reject rolls back.

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

	// The patch echoes our clientOpId; the sync carries the authoritative entry at seq 0.
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

// A rejected MOVE rolls back to the pre-drag order, never a third half-applied one, and must leave rotationSeq
// contiguous and not re-apply on the next op. Rolling back via an inverse op only touches rotationSeq, while the
// forward move permuted addedAt — so the permutation survives and re-derives the rejected order.
test('reject rolls back an optimistic MOVE to the exact pre-move state', () => {
	// Three of my own songs, each CONFIRMED, so the rejected move is the only pending op.
	const { store } = makeStore();
	store.addSong('m1'); // id0 entry, id1 opId
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 1, ops: [], causedBy: 'id1' } });
	store.addSong('m2'); // id2 entry, id3 opId
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 2, ops: [], causedBy: 'id3' } });
	store.addSong('m3'); // id4 entry, id5 opId
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 3, ops: [], causedBy: 'id5' } });
	expect(store.pendingCount).toBe(0); // settled
	const before = store.entries; // canonical pre-move snapshot (order + rotationSeq + addedAt)
	expect(before.map((e) => e.mediaId)).toEqual(['m1', 'm2', 'm3']);

	// move mints one id (the clientOpId) — id6 after 6 prior mints.
	const m3 = before.find((e) => e.mediaId === 'm3')!;
	store.moveEntry(m3.id, 0); // mints id6 as the move's clientOpId
	expect(store.entries.map((e) => e.mediaId)).toEqual(['m3', 'm1', 'm2']); // optimistic reorder
	expect(store.pendingCount).toBe(1); // just the move

	store.onServerEvent({ type: 'op:reject', clientOpId: 'id6', reason: 'unknown entry' });

	expect(store.entries).toEqual(before);
	// rotationSeq stays contiguous 0..n-1 with no duplicate (the assignSeqs invariant).
	expect(store.entries.map((e) => e.rotationSeq)).toEqual([0, 1, 2]);
	expect(store.pendingCount).toBe(0); // the rejected move is cleared

	// The rejected move must not silently re-apply on the singer's next action.
	store.addSong('m4');
	expect(store.entries.map((e) => e.mediaId)).toEqual(['m1', 'm2', 'm3', 'm4']);
});

// Guards the rollback rebase: rejecting an EARLIER pending op must keep a LATER still-pending op
// applied, and must not double-apply the earlier ops already baked into the rejected op's snapshot.
test('reject of an earlier pending op preserves a later still-pending op', () => {
	const { store } = makeStore();
	store.addSong('m1'); // id0 entry, id1 opId (pending A)
	store.removeEntry('id0'); // id2 opId (pending B) — remove the row A added; both still pending
	expect(store.pendingCount).toBe(2);
	expect(store.entries).toHaveLength(0); // A added it, B removed it

	// Server rejects the ADD (A). B (remove of a now-absent id) must still hold: the row stays gone.
	store.onServerEvent({ type: 'op:reject', clientOpId: 'id1', reason: 'unknown media' });
	expect(store.entries).toHaveLength(0); // A rolled back; B (remove) re-applied on top, still empty
	expect(store.pendingCount).toBe(1); // only B remains pending
});

// A rejected op rolls back to CURRENT server truth, never to a frozen snapshot: a second phone's add
// lands as a normal queue:patch between our pending move and its reject, and the reject must keep it.
test('reject rolls back to CURRENT truth, preserving a server patch that arrived meanwhile', () => {
	const { store } = makeStore();
	store.addSong('m1'); // id0/id1
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 1, ops: [], causedBy: 'id1' } });
	store.addSong('m2'); // id2/id3
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 2, ops: [], causedBy: 'id3' } });
	store.addSong('m3'); // id4/id5
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 3, ops: [], causedBy: 'id5' } });
	const m3 = store.entries.find((e) => e.mediaId === 'm3')!;

	store.moveEntry(m3.id, 0);
	expect(store.entries.map((e) => e.mediaId)).toEqual(['m3', 'm1', 'm2']);
	expect(store.pendingCount).toBe(1);

	// Another phone's add arrives as an authoritative patch; my pending move is rebased on top.
	store.onServerEvent({
		type: 'queue:patch',
		patch: {
			rev: 4,
			ops: [],
			entries: [
				{ id: 'a1', mediaId: 'm1', singerId: 'me', status: 'queued', rotationSeq: 0, addedAt: 1 },
				{ id: 'a2', mediaId: 'm2', singerId: 'me', status: 'queued', rotationSeq: 1, addedAt: 2 },
				{ id: m3.id, mediaId: 'm3', singerId: 'me', status: 'queued', rotationSeq: 2, addedAt: 3 },
				{ id: 'sam', mediaId: 'sm', singerId: 'sam', status: 'queued', rotationSeq: 3, addedAt: 4 }
			]
		}
	});
	const withPatch = store.entries.map((e) => e.mediaId);
	expect(withPatch).toContain('sm'); // the other phone's add is present
	expect(store.pendingCount).toBe(1); // my move still pending on top

	// The rollback lands on the WITH-PATCH world minus my move: sam's song must survive.
	store.onServerEvent({ type: 'op:reject', clientOpId: 'id6', reason: 'unknown entry' });
	expect(store.entries.map((e) => e.mediaId)).toContain('sm'); // server add preserved
	expect(store.pendingCount).toBe(0);
});

// #onSync must refresh each pending op's rollback target to CURRENT truth exactly as #onPatch does —
// they share #rebasePending. This is the RECONNECT path: resendPending fires on every queue:sync, so a
// reject after a resync rolls back through here and a stale target silently drops what the resync brought.
test('reject after a queue:sync rolls back to the post-sync truth, not a stale one (F1)', () => {
	const { store } = makeStore();
	const mine = store.addSong('mine'); // id0 entry / id1 opId (pending)
	store.onServerEvent({
		type: 'queue:sync',
		rev: 1,
		entries: [{ id: 'o1', mediaId: 'm1', singerId: 'sam', status: 'queued', rotationSeq: 0, addedAt: 1 }]
	});
	expect(store.entries.map((e) => e.id)).toContain(mine); // my add rebased on top
	expect(store.entries.map((e) => e.id)).toContain('o1');

	// A SECOND resync moves truth forward: o2 arrived while my add was in flight.
	store.onServerEvent({
		type: 'queue:sync',
		rev: 2,
		entries: [
			{ id: 'o1', mediaId: 'm1', singerId: 'sam', status: 'queued', rotationSeq: 0, addedAt: 1 },
			{ id: 'o2', mediaId: 'm2', singerId: 'sam', status: 'queued', rotationSeq: 1, addedAt: 2 }
		]
	});
	expect(store.entries.map((e) => e.id)).toContain('o2'); // the new server entry is present
	expect(store.pendingCount).toBe(1); // my add still pending

	// The rollback lands on the post-sync world minus my add: o2 must survive.
	store.onServerEvent({ type: 'op:reject', clientOpId: 'id1', reason: 'unknown media' });
	expect(store.entries.map((e) => e.id)).toEqual(['o1', 'o2']); // F1: post-sync truth preserved
	expect(store.pendingCount).toBe(0);
});

// #onReject's `p.seq <= pending.seq` filter skips ops already baked into the rejected op's snapshot, and
// is only reached by rejecting the LATER op first. Without it, A's snapshot is refreshed from a base that
// already contains A's own effect, so A's rollback target stops being pre-op and A survives its own reject.
test('reject the LATER pending op then the EARLIER one — both roll back cleanly (F2)', () => {
	const { store } = makeStore();
	store.onServerEvent({
		type: 'queue:sync',
		rev: 1,
		entries: [{ id: 'o1', mediaId: 'm0', singerId: 'sam', status: 'queued', rotationSeq: 0, addedAt: 1 }]
	});
	const a = store.addSong('mA'); // pending A (seq 0)
	const b = store.addSong('mB'); // pending B (seq 1)
	expect(store.pendingCount).toBe(2);
	expect(store.entries.map((e) => e.id)).toContain(a);
	expect(store.entries.map((e) => e.id)).toContain(b);

	store.onServerEvent({ type: 'op:reject', clientOpId: 'id3', reason: 'unknown media' });
	expect(store.entries.map((e) => e.id)).toContain(a);
	expect(store.entries.map((e) => e.id)).not.toContain(b);
	expect(store.pendingCount).toBe(1);

	// A's rollback target is its own pre-op snapshot ([o1]), so with B gone the world returns to [o1].
	store.onServerEvent({ type: 'op:reject', clientOpId: 'id1', reason: 'unknown media' });
	expect(store.entries.map((e) => e.id)).toEqual(['o1']); // F2: A gone, no half-applied third state
	expect(store.pendingCount).toBe(0);
});

test('observer applies a remote add (no pending, just inserts)', () => {
	const { store } = makeStore();
	const remote: QueueEntry = {
		id: 'other',
		mediaId: 'm2',
		singerId: 'sam',
		status: 'queued',
		rotationSeq: 0,
		addedAt: 1
	};
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 1, ops: [{ op: 'add', entry: remote }] } });
	expect(store.entries.map((e) => e.id)).toEqual(['other']);
});

test('resync REBASE: authoritative truth + still-pending local ops re-applied on top', () => {
	const { store } = makeStore();
	const myId = store.addSong('m1');
	expect(store.pendingCount).toBe(1);

	store.onServerEvent({
		type: 'queue:sync',
		rev: 4,
		entries: [{ id: 'sam1', mediaId: 'm2', singerId: 'sam', status: 'queued', rotationSeq: 0, addedAt: 1 }]
	});

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
	// Re-sent commands carry the SAME clientOpIds, so the server dedupes them.
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

test('optimistic add for a 2nd singer lands at its FAIR round-robin slot, not the bottom (Finding #2)', () => {
	const { store } = makeStore(); // singerId 'me'
	store.onServerEvent({
		type: 'queue:patch',
		patch: {
			rev: 2,
			ops: [],
			entries: [
				{ id: 'maya1', mediaId: 'm1', singerId: 'maya', status: 'queued', rotationSeq: 0, addedAt: 1 },
				{ id: 'maya2', mediaId: 'm2', singerId: 'maya', status: 'queued', rotationSeq: 1, addedAt: 2 }
			]
		}
	});
	// Round-robin must interleave my first pick to slot 1 immediately, not append it.
	const myId = store.addSong('m3');
	const order = store.entries.map((e) => e.id);
	expect(order).toEqual(['maya1', myId, 'maya2']); // fair interleave, predicted client-side
});

test('queue:patch with authoritative entries snaps to server order (no flicker), pruning terminal', () => {
	const { store } = makeStore();
	store.onServerEvent({
		type: 'queue:patch',
		patch: {
			rev: 5,
			ops: [],
			entries: [
				{ id: 'x', mediaId: 'm1', singerId: 'a', status: 'queued', rotationSeq: 0, addedAt: 1 },
				{ id: 'y', mediaId: 'm2', singerId: 'b', status: 'queued', rotationSeq: 1, addedAt: 2 }
			]
		}
	});
	expect(store.entries.map((e) => e.id)).toEqual(['x', 'y']);
	expect(store.rev).toBe(5);
});

// #onPatch must not rewind #rev below what a higher-rev event already set. #rev is what the WS gap
// detector reads, so a rewind makes the next legitimate patch look gapped and forces a full resync to
// every phone — the storm #noteRev's advance-only rule exists to stop.
test('a lower-rev queue:patch does NOT rewind rev, and the next real patch still applies', () => {
	const { store } = makeStore();

	// The state payload is required by the type but ignored by #noteRev, which reads only rev.
	const pb = {
		currentEntryId: null,
		positionSec: 0,
		isPlaying: false,
		keyShift: 0,
		background: null,
		guideLevel: null
	};
	store.onServerEvent({ type: 'playback:state', state: pb, rev: 10 });
	expect(store.rev).toBe(10);

	// A LOWER-rev patch, reachable once a duplicate socket breaks single-socket ordering.
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 4, ops: [] } });
	expect(store.rev).toBe(10); // guarded: NOT 4

	// rev 11 is exactly one past the counter, so it is adopted rather than looking gapped against a 5.
	store.onServerEvent({
		type: 'queue:patch',
		patch: {
			rev: 11,
			ops: [],
			entries: [{ id: 'z', mediaId: 'm9', singerId: 'a', status: 'queued', rotationSeq: 0, addedAt: 1 }]
		}
	});
	expect(store.rev).toBe(11);
	expect(store.entries.map((e) => e.id)).toEqual(['z']);
});

// moveToIndex emits a `move-to-index` op (a GLOBAL queued index, crossing singers) and applies it
// optimistically through the same applyAndReseq reducer the server runs.
test('moveToIndex emits move-to-index and pulls the entry to the global index this frame', () => {
	const { store, sent } = makeStore();
	store.onServerEvent({
		type: 'queue:sync',
		rev: 1,
		entries: [
			{ id: 'a1', mediaId: 'ma', singerId: 'alice', status: 'queued', rotationSeq: 0, addedAt: 1 },
			{ id: 'b1', mediaId: 'mb', singerId: 'bob', status: 'queued', rotationSeq: 1, addedAt: 2 }
		]
	});
	// A cross-singer reorder, which `move` cannot express.
	store.moveToIndex('b1', 0);
	const last = sent.at(-1)!;
	expect(last.op.op).toBe('move-to-index');
	expect(last.op).toMatchObject({ op: 'move-to-index', id: 'b1', toIdx: 0 });
	expect(store.entries[0]!.id).toBe('b1'); // landed at the front optimistically this frame
	expect(store.pendingKindById.get('b1')).toBe('move'); // shown as a pending reorder, not an add
});

// The optimistic reducer must predict with the ROOM's algorithm, not with fair rotation: a prediction
// under the wrong algorithm renders the row in the wrong place and snaps when the patch arrives, which
// is the flicker `applyAndReseq` is shared between phone and server to prevent.

function makeStore_QueueOrdering(ordering?: () => Ordering) {
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
	const { store } = makeStore_QueueOrdering(() => ({ order: 'fair' }));
	store.onServerEvent({ type: 'queue:sync', rev: 1, entries: theirs() });
	const mine = store.addSong('m1');
	expect(store.entries.map((e) => e.id)).toEqual(['them1', mine, 'them2']);
});

test('first come, first served: the same add lands at the BACK', () => {
	const { store } = makeStore_QueueOrdering(() => ({ order: 'fcfs' }));
	store.onServerEvent({ type: 'queue:sync', rev: 1, entries: theirs() });
	const mine = store.addSong('m1');
	expect(store.entries.map((e) => e.id)).toEqual(['them1', 'them2', mine]);
});

test('no ordering supplied = fair rotation, the pre-setting behaviour', () => {
	const { store } = makeStore_QueueOrdering();
	store.onServerEvent({ type: 'queue:sync', rev: 1, entries: theirs() });
	const mine = store.addSong('m1');
	expect(store.entries.map((e) => e.id)).toEqual(['them1', mine, 'them2']);
});

test('the ordering is read AT APPLY TIME, so a mid-party change takes effect on the next tap', () => {
	// A getter, not a snapshot: the room can switch algorithm while the phone is open.
	let order: Ordering['order'] = 'fair';
	const { store } = makeStore_QueueOrdering(() => ({ order }));
	store.onServerEvent({ type: 'queue:sync', rev: 1, entries: theirs() });
	const first = store.addSong('m1');
	expect(store.entries.map((e) => e.id)).toEqual(['them1', first, 'them2']);

	order = 'fcfs';
	store.onServerEvent({ type: 'queue:sync', rev: 2, entries: theirs() });
	const second = store.addSong('m2');
	// The still-pending first add is re-applied by the resync under the NEW ordering; fair would have interleaved them.
	expect(store.entries.map((e) => e.id)).toEqual(['them1', 'them2', first, second]);
});

test('a rebase after resync re-applies pending ops under the room ordering, not fair', () => {
	// The resync path has its OWN applyAndReseq call, so an ordering passed to the optimistic path but
	// forgotten here makes a reconnect quietly reorder the queue.
	const { store } = makeStore_QueueOrdering(() => ({ order: 'fcfs' }));
	const mine = store.addSong('m1'); // pending, not yet confirmed
	store.onServerEvent({ type: 'queue:sync', rev: 5, entries: theirs() });
	expect(store.entries.map((e) => e.id)).toEqual(['them1', 'them2', mine]);
});

test('least-recently-sung: the sing history from the roster changes where my add lands', () => {
	// `them` sang recently and I have not, so my pick leads the round. Fair gives ['them1', mine, 'them2'].
	const { store } = makeStore_QueueOrdering(() => ({
		order: 'least-recently-sung',
		lastSungAt: new Map([['them', 900]])
	}));
	store.onServerEvent({ type: 'queue:sync', rev: 1, entries: theirs() });
	const mine = store.addSong('m1');
	expect(store.entries.map((e) => e.id)).toEqual([mine, 'them1', 'them2']);
});
