// The visualizer loop's DECISIONS, as pure functions — everything the rAF callback must decide, with
// none of the canvas, the timers or the Svelte effect it decides for.
//
// WHY THIS IS SPLIT OUT. The loop had two bugs that a green test suite could not see, both structural
// rather than arithmetic (see VisualizerStage.svelte for the full account):
//
//   1. `variant`/`hue` were read only inside the rAF callback, so a Svelte `$effect` never tracked
//      them and a room change was dropped until remount. That is a tracking bug in the component and
//      is fixed there by reading them synchronously; it is not expressible here.
//   2. The time baseline lived in a per-effect-run local (`let start = 0`), so every effect re-run —
//      a `playing` toggle, the visualizer block remounting — reset it and pinned `t` near zero. Every
//      frame then drew the `t ~ 0` picture, which reads as a STATIC background.
//
// Bug 2 is the one this module protects. The baseline is passed IN and handed BACK, so the caller can
// hold it across effect re-runs and a test can simulate a re-run by threading the same baseline through
// a fresh call — the exact motion the component must preserve, asserted without a DOM.
//
// There is no canvas here and no `requestAnimationFrame`: `visualizer-motion.test.ts` says in its own
// header it cannot see a canvas, so the testable part of the loop is exactly this — clock derivation
// and the two ways the loop stops.

/**
 * Resolve the animation clock for a frame.
 *
 * `start` is the timestamp the loop treats as t=0. It is `null` until the first frame establishes it,
 * and — this is the whole point — it is owned by the CALLER so it survives an effect re-run. Passing
 * the same non-null `start` back in on every subsequent frame (and across a re-run) is what lets `t`
 * accumulate instead of resetting to zero.
 *
 * Returns the resolved baseline to persist and the elapsed seconds to draw. `tSec` is clamped at 0 so
 * a clock that somehow runs backwards (a `now` earlier than `start`) cannot hand a renderer a negative
 * time.
 */
export function frameClock(now: number, start: number | null): { start: number; tSec: number } {
	const base = start ?? now;
	return { start: base, tSec: Math.max(0, (now - base) / 1000) };
}

/**
 * Whether this frame is due, given the last drawn timestamp and the frame budget.
 *
 * The loop reschedules every animation frame (~60fps on a TV) but only DRAWS at ~30fps — the lyric
 * ball has the stronger claim on the budget (see VisualizerStage note 1). `last` is `null` before the
 * first draw, which is always due.
 */
export function frameDue(now: number, last: number | null, frameMs: number): boolean {
	return last === null || now - last >= frameMs;
}

/**
 * Whether the loop should ANIMATE, versus draw a single still frame and stop.
 *
 * Two reasons to hold still, and they are different in kind: `playing` false is an idle attract screen
 * that must cost nothing, and `reducedMotion` is an accessibility preference about movement — not a
 * request for a blank stage, which is why the caller still draws one frame in both cases.
 */
export function shouldAnimate(playing: boolean, reducedMotion: boolean): boolean {
	return playing && !reducedMotion;
}
