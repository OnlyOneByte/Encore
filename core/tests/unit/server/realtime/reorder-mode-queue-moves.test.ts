// The reorder mode against the REAL server, not a fixture. The invalidating states are produced by
// `assignSeqs` re-deriving every `rotationSeq` on every mutation, so the behaviour under test IS the
// interaction between the ops and the ordering layer — hand-writing an "after" state would pin a belief
// about it rather than the thing itself. Real ops go through `handleQueueCommand`.
import { test, expect } from 'bun:test';
import { handleQueueCommand, type HubDeps } from '$lib/server/realtime/hub';
import { reconcileOnReady } from '$lib/server/realtime/player';
import { AuthoritativeState } from '$lib/server/state/store';
import { type ServerEvent, type Media, type QueueEntry, type ClientCommand } from '$lib/contract';
import { EMPTY_SONG_PROFILE } from '$lib/contract';
import { modeInvalidation, liveSortTarget, gripVisible } from '$lib/reorder-mode';

/**
 * `n` uniform 60px rows stacked from y=0, as a real render would report them. The live sort takes the rows'
 * BOXES, because one height cannot place a list mixing queued rows with taller processing cards — but these
 * arms are about the INDEX SPACE following the list's length, so the geometry is the simplest thing that
 * can express "a drag long enough to reach the end".
 */
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ top: i * 60, height: 60 }));

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

/** The whole queued list, in the order the phone renders it — the collection the mode now reads. */
function queuedList(state: AuthoritativeState) {
	return state.entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq);
}

test('another guest queueing mid-drag re-orders the list, and the mode tracks the new length', () => {
	const { state, deps } = harness('s1');
	handleQueueCommand(addCmd('a', 'm1', 's1'), deps);
	handleQueueCommand(addCmd('b', 'm2', 's1'), deps);

	const before = queuedList(state).map((e) => e.id);
	expect(before).toHaveLength(2);
	expect(modeInvalidation(queuedList(state), 'a', 'queued')).toBeNull();
	// The claim is that the drag's index space follows the list's LENGTH as it changes underneath, so this
	// asks the live-sort arithmetic where a long drag lands: the last position that exists.
	expect(liveSortTarget({ fromIndex: 0, offsetPx: 10_000, rowBoundsPx: rows(2), count: 2 })).toBe(1);

	// A DIFFERENT guest queues a song mid-drag, through the real hub, so the re-derivation is the server's.
	handleQueueCommand(addCmd('x', 'm3', 's2'), { ...deps, actorSingerId: 's2' });

	// Non-vacuity: the flat list really changed, and fair rotation interleaves s2 between my two picks.
	const flat = queuedList(state).map((e) => e.id);
	expect(flat).toHaveLength(3);
	expect(flat).toContain('x');
	expect(flat.indexOf('x')).toBeLessThan(flat.indexOf('b'));

	// The mode stays open, spanning the WHOLE queue: 'a' is still queued and three songs remain, so a third
	// legal slot exists.
	expect(modeInvalidation(queuedList(state), 'a', 'queued')).toBeNull();
	// The third position is reachable, which is what proves the index space widened with the list rather
	// than being captured when the gesture began.
	expect(liveSortTarget({ fromIndex: 0, offsetPx: 10_000, rowBoundsPx: rows(3), count: 3 })).toBe(2);
});

test('the queue dropping below two songs closes the mode with a reason', () => {
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
	// The grip is gone for the next render, so the mode cannot be re-entered into the same lie.
	expect(gripVisible({ queuedCount: queued.length, reorderMeaningful: true })).toBe(false);
});

test('the moving song being removed elsewhere closes the mode with its own reason', () => {
	const { state, deps } = harness('s1');
	handleQueueCommand(addCmd('a', 'm1', 's1'), deps);
	handleQueueCommand(addCmd('b', 'm2', 's1'), deps);

	handleQueueCommand(removeCmd('a'), deps); // the row under the finger

	expect(state.entries.find((e) => e.id === 'a')).toBeUndefined();
	expect(modeInvalidation(queuedList(state), 'a', undefined)).toBe('That song left the queue — nothing was moved.');
});

test('the moving song starting playback closes the mode with its own reason', () => {
	const { state, deps } = harness('s1');
	handleQueueCommand(addCmd('a', 'm1', 's1'), deps);
	handleQueueCommand(addCmd('b', 'm2', 's1'), deps);

	// Through the SERVER's own path, not a forged op: a `status` op is server-owned and `validateCommand`
	// rejects it off the wire, so a client-shaped status command would test the reject rather than the
	// state. `reconcileOnReady` is what actually starts a song.
	reconcileOnReady(deps);

	const moving = state.entries.find((e) => e.id === 'a');
	expect(state.playback.currentEntryId).toBe('a'); // sentinel: the song really did start
	expect(moving?.status).toBe('playing');
	expect(modeInvalidation(queuedList(state), 'a', moving?.status)).toBe(
		'That song started playing — nothing was moved.'
	);
});

// A whole-queue drop really crosses singers, through the real hub.

test('· committing a drag as move-to-index moves a song to a GLOBAL slot, jumping another singer', () => {
	// The drag commits `store.moveToIndex(id, dragTo)` at the index the rows were RENDERED at, which is what
	// a global drop must do and what an own-picks `move` cannot express. The actor owns the moving entry, so
	// no capability gate is in the way.
	const { state, deps } = harness('s1');
	handleQueueCommand(addCmd('a', 'm1', 's1'), deps); // s1
	handleQueueCommand(addCmd('x', 'm2', 's2'), { ...deps, actorSingerId: 's2' }); // s2
	handleQueueCommand(addCmd('b', 'm3', 's1'), deps); // s1

	// Fair rotation interleaves the two singers and the exact order is the SERVER's, so read it rather than
	// assume it. The drag drops an s1 song at the FRONT of the whole queue, index 0.
	const before = queuedList(state).map((e) => e.id);
	expect(before).toHaveLength(3);
	expect(before[0]).not.toBe('b'); // sentinel: the move is a real change, not a no-op at its own slot

	handleQueueCommand(moveToIndexCmd('b', 0), deps);

	const after = queuedList(state).map((e) => e.id);
	expect(after[0]).toBe('b'); // landed at the global front, ahead of the other singer's 'x'
	expect(after).toHaveLength(3);
	expect(new Set(after)).toEqual(new Set(before)); // nothing added or dropped, only reordered
});
