// Regression for the dangling currentEntryId defect: removing the song that is CURRENTLY PLAYING via the client-driven queue
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
let _s = 0;
const addCmd = (id: string, mediaId: string): ClientCommand => ({
	clientOpId: 'add-' + id + '-' + ++_s,
	op: {
		op: 'add',
		entry: { id, mediaId, singerId: 's1', status: 'queued', rotationSeq: -1, addedAt: ++_s } as QueueEntry
	}
});
const removeCmd = (id: string): ClientCommand => ({ clientOpId: 'rm-' + id + '-' + ++_s, op: { op: 'remove', id } });

function harness() {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map([
			['m1', media('m1')],
			['m2', media('m2')]
		]),
		actorSingerId: 's1'
	};
	return { published, state, deps };
}

// mirrors the server.ts queue:command handler AFTER the predicate de-duplication: the arm calls reconcileOnReady
// UNCONDITIONALLY and does not re-derive the recovery predicate — reconcileOnReady owns that decision
// (player.ts), and its tail emitNowPlaying sits outside the recovery block so the "current resolves"
// case is a re-emit with no double broadcast. The predicate itself is exercised through
// reconcileOnReady rather than copied here, which is the point of that de-duplication.
function queueThenReconcile(cmd: ClientCommand, deps: HubDeps) {
	handleQueueCommand(cmd, deps);
	reconcileOnReady(deps);
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
	const np = published.filter((e) => e.type === 'nowplaying:changed').at(-1) as Extract<
		ServerEvent,
		{ type: 'nowplaying:changed' }
	>;
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
	const np = published.filter((e) => e.type === 'nowplaying:changed').at(-1) as Extract<
		ServerEvent,
		{ type: 'nowplaying:changed' }
	>;
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
	const playback: PlaybackState = {
		currentEntryId: 'q1',
		positionSec: 10,
		isPlaying: true,
		keyShift: 0,
		background: null,
		guideLevel: null
	};
	state.hydrate(entries, playback);
	expect(state.playback.currentEntryId).toBe('q1');
	expect(state.playback.isPlaying).toBe(true);
	expect(state.playback.positionSec).toBe(10);
});

// SOURCE-SCAN GUARD for the trigger line (server.ts). The behavioural cases above drive a mirror of
// the server's queue:command composition, so they pin `reconcileOnReady`'s recovery logic but NOT
// the one production line that FIRES it — apps/core/server.ts is the Bun.serve entry with no unit
// harness, and reverting its call to the pre-fix `if (!currentEntryId)` form leaves the whole suite
// green while resurrecting the dangling id (the recovery never fires on the reported path). This scan pins
// that the arm FIRES the recovery, and that the recovery predicate keys on RESOLUTION rather than
// nullness — the latter now asserted at player.ts, which is where the de-duplication made the predicate live in
// exactly one place. Same technique as session-cookie-attributes.test.ts on
// routes/api/join/+server.ts, a file with the identical no-harness problem. Comments are blanked so a
// commented-out call cannot satisfy it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server/realtime → apps/core/server.ts is three levels up.
const SERVER = stripComments(readFileSync(join(import.meta.dir, '..', '..', '..', 'server.ts'), 'utf8'));
const PLAYER = stripComments(readFileSync(join(import.meta.dir, 'player.ts'), 'utf8'));

test('server.ts recovers a DANGLING currentEntryId after a queue:command, keying on resolution not nullness', () => {
	// The recovery must be wired to the client queue path (handleQueueCommand is the sole prune that
	// can retire the playing entry) and fire reconcileOnReady.
	expect(SERVER).toMatch(/handleQueueCommand\(/);
	expect(SERVER).toMatch(/reconcileOnReady\(deps\)/);
	// THE PINNED PREDICATE, now at its single home. The gate tests whether the current id
	// RESOLVES to a live entry (`!entries.some((e) => e.id === currentEntryId)`), so a dangling
	// (non-null) id triggers recovery. The pre-fix `!state.playback.currentEntryId` form — which reads
	// a dangling id as "busy" and never recovers — must NOT be what guards the recovery block.
	// It is asserted on player.ts because the de-duplication deleted server.ts's second copy: server.ts used to
	// re-derive this same predicate to decide whether to CALL reconcileOnReady, so widening one copy
	// and not the other was invisible to the suite. The caller now delegates unconditionally.
	const fnIdx = PLAYER.indexOf('export function reconcileOnReady(');
	expect(fnIdx).toBeGreaterThanOrEqual(0);
	const body = PLAYER.slice(fnIdx);
	// the predicate is now the shared `entryResolves` helper (state/store.ts); recovery keys on
	// its result. Pin the CALL, not a re-inlined `.some(...)` — a re-inlined copy here would be the
	// drift the shared entryResolves helper removed.
	expect(body).toMatch(
		/const currentResolves = entryResolves\(\s*state\.entries\s*,\s*state\.playback\.currentEntryId\s*\)/
	);
	expect(body).toMatch(/if\s*\(\s*!currentResolves\s*\)/);
	// The caller must NOT carry a second copy of it — that duplication IS what was de-duplicated, and re-adding it makes
	// the silent-half-edit hazard live again.
	expect(SERVER).not.toMatch(/\.some\(\s*\(e\)\s*=>\s*e\.id\s*===\s*[\w.]*playback\.currentEntryId/);

	// THE PINNED ORDER: presence of the call is not enough — it must run AFTER
	// handleQueueCommand, which is the prune that retires the playing entry. If it is hoisted ABOVE
	// the call it evaluates the PRE-remove state (the playing id still resolves), so recovery never
	// fires and the dangling id re-opens with every assertion above still green. Slice the queue:command arm out
	// of the comment-blanked SERVER and require the reconcile's index inside that arm to be greater
	// than the handleQueueCommand(evt.command call's — which also pins the reconcile is inside the
	// queue:command arm at all, not merely somewhere in the file.
	const caseIdx = SERVER.indexOf("case 'queue:command':");
	expect(caseIdx).toBeGreaterThanOrEqual(0);
	const breakIdx = SERVER.indexOf('break;', caseIdx);
	expect(breakIdx).toBeGreaterThan(caseIdx);
	const arm = SERVER.slice(caseIdx, breakIdx);
	const callIdx = arm.search(/handleQueueCommand\(evt\.command/);
	const reconcileIdx = arm.search(/reconcileOnReady\(deps\)/);
	expect(callIdx).toBeGreaterThanOrEqual(0);
	expect(reconcileIdx).toBeGreaterThanOrEqual(0);
	expect(reconcileIdx).toBeGreaterThan(callIdx);
});

// SOURCE-SCAN GUARD for the hydrate() heal comment (store.ts).
// The heal at store.ts drops a dangling currentEntryId and sets isPlaying:false, which UNJAMS the
// `!currentEntryId` auto-start gates but starts nothing: there is no boot resync and no boot
// reconcile, so at hydrate time the room is left genuinely idle with a possibly-ready queue.
// Recovery only happens later, on the next real event that runs reconcileOnReady (a queue:command,
// a cook completing, or a manual play). The pre-fix comment CLAIMED "the boot resync/reconcile then
// starts the next singer" — a boot reconcile that does not exist — which is exactly the false premise
// that would stop the next developer from noticing the gap. A comment is not machine-checkable by
// running it, so pin it here: the raw store.ts text must NOT re-assert a boot resync/reconcile that
// starts anything, and MUST name the three real recovery sites. Read RAW (not stripComments): the
// assertions are ABOUT the comment, so blanking comments would make every check vacuous.
const STORE = readFileSync(join(import.meta.dir, '..', 'state', 'store.ts'), 'utf8');

test("hydrate()'s heal comment (store.ts) tells the truth about boot recovery", () => {
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
// STRUCTURAL-TRUTH GUARD for the heal comment.
// The spelling guard above pins how store.ts's comment is SPELLED (its prose must deny a boot reconcile
// and name the three real recovery sites). It does not pin whether that prose is TRUE, because every
// assertion reads store.ts as text and the facts live in other files. The comment's load-bearing
// claim — "there is no boot resync or boot reconcile, so nothing starts a singer at hydrate time" —
// is a claim about reconcileOnReady's call sites in apps/core, not about store.ts. So the moment a
// later product decision adds the boot reconcile that correction deliberately quarantined ("DO NOT add a
// reconcileOnReady call ... a rebooted room starts playing audio unprompted is a product call the
// owner has not made"), the comment is false again — the exact false-premise defect the correction removed — and the
// spelling guard above stays green. Pin the STRUCTURE here instead.
//
// import.meta.dir === apps/core/src/server/realtime → apps/core is three levels up, apps/core/src two.
const CORE_ROOT = join(import.meta.dir, '..', '..', '..');
const SRC_ROOT = join(import.meta.dir, '..', '..');

function collectNonTestSources(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			if (['node_modules', '.svelte-kit', 'build', 'dist'].includes(name)) continue;
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
		}
	};
	walk(SRC_ROOT);
	out.push(join(CORE_ROOT, 'server.ts')); // the Bun.serve entry lives at the package root
	return out;
}

// A reconcileOnReady CALL, distinct from its `export function reconcileOnReady(` DEFINITION (player.ts).
const RECONCILE_CALL = /(?<!function\s)\breconcileOnReady\s*\(/;

test('reconcileOnReady is called from exactly the three non-boot sites: queue:command, onMediaReady, and the entry-delete', () => {
	// The set of NON-TEST files in apps/core that CALL reconcileOnReady must be exactly server.ts (the
	// queue:command arm) and src/server/app.ts (the onMediaReady handler). A reconcile added anywhere
	// else — e.g. a new boot module — reds this; deleting the last call in app.ts reds it too.
	const sites = collectNonTestSources()
		.filter((f) => RECONCILE_CALL.test(stripComments(readFileSync(f, 'utf8'))))
		.map((f) => relative(CORE_ROOT, f))
		.sort();
	expect(sites).toEqual(['server.ts', 'src/server/app.ts', 'src/server/media/delete.ts']);

	// The app.ts call must be INSIDE the onMediaReady handler and be the ONLY reconcile in the file.
	// This is what pins the comment's actual claim: a boot-time reconcile (the quarantined mutation)
	// would sit at the top level of createApp — outside onMediaReady — and red here even though the
	// per-file set above is unchanged (app.ts is already in it). Deleting the onMediaReady call also
	// reds here (zero calls inside the handler).
	const APP = stripComments(readFileSync(join(SRC_ROOT, 'server', 'app.ts'), 'utf8'));
	const handlerKey = APP.indexOf('onMediaReady:');
	expect(handlerKey).toBeGreaterThanOrEqual(0); // non-vacuous: the handler must exist
	const arrowBrace = APP.indexOf('{', APP.indexOf('=>', handlerKey));
	expect(arrowBrace).toBeGreaterThan(handlerKey);
	let depth = 0;
	let handlerEnd = -1;
	for (let i = arrowBrace; i < APP.length; i++) {
		if (APP[i] === '{') depth++;
		else if (APP[i] === '}' && --depth === 0) {
			handlerEnd = i;
			break;
		}
	}
	expect(handlerEnd).toBeGreaterThan(arrowBrace);
	const callRe = /(?<!function\s)\breconcileOnReady\s*\(/g;
	let inside = 0;
	let total = 0;
	let m: RegExpExecArray | null;
	while ((m = callRe.exec(APP)) !== null) {
		total++;
		if (m.index > arrowBrace && m.index < handlerEnd) inside++;
	}
	expect(total).toBe(1);
	expect(inside).toBe(1);
});

test('the play/pause transport button still allows a ready queue while nothing plays', () => {
	// The comment's third recovery route — "or a manual play … the play control stays enabled because a
	// non-empty queue satisfies its gate" — is the play button's gate. restart and skip are stricter
	// (they need a PLAYING entry), so after a boot heal (nowEntry null, queue ready) the play button is
	// the room's ONLY manual restart. Narrowing this gate to the restart/skip form (the mutation that comment's
	// own consequence paragraph named) leaves a boot-healed room with a phone that offers NO transport
	// control at all — invisible to the suite until now.
	//
	// Since the direction-A phone home shell the invariant spans TWO files: the transport moved onto the now-playing hero, so the
	// hero owns the gate's SHAPE and the route owns the value it is fed. Both halves are asserted,
	// because either one alone can break it — a hero that ANDs the two conditions is useless if the
	// route stops passing `canStart`, and vice versa. The behavioural half is also now covered by a
	// real mounted assertion (lib/components/phone-home-832.test.ts); this stays a source scan so a UI
	// refactor reds only its own line, kept SEPARATE from the reconcile check above.
	const HERO = stripComments(readFileSync(join(SRC_ROOT, 'lib', 'components', 'NowPlayingHero.svelte'), 'utf8'));
	const PAGE = stripComments(readFileSync(join(SRC_ROOT, 'routes', '+page.svelte'), 'utf8'));
	// non-vacuous: we are looking at the play/pause control specifically.
	expect(PAGE).toMatch(/cmd:\s*playback\.isPlaying\s*\?\s*'pause'\s*:\s*'play'/);
	// The gate must keep an allowance BEYOND "something is playing" — narrowing it to `!hasSong` (the
	// restart/skip form) is the mutation.
	expect(HERO).toMatch(/disabled=\{\s*!hasSong\s*&&\s*!canStart\s*\}/);
	// …and the route must feed that allowance from the queue's own length, not from a constant.
	expect(PAGE).toMatch(/canStart=\{\s*queued\.length\s*>\s*0\s*\}/);
});
