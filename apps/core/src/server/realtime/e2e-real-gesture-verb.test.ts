// guard: the #64 tap-to-start affordance — the ONLY route out of a silent TV — is exercisable e2e
// ONLY if the CDP driver can deliver a REAL user gesture, and only if some probe actually uses it.
//
// #332: every click verb in apps/core/e2e/cdp.mjs is a synthetic `el.click()` through
// Runtime.evaluate, which dispatches an UNTRUSTED event and grants NO user activation, so it can
// never unblock autoplay. The fix adds a `realClick(x, y)` verb that dispatches a trusted
// mousePressed/mouseReleased pair through the CDP Input domain, and a gestureless probe
// (e2e/probes/p13-tap-to-start.mjs) that taps the /tv stage and asserts decoded bytes climb.
//
// WHY A SOURCE SCAN: e2e probes under apps/core/e2e/probes/ are live-server .mjs scripts invoked by
// NOTHING in `bun test` — there is no unit harness and no pure function to exercise. So the verb and
// its use are decidable properties of the driver's and probe's own text. Reverting either half
// (deleting realClick, or the probe ceasing to call it) leaves the whole suite green while the
// affordance goes back to having zero coverage — exactly the hole #332 names. Comments are blanked so
// prose describing the old synthetic-click behaviour can neither satisfy nor trip these matches.
// Precedent: reaper-onfailed-wiring.test.ts, fuzz-i4-autoplay-refusal-skip.test.ts.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server/realtime → three levels up to apps/core, then into e2e/.
const E2E = join(import.meta.dir, '..', '..', '..', 'e2e');
const CDP = stripComments(readFileSync(join(E2E, 'cdp.mjs'), 'utf8'));
const PROBE = stripComments(readFileSync(join(E2E, 'probes', 'p13-tap-to-start.mjs'), 'utf8'));

test('the CDP driver files are non-empty (guard is not vacuous)', () => {
	// A broken path would read '' and every match below would trivially fail-open on a .not; assert
	// the driver and probe actually loaded before asserting anything about their content.
	expect(CDP.length).toBeGreaterThan(2000);
	expect(PROBE.length).toBeGreaterThan(1000);
});

test('cdp.mjs exposes a realClick verb that delivers a TRUSTED gesture via CDP Input (#332)', () => {
	// The verb must exist by name...
	expect(CDP).toMatch(/async\s+realClick\s*\(\s*x\s*,\s*y\s*\)/);
	// ...and it must use the Input domain, not another synthetic el.click(). A trusted click is a
	// mousePressed followed by a mouseReleased — assert BOTH halves, in order, or a half-verb (press
	// with no release, or release with no press) would grant activation unreliably and still pass a
	// single-token check.
	const pressed = CDP.indexOf("Input.dispatchMouseEvent");
	expect(pressed).toBeGreaterThanOrEqual(0);
	expect(CDP).toMatch(/Input\.dispatchMouseEvent[^\n]*type:\s*'mousePressed'/);
	expect(CDP).toMatch(/Input\.dispatchMouseEvent[^\n]*type:\s*'mouseReleased'/);
	const iPress = CDP.indexOf("'mousePressed'");
	const iRelease = CDP.indexOf("'mouseReleased'");
	expect(iPress).toBeGreaterThanOrEqual(0);
	expect(iRelease).toBeGreaterThan(iPress);
});

test('a probe actually EXERCISES the tap-to-start affordance with realClick (#332)', () => {
	// The verb existing is not coverage; a probe must call it against the /tv stage. Without this a
	// dead verb ships green and #64 keeps its zero coverage.
	expect(PROBE).toMatch(/\.realClick\s*\(/);
	// The tap must be preceded by the blocked-state oracle: the .autoplay-hint card is read, so the
	// probe proves the room was genuinely stalled BEFORE the gesture (not asserting a room that was
	// already playing).
	expect(PROBE).toMatch(/autoplay-hint/);
	// And the payoff must be the decode oracle, not paused===false alone.
	expect(PROBE).toMatch(/webkitAudioDecodedByteCount/);
});
