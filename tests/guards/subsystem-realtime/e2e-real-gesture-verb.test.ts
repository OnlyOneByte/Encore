// guard: a synthetic `el.click()` through evaluate dispatches an UNTRUSTED event and grants NO user
// activation, so it can never unblock autoplay. Caught: every click verb in the driver was synthetic,
// leaving tap-to-start — the only route out of a silent TV — with zero e2e coverage. Both halves are pinned
// because either alone ships green: the driver needs a trusted-gesture `realClick`, and a probe must call it.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// `read` throws on a missing file rather than handing the `.not` assertions below an empty string.
const CDP = stripComments(read('tests/e2e/driver.mjs'));
const PROBE = stripComments(read('tests/e2e/probes/p13-tap-to-start.mjs'));

test('the CDP driver files are non-empty (guard is not vacuous)', () => {
	// A broken path reads '' and every `.not` below would trivially fail-open.
	expect(CDP.length).toBeGreaterThan(2000);
	expect(PROBE.length).toBeGreaterThan(1000);
});

test('driver.mjs exposes a realClick verb that delivers a TRUSTED gesture, not a synthetic dispatch', () => {
	expect(CDP).toMatch(/async\s+realClick\s*\(\s*x\s*,\s*y\s*\)/);
	// `page.mouse` IS the browser's real input pipeline: Playwright dispatches through the Input domain
	// internally, so a `mouse.click`/`mouse.down` is a trusted press-and-release.
	expect(CDP).toMatch(/async\s+realClick[\s\S]{0,200}?page\.mouse\.(?:click|down)\s*\(/);
	// The negative half is the point: realClick must NOT be an evaluate-based `el.click()`.
	const realClickBody = CDP.slice(CDP.indexOf('async realClick'), CDP.indexOf('async drag'));
	expect(realClickBody).not.toMatch(/evaluate\s*\(/);
	expect(realClickBody).not.toMatch(/\.click\s*\(\s*\)/);
	// `drag` shares the pipeline — an untrusted pointer sequence is the same defect one interaction further on.
	expect(CDP).toMatch(/async\s+drag[\s\S]{0,400}?page\.mouse\.down\s*\(/);
	expect(CDP).toMatch(/async\s+drag[\s\S]{0,600}?page\.mouse\.up\s*\(/);
});

test('a probe actually EXERCISES the tap-to-start affordance with realClick', () => {
	// The verb existing is not coverage: without a caller a dead verb ships green.
	expect(PROBE).toMatch(/\.realClick\s*\(/);
	// Reading the autoplay-hint card first proves the room was genuinely stalled BEFORE the gesture, and the
	// decode counter is the payoff oracle — `paused === false` alone would pass on a silent TV.
	expect(PROBE).toMatch(/autoplay-hint/);
	expect(PROBE).toMatch(/webkitAudioDecodedByteCount/);
});
