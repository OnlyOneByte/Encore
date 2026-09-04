// The visualizer loop's decision logic, unit-tested where the component's rAF loop cannot be.
//
// `visualizer-motion.test.ts` states in its own header that it cannot see a canvas, so the loop's
// behaviour is exercised here instead — as pure functions, threading the baseline by hand the way the
// component threads it through `clockStart`. The load-bearing test is the SIMULATED EFFECT RE-RUN:
// that is the exact motion the "static picture" bug destroyed, and it is invisible to a source scan.
import { test, expect } from 'bun:test';
import { frameClock, frameDue, shouldAnimate } from './visualizer-loop';

test('the first frame establishes the baseline and draws t=0', () => {
	// Before any frame the baseline is null; the first `now` becomes t=0's anchor, not a jump.
	const { start, tSec } = frameClock(1000, null);
	expect(start).toBe(1000);
	expect(tSec).toBe(0);
});

test('elapsed time is derived in seconds from the persisted baseline', () => {
	const { start, tSec } = frameClock(4300, 1000);
	expect(start).toBe(1000); // an already-set baseline is preserved, never re-anchored
	expect(tSec).toBeCloseTo(3.3, 6);
});

test('t is monotonic across a SIMULATED effect re-run — the static-picture regression', () => {
	// Model exactly what the component does: hold the baseline OUTSIDE the loop and thread it back in on
	// every frame. A `playing` toggle / tracked-prop change / remount re-runs the effect; the OLD code
	// reset `start` to ~0 there, pinning `t` and drawing one frozen frame forever. Here the baseline
	// carries across the re-run, so `t` keeps climbing — which is the whole fix.
	let clockStart: number | null = null;

	// three frames of the first effect run
	for (const now of [0, 40, 80]) clockStart = frameClock(now, clockStart).start;
	const beforeRerun = frameClock(80, clockStart).tSec;

	// the effect tears down and re-runs; `clockStart` (component-scoped) is UNTOUCHED by that
	const afterRerun = frameClock(120, clockStart).tSec;

	expect(clockStart).toBe(0); // baseline never re-anchored
	expect(afterRerun).toBeGreaterThan(beforeRerun); // time advanced, not reset
	expect(afterRerun).toBeCloseTo(0.12, 6); // 120ms since the original t=0, not since the re-run
});

test('a backwards clock is clamped, never handed to a renderer as negative t', () => {
	// Defensive: if `now` ever precedes the baseline (clock skew), t floors at 0 rather than running a
	// renderer with a negative time.
	expect(frameClock(500, 1000).tSec).toBe(0);
});

test('the first draw is always due; later draws wait for the frame budget', () => {
	expect(frameDue(1000, null, 33)).toBe(true); // nothing drawn yet
	expect(frameDue(1010, 1000, 33)).toBe(false); // only 10ms since last draw, under the ~30fps cap
	expect(frameDue(1040, 1000, 33)).toBe(true); // 40ms >= budget
	expect(frameDue(1033, 1000, 33)).toBe(true); // exactly the budget is due
});

test('the loop animates only when playing and motion is allowed', () => {
	// The reduced-motion / not-playing branch: in either case the component draws exactly ONE still
	// frame and does not schedule the loop.
	expect(shouldAnimate(true, false)).toBe(true);
	expect(shouldAnimate(false, false)).toBe(false); // idle attract screen — cost nothing
	expect(shouldAnimate(true, true)).toBe(false); // reduced-motion — a still background, not blank
	expect(shouldAnimate(false, true)).toBe(false);
});
