// XR-PH-19 — the reorder mode against the REAL server, not a fixture.
//
// The requirement names this mechanism explicitly: "a harness test drives real ops through
// `handleQueueCommand` to produce the invalidating states (the `AuthoritativeState` + `HubDeps` idiom
// used by `autostart.test.ts` is the working template)". The reason it is not a fixture test is that
// the invalidating states are produced by `assignSeqs` re-deriving every `rotationSeq` on every
// mutation — the behaviour under test IS the interaction between the ops and the ordering layer, so
// hand-writing the "after" state would pin my belief about it rather than the thing itself.
import { test, expect } from 'bun:test';
import { handleQueueCommand, type HubDeps } from '$lib/server/realtime/hub';
import { reconcileOnReady } from '$lib/server/realtime/player';
import { AuthoritativeState } from '$lib/server/state/store';
import { type ServerEvent, type Media, type QueueEntry, type ClientCommand } from '$lib/contract';
import { EMPTY_SONG_PROFILE } from '$lib/contract';
import { modeInvalidation, ownSlots, gripVisible } from '$lib/reorder-mode';

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

/** What the phone derives for the mode: the actor's own QUEUED picks, in the order it renders them. */
function myPicks(state: AuthoritativeState, singerId: string) {
	return state.entries
		.filter((e) => e.status === 'queued' && e.singerId === singerId)
		.sort((a, b) => a.rotationSeq - b.rotationSeq);
}

test('XR-PH-19 · another guest queueing mid-drag re-orders the list but not the mode', () => {
	const { state, deps } = harness('s1');
	handleQueueCommand(addCmd('a', 'm1', 's1'), deps);
	handleQueueCommand(addCmd('b', 'm2', 's1'), deps);

	const before = myPicks(state, 's1').map((e) => e.id);
	const slotsBefore = ownSlots(before.length);
	expect(before).toHaveLength(2);
	expect(modeInvalidation(myPicks(state, 's1'), 'a', 'queued')).toBeNull();

	// A DIFFERENT guest queues a song while my drag is open. This is the real op through the real hub,
	// so the re-derivation is the server's own.
	const other = harness('s2');
	other.deps.state = state;
	handleQueueCommand(addCmd('x', 'm3', 's2'), { ...deps, actorSingerId: 's2' });

	// The flat list genuinely changed underneath: a third entry is in it, and fair rotation interleaves
	// s2 between my two picks — so this is not a no-op dressed as a test.
	const flat = state.entries.filter((e) => e.status === 'queued').map((e) => e.id);
	expect(flat).toHaveLength(3);
	expect(flat).toContain('x');
	expect(flat.indexOf('x')).toBeLessThan(flat.indexOf('b'));

	// …and the mode is untouched: same picks, same slot count, same commit indices, no reason to close.
	expect(myPicks(state, 's1').map((e) => e.id)).toEqual(before);
	expect(ownSlots(myPicks(state, 's1').length)).toEqual(slotsBefore);
	expect(modeInvalidation(myPicks(state, 's1'), 'a', 'queued')).toBeNull();
});

test('XR-PH-19 · my second pick removed elsewhere closes the mode with a reason', () => {
	const { state, deps } = harness('s1');
	handleQueueCommand(addCmd('a', 'm1', 's1'), deps);
	handleQueueCommand(addCmd('b', 'm2', 's1'), deps);
	expect(modeInvalidation(myPicks(state, 's1'), 'a', 'queued')).toBeNull();

	handleQueueCommand(removeCmd('b'), deps);

	const picks = myPicks(state, 's1');
	expect(picks).toHaveLength(1);
	const movingStatus = state.entries.find((e) => e.id === 'a')?.status;
	expect(modeInvalidation(picks, 'a', movingStatus)).toBe(
		'You have one song queued now — there is nothing to reorder.'
	);
	// And the grip is gone for the next render, so the mode cannot be re-entered into the same lie.
	expect(
		gripVisible({ mine: true, ownQueuedCount: picks.length, reorderMeaningful: true })
	).toBe(false);
});

test('XR-PH-19 · the moving song being removed elsewhere closes the mode with its own reason', () => {
	const { state, deps } = harness('s1');
	handleQueueCommand(addCmd('a', 'm1', 's1'), deps);
	handleQueueCommand(addCmd('b', 'm2', 's1'), deps);

	handleQueueCommand(removeCmd('a'), deps); // the row under the finger

	expect(state.entries.find((e) => e.id === 'a')).toBeUndefined();
	expect(modeInvalidation(myPicks(state, 's1'), 'a', undefined)).toBe(
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
	// `reorderWithinSinger` no-ops for a non-queued entry, so a drag left open here could only ever
	// commit nothing — which is exactly why the mode has to say so rather than appear to work.
	expect(modeInvalidation(myPicks(state, 's1'), 'a', moving?.status)).toBe(
		'That song started playing — nothing was moved.'
	);
});
