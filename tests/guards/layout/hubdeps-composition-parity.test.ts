// guard: the two hand-assembled HubDeps compositions must fill every optional hook the interface
// declares — a PARITY guard against HubDeps itself, not a thirteenth one-hook wiring guard.
//
// HubDeps (hub.ts) has 3 required fields and 12 OPTIONAL ones. Because every optional key is
// type-legal to omit, a composition site can silently drop a hook and the whole apps/core suite stays
// green: each hook feeds a LIVE service (onNowPlaying → app.plays, recordAdd → app.popularity,
// onSang → app.singers, onEntryRemoved → cancelJobsForMedia, hasOp → the re-ack peek …), but
// no test reads the composition, so none can tell a wired bag from an empty one. Measured on base:
// deleting any of 11 keys from the old hand-written server.ts bag left 1452 pass / 0 fail; only
// onEntryAdded reds, and only because an earlier pass wrote a one-hook guard for it. Same class three times,
// each closing ONE hole. This guard closes the class.
//
// The per-frame bag has since been folded into ONE factory, app.ts's
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
import { read } from '@encore/test-support';

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

// The three subjects, named from the repo root rather than counted off this file's old location.
// `join(REALTIME_DIR, '..', '..', '..', 'server.ts')` was apps/core/server.ts (the Bun.serve entry),
// `join(REALTIME_DIR, '..', 'app.ts')` was the server composition root, and `join(REALTIME_DIR,
// 'hub.ts')` was a SIBLING READ — "the hub next to me" — which is the realtime hub declaring the
// HubDeps interface this guard derives its key list FROM. That derivation is why `read`'s throw-on-
// missing matters most for hub.ts: an empty body would yield zero OPTIONAL_KEYS and the parity check
// would pass having compared nothing. (The sentinel below floors the key count for the same reason.)
const SERVER = stripComments(read('apps/core/server.ts'));
const HUB = stripComments(read('apps/core/src/server/realtime/hub.ts'));
const APP = stripComments(read('apps/core/src/server/app.ts'));

// ── Derive the optional-hook key list from the HubDeps interface body itself ──────────────────────
// Take the `export interface HubDeps { ... }` body and pull every optional declaration `<name>?:`.
const HUBDEPS_BODY = literalBody(HUB, /export\s+interface\s+HubDeps\s*\{/);
const OPTIONAL_KEYS = Array.from(HUBDEPS_BODY.matchAll(/^\s*([A-Za-z_$][\w$]*)\?\s*:/gm)).map((mm) => mm[1]);

// The hub bag is now assembled by ONE factory, app.ts's `buildHubDeps(app, perFrame): HubDeps`
// — so the parity target moved from server.ts's hand-written literal to the factory's
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
test('sentinel: HubDeps declares optional hooks, including onEntryAdded and hasOp', () => {
	expect(OPTIONAL_KEYS.length).toBeGreaterThanOrEqual(11);
	expect(OPTIONAL_KEYS).toContain('onEntryAdded');
	expect(OPTIONAL_KEYS).toContain('hasOp');
});

test('sentinel: both production composition literals were located', () => {
	// Non-empty bodies prove the anchors matched; a moved/renamed literal reds here first.
	expect(FACTORY_DEPS.length).toBeGreaterThan(0);
	expect(RECONCILE.length).toBeGreaterThan(0);
	// And it is the right one: the required fields every HubDeps carries.
	for (const req of ['state', 'publish', 'mediaById']) {
		expect(FACTORY_DEPS).toMatch(new RegExp(`(^|[\\s,{])${req}\\s*[,:]`));
	}
});

test('§3: server.ts wires the live frame path through buildHubDeps(app, {...perFrame})', () => {
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
// every WS frame; a dropped hook reds exactly as it did against the old hand-written bag.
test('app.ts buildHubDeps factory fills EVERY optional HubDeps hook', () => {
	const missing = OPTIONAL_KEYS.filter((k) => !new RegExp(`(^|[\\s,{])${k}\\s*:`).test(FACTORY_DEPS));
	expect(missing).toEqual([]);
});

// ── Parity: app.ts reconcileOnReady must fill the hooks that call needs to pick the right song ─────
// reconcileOnReady takes the full HubDeps type but supplies a deliberate subset. listSingers +
// getSettings are load-bearing (app.ts comment: without them it picks with fair rotation while every
// client sees the room's chosen order); onNowPlaying + onSang carry play-tracking / least-recently-
// sung through the reconcile path. Pin exactly those four so dropping any reds.
test('app.ts reconcileOnReady fills its load-bearing hooks (listSingers, getSettings, onNowPlaying, onSang)', () => {
	for (const k of ['listSingers', 'getSettings', 'onNowPlaying', 'onSang']) {
		expect(RECONCILE).toMatch(new RegExp(`(^|[\\s,{])${k}\\s*:`));
	}
});
