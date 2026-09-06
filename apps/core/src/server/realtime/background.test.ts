// The ephemeral TV background override: set it, validate it, and — the part that actually bites —
// make sure it CLEARS on a song change through every path that starts a song.
//
// PlaybackState is a long-lived singleton; nothing rebuilds it per song. Each ephemeral field is reset
// by being NAMED at three separate setPlayback sites in player.ts. A field missed at any one of them
// leaks the previous singer's choice into the next turn, and no type error catches that — hence one
// test per path rather than one test for "it resets".
import { test, expect } from 'bun:test';
import { handlePlayerCommand, handleTelemetry, reconcileOnReady } from './player';
import { AuthoritativeState } from '../state/store';
import { type HubDeps } from './hub';
import type { ServerEvent, Media, QueueEntry } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';

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
let _seq = 0;
const entry = (id: string, mediaId: string): QueueEntry => ({
	id,
	mediaId,
	singerId: 's1',
	status: 'queued',
	rotationSeq: -1,
	addedAt: ++_seq
});

function harness() {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map([
			['m1', media('m1')],
			['m2', media('m2')]
		])
	};
	return { published, state, deps };
}

test('the resting state is null — deferring to the room default, not overriding it', () => {
	const { state } = harness();
	expect(state.playback.background).toBeNull();
});

test('a valid style is accepted and broadcast', () => {
	const { state, deps, published } = harness();
	handlePlayerCommand({ cmd: 'background', style: 'singer' }, deps);
	expect(state.playback.background).toBe('singer');
	const evt = published.find((e) => e.type === 'playback:state');
	expect(evt).toBeDefined();
	expect((evt as Extract<ServerEvent, { type: 'playback:state' }>).state.background).toBe('singer');
});

test('null is a real choice — it hands the song back to the room default', () => {
	const { state, deps } = harness();
	handlePlayerCommand({ cmd: 'background', style: 'solid' }, deps);
	expect(state.playback.background).toBe('solid');
	handlePlayerCommand({ cmd: 'background', style: null }, deps);
	expect(state.playback.background).toBeNull();
});

test('every registered style is reachable', () => {
	const { state, deps } = harness();
	for (const id of ['off', 'gradient', 'singer', 'solid'] as const) {
		handlePlayerCommand({ cmd: 'background', style: id }, deps);
		expect(state.playback.background).toBe(id);
	}
});

test('a junk style is IGNORED and leaves the stage exactly as it was', () => {
	// This value reaches setPlayback, which write-behinds into SQLite — the path both historical
	// process-kills came through. A cosmetic control must not tear down the socket either, so an
	// unknown value is dropped rather than rejected.
	const { state, deps } = harness();
	handlePlayerCommand({ cmd: 'background', style: 'singer' }, deps);
	for (const junk of ['rainbow', 'OFF', '', 0, 1, {}, [], true, NaN]) {
		handlePlayerCommand({ cmd: 'background', style: junk as never }, deps);
		expect(state.playback.background).toBe('singer'); // unchanged
	}
});

test('a malformed frame does not throw', () => {
	const { deps } = harness();
	expect(() => handlePlayerCommand({ cmd: 'background' } as never, deps)).not.toThrow();
	expect(() => handlePlayerCommand(null as never, deps)).not.toThrow();
	expect(() => handlePlayerCommand({} as never, deps)).not.toThrow();
});

// ── the three reset paths ───────────────────────────────────────────────────

test('reset path 1 — an explicit skip clears the override', () => {
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handlePlayerCommand({ cmd: 'background', style: 'singer' }, deps);
	expect(state.playback.background).toBe('singer');

	handlePlayerCommand({ cmd: 'skip' }, deps);
	expect(state.playback.currentEntryId).toBe('q2'); // we really did change song
	expect(state.playback.background).toBeNull();
});

test('reset path 2 — a song ending on the TV clears the override', () => {
	// advance() is also reached by TV `ended` telemetry, not just an explicit skip. Same reset, but a
	// different caller, so it gets its own test.
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	state.applyQueueOp({ op: 'add', entry: entry('q2', 'm2') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handlePlayerCommand({ cmd: 'background', style: 'solid' }, deps);

	handleTelemetry({ positionSec: 100, ended: true }, deps);
	expect(state.playback.currentEntryId).toBe('q2');
	expect(state.playback.background).toBeNull();
});

test('reset path 3 — play-from-idle starts on the room default', () => {
	// An override can be set with nothing playing; the next song must not inherit it.
	const { state, deps } = harness();
	handlePlayerCommand({ cmd: 'background', style: 'gradient' }, deps);
	expect(state.playback.background).toBe('gradient');

	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	expect(state.playback.currentEntryId).toBe('q1');
	expect(state.playback.background).toBeNull();
});

test('reset path 4 — reconcileOnReady starts a fresh song on the room default', () => {
	// The autostart path: a song becomes playable while the room is idle.
	const { state, deps } = harness();
	handlePlayerCommand({ cmd: 'background', style: 'singer' }, deps);
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	reconcileOnReady(deps);
	expect(state.playback.currentEntryId).toBe('q1');
	expect(state.playback.background).toBeNull();
});

test('the override survives pause, resume, restart and seek — only a SONG change clears it', () => {
	// The point of the feature: it lasts for the song. If a pause cleared it, it would be useless.
	const { state, deps } = harness();
	state.applyQueueOp({ op: 'add', entry: entry('q1', 'm1') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	handlePlayerCommand({ cmd: 'background', style: 'solid' }, deps);
	for (const cmd of [
		{ cmd: 'pause' } as const,
		{ cmd: 'play' } as const,
		{ cmd: 'restart' } as const,
		{ cmd: 'seek', positionSec: 30 } as const
	]) {
		handlePlayerCommand(cmd, deps);
		expect(state.playback.background).toBe('solid');
	}
	expect(state.playback.currentEntryId).toBe('q1'); // still the same song
});
