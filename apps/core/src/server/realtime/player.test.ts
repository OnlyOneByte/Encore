// M3-C6: player:command mutates playback state + broadcasts playback:state.
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
	expect(published.at(-1)!.type).toBe('playback:state');
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
	expect(state.entries.find((e) => e.id === 'q1')!.status).toBe('done');
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
