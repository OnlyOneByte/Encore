// A queue `add` whose entry id is already held by a DIFFERENT entry must be rejected at the seam,
// not applied and broadcast. On base the arm validated id-present / singerId / mediaId but never
// asked whether the id was FREE, and `applyOp`'s add branch updates-in-place on an id match — so one
// hand-crafted frame from a joined phone carrying another live entry's id:
//   (a) destroyed that singer's turn: the record is rewritten WHOLE (singerId/mediaId/addedAt), so a
//       guest waiting for their song silently loses it, and persist() rewrites the table so it is
//       gone from disk too; and
//   (b) bypassed the cook-cancel seam: the hub fires onEntryRemoved only on a literal `remove`, so
//       the displaced media lost its last queue claim with NO onEntryRemoved — cancelJobsForMedia
//       never ran and a worker kept cooking a song nobody is queued on.
// The fix rejects an id already taken by a different IDENTITY (singerId or mediaId differ). The
// identical-identity re-add is deliberately still allowed (applyOp's in-place arm exists for the
// originator's own optimistic row, and an evicted clientOpId — seenOps is a bounded FIFO — can
// legitimately re-deliver an identical add).
//
// Load-bearing evidence is the END-TO-END property driven through the real validateCommand +
// handleQueueCommand + AuthoritativeState, with onEntryRemoved/onEntryAdded recorders wired the way
// server.ts wires them. This mirrors queue-add-shape.test.ts (#188), the sibling guard in this arm.
import { test, expect } from 'bun:test';
import { validateCommand, handleQueueCommand, type HubDeps } from './hub';
import { AuthoritativeState } from '../state/store';
import type { Media, QueueEntry, ClientCommand, ServerEvent } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';

const media = (id: string): Media => ({
	id, source: 'youtube', sourceRef: 'x', title: id, durationSec: 100,
	stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: `derived/stems/${id}-instrumental.flac`, songProfile: EMPTY_SONG_PROFILE
});

const entry = (id: string, singerId: string, mediaId: string): QueueEntry =>
	({ id, mediaId, singerId, status: 'queued', rotationSeq: 0, addedAt: 1 } as QueueEntry);

// Seed q1 = s1/m1, q2 = s2/m2 (the issue's harness). actorSingerId = s2 (the attacker/originator).
// onEntryRemoved/onEntryAdded are recorded exactly as the hub fires them.
function harness(actorSingerId = 's2') {
	const published: ServerEvent[] = [];
	const removedCalls: Array<[string, string[]]> = [];
	const addedCalls: Array<[string, string[]]> = [];
	const state = new AuthoritativeState();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 's1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 's2', 'm2') });
	const deps = {
		state,
		mediaById: new Map([['m1', media('m1')], ['m2', media('m2')]]),
		publish: (e: ServerEvent) => published.push(e),
		now: () => 0,
		actorSingerId,
		onEntryRemoved: (mediaId: string, remaining: QueueEntry[]) => removedCalls.push([mediaId, remaining.map((e) => e.id)]),
		onEntryAdded: (mediaId: string, entries: QueueEntry[]) => addedCalls.push([mediaId, entries.map((e) => e.id)])
	} as unknown as HubDeps;
	return { published, removedCalls, addedCalls, state, deps };
}

// s2 tries to overwrite q1 (s1's live turn) by minting an add that carries q1's id but s2's own
// singerId and a media s2 wants. singerId matches the session, so the :101 impersonation check passes.
const overwriteQ1 = (mediaId = 'm2'): ClientCommand => ({
	clientOpId: 'c1',
	baseRev: 0,
	op: { op: 'add', entry: { id: 'q1', mediaId, singerId: 's2', status: 'queued', rotationSeq: -1, addedAt: 1 } as QueueEntry }
});

test('validateCommand rejects an add whose id is held by a different singer (turn theft)', () => {
	const { deps } = harness();
	expect(validateCommand(overwriteQ1(), deps)).toBe('entry id already taken: q1');
});

test('validateCommand rejects a same-singer re-point to a different mediaId (orphans the old cook)', () => {
	// Consequence (c): same entry id, same singerId as the existing row, but a DIFFERENT mediaId.
	// This steals nothing but orphans m1's cook — which is why the guard must compare the WHOLE
	// identity, not singerId alone. Actor is s1 here (the owner of q1) so the singerId matches.
	const { deps } = harness('s1');
	const selfRepoint: ClientCommand = {
		clientOpId: 'c2', baseRev: 0,
		op: { op: 'add', entry: { id: 'q1', mediaId: 'm2', singerId: 's1', status: 'queued', rotationSeq: -1, addedAt: 1 } as QueueEntry }
	};
	expect(validateCommand(selfRepoint, deps)).toBe('entry id already taken: q1');
});

test('the identical-identity re-add is still allowed (originator optimistic row / seenOps eviction)', () => {
	// Same id, same singerId AND same mediaId as the existing row — a legitimate re-apply. applyOp's
	// in-place arm exists for exactly this, so the guard must let it through.
	const { deps } = harness('s1');
	const identicalReadd: ClientCommand = {
		clientOpId: 'c3', baseRev: 0,
		op: { op: 'add', entry: { id: 'q1', mediaId: 'm1', singerId: 's1', status: 'queued', rotationSeq: -1, addedAt: 1 } as QueueEntry }
	};
	expect(validateCommand(identicalReadd, deps)).toBeNull();
});

test('a first-time add of a genuinely free id still validates (guard is not over-broad)', () => {
	const { deps } = harness();
	const freshAdd: ClientCommand = {
		clientOpId: 'c4', baseRev: 0,
		op: { op: 'add', entry: { id: 'q3', mediaId: 'm2', singerId: 's2', status: 'queued', rotationSeq: -1, addedAt: 1 } as QueueEntry }
	};
	expect(validateCommand(freshAdd, deps)).toBeNull();
});

test('END-TO-END: the overwrite add is NOT applied, NOT broadcast, yields op:reject, and the displaced turn + its cook seam are untouched', () => {
	const { published, removedCalls, addedCalls, state, deps } = harness();
	const sent: unknown[] = [];
	const patch = handleQueueCommand(overwriteQ1(), deps, (e) => sent.push(e));

	// Rejected at the seam.
	expect(patch).toBeNull();
	expect(sent).toHaveLength(1);
	expect((sent[0] as { type: string }).type).toBe('op:reject');
	// Nothing broadcast — the poison never reached the write-behind flush.
	expect(published.some((e) => e.type === 'queue:patch')).toBe(false);

	// (a) s1's turn is intact: q1 is still s1/m1, and the queue is exactly the two seeded entries.
	const q1 = state.entries.find((e) => e.id === 'q1');
	expect(q1).toBeDefined();
	expect(q1!.singerId).toBe('s1');
	expect(q1!.mediaId).toBe('m1');
	expect(state.entries.map((e) => e.id).sort()).toEqual(['q1', 'q2']);

	// (b) m1 still has a queue claim, so its cook is never orphaned — and because nothing was applied,
	// neither seam hook fired for this rejected frame.
	expect(state.entries.some((e) => e.mediaId === 'm1')).toBe(true);
	expect(removedCalls).toHaveLength(0);
	expect(addedCalls).toHaveLength(0);
});

test('CONTROL: a legitimate remove of q1 still fires onEntryRemoved (the cook-cancel seam works — the add path simply was not on it)', () => {
	// Proves the seam the overwrite bypasses is real and reachable, so the defect was the add arm
	// silently deleting q1 off that seam, not the seam being broken.
	const { removedCalls, deps } = harness('s1');
	const remove: ClientCommand = { clientOpId: 'c5', baseRev: 0, op: { op: 'remove', id: 'q1' } };
	const patch = handleQueueCommand(remove, deps);
	expect(patch).not.toBeNull();
	expect(removedCalls).toHaveLength(1);
	expect(removedCalls[0][0]).toBe('m1'); // m1 lost its claim -> cancelJobsForMedia would run
});
