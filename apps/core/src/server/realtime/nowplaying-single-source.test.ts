// SINGLE-SOURCE GUARD for the two things player.ts owns and apps/core/server.ts used to re-derive —
// issue #803.
//
// Two findings, one root cause: the WebSocket switch in apps/core/server.ts wrote its own copy of
//   (1) the #128 recovery predicate — `entries.some((e) => e.id === playback.currentEntryId)` — to
//       decide whether to call reconcileOnReady, which already evaluates that same predicate itself;
//   (2) the `nowplaying:changed` payload, hand-derived and hand-built in the `hello` resync arm,
//       byte-identical to emitNowPlaying's modulo a `deps.` prefix.
//
// Neither copy was checkable. For (1) NOTHING in the suite compared the two: measured on base,
// widening ONLY player.ts's predicate to `&& e.status === 'playing'` left `bun test` byte-identical
// to baseline, while making the SAME edit at both copies (the correct change) red three regex pins.
// The incentive was inverted — the incomplete edit was silent, the complete one punished. For (2)
// `deps.publish` is typed `(event: ServerEvent) => void` (hub.ts) but the resync writes through
// `ws.send(JSON.stringify(...))`, which accepts anything: adding one required field to the
// nowplaying:changed variant (packages/shared/src/core/events.ts) produced exactly ONE tsc error, at
// player.ts, and ZERO at server.ts. So a reconnecting TV or a reloading phone would be served the
// old projection while every live client got the new one — #636's class (an advertised next that
// disagrees with the truth) reached from the resync seam.
//
// These are FILE-SET censuses, not line coordinates: the fix moves lines, so asserting a `path:line`
// would red on the very change it is meant to protect. Each arm names the file that must own the
// construct and requires no other non-test production file in apps/core to carry it.
//
// Sentinels below exist so no arm can be satisfied by DELETING the thing it protects — a census that
// only counts occurrences passes at zero.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// import.meta.dir === apps/core/src/server/realtime → apps/core is three levels up, apps/core/src two.
const CORE_ROOT = join(import.meta.dir, '..', '..', '..');
const SRC_ROOT = join(import.meta.dir, '..', '..');

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

/** Every NON-TEST production .ts/.svelte in apps/core, including the Bun.serve entry at the package
 *  root — server.ts sits OUTSIDE src/, and a src-scoped walk would miss the very file this guards. */
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

test('the census actually covers this package, including the harness-less Bun.serve entry (#803)', () => {
	// Non-vacuous scaffolding for every arm below: a walk that silently collected nothing, or that
	// missed server.ts (outside src/) or player.ts, would make all four censuses pass at zero.
	expect(SOURCES.length).toBeGreaterThanOrEqual(50);
	const rel = SOURCES.map(REL);
	expect(rel).toContain('server.ts');
	expect(rel).toContain('src/server/realtime/player.ts');
	// #848: a walk BLIND to store.ts is exactly how #803's census missed the third copy, so assert
	// store.ts's membership rather than assume it.
	expect(rel).toContain('src/server/state/store.ts');
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

// ── ARM 1: the #128 recovery predicate is written ONCE ─────────────────────────────────────────────
// Anchored on `currentEntryId` alone, NOT on a receiver spelling: #803's `[\w.]*playback\.`
// pattern could not see store.ts's `this.#playback.` copy, which is the hole #848 closed. After the
// #848 extraction the predicate is the bare-parameter comparison inside `entryResolves`
// (state/store.ts), so anchoring on the field name is what makes this census survive the relocation
// and still find a receiver-prefixed re-inlined copy if one ever comes back.
const RECOVERY_PREDICATE = /\.some\(\s*\(e\)\s*=>\s*e\.id\s*===\s*[\w.#]*currentEntryId/;

test('the #128 recovery predicate exists in exactly one production file, store.ts (#803, #848)', () => {
	// Base (pre-#848) FAILS with 2: src/server/realtime/player.ts and src/server/state/store.ts, the
	// two byte-identical-modulo-receiver copies #848 consolidated into `entryResolves`. #803 had
	// already removed server.ts's third copy. After #848 the sole home is the extracted helper.
	expect(filesMatching(RECOVERY_PREDICATE)).toEqual(['src/server/state/store.ts']);
});

test('ARM 1 cannot be satisfied by deleting the invariant — the resolution test still exists (#128)', () => {
	// Sentinel. A census counting sites passes at ZERO, so deleting the predicate outright would
	// satisfy ARM 1 while re-opening #128. Require the resolution form to be present in store.ts,
	// inside the exported `entryResolves` helper that both askers now call.
	const STORE = stripComments(readFileSync(join(SRC_ROOT, 'server', 'state', 'store.ts'), 'utf8'));
	const fnIdx = STORE.indexOf('export function entryResolves(');
	expect(fnIdx).toBeGreaterThanOrEqual(0);
	expect(STORE.slice(fnIdx)).toMatch(RECOVERY_PREDICATE);
});

// ── PROSE ARM: the comment that tells the next developer the predicate is single-sourced ────────────
// This pins the comment-only hunk of this fix, which by construction cannot red a behavioural test —
// `docs/loop/CODING-BOT.md` §3 sanctions exactly this shape, and the in-repo precedents are
// packages/shared/src/pin-base-prose-790.test.ts and spotify-enforcement-prose-742.test.ts. Read RAW
// (not stripComments), because the comment text IS the subject: blanking comments would make every
// assertion below vacuous.
//
// Why it is worth pinning rather than dropping: the structural arms above catch a second copy AFTER
// someone writes one. The comment is what stops them writing it — the next developer standing at this
// predicate needs to know their edit is complete here, and that callers deliberately decide nothing.
// Delete the disclosure and the duplication grows back for the same reason it grew the first time.
const PLAYER_RAW = readFileSync(join(import.meta.dir, 'player.ts'), 'utf8');

test('player.ts discloses where the recovery predicate is single-sourced (#803, #848)', () => {
	// Non-vacuous: anchor on the symbol the prose documents, so a rename reds here rather than passing
	// over a comment that no longer sits beside anything.
	const fnIdx = PLAYER_RAW.indexOf('export function reconcileOnReady(');
	expect(fnIdx).toBeGreaterThanOrEqual(0);
	const declIdx = PLAYER_RAW.indexOf('const currentResolves', fnIdx);
	expect(declIdx).toBeGreaterThan(fnIdx);
	// The prose sits BETWEEN the signature and the predicate it documents — not somewhere else in the
	// file where a reader standing at the predicate would never see it.
	const preamble = PLAYER_RAW.slice(fnIdx, declIdx);

	// Claim 1: the disclosure NAMES the single home of the predicate — the shared `entryResolves`
	// helper — rather than claiming player.ts states it (which #848 made false: player.ts now calls
	// the helper and states the predicate not at all). #803 AND #848 are cited so the next reader can
	// find both measurements. Wrap-tolerant — the phrase spans comment lines, so `//`, tabs and
	// newlines are allowed between words (same technique as the #254 guard in
	// dangling-current-entry.test.ts).
	const ws = String.raw`(?:\s|\/\/)+`;
	expect(preamble).toMatch(/#803/);
	expect(preamble).toMatch(/#848/);
	expect(preamble).toMatch(/entryResolves/);
	expect(preamble).toMatch(new RegExp(`single(?:${ws})?-?(?:${ws})?sourced`, 'i'));

	// Claim 2: it states that callers now delegate instead of pre-deciding. This is the half that
	// prevents the duplication returning — a reader who knows the caller decides NOTHING keeps the
	// single home in sync instead of re-inlining a copy.
	expect(preamble).toMatch(new RegExp(`[Cc]allers${ws}now${ws}call${ws}(?:this${ws}function${ws})?unconditionally`));
});

// ── ARM 2: the queue:command arm delegates the decision rather than re-deriving it ─────────────────
const SERVER = stripComments(readFileSync(join(CORE_ROOT, 'server.ts'), 'utf8'));

/** The comment-blanked `case 'queue:command':` arm of the WebSocket switch. */
function queueCommandArm(): string {
	const caseIdx = SERVER.indexOf("case 'queue:command':");
	expect(caseIdx).toBeGreaterThanOrEqual(0); // non-vacuous: the arm must still exist
	const breakIdx = SERVER.indexOf('break;', caseIdx);
	expect(breakIdx).toBeGreaterThan(caseIdx);
	return SERVER.slice(caseIdx, breakIdx);
}

test("server.ts's queue:command arm calls reconcileOnReady unconditionally, deciding nothing itself (#803)", () => {
	const arm = queueCommandArm();
	// Base FAILS all three: the arm carried `if (!state.entries.some(...)) reconcileOnReady(deps);`
	// with `else emitNowPlaying(deps);`.
	expect(arm).toMatch(/reconcileOnReady\(deps\)/);
	expect(arm).not.toMatch(RECOVERY_PREDICATE);
	expect(arm).not.toMatch(/\bemitNowPlaying\b/);
	// And the call must not be re-wrapped in any conditional at all — `if`/`else`/`?:`/`&&` guarding
	// the reconcile is the same defect under a different spelling.
	expect(arm).not.toMatch(/\b(?:if|else)\b[^\n]*reconcileOnReady\(deps\)/);
	expect(arm).not.toMatch(/reconcileOnReady\(deps\)[^\n]*\belse\b/);
});

test('PINNED ORDER (#261): the reconcile still runs AFTER handleQueueCommand (#803)', () => {
	// #261 is the measured proof this matters: HOISTING the call above handleQueueCommand re-opened
	// #128 in full with the whole suite green, because the reconcile then reads the PRE-remove state
	// where the playing id still resolves. handleQueueCommand is the sole prune that can retire the
	// playing entry, so the ordering IS the fix. Indexes are taken inside the arm, which also pins
	// that the call is in the queue:command arm at all rather than merely somewhere in the file.
	const arm = queueCommandArm();
	const callIdx = arm.search(/handleQueueCommand\(evt\.command/);
	const reconcileIdx = arm.search(/reconcileOnReady\(deps\)/);
	expect(callIdx).toBeGreaterThanOrEqual(0);
	expect(reconcileIdx).toBeGreaterThanOrEqual(0);
	expect(reconcileIdx).toBeGreaterThan(callIdx);
});

// ── ARM 3 + 4: the nowplaying:changed frame is BUILT once ──────────────────────────────────────────
// Two independent constructs, because a change can hit either half: WHAT the event carries (the
// payload literal) and HOW upNext is projected from the current entry.
const UPNEXT_PROJECTION = /upNextAfter\(\s*cur\?\.id\s*\?\?\s*null,/;
const NOWPLAYING_LITERAL = /type:\s*'nowplaying:changed'/;

test('the upNext projection exists in exactly one production file, player.ts (#803)', () => {
	// Base FAILS with 2 (player.ts's emitNowPlaying + server.ts's hello arm).
	expect(filesMatching(UPNEXT_PROJECTION)).toEqual(['src/server/realtime/player.ts']);
});

test('the nowplaying:changed payload is stated in exactly one production file, player.ts (#803)', () => {
	// Base FAILS with 2. Counted per FILE, not per occurrence: player.ts legitimately names the
	// literal twice after the fix — once in nowPlayingEvent's `Extract<ServerEvent, …>` return type
	// and once in the returned object — and an occurrence count would read that as unfixed.
	expect(filesMatching(NOWPLAYING_LITERAL)).toEqual(['src/server/realtime/player.ts']);
});

test('ARM 3/4 cannot be satisfied by dropping the resync frame — hello still sends three frames (#803)', () => {
	// Sentinel. Deleting the `hello` arm's nowplaying frame outright would also collapse both censuses
	// to one file, while silently regressing every reconnecting client to no nowplaying state at all.
	// Require the resync to still send queue:sync, playback:state and the nowplaying frame — and the
	// last one through player.ts's builder, not a locally rebuilt object.
	const caseIdx = SERVER.indexOf("case 'hello':");
	expect(caseIdx).toBeGreaterThanOrEqual(0);
	const breakIdx = SERVER.indexOf('break;', caseIdx);
	expect(breakIdx).toBeGreaterThan(caseIdx);
	const arm = SERVER.slice(caseIdx, breakIdx);
	expect(arm).toMatch(/syncEvent\(state, deps\)/);
	expect(arm).toMatch(/type:\s*'playback:state'/);
	expect(arm).toMatch(/ws\.send\(JSON\.stringify\(nowPlayingEvent\(deps\)\)\)/);
	// Imported from the player module — the owner — not re-implemented locally.
	expect(SERVER).toMatch(/import\s*\{[^}]*\bnowPlayingEvent\b[^}]*\}\s*from\s*'\.\/src\/server\/realtime\/player'/);
});

test('the typed-builder precedent this follows still exists: syncEvent (#803)', () => {
	// nowPlayingEvent is modelled on hub.ts's syncEvent — a typed event builder with the identical
	// `Extract<ServerEvent, { type: … }>` return shape, called by this same hello arm one line above.
	// If that precedent is ever removed the shape here should be revisited, not silently diverge.
	const HUB = stripComments(readFileSync(join(import.meta.dir, 'hub.ts'), 'utf8'));
	expect(HUB).toMatch(/export function syncEvent\(/);
	expect(HUB).toMatch(/Extract<ServerEvent,\s*\{\s*type:\s*'queue:sync'\s*\}>/);
});

test('nowPlayingEvent has a non-test caller (#803)', () => {
	// A builder nothing calls is dead weight, and the whole point of the extraction is that the
	// resync path goes through it. Grep the production set, excluding player.ts's own definition.
	const callers = SOURCES.filter((f) => REL(f) !== 'src/server/realtime/player.ts').filter((f) =>
		/(?<!function\s)\bnowPlayingEvent\s*\(/.test(stripComments(readFileSync(f, 'utf8')))
	);
	expect(callers.map(REL)).toEqual(['server.ts']);
});
