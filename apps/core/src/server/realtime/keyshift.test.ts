// M7-C9: the `key` player command transposes a make-karaoke (file) song, clamped to ±MAX_KEY_SHIFT,
// and resets to 0 on every song change. No-op on a YouTube iframe or a not-yet-ready file.
import { test, expect } from 'bun:test';
import { handlePlayerCommand } from './player';
import { AuthoritativeState } from '../state/store';
import { type HubDeps } from './hub';
import { MAX_KEY_SHIFT, type Media, type QueueEntry, type ServerEvent } from '@encore/shared';

let _s = 0;
const entry = (id: string, mediaId: string): QueueEntry => ({ id, mediaId, singerId: 's1', status: 'queued', rotationSeq: -1, addedAt: ++_s });
const media = (id: string, over: Partial<Media> = {}): Media => ({
	id, source: 'youtube', sourceRef: 'x', title: id, durationSec: 100, stemStatus: 'none', playMode: 'iframe', ...over
});

function harness() {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		// m-file is a ready make-karaoke song; m-iframe is a plain YouTube song; m-cooking not ready
		mediaById: new Map<string, Media>([
			['m-file', media('m-file', { playMode: 'file', stemStatus: 'ready', sourceRef: 'stems/m-file-instrumental.wav' })],
			['m-iframe', media('m-iframe')],
			['m-cooking', media('m-cooking', { playMode: 'file', stemStatus: 'queued' })]
		])
	};
	return { published, state, deps };
}

test('key shifts a ready file song and broadcasts playback:state', () => {
	const { state, deps, published } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm-file') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	published.length = 0;

	handlePlayerCommand({ cmd: 'key', semitones: 3 }, deps);
	expect(state.playback.keyShift).toBe(3);
	expect(published.some((e) => e.type === 'playback:state')).toBe(true);

	handlePlayerCommand({ cmd: 'key', semitones: -2 }, deps); // absolute target, not a delta
	expect(state.playback.keyShift).toBe(-2);
});

test('key is clamped to ±MAX_KEY_SHIFT', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm-file') });
	handlePlayerCommand({ cmd: 'play' }, deps);

	handlePlayerCommand({ cmd: 'key', semitones: 99 }, deps);
	expect(state.playback.keyShift).toBe(MAX_KEY_SHIFT);
	handlePlayerCommand({ cmd: 'key', semitones: -99 }, deps);
	expect(state.playback.keyShift).toBe(-MAX_KEY_SHIFT);
});

test('key is a no-op on a YouTube iframe song (cannot re-pitch)', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm-iframe') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handlePlayerCommand({ cmd: 'key', semitones: 4 }, deps);
	expect(state.playback.keyShift).toBe(0);
});

test('key is a no-op on a file song whose stems are not ready yet', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm-cooking') });
	// force it current even though not ready (held-slot edge)
	state.setPlayback({ currentEntryId: 'q1' });
	handlePlayerCommand({ cmd: 'key', semitones: 4 }, deps);
	expect(state.playback.keyShift).toBe(0);
});

test('keyShift resets to 0 when the song changes (skip)', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm-file') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm-iframe') });
	handlePlayerCommand({ cmd: 'play' }, deps); // q1 (file)
	handlePlayerCommand({ cmd: 'key', semitones: 5 }, deps);
	expect(state.playback.keyShift).toBe(5);

	handlePlayerCommand({ cmd: 'skip' }, deps); // → q2, fresh song
	expect(state.playback.keyShift).toBe(0);
});
