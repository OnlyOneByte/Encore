// Proposal 11: a song the TV cannot play moves the room on, and the turn KEEPS ITS SPOT. `failed` telemetry advances
// exactly as `ended` does, under the same entryId rule, but the entry goes back to `queued` with `playFailed` in the
// slot it already held, and the rotation skips it from there.
import { test, expect, jest } from 'bun:test';
import { read } from '$test';
import { HOLD_FALLBACK_MS, handlePlayerCommand, handleTelemetry, onTvHello } from '$lib/server/realtime/player';
import { handleQueueCommand, validateCommand, type HubDeps } from '$lib/server/realtime/hub';
import { nextPlayable, upNextAfter } from '$lib/server/rotation';
import { AuthoritativeState } from '$lib/server/state/store';
import { openDb } from '$lib/server/db/index';
import { runMigrations, hydrate } from '$lib/server/db/migrate';
import { sqlitePersistence } from '$lib/server/state/persistence';
import { nextPlayableEntryId } from '$lib/readiness';
import { EMPTY_SONG_PROFILE, type Media, type QueueEntry, type ServerEvent } from '$lib/contract';

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

/** Maya singing, then Theo, then Ana, then Maya's second song. */
function room() {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	state.hydrate([entry('maya', 'maya'), entry('theo', 'theo'), entry('ana', 'ana'), entry('maya2', 'maya')], null);
	const mediaById = new Map([['m1', media('m1')]]);
	const deps: HubDeps = { state, publish: (e) => published.push(e), mediaById, actorSingerId: 'theo' };
	handlePlayerCommand({ cmd: 'play' }, deps);
	handleTelemetry({ entryId: 'maya', positionSec: 100, ended: true }, deps); // Theo's song starts
	return { state, deps, published, mediaById };
}
const theo = (state: AuthoritativeState) => state.entries.find((e) => e.id === 'theo');
const order = (state: AuthoritativeState) => state.entries.map((e) => e.id);

test('failed moves the room on to the next singer, once', () => {
	const { state, deps } = room();
	expect(state.playback.currentEntryId).toBe('theo');
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
	expect(state.playback.currentEntryId).toBe('ana');
	// Held behind the TV's Skipped notice: Ana's song waits, paused, for the TV to say the notice cleared.
	expect(state.playback.isPlaying).toBe(false);
	// A repeat of the same frame names a song that is no longer current, so it moves nothing.
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
	expect(state.playback.currentEntryId).toBe('ana');
});

test('a failed turn is not sung: it stays queued, marked, in the slot it held', () => {
	const { state, deps } = room();
	const before = order(state);
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
	expect(theo(state)).toMatchObject({ status: 'queued', playFailed: true });
	// Nothing moved it: Theo is still ahead of everyone who was waiting behind him.
	expect(order(state)).toEqual(before);
});

test('the rotation holds a failed turn: never next, never up next, on the server and the phone alike', () => {
	const { state, deps, mediaById } = room();
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
	expect(upNextAfter('ana', state.entries, mediaById)?.id).toBe('maya2');
	expect(nextPlayable(state.entries, mediaById).next?.id).toBe('maya2');
	expect(nextPlayable(state.entries, mediaById).held.map((e) => e.id)).toEqual(['theo']);
	// The phone's mirror must agree, or /queue crowns a turn the TV will skip.
	const queued = state.entries.filter((e) => e.status === 'queued');
	expect(
		nextPlayableEntryId(
			queued,
			(id) => mediaById.get(id),
			() => undefined
		)
	).toBe('maya2');
	// Ana's song ends: the room skips past Theo's held turn rather than retrying it.
	handleTelemetry({ entryId: 'ana', positionSec: 100, ended: true }, deps);
	expect(state.playback.currentEntryId).toBe('maya2');
});

test('once the hold is lifted the turn plays straight after the current song, from the spot it kept', () => {
	const { state, deps, mediaById } = room();
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
	// PR 2's "Try again" clears the flag; the slot it kept is ahead of Maya's second song.
	const lifted = state.entries.map((e) => (e.id === 'theo' ? { ...e, playFailed: false } : e));
	expect(nextPlayable(lifted, mediaById).next?.id).toBe('theo');
});

test('failed is ignored without an entryId, and for an entry that is no longer current', () => {
	const { state, deps } = room();
	handleTelemetry({ positionSec: 0, failed: true }, deps);
	expect(state.playback.currentEntryId).toBe('theo');
	handleTelemetry({ entryId: 'maya', positionSec: 0, failed: true }, deps);
	expect(state.playback.currentEntryId).toBe('theo');
	expect(theo(state)?.status).toBe('playing');
});

test('a failure on the last song settles the room idle, with the turn still held', () => {
	const state = new AuthoritativeState();
	state.hydrate([entry('solo', 'theo')], null);
	const deps: HubDeps = { state, publish: () => {}, mediaById: new Map([['m1', media('m1')]]) };
	handlePlayerCommand({ cmd: 'play' }, deps);
	handleTelemetry({ entryId: 'solo', positionSec: 0, failed: true }, deps);
	expect(state.playback.currentEntryId).toBeNull();
	expect(state.playback.isPlaying).toBe(false);
	expect(state.entries).toMatchObject([{ id: 'solo', status: 'queued', playFailed: true }]);
});

test('only the TV may fail a song: a phone sending play-failed is refused', () => {
	const { deps } = room();
	expect(validateCommand({ clientOpId: 'c1', op: { op: 'play-failed', id: 'ana' } }, deps)).toBe(
		'play-failed is server-owned'
	);
});

test('a phone re-sending its add can neither lift a held turn nor mint one', () => {
	// From the code review of #994: the hub lets a still-queued id be re-added (the optimistic echo), and it spread the
	// client's entry as-is, so the re-send was a "Try again" with no button.
	const { state, deps } = room();
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
	const held = state.entries.find((e) => e.id === 'theo')!;
	const { playFailed: _drop, ...echo } = held;
	handleQueueCommand({ clientOpId: 'c-echo', op: { op: 'add', entry: { ...echo, playFailed: false } } }, deps);
	expect(state.entries.find((e) => e.id === 'theo')?.playFailed).toBe(true);
	handleQueueCommand({ clientOpId: 'c-bare', op: { op: 'add', entry: echo } }, deps);
	expect(state.entries.find((e) => e.id === 'theo')?.playFailed).toBe(true);
	const fresh = entry('theo2', 'theo', { playFailed: true });
	handleQueueCommand({ clientOpId: 'c-mint', op: { op: 'add', entry: fresh } }, deps);
	expect(state.entries.find((e) => e.id === 'theo2')?.playFailed).toBeUndefined();
});

test('a held failed turn survives a reboot', () => {
	const { db } = openDb(':memory:');
	runMigrations(db);
	const state = new AuthoritativeState(sqlitePersistence(db, 'room1'));
	state.hydrate([entry('a', 'theo', { playFailed: true }), entry('b', 'ana')], null);
	state.flushNow();
	const rows = hydrate(db, 'room1').entries;
	expect(rows.find((e) => e.id === 'a')).toMatchObject({ status: 'queued', playFailed: true });
	expect(rows.find((e) => e.id === 'b')).toMatchObject({ playFailed: false });
});

test('the wire carries it: the TV socket maps status "failed" to the failed telemetry, and the TV sends it', () => {
	expect(read('server.ts')).toContain("failed: evt.status === 'failed'");
	expect(read('server.ts')).toContain("resume: evt.status === 'resume'");
	// THE TV only (#990's seat): a copy's frames, hello and presence never fail, release or start a held song.
	const server = read('server.ts');
	expect(server).toContain('tvConnected: () => tvSeats.hasLiveHolder(app.activeRoomId)');
	expect(server.match(/if \(seated\(ws\)\) onTvHello\(deps\);/g)).toHaveLength(2); // the seat's hello, and a claim
	const telemetry = server.split("case 'tv:telemetry':")[1]?.split('handleTelemetry(')[0] ?? '';
	expect(telemetry).toContain('if (!seated(ws)) break;');
	const page = read('src/routes/tv/+page.svelte');
	const onFailed = page.split('function onVisibleFailed(failedId: string | null) {')[1]?.split('\n\t}\n')[0] ?? '';
	// Stamped with the failing slot's entry, and paused BEFORE the end: #988's swap would start the held song at once.
	expect(onFailed).toContain("onVisibleEnded(failedId, 'failed')");
	// The seat only: a copy's `failed` and `resume` are dropped, so a paused copy would never start again.
	const pause = 'if (seatMine === true) isPlaying = false;';
	expect(onFailed.indexOf(pause)).toBeGreaterThan(-1);
	expect(onFailed.indexOf(pause)).toBeLessThan(onFailed.indexOf('onVisibleEnded('));
	// The notice names the failing slot's singer, not `current`'s.
	expect(onFailed).toContain('const failed = [current, upNext].find((e) => e && e.id === failedId) ?? null;');
	expect(onFailed).toContain('singerName(failed?.singerId)');
	expect(page).toContain("sendTelemetry('resume', ctl.currentId);");
});

test('the TV lifts the hold when its notice clears, and only for the song it held', () => {
	const { state, deps, published } = room();
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
	handleTelemetry({ entryId: 'theo', positionSec: 0, resume: true }, deps); // names the failed song: ignored
	handleTelemetry({ positionSec: 0, resume: true }, deps); // names nothing: ignored
	expect(state.playback.isPlaying).toBe(false);
	published.length = 0;
	handleTelemetry({ entryId: 'ana', positionSec: 0, resume: true }, deps);
	expect(state.playback).toMatchObject({ currentEntryId: 'ana', isPlaying: true, positionSec: 0 });
	// Every phone anchors its playhead on this frame, which is when the TV's song actually starts.
	expect(published.some((e) => e.type === 'playback:state')).toBe(true);
	// Spent: a second resume does nothing after a phone pauses.
	handlePlayerCommand({ cmd: 'pause' }, deps);
	handleTelemetry({ entryId: 'ana', positionSec: 0, resume: true }, deps);
	expect(state.playback.isPlaying).toBe(false);
});

test('a phone that takes the transport during the hold outranks it; a key change does not', () => {
	const { state, deps } = room();
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
	handlePlayerCommand({ cmd: 'key', semitones: 1, entryId: 'ana' }, deps);
	handleTelemetry({ entryId: 'ana', positionSec: 0, resume: true }, deps);
	expect(state.playback.isPlaying).toBe(true); // the key tap left the hold for the TV to lift
	const second = room();
	handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, second.deps);
	handlePlayerCommand({ cmd: 'pause' }, second.deps);
	handleTelemetry({ entryId: 'ana', positionSec: 0, resume: true }, second.deps);
	expect(second.state.playback.isPlaying).toBe(false); // the phone's pause stands
});

test('only a failure holds: a song that ENDED hands straight to the next, playing', () => {
	const { state, deps } = room();
	handleTelemetry({ entryId: 'theo', positionSec: 100, ended: true }, deps);
	expect(state.playback).toMatchObject({ currentEntryId: 'ana', isPlaying: true });
});

/** Run `body` on a fake clock, restoring the real one whatever happens. */
function withFakeTimers(body: () => void): void {
	jest.useFakeTimers();
	try {
		body();
	} finally {
		jest.useRealTimers();
	}
}

test('a TV that never says resume (it dropped off mid-notice) does not leave the song paused for good', () => {
	expect(HOLD_FALLBACK_MS).toBe(6_000); // the notice's 4 s plus 2 s of grace
	withFakeTimers(() => {
		const { state, deps, published } = room();
		handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
		published.length = 0;
		jest.advanceTimersByTime(HOLD_FALLBACK_MS - 1);
		expect(state.playback.isPlaying).toBe(false);
		jest.advanceTimersByTime(1);
		expect(state.playback).toMatchObject({ currentEntryId: 'ana', isPlaying: true });
		// Every phone hears it, and anchors its playhead there.
		expect(published.filter((e) => e.type === 'playback:state')).toHaveLength(1);
	});
});

test('the fallback stands down once the TV has resumed, so it cannot undo a later pause', () => {
	withFakeTimers(() => {
		const { state, deps } = room();
		handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
		jest.advanceTimersByTime(4_000);
		handleTelemetry({ entryId: 'ana', positionSec: 0, resume: true }, deps);
		handlePlayerCommand({ cmd: 'pause' }, deps);
		jest.advanceTimersByTime(HOLD_FALLBACK_MS);
		expect(state.playback.isPlaying).toBe(false);
	});
});

test('a phone that pauses or skips during the hold outranks the fallback too', () => {
	withFakeTimers(() => {
		const paused = room();
		handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, paused.deps);
		handlePlayerCommand({ cmd: 'pause' }, paused.deps);
		jest.advanceTimersByTime(HOLD_FALLBACK_MS);
		expect(paused.state.playback.isPlaying).toBe(false);
		// Skipped past the held song: the fallback must not start whatever is current now from under its own rules.
		const skipped = room();
		handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, skipped.deps);
		handlePlayerCommand({ cmd: 'skip', entryId: 'ana' }, skipped.deps);
		handlePlayerCommand({ cmd: 'pause' }, skipped.deps);
		jest.advanceTimersByTime(HOLD_FALLBACK_MS);
		expect(skipped.state.playback).toMatchObject({ currentEntryId: 'maya2', isPlaying: false });
	});
});

test('the fallback starts the held song while a TV is connected', () => {
	withFakeTimers(() => {
		const { state, deps } = room();
		deps.tvConnected = () => true;
		handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
		jest.advanceTimersByTime(HOLD_FALLBACK_MS);
		expect(state.playback).toMatchObject({ currentEntryId: 'ana', isPlaying: true });
	});
});

test('with NO TV connected the fallback leaves the room paused, says nothing, and the next TV to say hello starts it', () => {
	// The owner's ruling on the r3 UI review of #994: a song nobody can hear is not started, so no phone shows it
	// playing or buzzes "You're up" for it; a TV that comes back starts it from 0, with its card, in step with the phones.
	withFakeTimers(() => {
		const { state, deps, published } = room();
		let tv = true;
		deps.tvConnected = () => tv;
		handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
		tv = false; // the TV goes during the notice
		published.length = 0;
		jest.advanceTimersByTime(HOLD_FALLBACK_MS * 3);
		expect(state.playback).toMatchObject({ currentEntryId: 'ana', isPlaying: false, positionSec: 0 });
		expect(published.filter((e) => e.type === 'playback:state')).toHaveLength(0);
		tv = true;
		onTvHello(deps);
		expect(state.playback).toMatchObject({ currentEntryId: 'ana', isPlaying: true, positionSec: 0 });
		expect(published.filter((e) => e.type === 'playback:state')).toHaveLength(1);
		onTvHello(deps); // a second TV, or the same one again: once only
		expect(published.filter((e) => e.type === 'playback:state')).toHaveLength(1);
	});
});

test('a TV saying hello INSIDE the hold changes nothing: the TV that raised the notice, or the fallback, starts it', () => {
	withFakeTimers(() => {
		const { state, deps } = room();
		deps.tvConnected = () => true;
		handleTelemetry({ entryId: 'theo', positionSec: 0, failed: true }, deps);
		jest.advanceTimersByTime(1_000);
		onTvHello(deps);
		expect(state.playback.isPlaying).toBe(false);
		jest.advanceTimersByTime(HOLD_FALLBACK_MS);
		expect(state.playback.isPlaying).toBe(true);
	});
});
