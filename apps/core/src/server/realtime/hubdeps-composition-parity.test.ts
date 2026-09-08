// guard: the two hand-assembled HubDeps compositions must fill every optional hook the interface
// declares — a PARITY guard against HubDeps itself, not a thirteenth one-hook wiring guard (#528).
//
// HubDeps (hub.ts) has 3 required fields and 12 OPTIONAL ones. Because every optional key is
// type-legal to omit, a composition site can silently drop a hook and the whole apps/core suite stays
// green: each hook feeds a LIVE service (onNowPlaying → app.plays, recordAdd → app.popularity,
// onSang → app.singers, onEntryRemoved → cancelJobsForMedia, hasOp → the #490 re-ack peek …), but
// no test reads the composition, so none can tell a wired bag from an empty one. Measured in #528:
// deleting any of 11 keys from the old hand-written server.ts bag left 1452 pass / 0 fail; only
// onEntryAdded reds, and only because #179/#309 wrote a one-hook guard for it. Same class three times
// (#123, #179/#309, #295), each closing ONE hole. This guard closes the class.
//
// Post-#460 §3 the per-frame bag was folded into ONE factory, app.ts's
// `buildHubDeps(app, perFrame): HubDeps` — now the single place every optional hook is wired to its
// service. So the parity target is the FACTORY'S RETURN literal (below): filling every optional key
// there wires it for every WS frame, and server.ts's call site just passes the per-frame subset,
// whose completeness the `HubDepsPerFrame` param type checks. reconcileOnReady in app.ts remains the
// second, deliberately-partial composition and is pinned to its four load-bearing hooks.
//
// THE POINT — the key list is DERIVED from hub.ts, not hardcoded: the NEXT optional hook added to
// HubDeps fails this guard until it is wired into the factory, instead of needing another one-hook
// guard.
//
// This asserts production's own text; comments are blanked first so a commented-out wiring cannot
// satisfy the scan (same technique as reprioritize-cook-wiring.test.ts:20-23,
// ephemeral-reset-single-source.test.ts). It anchors on each LITERAL, not the whole file, because
// several hook names (entries, jobs, dispatch, now) also appear at unrelated call sites.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// Slice a brace-balanced literal body starting at `openMarker`'s `{`. Returns the text BETWEEN the
// outermost braces so key assertions can't stray past the literal into unrelated call sites.
function literalBody(src: string, openMarker: RegExp): string {
	const m = src.match(openMarker);
	if (m === null || m.index === undefined) return '';
	const braceStart = src.indexOf('{', m.index);
	if (braceStart === -1) return '';
	let depth = 0;
	for (let i = braceStart; i < src.length; i++) {
		const ch = src[i];
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) return src.slice(braceStart + 1, i);
		}
	}
	return '';
}

// import.meta.dir === apps/core/src/server/realtime → three levels up to apps/core/server.ts.
const REALTIME_DIR = import.meta.dir;
const SERVER = stripComments(readFileSync(join(REALTIME_DIR, '..', '..', '..', 'server.ts'), 'utf8'));
const HUB = stripComments(readFileSync(join(REALTIME_DIR, 'hub.ts'), 'utf8'));
const APP = stripComments(readFileSync(join(REALTIME_DIR, '..', 'app.ts'), 'utf8'));

// ── Derive the optional-hook key list from the HubDeps interface body itself ──────────────────────
// Take the `export interface HubDeps { ... }` body and pull every optional declaration `<name>?:`.
const HUBDEPS_BODY = literalBody(HUB, /export\s+interface\s+HubDeps\s*\{/);
const OPTIONAL_KEYS = Array.from(HUBDEPS_BODY.matchAll(/^\s*([A-Za-z_$][\w$]*)\?\s*:/gm)).map((mm) => mm[1]);

// The hub bag is now assembled by ONE factory, app.ts's `buildHubDeps(app, perFrame): HubDeps`
// (#460 §3), so the parity target moved from server.ts's hand-written literal to the factory's
// RETURN literal — that is now the single place every optional hook is wired. Anchor on the factory's
// `return {`: the regex ends at `return`, so literalBody's next `{` is the returned object literal,
// not the function body's own brace. (server.ts's call site just PASSES the per-frame subset — the
// TS `HubDepsPerFrame` param type checks that, so the completeness invariant lives at the factory.)
const FACTORY_DEPS = literalBody(
	APP,
	/export\s+function\s+buildHubDeps\s*\([\s\S]*?\)\s*:\s*HubDeps\s*\{[\s\S]*?return\s*/
);
const RECONCILE = literalBody(APP, /reconcileOnReady\s*\(\s*\{/);

// ── Not-vacuous sentinels: a rename/move must red LOUDLY, never let the scan pass over nothing ─────
test('#528 sentinel: HubDeps declares optional hooks, including onEntryAdded and hasOp', () => {
	expect(OPTIONAL_KEYS.length).toBeGreaterThanOrEqual(11);
	expect(OPTIONAL_KEYS).toContain('onEntryAdded');
	expect(OPTIONAL_KEYS).toContain('hasOp');
});

test('#528 sentinel: both production composition literals were located', () => {
	// Non-empty bodies prove the anchors matched; a moved/renamed literal reds here first.
	expect(FACTORY_DEPS.length).toBeGreaterThan(0);
	expect(RECONCILE.length).toBeGreaterThan(0);
	// And it is the right one: the required fields every HubDeps carries.
	for (const req of ['state', 'publish', 'mediaById']) {
		expect(FACTORY_DEPS).toMatch(new RegExp(`(^|[\\s,{])${req}\\s*[,:]`));
	}
});

test('#460 §3: server.ts wires the live frame path through buildHubDeps(app, {...perFrame})', () => {
	// The factory being COMPLETE is only load-bearing if the live WS frame path actually calls it.
	// Pin that server.ts assembles `const deps: HubDeps = buildHubDeps(app, { ... })` — so a revert to
	// a hand-written bag (which would escape the factory-scoped parity check above) reds here, and the
	// per-frame subset is passed (broadcast + actorSingerId + the ledger), whose completeness the
	// HubDepsPerFrame param type then checks.
	expect(SERVER).toMatch(/const\s+deps\s*:\s*HubDeps\s*=\s*buildHubDeps\(\s*app\s*,\s*\{/);
	for (const pf of ['broadcast', 'actorSingerId', 'listOnline', 'listAway', 'seenOp', 'hasOp']) {
		expect(SERVER).toMatch(new RegExp(`(^|[\\s,{])${pf}\\s*[,:]`));
	}
});

// ── Parity: every optional hook HubDeps declares must be filled by the buildHubDeps factory ───────
// The factory is the SINGLE composition site now, so filling every optional key here wires it for
// every WS frame; a dropped hook reds exactly as it did against the old hand-written bag (#528).
test('#528: app.ts buildHubDeps factory fills EVERY optional HubDeps hook', () => {
	const missing = OPTIONAL_KEYS.filter((k) => !new RegExp(`(^|[\\s,{])${k}\\s*:`).test(FACTORY_DEPS));
	expect(missing).toEqual([]);
});

// ── Parity: app.ts reconcileOnReady must fill the hooks that call needs to pick the right song ─────
// reconcileOnReady takes the full HubDeps type but supplies a deliberate subset. listSingers +
// getSettings are load-bearing (app.ts comment: without them it picks with fair rotation while every
// client sees the room's chosen order); onNowPlaying + onSang carry play-tracking / least-recently-
// sung through the reconcile path. Pin exactly those four so dropping any reds.
test('#528: app.ts reconcileOnReady fills its load-bearing hooks (listSingers, getSettings, onNowPlaying, onSang)', () => {
	for (const k of ['listSingers', 'getSettings', 'onNowPlaying', 'onSang']) {
		expect(RECONCILE).toMatch(new RegExp(`(^|[\\s,{])${k}\\s*:`));
	}
});
