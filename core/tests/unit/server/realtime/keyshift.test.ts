// The `key` player command transposes a process (file) song, clamped to ±MAX_KEY_SHIFT,
// and resets to 0 on every song change. No-op on a YouTube iframe or a not-yet-ready file.
import { test, expect } from 'bun:test';
import { handlePlayerCommand } from '$lib/server/realtime/player';
import { AuthoritativeState } from '$lib/server/state/store';
import { type HubDeps } from '$lib/server/realtime/hub';
import { MAX_KEY_SHIFT, type Media, type QueueEntry, type ServerEvent, EMPTY_SONG_PROFILE } from '$lib/contract';

let _s = 0;
const entry = (id: string, mediaId: string): QueueEntry => ({
	id,
	mediaId,
	singerId: 's1',
	status: 'queued',
	rotationSeq: -1,
	addedAt: ++_s
});
const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	stemStatus: 'none',
	...over
});

function harness() {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		// m-file is a processed song; m-unprocessed has no instrumental; m-processing is still separating
		mediaById: new Map<string, Media>([
			[
				'm-file',
				media('m-file', {
					stemStatus: 'ready',
					lyricsStatus: 'ready',
					instrumentalRef: 'derived/stems/m-file-instrumental.wav',
					songProfile: EMPTY_SONG_PROFILE
				})
			],
			['m-iframe', media('m-iframe')],
			['m-processing', media('m-processing', { stemStatus: 'queued' })]
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
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm-processing') });
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

	handlePlayerCommand({ cmd: 'skip', entryId: 'q1' }, deps); // → q2, fresh song
	expect(state.playback.keyShift).toBe(0);
});
