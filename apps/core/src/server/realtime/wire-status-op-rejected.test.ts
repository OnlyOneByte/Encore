// Regression guard: a `status` op is SERVER-OWNED and must be rejected at the wire seam.
//
// The only two producers of `{op:'status'}` in the whole repo are the server itself — player.ts
// beginSinging ('playing') and advance ('done') — and BOTH call state.applyQueueOp DIRECTLY, never
// through handleQueueCommand. So the wire arm had no honest caller, yet it admitted the op after only
// checking the entry exists. One joined phone could then:
//   (a) forge a second 'playing' entry that is never playable, never terminal, not removable on leave,
//       and durable across restarts,
//   (b) write an off-enum status string into the NOT NULL enum column, and
//   (c) retire a song with a terminal status while its cook keeps running (only `remove` fires
//       onEntryRemoved).
// The load-bearing assertion is the seam property: the bad op is NOT applied, NOT broadcast, and yields
// op:reject — so none of (a)/(b)/(c) is reachable from the wire.
import { test, expect } from 'bun:test';
import { validateCommand, handleQueueCommand, type HubDeps } from './hub';
import { AuthoritativeState } from '../state/store';
import { removableOnLeave } from '../singers/leave';
import type { EncoreApp } from '../app';
import { ulid, type ServerEvent, type Media, type QueueEntry, type ClientCommand } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';

const media = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: `derived/stems/${id}-instrumental.flac`,
	songProfile: EMPTY_SONG_PROFILE
});

// A room with q1 genuinely playing (server-driven) and q2 a normal QUEUED entry belonging to bob.
// alice is the actor sending the forged frame — everyone-is-a-host is ratified, so this is not a
// privilege claim; the point is that a server-owned op is writable from the wire without validation.
function harness(opts: { onEntryRemoved?: HubDeps['onEntryRemoved'] } = {}) {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	// Seed the two entries via the SERVER's own paths, the way real playback does.
	state.applyQueueOp({
		op: 'add',
		entry: { id: 'q1', mediaId: 'm1', singerId: 'alice', status: 'queued', rotationSeq: -1, addedAt: 1 }
	});
	state.applyQueueOp({
		op: 'add',
		entry: { id: 'q2', mediaId: 'm2', singerId: 'bob', status: 'queued', rotationSeq: -1, addedAt: 2 }
	});
	state.applyQueueOp({ op: 'status', id: 'q1', status: 'playing' }); // server-driven, like player.beginSinging
	state.setPlayback({ currentEntryId: 'q1', isPlaying: true });
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map([
			['m1', media('m1')],
			['m2', media('m2')]
		]),
		actorSingerId: 'alice',
		onEntryRemoved: opts.onEntryRemoved
	};
	return { published, state, deps };
}

const statusCmd = (id: string, status: string): ClientCommand => ({
	clientOpId: ulid(),
	op: { op: 'status', id, status: status as QueueEntry['status'] }
});

test('validateCommand rejects every wire status op as server-owned — even a well-formed one on a real entry', () => {
	const { deps } = harness();
	// Well-formed EXCEPT that it is a status op at all: real entry id, valid enum value. On base this
	// returned null (accepted); the only guard was entry-existence.
	expect(validateCommand(statusCmd('q2', 'playing'), deps)).toBe('status is server-owned');
	expect(validateCommand(statusCmd('q2', 'done'), deps)).toBe('status is server-owned');
	expect(validateCommand(statusCmd('q2', 'skipped'), deps)).toBe('status is server-owned');
	// An off-enum string is rejected too — and by the SAME server-owned reason, not a shape error.
	expect(validateCommand(statusCmd('q2', 'banana'), deps)).toBe('status is server-owned');
});

test('(a) a forged second "playing" is NOT applied, NOT broadcast, yields op:reject — never reaches state or leave', () => {
	const { published, state, deps } = harness();
	const sent: ServerEvent[] = [];
	const before = state.rev;
	const patch = handleQueueCommand(statusCmd('q2', 'playing'), deps, (e) => sent.push(e));

	// Seam property: nothing applied, nothing broadcast, op rejected.
	expect(patch).toBeNull();
	expect(state.rev).toBe(before); // rev did not advance
	expect(published.some((e) => e.type === 'queue:patch')).toBe(false);
	expect(sent).toHaveLength(1);
	expect((sent[0] as { type: string }).type).toBe('op:reject');

	// The consequence that made (a) the sharpest: q2 stays QUEUED (one 'playing', not two) so bob's own
	// Leave can still evict it. On base this list would be [] because q2 had become 'playing'.
	const q2 = state.entries.find((e) => e.id === 'q2')!;
	expect(q2.status).toBe('queued');
	expect(state.entries.filter((e) => e.status === 'playing').map((e) => e.id)).toEqual(['q1']);
	const app = { state } as unknown as EncoreApp;
	expect(removableOnLeave(app, 'bob').map((e) => e.id)).toEqual(['q2']);
});

test('(b) an off-enum status never reaches the queue — no junk string can be persisted from the wire', () => {
	const { published, state, deps } = harness();
	const sent: ServerEvent[] = [];
	const patch = handleQueueCommand(statusCmd('q2', 'banana'), deps, (e) => sent.push(e));
	expect(patch).toBeNull();
	expect(state.entries.find((e) => e.id === 'q2')!.status).toBe('queued'); // NOT 'banana'
	expect(published.some((e) => e.type === 'queue:patch')).toBe(false);
	expect((sent[0] as { type: string }).type).toBe('op:reject');
});

test('(c) a terminal status op cannot retire a song from the wire — the queue is untouched and no removal fires', () => {
	const removed: string[] = [];
	const { published, state, deps } = harness({ onEntryRemoved: (mediaId) => removed.push(mediaId) });
	const sent: ServerEvent[] = [];
	const patch = handleQueueCommand(statusCmd('q2', 'done'), deps, (e) => sent.push(e));

	expect(patch).toBeNull();
	// q2 is still in the queue (a terminal status through applyAndReseq would have pruned it), and the
	// cook-cancel hook did not fire — matching that only `remove` reaches cancelJobsForMedia.
	expect(state.entries.map((e) => e.id).sort()).toEqual(['q1', 'q2']);
	expect(removed).toEqual([]);
	expect(published.some((e) => e.type === 'queue:patch')).toBe(false);
	expect((sent[0] as { type: string }).type).toBe('op:reject');
});

test('the fix is behaviour-preserving: remove/move/add on the same entry still work from the wire', () => {
	// Only the status arm changed. A joined actor can still remove q2 (the control the issue used), which
	// DOES fire onEntryRemoved — proving the rejection is scoped to `status`, not the whole handler.
	const removed: string[] = [];
	const { state, deps } = harness({ onEntryRemoved: (mediaId) => removed.push(mediaId) });
	const patch = handleQueueCommand({ clientOpId: ulid(), op: { op: 'remove', id: 'q2' } }, deps);
	expect(patch).not.toBeNull();
	expect(state.entries.map((e) => e.id)).toEqual(['q1']);
	expect(removed).toEqual(['m2']);
});
