// player:command mutates playback state + broadcasts playback:state.
import { test, expect } from 'bun:test';
import { handlePlayerCommand } from './player';
import { AuthoritativeState } from '../state/store';
import { type HubDeps } from './hub';
import { ulid, type ServerEvent, type Media, type QueueEntry } from '@encore/shared';

const media = (id: string): Media => ({ id, source: 'youtube', sourceRef: 'x', title: id, durationSec: 100, stemStatus: 'none', playMode: 'iframe' });
let _seq = 0;
const entry = (id: string, mediaId: string): QueueEntry => ({ id, mediaId, singerId: 's1', status: 'queued', rotationSeq: -1, addedAt: ++_seq });

function harness() {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = { state, publish: (e) => published.push(e), mediaById: new Map([['m1', media('m1')], ['m2', media('m2')]]) };
	return { published, state, deps };
}

test('play with nothing loaded starts the first playable entry', () => {
	const { state, deps, published } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	expect(state.playback.currentEntryId).toBe('q1');
	expect(state.playback.isPlaying).toBe(true);
	// play broadcasts playback:state (then nowplaying:changed follows it)
	expect(published.some((e) => e.type === 'playback:state')).toBe(true);
	expect(published.at(-1)!.type).toBe('nowplaying:changed');
});

test('pause toggles isPlaying false', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handlePlayerCommand({ cmd: 'pause' }, deps);
	expect(state.playback.isPlaying).toBe(false);
});

test('seek sets clamped position', () => {
	const { state, deps } = harness();
	handlePlayerCommand({ cmd: 'seek', positionSec: 42 }, deps);
	expect(state.playback.positionSec).toBe(42);
	handlePlayerCommand({ cmd: 'seek', positionSec: -5 }, deps);
	expect(state.playback.positionSec).toBe(0);
});

test('skip marks current done and advances to next', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') });
	handlePlayerCommand({ cmd: 'play' }, deps); // q1 playing
	handlePlayerCommand({ cmd: 'skip' }, deps); // -> q2
	expect(state.playback.currentEntryId).toBe('q2');
	// q1 is marked done -> pruned from the queue (terminal entries don't linger, Finding #3a)
	expect(state.entries.find((e) => e.id === 'q1')).toBeUndefined();
	expect(state.entries.find((e) => e.id === 'q2')!.status).toBe('playing');
});

test('restart resets position', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handlePlayerCommand({ cmd: 'seek', positionSec: 50 }, deps);
	handlePlayerCommand({ cmd: 'restart' }, deps);
	expect(state.playback.positionSec).toBe(0);
	expect(state.playback.isPlaying).toBe(true);
});

// ── a playback transition is also a QUEUE mutation, and must broadcast as one ──
// Reported from a live session: "when I skip a song, it takes a bit for it to disappear from the
// queued songs". advance() flips entries to done/playing, but this module only published
// playback:state + nowplaying:changed — so clients kept the skipped song in their `queued` list
// until an unrelated resync happened to arrive.
function queuePatches(published: ServerEvent[]) {
	return published.filter((e): e is Extract<ServerEvent, { type: 'queue:patch' }> => e.type === 'queue:patch');
}

test('THE BUG: skip broadcasts a queue:patch so the song leaves `queued` immediately', () => {
	const { state, deps, published } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	published.length = 0;

	handlePlayerCommand({ cmd: 'skip' }, deps);

	const patches = queuePatches(published);
	expect(patches.length).toBeGreaterThan(0);
	const snapshot = patches.at(-1)!.patch.entries!;
	// q1 was skipped: it is pruned or no longer queued, and q2 is now the playing one.
	expect(snapshot.find((e) => e.id === 'q1')?.status ?? 'pruned').not.toBe('queued');
	expect(snapshot.find((e) => e.id === 'q2')?.status).toBe('playing');
});

test('the skip patch carries the authoritative rev and the media inline', () => {
	const { state, deps, published } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	published.length = 0;

	handlePlayerCommand({ cmd: 'skip' }, deps);

	const patch = queuePatches(published).at(-1)!;
	expect(patch.patch.rev).toBe(state.rev);
	// media rides along so an observer can still render the title of the newly-playing song
	expect(patch.patch.media?.some((m) => m.id === 'm2')).toBe(true);
	// no causedBy: this was not a client op, so no pending op should be cleared by it
	expect(patch.patch.causedBy).toBeUndefined();
});

test('play-from-idle also broadcasts the queue (the entry left `queued`)', () => {
	const { state, deps, published } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	published.length = 0;
	handlePlayerCommand({ cmd: 'play' }, deps);
	expect(queuePatches(published).at(-1)!.patch.entries!.find((e) => e.id === 'q1')?.status).toBe('playing');
});

test('pause/seek do NOT emit a queue:patch (nothing about the queue changed)', () => {
	const { state, deps, published } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	published.length = 0;
	handlePlayerCommand({ cmd: 'pause' }, deps);
	handlePlayerCommand({ cmd: 'seek', positionSec: 10 }, deps);
	expect(queuePatches(published)).toHaveLength(0);
});
