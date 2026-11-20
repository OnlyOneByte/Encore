// BE-04: skip, restart and seek name the entry they were pressed on, and one naming a song that is no longer current
// does nothing. Without it, two phones tapping skip at the end of a song — or one skip racing the TV's `ended` —
// threw away the next singer's whole turn.
import { test, expect } from 'bun:test';
import { handlePlayerCommand, handleTelemetry } from '$lib/server/realtime/player';
import { AuthoritativeState } from '$lib/server/state/store';
import { type HubDeps } from '$lib/server/realtime/hub';
import { type ServerEvent, type Media, type QueueEntry, EMPTY_SONG_PROFILE } from '$lib/contract';

const media = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: id,
	title: id,
	durationSec: 100,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: `derived/stems/${id}-instrumental.flac`,
	songProfile: EMPTY_SONG_PROFILE
});
let seq = 0;
const entry = (id: string, mediaId: string, singerId: string): QueueEntry => ({
	id,
	mediaId,
	singerId,
	status: 'queued',
	rotationSeq: -1,
	addedAt: ++seq
});

/** Alice singing, Bob next, then Cara. */
function room() {
	const published: ServerEvent[] = [];
	const toOrigin: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map(['m1', 'm2', 'm3'].map((id) => [id, media(id)]))
	};
	state.applyQueueOp({ op: 'add', entry: entry('alice', 'm1', 'sA') });
	state.applyQueueOp({ op: 'add', entry: entry('bob', 'm2', 'sB') });
	state.applyQueueOp({ op: 'add', entry: entry('cara', 'm3', 'sC') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	const send = (e: ServerEvent) => toOrigin.push(e);
	return { state, deps, published, toOrigin, send };
}

test('two phones tapping skip on the SAME song skip one song, not two', () => {
	const { state, deps } = room();
	expect(state.playback.currentEntryId).toBe('alice');
	handlePlayerCommand({ cmd: 'skip', entryId: 'alice' }, deps);
	handlePlayerCommand({ cmd: 'skip', entryId: 'alice' }, deps);
	expect(state.playback.currentEntryId).toBe('bob');
	expect(state.entries.find((e) => e.id === 'bob')?.status).toBe('playing');
});

test('a skip that races the TV ended frame does not eat the next singer', () => {
	const { state, deps } = room();
	handleTelemetry({ positionSec: 99, ended: true, entryId: 'alice' }, deps);
	handlePlayerCommand({ cmd: 'skip', entryId: 'alice' }, deps);
	expect(state.playback.currentEntryId).toBe('bob');
});

test('a stale skip changes nothing and broadcasts nothing; only the sender hears why', () => {
	const { state, deps, published, toOrigin, send } = room();
	handlePlayerCommand({ cmd: 'skip', entryId: 'alice' }, deps, send);
	const rev = state.rev;
	published.length = 0;
	handlePlayerCommand({ cmd: 'skip', entryId: 'alice' }, deps, send);
	expect(state.rev).toBe(rev);
	expect(published).toHaveLength(0);
	expect(toOrigin).toEqual([{ type: 'player:stale', cmd: 'skip' }]);
});

test('a late restart does not rewind the next singer’s song', () => {
	const { state, deps, send, toOrigin } = room();
	handlePlayerCommand({ cmd: 'skip', entryId: 'alice' }, deps);
	handleTelemetry({ positionSec: 12, entryId: 'bob' }, deps);
	handlePlayerCommand({ cmd: 'restart', entryId: 'alice' }, deps, send);
	expect(state.playback.currentEntryId).toBe('bob');
	expect(state.playback.positionSec).toBe(12);
	expect(toOrigin).toEqual([{ type: 'player:stale', cmd: 'restart' }]);
});

test('a seek naming an old song does not move the current one', () => {
	const { state, deps, send, toOrigin } = room();
	handlePlayerCommand({ cmd: 'skip', entryId: 'alice' }, deps);
	handlePlayerCommand({ cmd: 'seek', positionSec: 40, entryId: 'alice' }, deps, send);
	expect(state.playback.positionSec).toBe(0);
	expect(toOrigin).toEqual([{ type: 'player:stale', cmd: 'seek' }]);
	handlePlayerCommand({ cmd: 'seek', positionSec: 40, entryId: 'bob' }, deps);
	expect(state.playback.positionSec).toBe(40);
});

test('a late key or guide tap does not land on the next singer’s song or their On deck preset', () => {
	const { state, deps, send, toOrigin } = room();
	state.applyQueueOp({ op: 'set-entry-prefs', id: 'bob', keyShift: -2, guideLevel: 0.2 });
	handlePlayerCommand({ cmd: 'skip', entryId: 'alice' }, deps);
	const bobStart = { keyShift: state.playback.keyShift, guideLevel: state.playback.guideLevel };
	expect(bobStart).toEqual({ keyShift: -2, guideLevel: 0.2 });
	handlePlayerCommand({ cmd: 'key', semitones: 5, entryId: 'alice' }, deps, send);
	handlePlayerCommand({ cmd: 'guide', level: 0.9, entryId: 'alice' }, deps, send);
	expect({ keyShift: state.playback.keyShift, guideLevel: state.playback.guideLevel }).toEqual(bobStart);
	expect(toOrigin).toEqual([
		{ type: 'player:stale', cmd: 'key' },
		{ type: 'player:stale', cmd: 'guide' }
	]);
	// Aimed at Bob's song, the key lands.
	handlePlayerCommand({ cmd: 'key', semitones: 3, entryId: 'bob' }, deps);
	expect(state.playback.keyShift).toBe(3);
});

test('a transport frame with no entryId off the wire is dropped, never a free skip', () => {
	const { state, deps } = room();
	handlePlayerCommand({ cmd: 'skip' } as never, deps);
	handlePlayerCommand({ cmd: 'restart', entryId: 42 } as never, deps);
	expect(state.playback.currentEntryId).toBe('alice');
});
