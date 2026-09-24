// guard: removing the CURRENTLY PLAYING entry through the hub left `playback.currentEntryId` pointing at
// a pruned entry, and because every auto-start gate is spelled `!currentEntryId` that dangling id read as
// "a song is playing" while nothing was, so the rotation never advanced. The invariant lives in
// `reconcileOnReady`, which keys on RESOLUTION rather than nullness. See docs/GUARDS.md#realtime.
import { test, expect } from 'bun:test';
import { handleQueueCommand, type HubDeps } from '$lib/server/realtime/hub';
import { reconcileOnReady } from '$lib/server/realtime/player';
import { AuthoritativeState } from '$lib/server/state/store';
import { type ServerEvent, type Media, type QueueEntry, type ClientCommand, type PlaybackState } from '$lib/contract';
import { EMPTY_SONG_PROFILE } from '$lib/contract';

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

// Mirrors server.ts's queue:command arm: reconcileOnReady is called UNCONDITIONALLY and the predicate is
// exercised through it rather than copied here.
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

	// No dangling id: current is cleared to null so the `!currentEntryId` gates unstick.
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
	// A room persisted mid-defect: playback names q1, which is not among the stored entries. persist()
	// writes both from one snapshot, so the dangling pair round-trips unless hydrate self-heals.
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

// Source scan for the trigger line. server.ts is the Bun.serve entry with no unit harness, so reverting
// its call to an `if (!currentEntryId)` gate leaves the whole suite green while the recovery never fires
// on the reported path. Comments are blanked so a commented-out call cannot satisfy it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { at, repoRoot } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const SERVER = stripComments(readFileSync(at('server.ts'), 'utf8'));
const PLAYER = stripComments(readFileSync(at('src/lib/server/realtime/player.ts'), 'utf8'));

test('server.ts recovers a DANGLING currentEntryId after a queue:command, keying on resolution not nullness', () => {
	// handleQueueCommand is the sole prune that can retire the playing entry.
	expect(SERVER).toMatch(/handleQueueCommand\(/);
	expect(SERVER).toMatch(/reconcileOnReady\(deps\)/);
	// THE PINNED PREDICATE, at its single home in player.ts. A `!state.playback.currentEntryId` gate reads a
	// dangling id as "busy" and never recovers. server.ts used to re-derive the same predicate to decide
	// whether to CALL reconcileOnReady, so widening one copy and not the other was invisible to the suite.
	const fnIdx = PLAYER.indexOf('export function reconcileOnReady(');
	expect(fnIdx).toBeGreaterThanOrEqual(0);
	const body = PLAYER.slice(fnIdx);
	// Pin the CALL of the shared `entryResolves` helper (state/store.ts), not a re-inlined `.some(...)`.
	expect(body).toMatch(
		/const currentResolves = entryResolves\(\s*state\.entries\s*,\s*state\.playback\.currentEntryId\s*\)/
	);
	expect(body).toMatch(/if\s*\(\s*!currentResolves\s*\)/);
	// The caller must NOT carry a second copy — that duplication is the silent-half-edit hazard.
	expect(SERVER).not.toMatch(/\.some\(\s*\(e\)\s*=>\s*e\.id\s*===\s*[\w.]*playback\.currentEntryId/);

	// THE PINNED ORDER: hoisted ABOVE handleQueueCommand the reconcile evaluates PRE-remove state (the
	// playing id still resolves) and never fires, with every assertion above still green. Sliced to the
	// queue:command arm, which also pins the reconcile inside that arm rather than anywhere in the file.
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

// The hydrate() heal unjams the `!currentEntryId` gates but starts nothing: there is no boot resync and
// no boot reconcile, so recovery waits for a queue:command, a process completing, or a manual play.
// store.ts's comment once promised a boot reconcile that does not exist, which is the false premise
// pinned below. Read RAW rather than comment-stripped, because the comment text IS the subject.
const STORE = readFileSync(at('src/lib/server/state/store.ts'), 'utf8');

test("hydrate()'s heal comment (store.ts) tells the truth about boot recovery", () => {
	// Non-vacuous: the heal the comment describes must actually be present.
	expect(STORE).toMatch(/currentEntryId:\s*null,\s*isPlaying:\s*false/);
	// Anchored on the CLAIM, never on a task reference: tests/guards/meta/task-number-hygiene.test.ts bans
	// one in every tracked file, so anchoring there would pin a label store.ts cannot carry.
	expect(STORE).toContain('Self-heal a persisted DANGLING currentEntryId');

	// THE PINNED FALSEHOOD: a "boot resync"/"boot reconcile" whose SAME clause (no newline between) carries
	// a start/recover/advance verb acting on a singer or room. A blunt word-scan is deliberately NOT used,
	// because the corrected comment legitimately DENIES a boot reconcile.
	const bootPromisesStart =
		/boot\s+(?:resync|reconcile)[^\n]*\b(?:start|starts|recover|recovers|advance|advances)\b[^\n]*\b(?:singer|room|playback|song)\b/i;
	expect(STORE).not.toMatch(bootPromisesStart);

	// The corrected comment must AFFIRM there is no boot reconcile and name the three REAL recovery sites.
	// Wrap-tolerant, because the phrase spans two comment lines in the source.
	expect(STORE).toMatch(/no(?:\s|\/\/)+boot(?:\s|\/\/)+resync(?:\s|\/\/)+or(?:\s|\/\/)+boot(?:\s|\/\/)+reconcile/i);
	expect(STORE).toContain('queue:command');
	expect(STORE).toContain('onMediaReady');
	expect(STORE).toContain('manual play');
});
// The guard above pins how store.ts's comment is SPELLED, not whether it is TRUE: the claim is about
// reconcileOnReady's call sites across the app, so a later boot reconcile makes the comment false again
// while the spelling guard stays green. The STRUCTURE is pinned here instead.
const CORE_ROOT = repoRoot;
const SRC_ROOT = at('src');

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
	// A reconcile added anywhere else — a new boot module, say — reds here, and deleting the last call in
	// app.ts reds it too.
	const sites = collectNonTestSources()
		.filter((f) => RECONCILE_CALL.test(stripComments(readFileSync(f, 'utf8'))))
		.map((f) => relative(CORE_ROOT, f))
		.sort();
	expect(sites).toEqual(['server.ts', 'src/lib/server/app.ts', 'src/lib/server/media/delete.ts']);

	// The app.ts call must be INSIDE onMediaReady and the ONLY one in the file: a boot reconcile would sit
	// at the top level of createApp and leave the per-file set above unchanged.
	const APP = stripComments(readFileSync(join(SRC_ROOT, 'lib', 'server', 'app.ts'), 'utf8'));
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
	// restart and skip are stricter — they need a PLAYING entry — so after a boot heal the play button is the
	// room's ONLY manual restart, and narrowing its gate to the restart/skip form leaves a boot-healed room
	// with no transport control at all. The invariant spans two files: the band owns the gate's SHAPE and the
	// layout owns the value fed to it, so both halves are asserted because either alone can break it.
	const DRAWER = stripComments(readFileSync(join(SRC_ROOT, 'lib', 'components', 'NowPlayingDrawer.svelte'), 'utf8'));
	const LAYOUT = stripComments(readFileSync(join(SRC_ROOT, 'routes', '+layout.svelte'), 'utf8'));
	// The drawer's OWN element, not the whole file: the band beside it takes the same `ontoggleplay`, so a
	// file-wide match could be satisfied by the band while the drawer's transport was wired to nothing.
	const mount = (() => {
		const start = LAYOUT.indexOf('<NowPlayingDrawer');
		expect(start, 'the layout no longer mounts NowPlayingDrawer').toBeGreaterThanOrEqual(0);
		const end = LAYOUT.indexOf('/>', start);
		expect(end).toBeGreaterThan(start);
		return LAYOUT.slice(start, end);
	})();
	// non-vacuous: we are looking at the play/pause control specifically.
	expect(mount).toMatch(/cmd:\s*isPlaying\s*\?\s*'pause'\s*:\s*'play'/);
	// The gate must keep an allowance BEYOND "something is playing"; narrowing it to `!hasSong` is the
	// mutation. The band's disc declares the gate's SHAPE and the drawer passes `canStart` through to it.
	const BAND = stripComments(readFileSync(join(SRC_ROOT, 'lib', 'components', 'NowPlayingBand.svelte'), 'utf8'));
	expect(BAND).toMatch(/disabled=\{\s*!hasSong\s*&&\s*!canStart\s*\}/);
	expect(DRAWER, 'the drawer must pass the allowance on to the band that owns the control').toMatch(
		/canStart=\{canStart\}/
	);
	// The allowance is fed from the queue's own contents, never a constant: the room mirror asks whether a
	// QUEUED entry exists, so a queue holding only finished or skipped entries does not light the control.
	expect(mount).toMatch(/\{canStart\}/);
	expect(LAYOUT).toMatch(/canStart = room\.entries\.some\(\(e\) => e\.status === 'queued'\)/);
});
