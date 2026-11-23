// Proposal 11, PR 2: the singer's way back from a song the TV could not play. "Try again" lifts the held turn, which
// plays next from the spot it kept; a song that fails twice offers only "Pick another", which swaps the song in the
// same turn and starts its count again.
import { test, expect, jest } from 'bun:test';
import { HOLD_FALLBACK_MS, handlePlayerCommand, handleTelemetry, reconcileOnReady } from '$lib/server/realtime/player';
import { handleQueueCommand, validateCommand, type HubDeps } from '$lib/server/realtime/hub';
import { nextPlayable } from '$lib/server/rotation';
import { AuthoritativeState } from '$lib/server/state/store';
import { openDb } from '$lib/server/db/index';
import { runMigrations, hydrate } from '$lib/server/db/migrate';
import { sqlitePersistence } from '$lib/server/state/persistence';
import { EMPTY_SONG_PROFILE, canRetryPlay, type Media, type QueueEntry } from '$lib/contract';

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

/** Maya singing, then Theo, then Ana, then Maya's second song. Theo's phone is the actor. */
function room(ids = ['maya', 'theo', 'ana', 'maya2']) {
	const state = new AuthoritativeState();
	state.hydrate(
		ids.map((id) => entry(id, id.replace(/\d$/, ''))),
		null
	);
	const mediaById = new Map([
		['m1', media('m1')],
		['m2', media('m2')]
	]);
	const deps: HubDeps = { state, publish: () => {}, mediaById, actorSingerId: 'theo' };
	handlePlayerCommand({ cmd: 'play' }, deps);
	return { state, deps };
}
const byId = (state: AuthoritativeState, id: string) => state.entries.find((e) => e.id === id)!;
let op = 0;
/** A queue command as server.ts runs it: the hub, then `reconcileOnReady`. */
function send(deps: HubDeps, o: Parameters<typeof handleQueueCommand>[0]['op']) {
	const patch = handleQueueCommand({ clientOpId: `c${++op}`, op: o }, deps);
	reconcileOnReady(deps);
	return patch;
}
/** Run `body` on a fake clock, restoring the real one whatever happens. */
function withFakeTimers(body: () => void): void {
	jest.useFakeTimers();
	try {
		body();
	} finally {
		jest.useRealTimers();
	}
}

test('Try again lifts the hold, and the song plays straight after the current one, from the spot it kept', () => {
	const { state, deps } = room();
	handleTelemetry({ entryId: 'maya', positionSec: 100, ended: true }, deps); // Theo's song starts
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps); // and fails: Ana is current
	expect(nextPlayable(state.entries, deps.mediaById).next?.id).toBe('maya2');
	expect(send(deps, { op: 'retry-play', id: 'theo' })).not.toBeNull();
	expect(byId(state, 'theo')).toMatchObject({ status: 'queued', playFailed: false, playFailures: 1 });
	expect(nextPlayable(state.entries, deps.mediaById).next?.id).toBe('theo');
	// Ana sings on: the retry moved nobody.
	expect(state.playback.currentEntryId).toBe('ana');
	handleTelemetry({ entryId: 'ana', positionSec: 100, ended: true }, deps);
	expect(state.playback.currentEntryId).toBe('theo');
});

test('Try again in an idle room starts the song at once', () => {
	const { state, deps } = room(['theo']);
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
	expect(state.playback.currentEntryId).toBeNull();
	send(deps, { op: 'retry-play', id: 'theo' });
	expect(state.playback).toMatchObject({ currentEntryId: 'theo', isPlaying: true });
});

test('a second failure of the same song takes Try again away; Pick another is still offered', () => {
	const { state, deps } = room(['theo', 'ana']);
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
	expect(canRetryPlay(byId(state, 'theo'))).toBe(true);
	send(deps, { op: 'retry-play', id: 'theo' });
	handleTelemetry({ entryId: 'ana', positionSec: 100, ended: true }, deps); // Theo again
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps); // fails again
	expect(byId(state, 'theo')).toMatchObject({ playFailed: true, playFailures: 2 });
	expect(canRetryPlay(byId(state, 'theo'))).toBe(false);
	expect(validateCommand({ clientOpId: 'x', op: { op: 'retry-play', id: 'theo' } }, deps)).toBe(
		'this song failed twice; pick another'
	);
	expect(
		validateCommand({ clientOpId: 'y', op: { op: 'replace-media', id: 'theo', mediaId: 'm2', keyShift: 0 } }, deps)
	).toBeNull();
});

test('Pick another lifts the hold and starts the count again, in the same spot', () => {
	const { state, deps } = room();
	handleTelemetry({ entryId: 'maya', positionSec: 100, ended: true }, deps);
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
	const seq = byId(state, 'theo').rotationSeq;
	send(deps, { op: 'replace-media', id: 'theo', mediaId: 'm2', keyShift: 0 });
	expect(byId(state, 'theo')).toMatchObject({ mediaId: 'm2', playFailed: false, playFailures: 0, rotationSeq: seq });
	expect(nextPlayable(state.entries, deps.mediaById).next?.id).toBe('theo');
});

test('Try again is refused on a turn that is not held', () => {
	const { deps } = room();
	expect(validateCommand({ clientOpId: 'x', op: { op: 'retry-play', id: 'theo' } }, deps)).toBe(
		'this turn is not held'
	);
	expect(validateCommand({ clientOpId: 'x', op: { op: 'retry-play', id: 'ghost' } }, deps)).toBe(
		'unknown entry: ghost'
	);
});

test('Try again is the singer’s own: another phone, the TV and a cookieless socket are refused', () => {
	// From the #1047 review: it was gated on `queue:reorder-any`, which every joined singer holds, so Ana could spend
	// Theo's one Try again. It is owner-only now, like the On deck ops, with no `-any` capability.
	const { state, deps } = room();
	handleTelemetry({ entryId: 'maya', positionSec: 100, ended: true }, deps);
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
	const retry = { op: 'retry-play' as const, id: 'theo' };
	// Ana's phone: her own session, not Theo's turn.
	expect(send({ ...deps, actorSingerId: 'ana' }, retry)).toBeNull();
	expect(validateCommand({ clientOpId: 'a', op: retry }, { ...deps, actorSingerId: 'ana' })).toBe(
		'only the singer can change this entry'
	);
	// The TV's socket and a cookieless one both reach the hub with no singer session.
	expect(validateCommand({ clientOpId: 't', op: retry }, { ...deps, actorSingerId: undefined })).toBe(
		'join the room first'
	);
	expect(byId(state, 'theo')).toMatchObject({ playFailed: true, playFailures: 1 });
	// Theo's own is accepted.
	expect(send(deps, retry)).not.toBeNull();
	expect(byId(state, 'theo').playFailed).toBe(false);
});

test('Pick another on a HELD turn is the singer’s own too: nobody else can lift the hold with a swap', () => {
	// From the #1047 r2 review: `replace-media` lifts the hold and only asked for `remove-any`, so Ana could "pick" Theo's
	// own dead song for him (a Try again by another name), or any other song, and put him ahead of whoever is On deck.
	const { state, deps } = room();
	handleTelemetry({ entryId: 'maya', positionSec: 100, ended: true }, deps);
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
	const ana = { ...deps, actorSingerId: 'ana' };
	for (const mediaId of ['m1', 'm2']) {
		const swap = { op: 'replace-media' as const, id: 'theo', mediaId, keyShift: 0 };
		expect(validateCommand({ clientOpId: `s-${mediaId}`, op: swap }, ana)).toBe(
			'only the singer can change this entry'
		);
		expect(send(ana, swap)).toBeNull();
		expect(validateCommand({ clientOpId: `n-${mediaId}`, op: swap }, { ...deps, actorSingerId: undefined })).toBe(
			'join the room first'
		);
	}
	expect(byId(state, 'theo')).toMatchObject({ mediaId: 'm1', playFailed: true, playFailures: 1 });
	// A turn that is NOT held keeps #970's rule: another singer may still swap it (`remove-any`).
	expect(
		validateCommand({ clientOpId: 'm', op: { op: 'replace-media', id: 'maya2', mediaId: 'm2', keyShift: 0 } }, ana)
	).toBeNull();
	// Theo's own swap lifts it.
	expect(send(deps, { op: 'replace-media', id: 'theo', mediaId: 'm2', keyShift: 0 })).not.toBeNull();
	expect(byId(state, 'theo').playFailed).toBe(false);
});

test('Try again passes the singer’s own turn ahead of whoever is On deck: it moves nothing', () => {
	const { state, deps } = room(['maya', 'theo', 'ana', 'bo']);
	handleTelemetry({ entryId: 'maya', positionSec: 100, ended: true }, deps);
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps); // Ana sings, Bo is On deck
	const before = state.entries.map((e) => `${e.id}:${e.rotationSeq}`);
	expect(send(deps, { op: 'retry-play', id: 'theo' })).not.toBeNull();
	expect(state.entries.map((e) => `${e.id}:${e.rotationSeq}`)).toEqual(before);
	expect(nextPlayable(state.entries, deps.mediaById).next?.id).toBe('theo');
});

test('Pick another with the SAME song keeps the count: it is a Try again, under the same limit', () => {
	const { state, deps } = room(['theo', 'ana']);
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
	send(deps, { op: 'replace-media', id: 'theo', mediaId: 'm1', keyShift: 0 });
	expect(byId(state, 'theo')).toMatchObject({ playFailed: false, playFailures: 1 });
	handleTelemetry({ entryId: 'ana', positionSec: 100, ended: true }, deps);
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
	expect(byId(state, 'theo')).toMatchObject({ playFailed: true, playFailures: 2 });
	expect(
		validateCommand({ clientOpId: 's', op: { op: 'replace-media', id: 'theo', mediaId: 'm1', keyShift: 0 } }, deps)
	).toBe('this song failed twice; pick another');
	// A different song is a new chance.
	send(deps, { op: 'replace-media', id: 'theo', mediaId: 'm2', keyShift: 0 });
	expect(byId(state, 'theo')).toMatchObject({ mediaId: 'm2', playFailed: false, playFailures: 0 });
});

test('a re-sent add cannot buy back a spent Try again', () => {
	const { state, deps } = room(['theo', 'ana']);
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
	const held = byId(state, 'theo');
	send(deps, { op: 'add', entry: { ...held, playFailed: false, playFailures: 0 } });
	expect(byId(state, 'theo')).toMatchObject({ playFailed: true, playFailures: 1 });
});

test('the failure count survives a reboot', () => {
	const { db } = openDb(':memory:');
	runMigrations(db);
	const state = new AuthoritativeState(sqlitePersistence(db, 'room1'));
	state.hydrate([entry('a', 'theo', { playFailed: true, playFailures: 2 }), entry('b', 'ana')], null);
	state.flushNow();
	const rows = hydrate(db, 'room1').entries;
	expect(rows.find((e) => e.id === 'a')).toMatchObject({ playFailed: true, playFailures: 2 });
	expect(rows.find((e) => e.id === 'b')).toMatchObject({ playFailures: 0 });
});

test('the hold fallback is keyed by the hold: an earlier timer never starts the same song held again', () => {
	// From the r3 code review of #994. Try again lets one entry be held twice inside one fallback window, and a timer
	// keyed by the entry would start the second hold early, under the TV's Skipped notice.
	withFakeTimers(() => {
		const { state, deps } = room(['maya', 'theo', 'ana']);
		handleTelemetry({ entryId: 'maya', positionSec: 0, failed: true }, deps); // t0: Theo held (1st)
		jest.advanceTimersByTime(1_000);
		handlePlayerCommand({ cmd: 'play' }, deps); // a phone starts Theo
		jest.advanceTimersByTime(1_000);
		handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps); // Ana held
		jest.advanceTimersByTime(500);
		send(deps, { op: 'retry-play', id: 'theo' });
		jest.advanceTimersByTime(500);
		handlePlayerCommand({ cmd: 'play' }, deps); // a phone starts Ana
		jest.advanceTimersByTime(1_000);
		handleTelemetry({ entryId: 'ana', positionSec: 0, failed: true }, deps); // t0+4 s: Theo held (2nd)
		expect(state.playback).toMatchObject({ currentEntryId: 'theo', isPlaying: false });
		jest.advanceTimersByTime(2_000); // t0+6 s: the FIRST hold's timer
		expect(state.playback.isPlaying).toBe(false);
		jest.advanceTimersByTime(HOLD_FALLBACK_MS - 2_000); // the second hold's own
		expect(state.playback).toMatchObject({ currentEntryId: 'theo', isPlaying: true });
	});
});
