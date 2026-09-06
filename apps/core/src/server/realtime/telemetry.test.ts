// Ended telemetry advances rotation, picks next by seq; nowplaying carries upNext.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handlePlayerCommand, handleTelemetry, emitNowPlaying, reconcileOnReady } from './player';
import { AuthoritativeState } from '../state/store';
import { type HubDeps } from './hub';
import { type ServerEvent, type Media, type QueueEntry } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';

const media = (id: string): Media => ({ id, source: 'youtube', sourceRef: 'x', title: id, durationSec: 100, stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: 'derived/stems/i-instrumental.flac', songProfile: EMPTY_SONG_PROFILE });
let _s = 0;
const entry = (id: string, mediaId: string, singerId = 's1'): QueueEntry => ({ id, mediaId, singerId, status: 'queued', rotationSeq: -1, addedAt: ++_s });

function harness() {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = { state, publish: (e) => published.push(e), mediaById: new Map([['m1', media('m1')], ['m2', media('m2')], ['m3', media('m3')]]) };
	return { published, state, deps };
}

test('ended telemetry marks current done and advances to next by seq', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') });
	handlePlayerCommand({ cmd: 'play' }, deps); // q1 playing
	expect(state.playback.currentEntryId).toBe('q1');

	handleTelemetry({ positionSec: 100, durationSec: 100, status: 'playing', bufferedNextPct: 100, ended: true }, deps);
	expect(state.playback.currentEntryId).toBe('q2');
	// q1 is marked done -> pruned from the queue (terminal entries don't linger, Finding #3a)
	expect(state.entries.find((e) => e.id === 'q1')).toBeUndefined();
	expect(state.entries.find((e) => e.id === 'q2')!.status).toBe('playing');
});

test('ended on the last entry goes to no-current (attract)', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handleTelemetry({ positionSec: 100, durationSec: 100, status: 'playing', bufferedNextPct: 0, ended: true }, deps);
	expect(state.playback.currentEntryId).toBeNull();
	expect(state.playback.isPlaying).toBe(false);
});

test('nowplaying:changed carries current + soonest-ready upNext', () => {
	const { state, deps, published } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') });
	handlePlayerCommand({ cmd: 'play' }, deps); // emits nowplaying
	const np = published.filter((e) => e.type === 'nowplaying:changed').at(-1) as Extract<ServerEvent, { type: 'nowplaying:changed' }>;
	expect(np.current?.id).toBe('q1');
	expect(np.upNext?.id).toBe('q2');
});

test('position-only telemetry updates position without advancing', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handleTelemetry({ positionSec: 42.7, durationSec: 100, status: 'playing', bufferedNextPct: 50 }, deps);
	expect(state.playback.currentEntryId).toBe('q1'); // unchanged
	expect(state.playback.positionSec).toBe(42); // floored
});

test('held-slot: ended skips a not-ready file entry, plays the ready one', () => {
	const { state, deps } = harness();
	// q1 ready iframe (playing), q2 is a cooking file, q3 ready
	deps.mediaById.set('m2', { ...media('m2'), stemStatus: 'queued' });
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') });
	state.applyQueueOp({ op: 'add', entry: entry('q3', 'm3') });
	handlePlayerCommand({ cmd: 'play' }, deps); // q1
	handleTelemetry({ positionSec: 100, durationSec: 100, status: 'playing', bufferedNextPct: 100, ended: true }, deps);
	// q2 not ready -> held -> advance picks q3
	expect(state.playback.currentEntryId).toBe('q3');
});

test('reconcileOnReady: room idled while cooking → the freshly-ready song starts playing', () => {
	const { state, deps, published } = harness();
	// the only queued song is a cooking file — nothing plays yet (room idle)
	deps.mediaById.set('m1', { ...media('m1'), stemStatus: 'queued' });
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	expect(state.playback.currentEntryId).toBeNull();

	// stems finish → media ready → reconcile starts it
	deps.mediaById.set('m1', { ...media('m1'), stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: 'derived/stems/i-instrumental.flac' });
	reconcileOnReady(deps);
	expect(state.playback.currentEntryId).toBe('q1');
	expect(state.playback.isPlaying).toBe(true);
	expect(published.some((e) => e.type === 'playback:state')).toBe(true);
	expect(published.at(-1)!.type).toBe('nowplaying:changed');
});

test('reconcileOnReady: something already playing → only re-emits nowplaying (no preemption)', () => {
	const { state, deps, published } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') }); // ready iframe
	deps.mediaById.set('m2', { ...media('m2'), stemStatus: 'queued' });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') }); // cooking
	handlePlayerCommand({ cmd: 'play' }, deps); // q1 playing
	const before = state.playback.currentEntryId;
	published.length = 0;

	deps.mediaById.set('m2', { ...media('m2'), stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: 'derived/stems/i-instrumental.flac' });
	reconcileOnReady(deps);
	expect(state.playback.currentEntryId).toBe(before); // q1 NOT preempted
	// no new playback:state (we didn't change playback), just a nowplaying refresh so TV preloads m2
	expect(published.every((e) => e.type !== 'playback:state')).toBe(true);
	expect(published.some((e) => e.type === 'nowplaying:changed')).toBe(true);
});

test('two ended frames do not double-advance: the stale ended for a no-longer-current entry is ignored (#70)', () => {
	// Queue Alice, Bob, Cara. Alice plays, ends. A SECOND `ended` (a duplicate send, a second TV,
	// or a reconnecting TV replaying its last frame) must not consume Bob's turn too.
	const { state, deps } = harness();
	deps.mediaById.set('m3', media('m3'));
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') }); // Alice
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') }); // Bob
	state.applyQueueOp({ op: 'add', entry: entry('q3', 'm3') }); // Cara
	handlePlayerCommand({ cmd: 'play' }, deps);
	expect(state.playback.currentEntryId).toBe('q1');

	// First ended carries Alice's id (the entry that actually ended on screen). Advances to Bob.
	handleTelemetry({ entryId: 'q1', positionSec: 100, durationSec: 100, status: 'playing', bufferedNextPct: 100, ended: true }, deps);
	expect(state.playback.currentEntryId).toBe('q2');

	// Second (stale/duplicate) ended still names Alice (q1) — no longer current. It must be IGNORED.
	handleTelemetry({ entryId: 'q1', positionSec: 100, durationSec: 100, status: 'playing', bufferedNextPct: 100, ended: true }, deps);
	expect(state.playback.currentEntryId).toBe('q2'); // still Bob, NOT Cara
	expect(state.entries.find((e) => e.id === 'q2')!.status).toBe('playing'); // Bob's turn survives
	expect(state.entries.find((e) => e.id === 'q3')).toBeDefined(); // Cara still queued, not skipped
});

test('a genuine ended whose id matches the current entry advances as before (#70)', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handleTelemetry({ entryId: 'q1', positionSec: 100, durationSec: 100, status: 'playing', bufferedNextPct: 100, ended: true }, deps);
	expect(state.playback.currentEntryId).toBe('q2');
});

test('an ended with no entry id keeps legacy behaviour (backward compatible with an older TV) (#70)', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handleTelemetry({ positionSec: 100, durationSec: 100, status: 'playing', bufferedNextPct: 100, ended: true }, deps);
	expect(state.playback.currentEntryId).toBe('q2');
});

test('a stale position frame naming the outgoing entry after an advance does NOT move the playhead (#125)', () => {
	// q1 plays at ~87s, then a skip/ended advances to q2 (fresh position 0). The outgoing <audio>
	// for q1 fires one more ontimeupdate across the round-trip + slot swap: a POSITION frame naming
	// q1, which is no longer current. Before #125 it was written unconditionally (q2.positionSec=87)
	// and fed back to the TV as a seek target, starting q2 87s in. It must now be dropped.
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') });
	handlePlayerCommand({ cmd: 'play' }, deps); // q1 playing
	handleTelemetry({ entryId: 'q1', positionSec: 87.4, durationSec: 100, status: 'playing', bufferedNextPct: 100 }, deps);
	expect(state.playback.positionSec).toBe(87); // a live frame for the current entry still tracks

	// Advance to q2 (its own play resets positionSec to 0).
	handleTelemetry({ entryId: 'q1', positionSec: 100, durationSec: 100, status: 'playing', bufferedNextPct: 100, ended: true }, deps);
	expect(state.playback.currentEntryId).toBe('q2');
	expect(state.playback.positionSec).toBe(0);

	// The stale trailing position frame from q1's outgoing <audio> — no longer current. Must be dropped.
	handleTelemetry({ entryId: 'q1', positionSec: 87.4, durationSec: 100, status: 'playing', bufferedNextPct: 100 }, deps);
	expect(state.playback.positionSec).toBe(0); // NOT 87 — q2 does not inherit q1's playhead
	expect(state.playback.currentEntryId).toBe('q2');
});

test('a position frame for the current entry still updates position (guard hoist does not break the live path) (#125)', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handleTelemetry({ entryId: 'q1', positionSec: 42.7, durationSec: 100, status: 'playing', bufferedNextPct: 50 }, deps);
	expect(state.playback.positionSec).toBe(42);
});

test('an id-less position frame keeps legacy behaviour (older TV unaffected) (#125)', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handleTelemetry({ positionSec: 33.3, durationSec: 100, status: 'playing', bufferedNextPct: 50 }, deps);
	expect(state.playback.positionSec).toBe(33); // no id -> still applied
});


test('the TV stamps entryId on EVERY telemetry frame, not just ended — so the position-path guard is reachable (#125)', () => {
	// The server drop (player.ts) can only fire on a frame that CARRIES an entryId. Before #125 the
	// TV stamped one only on `ended`, so position frames arrived id-less and the guard's first
	// conjunct was false. Reverting the client hunk alone leaves the whole suite green (the server
	// test still passes because its stale frame is hand-stamped), silently re-opening #125. Pin the
	// stamping at the call site — same source-scan shape guide-sync.test.ts uses on this file.
	const src = readFileSync(join(import.meta.dir, '..', '..', 'routes', 'tv', '+page.svelte'), 'utf8');
	const body = src.split('function sendTelemetry(')[1]?.split('\n\t}')[0] ?? '';
	expect(body).toContain('const entryId = current?.id'); // stamped on EVERY frame
	expect(body).not.toContain("status === 'ended' ?");     // the ended-only form is the #125 bug
});
