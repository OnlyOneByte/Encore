// guard: a HubDeps composition must fill every optional hook the interface declares. All 12 optional keys
// are type-legal to omit while feeding a LIVE service (onNowPlaying → app.plays, onSang → app.singers,
// onEntryRemoved → cancelJobsForMedia, hasOp → the re-ack peek), and nothing reads the composition: deleting
// any of 11 from the hand-written bag left the suite green. THE KEY LIST IS DERIVED from hub.ts, so the NEXT
// optional hook fails this guard until it is wired. The parity target is `buildHubDeps`'s RETURN literal,
// and each assertion anchors on a LITERAL, because several hook names appear at unrelated call sites.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// Slice a brace-balanced literal body starting at `openMarker`'s `{`, so a key assertion cannot stray
// past the literal into unrelated call sites.
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

// The three subjects: the Bun.serve entry, the server composition root, and the realtime hub declaring the
// HubDeps interface the key list is DERIVED from. `read` throws on a missing file, which matters most for
// hub.ts — an empty body yields zero OPTIONAL_KEYS and the parity check passes having compared nothing.
const SERVER = stripComments(read('server.ts'));
const HUB = stripComments(read('src/lib/server/realtime/hub.ts'));
const APP = stripComments(read('src/lib/server/app.ts'));

// Every optional declaration `<name>?:` in the `export interface HubDeps { … }` body.
const HUBDEPS_BODY = literalBody(HUB, /export\s+interface\s+HubDeps\s*\{/);
const OPTIONAL_KEYS = Array.from(HUBDEPS_BODY.matchAll(/^\s*([A-Za-z_$][\w$]*)\?\s*:/gm)).map((mm) => mm[1]);

// Anchored on the factory's `return {`: the regex ends at `return`, so literalBody's next `{` is the
// returned object literal rather than the function body's own brace.
const FACTORY_DEPS = literalBody(
	APP,
	/export\s+function\s+buildHubDeps\s*\([\s\S]*?\)\s*:\s*HubDeps\s*\{[\s\S]*?return\s*/
);
const RECONCILE = literalBody(APP, /reconcileOnReady\s*\(\s*\{/);

// Not-vacuous sentinels: a rename or move must red LOUDLY rather than let the scan pass over nothing.
test('sentinel: HubDeps declares optional hooks, including onEntryAdded and hasOp', () => {
	expect(OPTIONAL_KEYS.length).toBeGreaterThanOrEqual(11);
	expect(OPTIONAL_KEYS).toContain('onEntryAdded');
	expect(OPTIONAL_KEYS).toContain('hasOp');
});

test('sentinel: both production composition literals were located', () => {
	// Non-empty bodies prove the anchors matched, so a moved literal reds here first.
	expect(FACTORY_DEPS.length).toBeGreaterThan(0);
	expect(RECONCILE.length).toBeGreaterThan(0);
	// …and it is the right literal: the required fields every HubDeps carries.
	for (const req of ['state', 'publish', 'mediaById']) {
		expect(FACTORY_DEPS).toMatch(new RegExp(`(^|[\\s,{])${req}\\s*[,:]`));
	}
});

test('§3: server.ts wires the live frame path through buildHubDeps(app, {...perFrame})', () => {
	// The factory being COMPLETE is only load-bearing if the live WS frame path calls it, so a revert to a
	// hand-written bag — which would escape the factory-scoped parity check — reds here.
	expect(SERVER).toMatch(/const\s+deps\s*:\s*HubDeps\s*=\s*buildHubDeps\(\s*app\s*,\s*\{/);
	for (const pf of ['broadcast', 'actorSingerId', 'listOnline', 'listAway', 'seenOp', 'hasOp']) {
		expect(SERVER).toMatch(new RegExp(`(^|[\\s,{])${pf}\\s*[,:]`));
	}
});

// The factory is the SINGLE composition site, so filling every optional key there wires it for every WS
// frame and a dropped hook reds.
test('app.ts buildHubDeps factory fills EVERY optional HubDeps hook', () => {
	const missing = OPTIONAL_KEYS.filter((k) => !new RegExp(`(^|[\\s,{])${k}\\s*:`).test(FACTORY_DEPS));
	expect(missing).toEqual([]);
});

// `reconcileOnReady` takes the full HubDeps type but supplies a deliberate subset. `listSingers` and
// `getSettings` are load-bearing — without them it picks with fair rotation while every client sees the
// room's chosen order — and `onNowPlaying`/`onSang` carry play-tracking through the reconcile path.
test('app.ts reconcileOnReady fills its load-bearing hooks (listSingers, getSettings, onNowPlaying, onSang)', () => {
	for (const k of ['listSingers', 'getSettings', 'onNowPlaying', 'onSang']) {
		expect(RECONCILE).toMatch(new RegExp(`(^|[\\s,{])${k}\\s*:`));
	}
});
