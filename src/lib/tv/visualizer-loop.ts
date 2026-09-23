// The visualizer loop's DECISIONS, as pure functions — no canvas, no timers, no Svelte effect, so the clock
// derivation and the two ways the loop stops are testable without a DOM.

/**
 * `start` is the timestamp the loop treats as t=0, and it is owned by the CALLER so it survives an effect
 * re-run. A baseline kept in a per-effect-run local is reset by every `playing` toggle or remount, which pins
 * `t` near zero and draws a static background. `tSec` is floored at 0, so a backwards clock cannot hand a
 * renderer a negative time.
 */
export function frameClock(now: number, start: number | null): { start: number; tSec: number } {
	const base = start ?? now;
	return { start: base, tSec: Math.max(0, (now - base) / 1000) };
}

/**
 * Whether this frame is due. The loop reschedules every animation frame (~60fps on a TV) but only DRAWS at
 * ~30fps: the lyric ball has the stronger claim on the frame budget. `last` is `null` before the first draw.
 */
export function frameDue(now: number, last: number | null, frameMs: number): boolean {
	return last === null || now - last >= frameMs;
}

/**
 * Whether the loop should ANIMATE, versus draw a single still frame and stop. Two reasons to hold still, and
 * they differ in kind: `playing` false is an idle attract screen that must cost nothing, and `reducedMotion`
 * is a preference about MOVEMENT, not a request for a blank stage — which is why the caller still draws one
 * frame in both cases.
 */
export function shouldAnimate(playing: boolean, reducedMotion: boolean): boolean {
	return playing && !reducedMotion;
}
