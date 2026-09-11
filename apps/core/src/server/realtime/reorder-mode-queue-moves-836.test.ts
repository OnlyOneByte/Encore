// XR-PH-19 (issue #836; drag rewired to the whole queue in #912) — the reorder mode against the REAL
// server, not a fixture.
//
// The requirement names this mechanism explicitly: "a harness test drives real ops through
// `handleQueueCommand` to produce the invalidating states (the `AuthoritativeState` + `HubDeps` idiom
// used by `autostart.test.ts` is the working template)". The reason it is not a fixture test is that
// the invalidating states are produced by `assignSeqs` re-deriving every `rotationSeq` on every
// mutation — the behaviour under test IS the interaction between the ops and the ordering layer, so
// hand-writing the "after" state would pin my belief about it rather than the thing itself.
import { test, expect } from 'bun:test';
import { handleQueueCommand, type HubDeps } from './hub';
import { reconcileOnReady } from './player';
import { AuthoritativeState } from '../state/store';
import { type ServerEvent, type Media, type QueueEntry, type ClientCommand } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';
import { modeInvalidation, queueSlots, gripVisible } from '../../lib/reorder-mode';

const media = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: 'derived/stems/i-instrumental.flac',
	songProfile: EMPTY_SONG_PROFILE
});

let _s = 0;
const addCmd = (id: string, mediaId: string, singerId: string): ClientCommand => ({
	clientOpId: 'op-' + id,
	op: {
		op: 'add',
		entry: { id, mediaId, singerId, status: 'queued', rotationSeq: -1, addedAt: ++_s } as QueueEntry
	}
});
const removeCmd = (id: string): ClientCommand => ({ clientOpId: 'op-rm-' + id, op: { op: 'remove', id } });
const moveToIndexCmd = (id: string, toIdx: number): ClientCommand => ({
	clientOpId: 'op-mvi-' + id + '-' + toIdx,
	op: { op: 'move-to-index', id, toIdx }
});

function harness(actor = 's1') {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map([
			['m1', media('m1')],
			['m2', media('m2')],
			['m3', media('m3')]
		]),
		actorSingerId: actor
	};
	return { published, state, deps };
}

/** The whole queued list, in the order the phone renders it — the collection the mode now reads (#912). */
function queuedList(state: AuthoritativeState) {
	return state.entries
		.filter((e) => e.status === 'queued')
		.sort((a, b) => a.rotationSeq - b.rotationSeq);
}

test('XR-PH-19 · another guest queueing mid-drag re-orders the list, and the mode tracks the new length', () => {
	const { state, deps } = harness('s1');
	handleQueueCommand(addCmd('a', 'm1', 's1'), deps);
	handleQueueCommand(addCmd('b', 'm2', 's1'), deps);

	const before = queuedList(state).map((e) => e.id);
	expect(before).toHaveLength(2);
	expect(modeInvalidation(queuedList(state), 'a', 'queued')).toBeNull();
	expect(queueSlots(queuedList(state).length)).toHaveLength(2);

	// A DIFFERENT guest queues a song while my drag is open. This is the real op through the real hub,
	// so the re-derivation is the server's own.
	handleQueueCommand(addCmd('x', 'm3', 's2'), { ...deps, actorSingerId: 's2' });

	// The flat list genuinely changed underneath: a third entry is in it, and fair rotation interleaves
	// s2 between my two picks — so this is not a no-op dressed as a test.
	const flat = queuedList(state).map((e) => e.id);
	expect(flat).toHaveLength(3);
	expect(flat).toContain('x');
	expect(flat.indexOf('x')).toBeLessThan(flat.indexOf('b'));

	// …and the mode stays open, now spanning the WHOLE queue: the moving song 'a' is still queued and
	// three songs remain, so there is a third legal slot to drop into.
	expect(modeInvalidation(queuedList(state), 'a', 'queued')).toBeNull();
	expect(queueSlots(queuedList(state).length)).toHaveLength(3);
});

test('XR-PH-19 · the queue dropping below two songs closes the mode with a reason', () => {
	const { state, deps } = harness('s1');
	handleQueueCommand(addCmd('a', 'm1', 's1'), deps);
	handleQueueCommand(addCmd('b', 'm2', 's1'), deps);
	expect(modeInvalidation(queuedList(state), 'a', 'queued')).toBeNull();

	handleQueueCommand(removeCmd('b'), deps);

	const queued = queuedList(state);
	expect(queued).toHaveLength(1);
	const movingStatus = state.entries.find((e) => e.id === 'a')?.status;
	expect(modeInvalidation(queued, 'a', movingStatus)).toBe(
		'Only one song is queued now — there is nothing to reorder.'
	);
	// And the grip is gone for the next render, so the mode cannot be re-entered into the same lie.
	expect(gripVisible({ queuedCount: queued.length, reorderMeaningful: true })).toBe(false);
});

test('XR-PH-19 · the moving song being removed elsewhere closes the mode with its own reason', () => {
	const { state, deps } = harness('s1');
	handleQueueCommand(addCmd('a', 'm1', 's1'), deps);
	handleQueueCommand(addCmd('b', 'm2', 's1'), deps);

	handleQueueCommand(removeCmd('a'), deps); // the row under the finger

	expect(state.entries.find((e) => e.id === 'a')).toBeUndefined();
	expect(modeInvalidation(queuedList(state), 'a', undefined)).toBe(
		'That song left the queue — nothing was moved.'
	);
});

test('XR-PH-19 · the moving song starting playback closes the mode with its own reason', () => {
	const { state, deps } = harness('s1');
	handleQueueCommand(addCmd('a', 'm1', 's1'), deps);
	handleQueueCommand(addCmd('b', 'm2', 's1'), deps);

	// Driven through the SERVER's own path, not a forged op. A `status` op is server-owned and
	// `validateCommand` rejects it off the wire (hub.ts:278), so a client-shaped status command would
	// have tested the reject rather than the state — exactly the sort of fixture the harness rule in
	// XR-PH-19 exists to avoid. `reconcileOnReady` is what actually starts a song, and is the same
	// composition `autostart.test.ts` drives.
	reconcileOnReady(deps);

	const moving = state.entries.find((e) => e.id === 'a');
	expect(state.playback.currentEntryId).toBe('a'); // sentinel: the song really did start
	expect(moving?.status).toBe('playing');
	expect(modeInvalidation(queuedList(state), 'a', moving?.status)).toBe(
		'That song started playing — nothing was moved.'
	);
});

// ── #912 · a whole-queue drop actually crosses singers through the real hub ───────────────────────

test('#912 · committing a drag as move-to-index moves a song to a GLOBAL slot, jumping another singer', () => {
	// The drag now commits `store.moveToIndex(id, dropTarget)`, which sends a `move-to-index` op. This
	// is the drive-through-the-real-hub proof that a drop at a global index reorders across singers —
	// what the old own-picks `move` could never do. The actor owns the moving entry here, so no
	// capability gate is in the way.
	const { state, deps } = harness('s1');
	handleQueueCommand(addCmd('a', 'm1', 's1'), deps); // s1
	handleQueueCommand(addCmd('x', 'm2', 's2'), { ...deps, actorSingerId: 's2' }); // s2
	handleQueueCommand(addCmd('b', 'm3', 's1'), deps); // s1

	// Fair rotation interleaves the two singers; the exact order is the server's, so read it rather than
	// assume it. The drag drops 'b' (an s1 song) at the FRONT of the whole queue — index 0.
	const before = queuedList(state).map((e) => e.id);
	expect(before).toHaveLength(3);
	expect(before[0]).not.toBe('b'); // sentinel: the move is a real change, not a no-op at its own slot

	handleQueueCommand(moveToIndexCmd('b', 0), deps);

	const after = queuedList(state).map((e) => e.id);
	expect(after[0]).toBe('b'); // landed at the global front, ahead of the other singer's 'x'
	expect(after).toHaveLength(3);
	expect(new Set(after)).toEqual(new Set(before)); // nothing added or dropped, only reordered
});
