// A queue `add` whose entry id is already held by a DIFFERENT entry must be rejected at the seam. Validating
// id-present/singerId/mediaId without asking whether the id is FREE lets one hand-crafted frame through `applyOp`'s
// in-place add branch, which rewrites the victim's record WHOLE (the guest silently loses their turn, and persist()
// takes it off disk) and bypasses the process-cancel seam, since the hub fires onEntryRemoved only on a literal
// `remove` — so a worker keeps processing a song nobody is queued on.
//
// An identical-identity re-add is deliberately STILL allowed: applyOp's in-place arm exists for the originator's own
// optimistic row, and an evicted clientOpId (seenOps is a bounded FIFO) can legitimately re-deliver one. Driven
// end-to-end through the real validateCommand + handleQueueCommand + AuthoritativeState.
import { test, expect } from 'bun:test';
import { validateCommand, handleQueueCommand, type HubDeps } from '$lib/server/realtime/hub';
import { AuthoritativeState } from '$lib/server/state/store';
import type { Media, QueueEntry, ClientCommand, ServerEvent } from '$lib/contract';
import { EMPTY_SONG_PROFILE } from '$lib/contract';

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

const entry = (id: string, singerId: string, mediaId: string): QueueEntry =>
	({ id, mediaId, singerId, status: 'queued', rotationSeq: 0, addedAt: 1 }) as QueueEntry;

// q1 = s1/m1, q2 = s2/m2; actorSingerId is s2. The seam hooks are recorded as the hub fires them.
function harness(actorSingerId = 's2') {
	const published: ServerEvent[] = [];
	const removedCalls: Array<[string, string[]]> = [];
	const addedCalls: Array<[string, string[]]> = [];
	const state = new AuthoritativeState();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 's1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 's2', 'm2') });
	const deps = {
		state,
		mediaById: new Map([
			['m1', media('m1')],
			['m2', media('m2')]
		]),
		publish: (e: ServerEvent) => published.push(e),
		now: () => 0,
		actorSingerId,
		onEntryRemoved: (mediaId: string, remaining: QueueEntry[]) =>
			removedCalls.push([mediaId, remaining.map((e) => e.id)]),
		onEntryAdded: (mediaId: string, entries: QueueEntry[]) => addedCalls.push([mediaId, entries.map((e) => e.id)])
	} as unknown as HubDeps;
	return { published, removedCalls, addedCalls, state, deps };
}

// s2 mints an add carrying q1's id but s2's own singerId, so the impersonation check passes.
const overwriteQ1 = (mediaId = 'm2'): ClientCommand => ({
	clientOpId: 'c1',
	op: {
		op: 'add',
		entry: { id: 'q1', mediaId, singerId: 's2', status: 'queued', rotationSeq: -1, addedAt: 1 } as QueueEntry
	}
});

test('validateCommand rejects an add whose id is held by a different singer (turn theft)', () => {
	const { deps } = harness();
	expect(validateCommand(overwriteQ1(), deps)).toBe('entry id already taken: q1');
});

test('validateCommand rejects a same-singer re-point to a different mediaId (orphans the old process)', () => {
	// Same id and singerId, DIFFERENT mediaId: steals nothing but orphans m1's process, which is why the
	// guard compares the WHOLE identity rather than singerId alone.
	const { deps } = harness('s1');
	const selfRepoint: ClientCommand = {
		clientOpId: 'c2',
		op: {
			op: 'add',
			entry: { id: 'q1', mediaId: 'm2', singerId: 's1', status: 'queued', rotationSeq: -1, addedAt: 1 } as QueueEntry
		}
	};
	expect(validateCommand(selfRepoint, deps)).toBe('entry id already taken: q1');
});

test('the identical-identity re-add is still allowed (originator optimistic row / seenOps eviction)', () => {
	// A legitimate re-apply, which applyOp's in-place arm exists for.
	const { deps } = harness('s1');
	const identicalReadd: ClientCommand = {
		clientOpId: 'c3',
		op: {
			op: 'add',
			entry: { id: 'q1', mediaId: 'm1', singerId: 's1', status: 'queued', rotationSeq: -1, addedAt: 1 } as QueueEntry
		}
	};
	expect(validateCommand(identicalReadd, deps)).toBeNull();
});

test('a first-time add of a genuinely free id still validates (guard is not over-broad)', () => {
	const { deps } = harness();
	const freshAdd: ClientCommand = {
		clientOpId: 'c4',
		op: {
			op: 'add',
			entry: { id: 'q3', mediaId: 'm2', singerId: 's2', status: 'queued', rotationSeq: -1, addedAt: 1 } as QueueEntry
		}
	};
	expect(validateCommand(freshAdd, deps)).toBeNull();
});

test('END-TO-END: the overwrite add is NOT applied, NOT broadcast, yields op:reject, and the displaced turn + its process seam are untouched', () => {
	const { published, removedCalls, addedCalls, state, deps } = harness();
	const sent: unknown[] = [];
	const patch = handleQueueCommand(overwriteQ1(), deps, (e) => sent.push(e));

	expect(patch).toBeNull();
	expect(sent).toHaveLength(1);
	expect((sent[0] as { type: string }).type).toBe('op:reject');
	// Nothing broadcast: the frame never reached the write-behind flush.
	expect(published.some((e) => e.type === 'queue:patch')).toBe(false);

	// s1's turn is intact and the queue is exactly the two seeded entries.
	const q1 = state.entries.find((e) => e.id === 'q1');
	expect(q1).toBeDefined();
	expect(q1!.singerId).toBe('s1');
	expect(q1!.mediaId).toBe('m1');
	expect(state.entries.map((e) => e.id).sort()).toEqual(['q1', 'q2']);

	// m1 still has a queue claim, so its process is never orphaned, and neither seam hook fired.
	expect(state.entries.some((e) => e.mediaId === 'm1')).toBe(true);
	expect(removedCalls).toHaveLength(0);
	expect(addedCalls).toHaveLength(0);
});

test('CONTROL: a legitimate remove of q1 still fires onEntryRemoved (the process-cancel seam works — the add path simply was not on it)', () => {
	// Non-vacuity: the seam an overwrite bypasses is real and reachable.
	const { removedCalls, deps } = harness('s1');
	const remove: ClientCommand = { clientOpId: 'c5', op: { op: 'remove', id: 'q1' } };
	const patch = handleQueueCommand(remove, deps);
	expect(patch).not.toBeNull();
	expect(removedCalls).toHaveLength(1);
	expect(removedCalls[0][0]).toBe('m1'); // m1 lost its claim -> cancelJobsForMedia would run
});

// The singerId half of hub.ts's identity compare is asserted ONLY here: every collision above also differs on mediaId,
// so the mediaId disjunct decides those. The case only singerId rejects is a SAME-MEDIA, DIFFERENT-SINGER collision on a
// still-'queued' entry — a second guest re-adding the victim's public mediaId under their own singerId, stealing the turn
// with not even an orphaned process to notice later. Deleting the disjunct reds exactly these two and nothing else.
test('validateCommand rejects a SAME-MEDIA, different-singer collision — only the singerId half can (turn theft)', () => {
	const { deps } = harness(); // actor s2, existing q1 = s1/m1 (queued)
	// q1's id, s2's own singerId (so impersonation passes) and the SAME media, so mediaId and status both
	// match and the singerId disjunct is the sole rejector.
	expect(validateCommand(overwriteQ1('m1'), deps)).toBe('entry id already taken: q1');
});

test('END-TO-END: the same-media steal is NOT applied/broadcast and s1 still holds the turn', () => {
	const { published, state, deps } = harness();
	const sent: unknown[] = [];
	const patch = handleQueueCommand(overwriteQ1('m1'), deps, (e) => sent.push(e));

	expect(patch).toBeNull();
	expect((sent[0] as { type: string }).type).toBe('op:reject');
	expect(published.some((e) => e.type === 'queue:patch')).toBe(false);

	// s1's turn survives and the queue is the two seeded entries.
	const q1 = state.entries.find((e) => e.id === 'q1');
	expect(q1!.singerId).toBe('s1');
	expect(state.entries.some((e) => e.singerId === 's1')).toBe(true);
	expect(state.entries.map((e) => e.id).sort()).toEqual(['q1', 'q2']);
});

// The identical-identity carve-out must ALSO compare status. Comparing only (singerId, mediaId) lets a joined phone
// re-add its OWN live song with a fresh clientOpId and status:'queued', and since applyOp rewrites the matched row WHOLE
// the server re-lands 'queued' on an entry it had moved to 'playing'. That downgraded entry falls inside
// removableOnLeave's status!=='playing' filter, so the singer's own Leave removes the song out from under the watching
// room. So an add may only re-land on a still-'queued' id.
import { removableOnLeave, doLeave } from '$lib/server/singers/leave';
import type { EncoreApp } from '$lib/server/app';

// s1 re-adds its OWN live song with a fresh clientOpId and a client-minted status:'queued'.
const readdLiveQ1: ClientCommand = {
	clientOpId: 'c6', // fresh — seenOps never fires
	op: {
		op: 'add',
		entry: { id: 'q1', mediaId: 'm1', singerId: 's1', status: 'queued', rotationSeq: -1, addedAt: 1 } as QueueEntry
	}
};

function playingHarness() {
	const h = harness('s1'); // actor is s1, the owner of q1
	h.state.applyQueueOp({ op: 'status', id: 'q1', status: 'playing' });
	h.state.setPlayback({ currentEntryId: 'q1', isPlaying: true, positionSec: 12 });
	const app = {
		state: h.state,
		publish: h.deps.publish,
		presence: { forget: (_id: string) => {} }
	} as unknown as EncoreApp;
	return { ...h, app };
}

test('an identical-identity re-add of the LIVE entry is rejected — does NOT downgrade it to queued', () => {
	const { deps, state } = playingHarness();
	expect(state.entries.find((e) => e.id === 'q1')!.status).toBe('playing');
	// The re-add of the live entry is refused at the seam.
	expect(validateCommand(readdLiveQ1, deps)).toBe('entry id already taken: q1');
});

test('END-TO-END: the live re-add is not applied/broadcast, stays playing, and Leave keeps it', () => {
	const { published, state, deps, app } = playingHarness();
	const sent: unknown[] = [];
	const patch = handleQueueCommand(readdLiveQ1, deps, (e) => sent.push(e));

	// Rejected at the seam, nothing broadcast.
	expect(patch).toBeNull();
	expect((sent[0] as { type: string }).type).toBe('op:reject');
	expect(published.some((e) => e.type === 'queue:patch')).toBe(false);

	// q1 is STILL playing: a downgrade would read 'queued' here.
	expect(state.entries.find((e) => e.id === 'q1')!.status).toBe('playing');

	// Still playing, so it is NOT in the doomed set and the owner's Leave keeps it.
	expect(removableOnLeave(app, 's1').map((e) => e.id)).toEqual([]);
	const result = doLeave(app, 's1');
	expect(result.removed).toEqual([]);
	expect(result.keptPlaying).toBe('q1');
	expect(state.entries.some((e) => e.id === 'q1')).toBe(true);
});

test('CONTROL: doLeave on an UNTOUCHED playing harness already keeps q1 — the re-add is what changed it on base', () => {
	// Control: with no re-add, Leave keeps the live song — so the frame, not the harness, is the cause.
	const { app } = playingHarness();
	expect(removableOnLeave(app, 's1').map((e) => e.id)).toEqual([]);
	const result = doLeave(app, 's1');
	expect(result.removed).toEqual([]);
	expect(result.keptPlaying).toBe('q1');
});
