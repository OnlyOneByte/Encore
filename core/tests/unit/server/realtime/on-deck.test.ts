// The on-deck preset and "Not yet". The preset must apply at EVERY song-start site and must NOT outlive its own
// song — the bug class player.ts's EPHEMERAL_RESET exists for (keyShift once leaked through reconcileOnReady).
import { test, expect } from 'bun:test';
import { handlePlayerCommand, handleTelemetry, reconcileOnReady } from '$lib/server/realtime/player';
import { handleQueueCommand, validateCommand, type HubDeps } from '$lib/server/realtime/hub';
import { AuthoritativeState } from '$lib/server/state/store';
import { openDb } from '$lib/server/db/index';
import { runMigrations, hydrate } from '$lib/server/db/migrate';
import { sqlitePersistence } from '$lib/server/state/persistence';
import { EMPTY_SONG_PROFILE, type ClientCommand, type Media, type QueueEntry, type QueueOp } from '$lib/contract';

const media = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: `derived/stems/${id}-instrumental.flac`,
	songProfile: EMPTY_SONG_PROFILE
});

let _seq = 0;
const entry = (id: string, singerId: string, over: Partial<QueueEntry> = {}): QueueEntry => ({
	id,
	mediaId: 'm1',
	singerId,
	status: 'queued',
	rotationSeq: _seq,
	addedAt: ++_seq,
	...over
});

function harness(entries: QueueEntry[], actorSingerId = 'maya') {
	const state = new AuthoritativeState();
	state.hydrate(entries, null);
	const deps: HubDeps = { state, publish: () => {}, mediaById: new Map([['m1', media('m1')]]), actorSingerId };
	return { state, deps };
}

let _op = 0;
const cmd = (op: QueueOp): ClientCommand => ({ clientOpId: `c${++_op}`, op });

const preset = { keyShift: -2, guideLevel: 0.2 };

// ---- the preset at song start --------------------------------------------------------------------------------

test('play: the preset applies at start, and the NEXT entry starts reset', () => {
	const { state, deps } = harness([entry('a', 'maya', preset), entry('b', 'theo')]);
	handlePlayerCommand({ cmd: 'play' }, deps);
	expect(state.playback).toMatchObject({ currentEntryId: 'a', keyShift: -2, guideLevel: 0.2 });
	handlePlayerCommand({ cmd: 'skip', entryId: 'a' }, deps);
	expect(state.playback).toMatchObject({ currentEntryId: 'b', keyShift: 0, guideLevel: null });
});

test('advance on `ended`: a preset entry after a plain one gets its preset, not the previous reset', () => {
	const { state, deps } = harness([entry('a', 'theo'), entry('b', 'maya', preset)]);
	handlePlayerCommand({ cmd: 'play' }, deps);
	handlePlayerCommand({ cmd: 'key', semitones: 3, entryId: 'a' }, deps); // Theo's live shift must not leak either
	handleTelemetry({ positionSec: 100, ended: true, entryId: 'a' }, deps);
	expect(state.playback).toMatchObject({ currentEntryId: 'b', keyShift: -2, guideLevel: 0.2 });
});

test('reconcileOnReady: an idle room starting a preset song applies it', () => {
	const { state, deps } = harness([entry('a', 'maya', preset)]);
	reconcileOnReady(deps);
	expect(state.playback).toMatchObject({ currentEntryId: 'a', keyShift: -2, guideLevel: 0.2 });
});

test('set-entry-prefs lands on the entry and is what the start applies', () => {
	const { state, deps } = harness([entry('a', 'maya')]);
	handleQueueCommand(cmd({ op: 'set-entry-prefs', id: 'a', keyShift: 1, guideLevel: null }), deps);
	expect(state.entries[0]).toMatchObject({ keyShift: 1, guideLevel: null });
	handlePlayerCommand({ cmd: 'play' }, deps);
	expect(state.playback).toMatchObject({ keyShift: 1, guideLevel: null });
});

// ---- who may set it, and with what ----------------------------------------------------------------------------

test('set-entry-prefs is owner-only and refuses out-of-range values rather than clamping them', () => {
	const { deps } = harness([entry('a', 'maya'), entry('b', 'theo')]);
	const set = (id: string, keyShift: number, guideLevel: number | null) =>
		validateCommand(cmd({ op: 'set-entry-prefs', id, keyShift, guideLevel }), deps);
	expect(set('a', -2, 0.2)).toBeNull();
	expect(set('b', -2, 0.2)).toBe('only the singer can change this entry');
	expect(set('a', 8, null)).toBe('invalid keyShift: 8');
	expect(set('a', 1.5, null)).toBe('invalid keyShift: 1.5');
	expect(set('a', 0, 2)).toBe('invalid guideLevel: 2');
});

test('an add may carry a remembered key, but only a valid one', () => {
	const { deps } = harness([]);
	const add = (keyShift: number) => validateCommand(cmd({ op: 'add', entry: entry('n', 'maya', { keyShift }) }), deps);
	expect(add(-3)).toBeNull();
	expect(add(99)).toBe('invalid keyShift: 99');
});

// ---- Not yet --------------------------------------------------------------------------------------------------

test('Not yet moves the entry one place back, and works only ONCE per entry', () => {
	const { state, deps } = harness([entry('a', 'maya'), entry('b', 'theo'), entry('c', 'ana')]);
	const order = () => state.entries.map((e) => e.id);
	expect(handleQueueCommand(cmd({ op: 'not-yet', id: 'a', toIdx: 1 }), deps)).not.toBeNull();
	expect(order()).toEqual(['b', 'a', 'c']);
	expect(state.entries.find((e) => e.id === 'a')?.deferred).toBe(true);
	// The second ask is refused and changes nothing.
	expect(validateCommand(cmd({ op: 'not-yet', id: 'a', toIdx: 2 }), deps)).toBe(
		'not yet was already used for this song'
	);
	expect(handleQueueCommand(cmd({ op: 'not-yet', id: 'a', toIdx: 2 }), deps)).toBeNull();
	expect(order()).toEqual(['b', 'a', 'c']);
});

test('Not yet is refused with nobody behind, for a forward move, and for someone else', () => {
	const queue = () => [entry('a', 'maya'), entry('b', 'theo')];
	const { deps } = harness(queue());
	const theo = harness(queue(), 'theo').deps;
	expect(validateCommand(cmd({ op: 'not-yet', id: 'b', toIdx: 2 }), theo)).toBe('invalid toIdx: 2');
	expect(validateCommand(cmd({ op: 'not-yet', id: 'a', toIdx: 0 }), deps)).toBe('invalid toIdx: 0');
	expect(validateCommand(cmd({ op: 'not-yet', id: 'b', toIdx: 1 }), deps)).toBe(
		'only the singer can change this entry'
	);
});

test('Not yet past my own next pick moves both picks behind the singer it names', () => {
	const { state, deps } = harness([entry('m1', 'maya'), entry('m2', 'maya'), entry('t1', 'theo')]);
	// Letting my own pick through lets nobody go first, so the server refuses it.
	expect(validateCommand(cmd({ op: 'not-yet', id: 'm1', toIdx: 1 }), deps)).toBe('invalid toIdx: 1');
	expect(handleQueueCommand(cmd({ op: 'not-yet', id: 'm1', toIdx: 2 }), deps)).not.toBeNull();
	expect(state.entries.map((e) => e.id)).toEqual(['t1', 'm1', 'm2']);
});

test('a client cannot mint a spent "Not yet": `deferred` is stripped from an add', () => {
	const { state, deps } = harness([]);
	expect(handleQueueCommand(cmd({ op: 'add', entry: entry('n', 'maya', { deferred: true }) }), deps)).not.toBeNull();
	expect(state.entries.find((e) => e.id === 'n')?.deferred).toBeUndefined();
});

// ---- persistence ----------------------------------------------------------------------------------------------

test('the preset and the spent deferral survive a reboot', () => {
	const { db } = openDb(':memory:');
	runMigrations(db);
	const state = new AuthoritativeState(sqlitePersistence(db, 'room1'));
	state.hydrate([entry('a', 'maya', { ...preset, deferred: true }), entry('b', 'theo')], null);
	state.flushNow();
	const rows = hydrate(db, 'room1').entries;
	expect(rows.find((e) => e.id === 'a')).toMatchObject({ keyShift: -2, guideLevel: 0.2, deferred: true });
	expect(rows.find((e) => e.id === 'b')).toMatchObject({ keyShift: 0, guideLevel: null, deferred: false });
});
