// guard: the tap-to-start affordance — the ONLY route out of a silent TV — is exercisable e2e
// ONLY if the CDP driver can deliver a REAL user gesture, and only if some probe actually uses it.
//
// every click verb in tests/e2e/driver.mjs is a synthetic `el.click()` through
// Runtime.evaluate, which dispatches an UNTRUSTED event and grants NO user activation, so it can
// never unblock autoplay. The fix adds a `realClick(x, y)` verb that dispatches a trusted
// mousePressed/mouseReleased pair through the CDP Input domain, and a gestureless probe
// (e2e/probes/p13-tap-to-start.mjs) that taps the /tv stage and asserts decoded bytes climb.
//
// WHY A SOURCE SCAN: e2e probes under tests/e2e/probes/ are live-server .mjs scripts invoked by
// NOTHING in `bun test` — there is no unit harness and no pure function to exercise. So the verb and
// its use are decidable properties of the driver's and probe's own text. Reverting either half
// (deleting realClick, or the probe ceasing to call it) leaves the whole suite green while the
// affordance goes back to having zero coverage — exactly the coverage hole this closes. Comments are blanked so
// prose describing the old synthetic-click behaviour can neither satisfy nor trip these matches.
// Precedent: reaper-onfailed-wiring.test.ts, fuzz-i4-autoplay-refusal-skip.test.ts.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// Was `at('tests/e2e')`, counted out from this guard's old home in
// src/lib/server/realtime. The driver and the probe are named from the repo root now, and `read`
// throws on a missing file rather than handing the `.not` assertions below an empty string.
const CDP = stripComments(read('tests/e2e/driver.mjs'));
const PROBE = stripComments(read('tests/e2e/probes/p13-tap-to-start.mjs'));

test('the CDP driver files are non-empty (guard is not vacuous)', () => {
	// A broken path would read '' and every match below would trivially fail-open on a .not; assert
	// the driver and probe actually loaded before asserting anything about their content.
	expect(CDP.length).toBeGreaterThan(2000);
	expect(PROBE.length).toBeGreaterThan(1000);
});

test('driver.mjs exposes a realClick verb that delivers a TRUSTED gesture, not a synthetic dispatch', () => {
	// The verb must exist by name...
	expect(CDP).toMatch(/async\s+realClick\s*\(\s*x\s*,\s*y\s*\)/);
	// ...and it must go through the browser's real input pipeline, not another synthetic el.click().
	//
	// WHAT CHANGED, AND WHAT DID NOT. This used to assert a raw CDP `Input.dispatchMouseEvent` pair —
	// `mousePressed` then `mouseReleased`, in that order — because the driver spoke CDP by hand. The driver
	// is Playwright now and `page.mouse` IS that pipeline: Playwright dispatches through the same Input
	// domain internally, and `mouse.click()` is a press and a release. So the CLAIM is unchanged — a
	// trusted gesture, because a synthetic click grants no user activation and autoplay stays blocked — and
	// only the spelling of the evidence moved.
	expect(CDP).toMatch(/async\s+realClick[\s\S]{0,200}?page\.mouse\.(?:click|down)\s*\(/);
	// And the negative half, which is the point of the guard: realClick must NOT be an evaluate-based
	// `el.click()`. That is what every other click verb was, and what does not grant activation.
	const realClickBody = CDP.slice(CDP.indexOf('async realClick'), CDP.indexOf('async drag'));
	expect(realClickBody).not.toMatch(/evaluate\s*\(/);
	expect(realClickBody).not.toMatch(/\.click\s*\(\s*\)/);
	// `drag` shares the pipeline: a drag handler that never sees a trusted pointer sequence is the same
	// defect one interaction further on, so pin it here rather than letting it regress separately.
	expect(CDP).toMatch(/async\s+drag[\s\S]{0,400}?page\.mouse\.down\s*\(/);
	expect(CDP).toMatch(/async\s+drag[\s\S]{0,600}?page\.mouse\.up\s*\(/);
});

test('a probe actually EXERCISES the tap-to-start affordance with realClick', () => {
	// The verb existing is not coverage; a probe must call it against the /tv stage. Without this a
	// dead verb ships green and the autoplay recovery keeps its zero coverage.
	expect(PROBE).toMatch(/\.realClick\s*\(/);
	// The tap must be preceded by the blocked-state oracle: the .autoplay-hint card is read, so the
	// probe proves the room was genuinely stalled BEFORE the gesture (not asserting a room that was
	// already playing).
	expect(PROBE).toMatch(/autoplay-hint/);
	// And the payoff must be the decode oracle, not paused===false alone.
	expect(PROBE).toMatch(/webkitAudioDecodedByteCount/);
});
