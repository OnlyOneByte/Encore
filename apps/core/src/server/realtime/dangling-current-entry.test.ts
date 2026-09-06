// Regression for issue #128: removing the song that is CURRENTLY PLAYING via the client-driven queue
// path (a `remove`/`status` op through the hub) leaves playback.currentEntryId pointing at an entry
// that no longer exists. Because every auto-start gate is written as `!currentEntryId`, that dangling
// (non-null) id reads as "a song is playing" while nothing is — so the music stops and the rotation
// never advances.
//
// The fix moves the invariant "currentEntryId resolves to a live entry" into the authoritative
// recovery path: the server fires reconcileOnReady whenever the current id no longer RESOLVES (not
// just when it is null), and reconcileOnReady advances to the next singer, or settles the room to
// idle when none is ready. These tests exercise the exact server.ts composition, plus the boot-time
// self-heal in AuthoritativeState.hydrate().
import { test, expect } from 'bun:test';
import { handleQueueCommand, type HubDeps } from './hub';
import { reconcileOnReady } from './player';
import { AuthoritativeState } from '../state/store';
import { type ServerEvent, type Media, type QueueEntry, type ClientCommand, type PlaybackState } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';

const media = (id: string): Media => ({ id, source: 'youtube', sourceRef: 'x', title: id, durationSec: 100, stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: 'derived/stems/i-instrumental.flac', songProfile: EMPTY_SONG_PROFILE });
let _s = 0;
const addCmd = (id: string, mediaId: string): ClientCommand => ({
	clientOpId: 'add-' + id + '-' + ++_s,
	baseRev: 0,
	op: { op: 'add', entry: { id, mediaId, singerId: 's1', status: 'queued', rotationSeq: -1, addedAt: ++_s } as QueueEntry }
});
const removeCmd = (id: string): ClientCommand => ({ clientOpId: 'rm-' + id + '-' + ++_s, baseRev: 0, op: { op: 'remove', id } });

function harness() {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = { state, publish: (e) => published.push(e), mediaById: new Map([['m1', media('m1')], ['m2', media('m2')]]), actorSingerId: 's1' };
	return { published, state, deps };
}

// mirrors the server.ts queue:command handler AFTER the #128 fix: the auto-start/recover gate keys
// on whether currentEntryId RESOLVES to a live entry, not on it merely being non-null.
function queueThenReconcile(cmd: ClientCommand, deps: HubDeps) {
	handleQueueCommand(cmd, deps);
	if (!deps.state.entries.some((e) => e.id === deps.state.playback.currentEntryId)) reconcileOnReady(deps);
}

test('removing the PLAYING entry advances the rotation to the next singer', () => {
	const { state, deps, published } = harness();
	queueThenReconcile(addCmd('q1', 'm1'), deps); // q1 auto-starts
	queueThenReconcile(addCmd('q2', 'm2'), deps); // q2 queues behind it
	expect(state.playback.currentEntryId).toBe('q1');
	expect(state.entries.find((e) => e.id === 'q2')!.status).toBe('queued');

	// A guest removes the currently-playing q1 (the reachable trigger in the issue).
	queueThenReconcile(removeCmd('q1'), deps);

	// The invariant holds: current resolves to a LIVE entry, and it is the next singer's song.
	expect(state.entries.some((e) => e.id === state.playback.currentEntryId)).toBe(true);
	expect(state.playback.currentEntryId).toBe('q2');
	expect(state.playback.isPlaying).toBe(true);
	expect(state.entries.find((e) => e.id === 'q2')!.status).toBe('playing');
	// The room does not falsely claim to be playing a now-deleted song.
	const np = published.filter((e) => e.type === 'nowplaying:changed').at(-1) as Extract<ServerEvent, { type: 'nowplaying:changed' }>;
	expect(np.current?.id).toBe('q2');
});

test('removing the PLAYING entry when it is the only one settles the room to genuinely idle', () => {
	const { state, deps, published } = harness();
	queueThenReconcile(addCmd('q1', 'm1'), deps); // q1 auto-starts, only entry
	expect(state.playback.currentEntryId).toBe('q1');

	queueThenReconcile(removeCmd('q1'), deps);

	// No dangling id: current is cleared to null so the `!currentEntryId` gates unstick and the next
	// add will auto-start again.
	expect(state.playback.currentEntryId).toBeNull();
	expect(state.playback.isPlaying).toBe(false);
	const np = published.filter((e) => e.type === 'nowplaying:changed').at(-1) as Extract<ServerEvent, { type: 'nowplaying:changed' }>;
	expect(np.current).toBeNull();

	// Proof the room actually unstuck: a fresh add auto-starts, which a dangling id would have blocked.
	queueThenReconcile(addCmd('q3', 'm2'), deps);
	expect(state.playback.currentEntryId).toBe('q3');
	expect(state.playback.isPlaying).toBe(true);
});

test('hydrate() drops a persisted currentEntryId that does not resolve to a loaded entry', () => {
	const state = new AuthoritativeState();
	// A room persisted mid-bug: playback names q1, but q1 is not among the stored entries (it was
	// pruned before the snapshot). persist() writes entries and playback from one snapshot, so the
	// dangling pair round-trips verbatim unless hydrate self-heals.
	const entries: QueueEntry[] = [
		{ id: 'q2', mediaId: 'm2', singerId: 's1', status: 'queued', rotationSeq: 0, addedAt: 2 } as QueueEntry
	];
	const playback: PlaybackState = {
		currentEntryId: 'q1',
		positionSec: 42,
		isPlaying: true,
		keyShift: 0,
		background: null,
		guideLevel: null
	};
	state.hydrate(entries, playback);

	expect(state.playback.currentEntryId).toBeNull();
	expect(state.playback.isPlaying).toBe(false);
});

test('hydrate() leaves a currentEntryId that DOES resolve untouched', () => {
	const state = new AuthoritativeState();
	const entries: QueueEntry[] = [
		{ id: 'q1', mediaId: 'm1', singerId: 's1', status: 'playing', rotationSeq: 0, addedAt: 1 } as QueueEntry
	];
	const playback: PlaybackState = { currentEntryId: 'q1', positionSec: 10, isPlaying: true, keyShift: 0, background: null, guideLevel: null };
	state.hydrate(entries, playback);
	expect(state.playback.currentEntryId).toBe('q1');
	expect(state.playback.isPlaying).toBe(true);
	expect(state.playback.positionSec).toBe(10);
});

// SOURCE-SCAN GUARD for the trigger line (server.ts). The behavioural cases above drive a mirror of
// the server's queue:command composition, so they pin `reconcileOnReady`'s recovery logic but NOT
// the one production line that FIRES it — apps/core/server.ts is the Bun.serve entry with no unit
// harness, and reverting its gate to the pre-fix `!currentEntryId` form leaves the whole suite green
// while resurrecting issue #128 (the recovery never fires on the reported path). This scan pins that
// gate to key on RESOLUTION rather than nullness, on the live writer, the same technique
// session-cookie-attributes.test.ts (#107) uses on routes/api/join/+server.ts, a file with the
// identical no-harness problem. Comments are blanked so a commented-out gate cannot satisfy it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server/realtime → apps/core/server.ts is three levels up.
const SERVER = stripComments(readFileSync(join(import.meta.dir, '..', '..', '..', 'server.ts'), 'utf8'));

test('server.ts recovers a DANGLING currentEntryId after a queue:command, keying on resolution not nullness (#128)', () => {
	// The recovery must be wired to the client queue path (handleQueueCommand is the sole prune that
	// can retire the playing entry) and fire reconcileOnReady.
	expect(SERVER).toMatch(/handleQueueCommand\(/);
	expect(SERVER).toMatch(/reconcileOnReady\(deps\)/);
	// THE PINNED LINE: the gate tests whether the current id RESOLVES to a live entry
	// (`!entries.some((e) => e.id === currentEntryId)`), so a dangling (non-null) id triggers
	// recovery. The pre-fix `!state.playback.currentEntryId` form — which reads a dangling id as
	// "busy" and never recovers — must NOT be what guards the call.
	expect(SERVER).toMatch(
		/if\s*\(\s*!state\.entries\.some\(\s*\(e\)\s*=>\s*e\.id\s*===\s*state\.playback\.currentEntryId\s*\)\s*\)\s*reconcileOnReady\(deps\)/
	);
});

// SOURCE-SCAN GUARD for the hydrate() heal comment (store.ts) — issue #254.
// The heal at store.ts drops a dangling currentEntryId and sets isPlaying:false, which UNJAMS the
// `!currentEntryId` auto-start gates but starts nothing: there is no boot resync and no boot
// reconcile, so at hydrate time the room is left genuinely idle with a possibly-ready queue.
// Recovery only happens later, on the next real event that runs reconcileOnReady (a queue:command,
// a cook completing, or a manual play). The pre-#254 comment CLAIMED "the boot resync/reconcile then
// starts the next singer" — a boot reconcile that does not exist — which is exactly the false premise
// that would stop the next developer from noticing the gap. A comment is not machine-checkable by
// running it, so pin it here: the raw store.ts text must NOT re-assert a boot resync/reconcile that
// starts anything, and MUST name the three real recovery sites. Read RAW (not stripComments): the
// assertions are ABOUT the comment, so blanking comments would make every check vacuous.
const STORE = readFileSync(join(import.meta.dir, '..', 'state', 'store.ts'), 'utf8');

test("hydrate()'s heal comment (store.ts) tells the truth about boot recovery (#254)", () => {
	// Non-vacuous: the heal the comment describes must actually be present, or the checks below
	// would pass against a file that no longer has the code they document.
	expect(STORE).toMatch(/currentEntryId:\s*null,\s*isPlaying:\s*false/);
	expect(STORE).toContain('Self-heal a persisted DANGLING currentEntryId (issue #128)');

	// THE PINNED FALSEHOOD. The retired comment claimed "the boot resync/reconcile then starts the
	// next singer" — asserting a boot-time resync/reconcile that STARTS/recovers a singer. No such
	// boot-time reconcile exists. Reinstating that claim must red this test. Match the AFFIRMATIVE
	// over-promise: a "boot resync"/"boot reconcile" whose SAME clause (no newline between) carries a
	// start/recover/advance verb acting on a singer/room. The corrected comment legitimately DENIES a
	// boot reconcile ("there is no boot resync or boot reconcile, so nothing starts a singer"), so a
	// blunt word-scan is deliberately NOT used — that would forbid even saying it does not exist.
	// STORE is read RAW (not stripComments) because the comment text IS the subject here.
	const bootPromisesStart =
		/boot\s+(?:resync|reconcile)[^\n]*\b(?:start|starts|recover|recovers|advance|advances)\b[^\n]*\b(?:singer|room|playback|song)\b/i;
	expect(STORE).not.toMatch(bootPromisesStart);

	// And the corrected comment must AFFIRM there is no boot-time reconcile, and name the three REAL
	// recovery sites so the next reader is pointed at what actually restarts the room.
	// wrap-tolerant: the comment may line-wrap between tokens, so allow `//`, tabs and newlines
	// between words (the phrase spans two comment lines in the source).
	expect(STORE).toMatch(/no(?:\s|\/\/)+boot(?:\s|\/\/)+resync(?:\s|\/\/)+or(?:\s|\/\/)+boot(?:\s|\/\/)+reconcile/i);
	expect(STORE).toContain('queue:command');
	expect(STORE).toContain('onMediaReady');
	expect(STORE).toContain('manual play');
});
