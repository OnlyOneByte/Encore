// guard: player.ts owns the recovery predicate and the `nowplaying:changed` payload, and server.ts used to
// re-derive both. Widening ONLY player.ts's predicate left `bun test` byte-identical to baseline, so the
// incomplete edit was silent and the complete one red three pins; and `ws.send(JSON.stringify` accepts
// anything, so a new required field on the event produced one tsc error at player.ts and none at server.ts.
// FILE-SET censuses, not line coordinates, each with a sentinel against DELETING the subject.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { read, repoRoot, srcDir } from '@encore/test-support';

const CORE_ROOT = repoRoot;
const SRC_ROOT = srcDir;

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

/** Every NON-TEST production .ts/.svelte, including the Bun.serve entry, which sits OUTSIDE src/. */
function collectNonTestSources(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			if (['node_modules', '.svelte-kit', 'build', 'dist'].includes(name)) continue;
			// `src/lib/contract` is the ISOMORPHIC CONTRACT, excluded on purpose: every arm asks how many production
			// files BUILD this frame, and the contract DECLARES its shape in a type union — which the same pattern
			// matches while being the opposite of a duplicate.
			if (name === 'contract' && dir === join(SRC_ROOT, 'lib')) continue;
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
		}
	};
	walk(SRC_ROOT);
	out.push(join(CORE_ROOT, 'server.ts'));
	return out;
}

const SOURCES = collectNonTestSources();
const REL = (f: string) => relative(CORE_ROOT, f);

/** The set of non-test production files whose comment-stripped text matches `pattern`. */
function filesMatching(pattern: RegExp): string[] {
	return SOURCES.filter((f) => pattern.test(stripComments(readFileSync(f, 'utf8'))))
		.map(REL)
		.sort();
}

test('the census actually covers this package, including the harness-less Bun.serve entry', () => {
	// Non-vacuous scaffolding: a walk missing server.ts (outside src/) or player.ts passes all four at zero.
	expect(SOURCES.length).toBeGreaterThanOrEqual(50);
	const rel = SOURCES.map(REL);
	expect(rel).toContain('server.ts');
	expect(rel).toContain('src/lib/server/realtime/player.ts');
	// A walk BLIND to store.ts is how the first census missed the third copy, so assert its membership.
	expect(rel).toContain('src/lib/server/state/store.ts');
	// And the stripper must really blank comments, or a commented-out copy would count as a live one.
	const planted = stripComments(
		[
			'// entries.some((e) => e.id === state.playback.currentEntryId) in a line comment',
			"/* type: 'nowplaying:changed' and upNextAfter(cur?.id ?? null, in a block comment */",
			'const live = 1;'
		].join('\n')
	);
	expect(planted).not.toMatch(/\.some\(\s*\(e\)\s*=>\s*e\.id\s*===\s*[\w.#]*currentEntryId/);
	expect(planted).not.toMatch(/type:\s*'nowplaying:changed'/);
	expect(planted).not.toMatch(/upNextAfter\(\s*cur\?\.id\s*\?\?\s*null,/);
	expect(planted).toContain('const live = 1;'); // it blanks comments, not code
});

// Anchored on `currentEntryId` alone, NOT on a receiver spelling: a `[\w.]*playback\.` pattern could not
// see store.ts's `this.#playback.` copy, which is the hole the extraction closed. The bare field name is
// what makes this census survive the relocation into `entryResolves` and still find a re-inlined copy.
const RECOVERY_PREDICATE = /\.some\(\s*\(e\)\s*=>\s*e\.id\s*===\s*[\w.#]*currentEntryId/;

test('the recovery predicate exists in exactly one production file, store.ts', () => {
	// The sole home is the exported `entryResolves` helper; there were three receiver-prefixed copies.
	expect(filesMatching(RECOVERY_PREDICATE)).toEqual(['src/lib/server/state/store.ts']);
});

test('ARM 1 cannot be satisfied by deleting the invariant — the resolution test still exists', () => {
	// Sentinel: a census counting sites passes at ZERO, so deleting the predicate would satisfy ARM 1 while
	// re-opening the recovery defect. The resolution form must still be present inside `entryResolves`.
	const STORE = stripComments(readFileSync(join(SRC_ROOT, 'lib', 'server', 'state', 'store.ts'), 'utf8'));
	const fnIdx = STORE.indexOf('export function entryResolves(');
	expect(fnIdx).toBeGreaterThanOrEqual(0);
	expect(STORE.slice(fnIdx)).toMatch(RECOVERY_PREDICATE);
});

// PROSE ARM, pinning the comment that tells the next developer the predicate is single-sourced. The
// structural arms above catch a second copy AFTER someone writes one; the comment is what stops them
// writing it. Read RAW, because the comment text IS the subject. Shape: docs/GUARDS.md#docs-prose.
const PLAYER_RAW = read('src/lib/server/realtime/player.ts');

test('player.ts discloses where the recovery predicate is single-sourced', () => {
	// Non-vacuous: anchored on the symbol the prose documents, so a rename reds here instead of passing over
	// a comment that no longer sits beside anything.
	const fnIdx = PLAYER_RAW.indexOf('export function reconcileOnReady(');
	expect(fnIdx).toBeGreaterThanOrEqual(0);
	const declIdx = PLAYER_RAW.indexOf('const currentResolves', fnIdx);
	expect(declIdx).toBeGreaterThan(fnIdx);
	// The prose sits BETWEEN the signature and the predicate it documents, where a reader will see it.
	const preamble = PLAYER_RAW.slice(fnIdx, declIdx);

	// Claim 1: the disclosure NAMES the single home — the shared `entryResolves` helper — rather than claiming
	// player.ts states the predicate itself. Wrap-tolerant, because the phrase spans comment lines.
	const ws = String.raw`(?:\s|\/\/)+`;
	// Pins what the preamble must SAY, never a task reference: the disclosure was always the subject.
	expect(preamble).toMatch(new RegExp(`removed${ws}server\\.ts`, 'i'));
	expect(preamble).toMatch(/single-source|single source/i);
	expect(preamble).toMatch(/entryResolves/);
	expect(preamble).toMatch(new RegExp(`single(?:${ws})?-?(?:${ws})?sourced`, 'i'));

	// Claim 2: callers now delegate instead of pre-deciding. A reader who knows the caller decides NOTHING
	// keeps the single home in sync instead of re-inlining a copy.
	expect(preamble).toMatch(new RegExp(`[Cc]allers${ws}now${ws}call${ws}(?:this${ws}function${ws})?unconditionally`));
});

// ARM 2: the queue:command arm delegates the decision rather than re-deriving it.
const SERVER = stripComments(readFileSync(join(CORE_ROOT, 'server.ts'), 'utf8'));

/** The comment-blanked `case 'queue:command':` arm of the WebSocket switch. */
function queueCommandArm(): string {
	const caseIdx = SERVER.indexOf("case 'queue:command':");
	expect(caseIdx).toBeGreaterThanOrEqual(0); // non-vacuous: the arm must still exist
	const breakIdx = SERVER.indexOf('break;', caseIdx);
	expect(breakIdx).toBeGreaterThan(caseIdx);
	return SERVER.slice(caseIdx, breakIdx);
}

test("server.ts's queue:command arm calls reconcileOnReady unconditionally, deciding nothing itself", () => {
	const arm = queueCommandArm();
	expect(arm).toMatch(/reconcileOnReady\(deps\)/);
	expect(arm).not.toMatch(RECOVERY_PREDICATE);
	expect(arm).not.toMatch(/\bemitNowPlaying\b/);
	// The call must not be re-wrapped in any conditional either — `if`/`else`/`?:`/`&&` guarding the
	// reconcile is the same defect under a different spelling.
	expect(arm).not.toMatch(/\b(?:if|else)\b[^\n]*reconcileOnReady\(deps\)/);
	expect(arm).not.toMatch(/reconcileOnReady\(deps\)[^\n]*\belse\b/);
});

test('PINNED ORDER: the reconcile still runs AFTER handleQueueCommand', () => {
	// HOISTING the call above handleQueueCommand re-opens the original defect in full with the whole suite
	// green, because the reconcile then reads the PRE-remove state where the playing id still resolves.
	// Indexes are taken inside the arm, which also pins that the call is in the queue:command arm at all.
	const arm = queueCommandArm();
	const callIdx = arm.search(/handleQueueCommand\(evt\.command/);
	const reconcileIdx = arm.search(/reconcileOnReady\(deps\)/);
	expect(callIdx).toBeGreaterThanOrEqual(0);
	expect(reconcileIdx).toBeGreaterThanOrEqual(0);
	expect(reconcileIdx).toBeGreaterThan(callIdx);
});

// ARM 3 + 4: the nowplaying:changed frame is BUILT once. Two independent constructs, because a change can
// hit either half: WHAT the event carries, and HOW upNext is projected from the current entry.
const UPNEXT_PROJECTION = /upNextAfter\(\s*cur\?\.id\s*\?\?\s*null,/;
const NOWPLAYING_LITERAL = /type:\s*'nowplaying:changed'/;

test('the upNext projection exists in exactly one production file, player.ts', () => {
	expect(filesMatching(UPNEXT_PROJECTION)).toEqual(['src/lib/server/realtime/player.ts']);
});

test('the nowplaying:changed payload is stated in exactly one production file, player.ts', () => {
	// Counted per FILE, not per occurrence: player.ts legitimately names the literal twice — once in
	// nowPlayingEvent's `Extract<ServerEvent, …>` return type and once in the returned object.
	expect(filesMatching(NOWPLAYING_LITERAL)).toEqual(['src/lib/server/realtime/player.ts']);
});

test('ARM 3/4 cannot be satisfied by dropping the resync frame — hello still sends three frames', () => {
	// Sentinel: deleting the `hello` arm's nowplaying frame would also collapse both censuses to one file
	// while silently regressing every reconnecting client to no nowplaying state. The resync must still send
	// queue:sync, playback:state and the nowplaying frame, the last through player.ts's builder.
	const caseIdx = SERVER.indexOf("case 'hello':");
	expect(caseIdx).toBeGreaterThanOrEqual(0);
	const breakIdx = SERVER.indexOf('break;', caseIdx);
	expect(breakIdx).toBeGreaterThan(caseIdx);
	const arm = SERVER.slice(caseIdx, breakIdx);
	expect(arm).toMatch(/syncEvent\(state, deps\)/);
	expect(arm).toMatch(/type:\s*'playback:state'/);
	expect(arm).toMatch(/ws\.send\(JSON\.stringify\(nowPlayingEvent\(deps\)\)\)/);
	// Imported from the player module — the owner — not re-implemented locally.
	expect(SERVER).toMatch(
		/import\s*\{[^}]*\bnowPlayingEvent\b[^}]*\}\s*from\s*'\.\/src\/lib\/server\/realtime\/player'/
	);
});

test('the typed-builder precedent this follows still exists: syncEvent', () => {
	// nowPlayingEvent is modelled on hub.ts's syncEvent — the identical `Extract<ServerEvent, …>` return
	// shape, called by this same hello arm. If that precedent goes, this shape should be revisited.
	const HUB = stripComments(read('src/lib/server/realtime/hub.ts'));
	expect(HUB).toMatch(/export function syncEvent\(/);
	expect(HUB).toMatch(/Extract<ServerEvent,\s*\{\s*type:\s*'queue:sync'\s*\}>/);
});

test('nowPlayingEvent has a non-test caller', () => {
	// A builder nothing calls is dead weight, so grep the production set excluding player.ts's definition.
	const callers = SOURCES.filter((f) => REL(f) !== 'src/lib/server/realtime/player.ts').filter((f) =>
		/(?<!function\s)\bnowPlayingEvent\s*\(/.test(stripComments(readFileSync(f, 'utf8')))
	);
	expect(callers.map(REL)).toEqual(['server.ts']);
});
