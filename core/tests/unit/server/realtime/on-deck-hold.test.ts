// A reorder never silently steals On deck. While a song plays, the room's next playable entry is held
// against everyone but its owner (hub.ts `entryOpRefusal`, rotation.ts `heldOnDeck`/`stealsHeld`).
import { test, expect } from 'bun:test';
import { handleQueueCommand, validateCommand, type HubDeps } from '$lib/server/realtime/hub';
import { AuthoritativeState } from '$lib/server/state/store';
import { handlePlayerCommand } from '$lib/server/realtime/player';
import { heldOnDeck } from '$lib/server/rotation';
import { removableOnLeave } from '$lib/server/singers/leave';
import type { EncoreApp } from '$lib/server/app';
import { EMPTY_SONG_PROFILE, type ClientCommand, type Media, type QueueEntry, type QueueOp } from '$lib/contract';

const media = (id: string, ready = true): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	stemStatus: ready ? 'ready' : 'queued',
	lyricsStatus: 'ready',
	instrumentalRef: ready ? `derived/stems/${id}-instrumental.flac` : undefined,
	songProfile: EMPTY_SONG_PROFILE
});

let _seq = 0;
const entry = (id: string, singerId: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
	id,
	mediaId: 'ready',
	singerId,
	status: 'queued',
	rotationSeq: _seq,
	addedAt: ++_seq,
	...over
});

/** Maya sings; queued: Theo's `believin` (held), Ana's `prayer`, Ana's `brightside`. */
function room(opts: { actor?: string; playing?: boolean; away?: string[]; cookingFirst?: boolean } = {}) {
	const { actor = 'maya', playing = true, away = [], cookingFirst = false } = opts;
	const entries = [
		entry('caroline', 'maya', { status: playing ? 'playing' : 'done' }),
		...(cookingFirst ? [entry('cooking', 'ana', { mediaId: 'cooking' })] : []),
		entry('believin', 'theo'),
		entry('prayer', 'ana'),
		entry('brightside', 'ana')
	].filter((e) => e.status !== 'done');
	const state = new AuthoritativeState();
	state.hydrate(entries, null);
	const deps: HubDeps = {
		state,
		publish: () => {},
		mediaById: new Map([
			['ready', media('ready')],
			['cooking', media('cooking', false)]
		]),
		actorSingerId: actor,
		listAway: () => away
	};
	return { state, deps };
}

let _op = 0;
const cmd = (op: QueueOp): ClientCommand => ({ clientOpId: `c${++_op}`, op });
const queuedIds = (state: AuthoritativeState) => state.entries.filter((e) => e.status === 'queued').map((e) => e.id);

test('the repro: Maya cannot drag Ana`s second song in front of Theo`s On deck', () => {
	const { state, deps } = room();
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'brightside', toIdx: 0 }), deps)).toBe(
		'on deck is held: believin'
	);
	expect(handleQueueCommand(cmd({ op: 'move-to-index', id: 'brightside', toIdx: 0 }), deps)).toBeNull();
	expect(queuedIds(state)).toEqual(['believin', 'prayer', 'brightside']);
});

test('nobody else may move the held entry itself, down or anywhere', () => {
	const { deps } = room();
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'believin', toIdx: 2 }), deps)).toBe(
		'on deck is held: believin'
	);
	expect(validateCommand(cmd({ op: 'move', id: 'believin', toSeq: 0 }), deps)).toBe('on deck is held: believin');
});

test('its owner keeps every move: Theo may move his own song down', () => {
	const { deps } = room({ actor: 'theo' });
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'believin', toIdx: 2 }), deps)).toBeNull();
});

test('owning the MOVED row is no exemption: Ana`s drag of her own song in front of Theo is refused', () => {
	const { deps } = room({ actor: 'ana' });
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'brightside', toIdx: 0 }), deps)).toBe(
		'on deck is held: believin'
	);
	// ...and her own reorder within her picks, behind Theo, still passes.
	expect(validateCommand(cmd({ op: 'move', id: 'brightside', toSeq: 0 }), deps)).toBeNull();
});

test('moves among the rows behind it pass', () => {
	const { state, deps } = room();
	handleQueueCommand(cmd({ op: 'move-to-index', id: 'brightside', toIdx: 1 }), deps);
	expect(queuedIds(state)).toEqual(['believin', 'brightside', 'prayer']);
});

test('the same drag with nothing playing passes: an idle room holds nothing', () => {
	const { deps } = room({ playing: false });
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'brightside', toIdx: 0 }), deps)).toBeNull();
});

// The owner's ruling: the hold STAYS while Theo's phone is locked or away. Every way it must still end is pinned below
// WITH Theo away, so none of them leans on an away lift.
test('the same drag while Theo`s phone is away is refused: the hold stays', () => {
	const { deps } = room({ away: ['theo'] });
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'brightside', toIdx: 0 }), deps)).toBe(
		'on deck is held: believin'
	);
});

/** `room()` with Maya's song really on: playback names it, so a skip has a song to skip. */
function singing(opts: Parameters<typeof room>[0]) {
	const r = room(opts);
	r.state.hydrate(r.state.entries as QueueEntry[], {
		...r.state.playback,
		currentEntryId: 'caroline',
		isPlaying: true
	});
	return r;
}

test('away, the hold still ends when Theo`s turn starts: nothing of his is held while he sings', () => {
	const { state, deps } = singing({ away: ['theo'] });
	handlePlayerCommand({ cmd: 'skip', entryId: 'caroline' }, deps);
	expect(state.entries.find((e) => e.id === 'believin')?.status).toBe('playing');
	expect(heldOnDeck(state.entries as QueueEntry[], deps.mediaById, {}, ['theo'])?.id).toBe('prayer');
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'brightside', toIdx: 0 }), deps)).toBe(
		'on deck is held: prayer'
	);
});

test('away, the host can still skip Theo once his turn starts', () => {
	const { state, deps } = singing({ away: ['theo'] });
	handlePlayerCommand({ cmd: 'skip', entryId: 'caroline' }, deps);
	handlePlayerCommand({ cmd: 'skip', entryId: 'believin' }, deps);
	expect(state.playback.currentEntryId).toBe('prayer');
});

test('away, Theo`s own Not yet still moves it: an owner op, never refused by the hold', () => {
	const { state, deps } = room({ actor: 'theo', away: ['theo'] });
	handleQueueCommand(cmd({ op: 'not-yet', id: 'believin', toIdx: 1 }), deps);
	expect(queuedIds(state)).toEqual(['prayer', 'believin', 'brightside']);
	expect(heldOnDeck(state.entries as QueueEntry[], deps.mediaById, {}, ['theo'])?.id).toBe('prayer');
});

test('away, leaving the room ends it: the leave removes his queued songs, so On deck passes on', () => {
	const { state, deps } = room({ away: ['theo'] });
	// `doLeave`'s own selection of what a leave removes, applied the way it applies it.
	for (const e of removableOnLeave({ state } as EncoreApp, 'theo')) state.applyQueueOp({ op: 'remove', id: e.id });
	expect(heldOnDeck(state.entries as QueueEntry[], deps.mediaById, {}, ['theo'])?.id).toBe('prayer');
});

test('a cooking song in front of the held one is skipped by the hold, and may move behind it', () => {
	const { state, deps } = room({ cookingFirst: true });
	// `cooking` is first in rotation but not ready, so On deck is Theo's `believin` (index 1).
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'brightside', toIdx: 1 }), deps)).toBe(
		'on deck is held: believin'
	);
	handleQueueCommand(cmd({ op: 'move-to-index', id: 'cooking', toIdx: 3 }), deps);
	expect(queuedIds(state)).toEqual(['believin', 'prayer', 'brightside', 'cooking']);
});

test('a swap that keeps the count ahead still steals: Ana`s ready song trading slots with her cooking one', () => {
	// `move` permutes Ana's picks among her own slots: `brightside` (ready) takes the cooking song's slot ahead of Theo.
	const { deps } = room({ cookingFirst: true });
	expect(validateCommand(cmd({ op: 'move', id: 'brightside', toSeq: 0 }), deps)).toBe('on deck is held: believin');
});

test('removing someone else`s held entry is not a reorder and is not held', () => {
	const { deps } = room();
	expect(validateCommand(cmd({ op: 'remove', id: 'believin' }), deps)).toBeNull();
});

test('back to back is not held: while Theo sings, his own next song shows no card, so Maya may put Ana first', () => {
	const state = new AuthoritativeState();
	state.hydrate([entry('theo-1', 'theo', { status: 'playing' }), entry('theo-2', 'theo'), entry('ana-1', 'ana')], null);
	const deps: HubDeps = {
		state,
		publish: () => {},
		mediaById: new Map([['ready', media('ready')]]),
		actorSingerId: 'maya'
	};
	expect(validateCommand(cmd({ op: 'move-to-index', id: 'ana-1', toIdx: 0 }), deps)).toBeNull();
});

test('an add cannot take On deck either: a never-sung guest under "longest ago" lands right behind Theo', () => {
	const lastSungAt = new Map([
		['maya', 3],
		['theo', 1],
		['ana', 2]
	]);
	const state = new AuthoritativeState(undefined, 250, () => ({ order: 'least-recently-sung', lastSungAt }));
	state.hydrate(
		[entry('caroline', 'maya', { status: 'playing' }), entry('believin', 'theo'), entry('prayer', 'ana')],
		null
	);
	const deps: HubDeps = {
		state,
		publish: () => {},
		mediaById: new Map([['ready', media('ready')]]),
		actorSingerId: 'zoe'
	};
	handleQueueCommand(cmd({ op: 'add', entry: entry('zoe-1', 'zoe') }), deps);
	expect(queuedIds(state)).toEqual(['believin', 'zoe-1', 'prayer']);
});
