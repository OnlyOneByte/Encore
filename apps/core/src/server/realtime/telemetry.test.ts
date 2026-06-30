// M5-C1 done-when: ended telemetry advances rotation, picks next by seq; nowplaying carries upNext.
import { test, expect } from 'bun:test';
import { handlePlayerCommand, handleTelemetry, emitNowPlaying, reconcileOnReady } from './player';
import { AuthoritativeState } from '../state/store';
import { type HubDeps } from './hub';
import { type ServerEvent, type Media, type QueueEntry } from '@encore/shared';

const media = (id: string): Media => ({ id, source: 'youtube', sourceRef: 'x', title: id, durationSec: 100, stemStatus: 'none', playMode: 'iframe' });
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
	deps.mediaById.set('m2', { ...media('m2'), playMode: 'file', stemStatus: 'queued' });
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
	deps.mediaById.set('m1', { ...media('m1'), playMode: 'file', stemStatus: 'queued' });
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	expect(state.playback.currentEntryId).toBeNull();

	// stems finish → media ready → reconcile starts it
	deps.mediaById.set('m1', { ...media('m1'), playMode: 'file', stemStatus: 'ready' });
	reconcileOnReady(deps);
	expect(state.playback.currentEntryId).toBe('q1');
	expect(state.playback.isPlaying).toBe(true);
	expect(published.some((e) => e.type === 'playback:state')).toBe(true);
	expect(published.at(-1)!.type).toBe('nowplaying:changed');
});

test('reconcileOnReady: something already playing → only re-emits nowplaying (no preemption)', () => {
	const { state, deps, published } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') }); // ready iframe
	deps.mediaById.set('m2', { ...media('m2'), playMode: 'file', stemStatus: 'queued' });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') }); // cooking
	handlePlayerCommand({ cmd: 'play' }, deps); // q1 playing
	const before = state.playback.currentEntryId;
	published.length = 0;

	deps.mediaById.set('m2', { ...media('m2'), playMode: 'file', stemStatus: 'ready' });
	reconcileOnReady(deps);
	expect(state.playback.currentEntryId).toBe(before); // q1 NOT preempted
	// no new playback:state (we didn't change playback), just a nowplaying refresh so TV preloads m2
	expect(published.every((e) => e.type !== 'playback:state')).toBe(true);
	expect(published.some((e) => e.type === 'nowplaying:changed')).toBe(true);
});
