// While a song plays, its key and guide are its singer's. From any other socket the command does nothing,
// broadcasts nothing, and only the sender hears why (`player:stale` with `singerOnly`). The transport stays the room's.
import { test, expect } from 'bun:test';
import { handlePlayerCommand } from '$lib/server/realtime/player';
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
	guideMixRef: `derived/stems/${id}-guide-mix.flac`,
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

/** Maya singing, Theo next. `actor` is whose socket the commands come from. */
function room(actor: string | undefined) {
	const published: ServerEvent[] = [];
	const toOrigin: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map(['m1', 'm2'].map((id) => [id, media(id)])),
		actorSingerId: actor
	};
	state.applyQueueOp({ op: 'add', entry: entry('maya-song', 'm1', 'maya') });
	state.applyQueueOp({ op: 'add', entry: entry('theo-song', 'm2', 'theo') });
	handlePlayerCommand({ cmd: 'play' }, deps);
	published.length = 0;
	const send = (e: ServerEvent) => toOrigin.push(e);
	return { state, deps, published, toOrigin, send };
}

test('the singer changes their own key and guide', () => {
	const { state, deps, published, toOrigin, send } = room('maya');
	handlePlayerCommand({ cmd: 'key', semitones: 2, entryId: 'maya-song' }, deps, send);
	handlePlayerCommand({ cmd: 'guide', level: 0.4, entryId: 'maya-song' }, deps, send);
	expect(state.playback).toMatchObject({ keyShift: 2, guideLevel: 0.4 });
	expect(published.filter((e) => e.type === 'playback:state')).toHaveLength(2);
	expect(toOrigin).toEqual([]);
});

for (const [who, actor] of [
	['another joined guest', 'theo'],
	['a socket with no singer (cookieless, or a TV)', undefined]
] as const) {
	test(`key and guide from ${who} are refused, told to the sender only, and broadcast nothing`, () => {
		const { state, deps, published, toOrigin, send } = room(actor);
		const rev = state.rev;
		handlePlayerCommand({ cmd: 'key', semitones: 2, entryId: 'maya-song' }, deps, send);
		handlePlayerCommand({ cmd: 'guide', level: 0.9, entryId: 'maya-song' }, deps, send);
		expect(state.playback).toMatchObject({ keyShift: 0, guideLevel: null });
		expect(state.rev).toBe(rev);
		expect(published).toEqual([]);
		expect(toOrigin).toEqual([
			{ type: 'player:stale', cmd: 'key', singerOnly: true },
			{ type: 'player:stale', cmd: 'guide', singerOnly: true }
		]);
	});
}

test('the transport stays with everyone: another guest pauses, restarts, seeks and skips', () => {
	const { state, deps, toOrigin, send } = room('theo');
	handlePlayerCommand({ cmd: 'pause' }, deps, send);
	expect(state.playback.isPlaying).toBe(false);
	handlePlayerCommand({ cmd: 'restart', entryId: 'maya-song' }, deps, send);
	expect(state.playback.isPlaying).toBe(true);
	handlePlayerCommand({ cmd: 'seek', positionSec: 42, entryId: 'maya-song' }, deps, send);
	expect(state.playback.positionSec).toBe(42);
	handlePlayerCommand({ cmd: 'skip', entryId: 'maya-song' }, deps, send);
	expect(state.playback.currentEntryId).toBe('theo-song');
	expect(toOrigin).toEqual([]);
});

test('the rule follows the song: after a skip, the new singer owns it and the last one does not', () => {
	const { state, deps, toOrigin, send } = room('maya');
	handlePlayerCommand({ cmd: 'skip', entryId: 'maya-song' }, deps);
	handlePlayerCommand({ cmd: 'key', semitones: 3, entryId: 'theo-song' }, deps, send);
	expect(state.playback.keyShift).toBe(0);
	expect(toOrigin).toEqual([{ type: 'player:stale', cmd: 'key', singerOnly: true }]);
	handlePlayerCommand({ cmd: 'key', semitones: 3, entryId: 'theo-song' }, { ...deps, actorSingerId: 'theo' });
	expect(state.playback.keyShift).toBe(3);
});

test('a current id naming no entry has no singer to name: the old no-op, not a singer-only notice', () => {
	const { state, deps, toOrigin, send } = room('theo');
	state.setPlayback({ currentEntryId: 'ghost' });
	handlePlayerCommand({ cmd: 'key', semitones: 2, entryId: 'ghost' }, deps, send);
	expect(state.playback.keyShift).toBe(0);
	expect(toOrigin).toEqual([]);
});

test('a stale key tap is still told as stale, not as someone else’s song', () => {
	const { deps, toOrigin, send } = room('theo');
	handlePlayerCommand({ cmd: 'skip', entryId: 'maya-song' }, deps);
	handlePlayerCommand({ cmd: 'key', semitones: 1, entryId: 'maya-song' }, deps, send);
	expect(toOrigin).toEqual([{ type: 'player:stale', cmd: 'key' }]);
});
