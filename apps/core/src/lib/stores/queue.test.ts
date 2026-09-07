// done-when: add renders pre-broadcast, reconciles with zero reorder; reject rolls back.
import { test, expect } from 'bun:test';
import { QueueStore } from './queue';
import type { ClientCommand, QueueEntry } from '@encore/shared';

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

// Regression for issue #101: a rejected MOVE must roll back to the pre-drag order, not a third
// half-applied order, and must not leave rotationSeq non-contiguous or re-apply on the next op.
// RED on base: base rolled back via applyOp(inverse) which only touches rotationSeq while the
// forward move (applyAndReseq -> reorderWithinSinger) had permuted addedAt, so the addedAt
// permutation survived and re-derived the rejected order.
test('reject rolls back an optimistic MOVE to the exact pre-move state (#101)', () => {
	// Seed three of my own songs through the real store, each CONFIRMED by the server so the queue
	// is settled (matches the issue's quiet-party repro: a rejected move is then the only pending op).
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

	// Drag m3 to the front. move mints one id (the clientOpId) — id6 after 6 prior mints.
	const m3 = before.find((e) => e.mediaId === 'm3')!;
	store.moveEntry(m3.id, 0); // mints id6 as the move's clientOpId
	expect(store.entries.map((e) => e.mediaId)).toEqual(['m3', 'm1', 'm2']); // optimistic reorder
	expect(store.pendingCount).toBe(1); // just the move

	// Server rejects the move (e.g. the entry just started playing server-side).
	store.onServerEvent({ type: 'op:reject', clientOpId: 'id6', reason: 'unknown entry' });

	// 1. Order is exactly the pre-move order — not the requested one, not a third order.
	expect(store.entries).toEqual(before);
	// 2. rotationSeq is contiguous 0..n-1 with no duplicate (the assignSeqs invariant holds).
	expect(store.entries.map((e) => e.rotationSeq)).toEqual([0, 1, 2]);
	expect(store.pendingCount).toBe(0); // the rejected move is cleared

	// 3. The rejected move does NOT silently re-apply on the singer's next action.
	store.addSong('m4');
	expect(store.entries.map((e) => e.mediaId)).toEqual(['m1', 'm2', 'm3', 'm4']);
});

// Guards the rollback rebase: rejecting an EARLIER pending op must keep a LATER still-pending op
// applied, and must not double-apply the earlier ops already baked into the rejected op's snapshot.
test('reject of an earlier pending op preserves a later still-pending op (#101)', () => {
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

// Regression for the pr-bot #168 finding: a rejected op must roll back to CURRENT server truth,
// not to a stale issue-time snapshot. A second phone's add lands as a normal queue:patch between
// our pending move and its reject; the reject must keep that add, not discard it.
// RED on the frozen-snapshot draft (rolled back to m1,m2,m3, dropping sam-song); GREEN once the
// rebase loops refresh each pending op's snapshot to the rebased pre-op state.
test('reject rolls back to CURRENT truth, preserving a server patch that arrived meanwhile (#168)', () => {
	const { store } = makeStore();
	// Seed + confirm three of my songs so the queue is settled.
	store.addSong('m1'); // id0/id1
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 1, ops: [], causedBy: 'id1' } });
	store.addSong('m2'); // id2/id3
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 2, ops: [], causedBy: 'id3' } });
	store.addSong('m3'); // id4/id5
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 3, ops: [], causedBy: 'id5' } });
	const m3 = store.entries.find((e) => e.mediaId === 'm3')!;

	// I drag m3 to the front (still pending — clientOpId id6).
	store.moveEntry(m3.id, 0);
	expect(store.entries.map((e) => e.mediaId)).toEqual(['m3', 'm1', 'm2']);
	expect(store.pendingCount).toBe(1);

	// Another phone adds a song; server broadcasts it as an authoritative patch. My pending move is
	// rebased on top, so the optimistic view now shows both the new row AND my move.
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

	// Now my move is rejected. The rollback must land on the WITH-PATCH world minus my move —
	// sam's song MUST survive, not be discarded by a stale pre-patch snapshot.
	store.onServerEvent({ type: 'op:reject', clientOpId: 'id6', reason: 'unknown entry' });
	expect(store.entries.map((e) => e.mediaId)).toContain('sm'); // #168: server add preserved
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

test('optimistic add for a 2nd singer lands at its FAIR round-robin slot, not the bottom (Finding #2)', () => {
	const { store } = makeStore(); // singerId 'me'
	// seed someone else's two queued songs via a server patch (authoritative entries inline)
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
	// I add my first pick — round-robin must interleave it to slot 1 immediately (no jump-to-bottom)
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

// Issue #115: #onPatch must not rewind #rev below what a higher-rev event already set. #rev is what
// the WS gap detector reads (getLastRev at client.ts:161); if a lower-rev queue:patch rewinds it, the
// next legitimate patch is measured against a stale expected and discarded, forcing a full resync to
// every phone — the exact storm #noteRev's advance-only rule was written to stop, reintroduced here.
test('a lower-rev queue:patch does NOT rewind rev, and the next real patch still applies (issue #115)', () => {
	const { store } = makeStore();

	// server advances the shared counter to 10 via a playback:state (advance-only path).
	// (state payload is required by the type but ignored by #noteRev, which reads only rev.)
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

	// an out-of-order queue:patch carrying a LOWER rev arrives (reachable once #114's duplicate
	// socket breaks single-socket ordering). It must NOT rewind the counter.
	store.onServerEvent({ type: 'queue:patch', patch: { rev: 4, ops: [] } });
	expect(store.rev).toBe(10); // guarded: NOT 4

	// the next legitimate patch (rev 11) is exactly one past the counter, so getLastRev()+1 === 11
	// matches and it is adopted rather than looking gapped against a rewound 5.
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

// Issue #638: the host global-reorder store methods. pinEntry emits a `move-global` op (a GLOBAL
// index, crossing singers) and applies it optimistically this frame; unpinEntry emits `unpin`.
// Reverting the store methods reds these.
test('pinEntry emits move-global and pins the entry to the global slot this frame', () => {
	const { store, sent } = makeStore();
	// seed two entries from DIFFERENT singers via server sync (so we are not adding our own)
	store.onServerEvent({
		type: 'queue:sync',
		rev: 1,
		entries: [
			{ id: 'a1', mediaId: 'ma', singerId: 'alice', status: 'queued', rotationSeq: 0, addedAt: 1 },
			{ id: 'b1', mediaId: 'mb', singerId: 'bob', status: 'queued', rotationSeq: 1, addedAt: 2 }
		]
	});
	// pin b1 (bob's) to the front — a cross-singer host move
	store.pinEntry('b1', 0);
	const last = sent.at(-1)!;
	expect(last.op.op).toBe('move-global');
	expect(last.op).toMatchObject({ op: 'move-global', id: 'b1', toSeq: 0 });
	expect(store.entries[0]!.id).toBe('b1'); // pinned to the front optimistically this frame
});

test('unpinEntry emits an unpin op', () => {
	const { store, sent } = makeStore();
	store.onServerEvent({
		type: 'queue:sync',
		rev: 1,
		entries: [{ id: 'a1', mediaId: 'ma', singerId: 'alice', status: 'queued', rotationSeq: 0, addedAt: 1 }]
	});
	store.unpinEntry('a1');
	expect(sent.at(-1)!.op.op).toBe('unpin');
});
