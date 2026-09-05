// The position the lyrics reel DRAWS at, as a pure function of the authoritative playback position —
// and specifically why the paused case may not depend on a running clock.
//
// THE BUG THIS CLOSES (issue #54). Defocus the TV while a song is PAUSED and the reel snaps to
// the first line; unpausing restores the correct place. The drawn scroll offset is derived from
// `displayPos`, which LyricsOverlay kept as a mutable `$state(0)` that its requestAnimationFrame loop
// rewrote every frame. A backgrounded tab has its rAF throttled or stopped, so the loop that was the
// SOLE keeper of `displayPos` stops running and the value the reel is drawn from drifts back toward its
// `0` initial — line 0, the top. The symptom is loop-carried render state, not a wrong anchor: nothing
// is mis-computed, there is simply no computation happening while the frame budget is suspended.
//
// The fix direction the issue specifies is PURITY, not a `visibilitychange` special-case (re-deriving
// on the wake event papers over it while leaving the accumulator in place). So the drawn position
// becomes a pure function of the authoritative `positionSec` plus, ONLY while playing, a wall-clock
// delta since that position was last anchored:
//
//   • paused  → `positionSec` exactly. No wall-clock term, no accumulator, nothing a stopped rAF can
//     lose. Reaching a given `positionSec` by play-there, seek-there, or background-and-return all draw
//     the identical offset — the path-independence the detector for this bug class checks.
//   • playing → `positionSec + (now - anchoredAt)` in seconds, the honest 60fps sweep between the
//     ~4Hz telemetry ticks, self-corrected on every tick. A throttled rAF here only makes the sweep
//     coarse until the next tick re-anchors it; it cannot jump to the top because the floor is
//     `positionSec`, never 0.
//
// Pure (no DOM, no globals — the clock is passed in) so it is unit-testable without a real element or a
// real animation frame, matching `transport.ts`, `video-src.ts` and `guide-sync.ts`.

export interface LyricsPositionInputs {
	/** Authoritative playback position in seconds, from the player's telemetry (the anchor). */
	positionSec: number;
	/** Whether the transport is actually advancing right now (see `lyricsAdvancing`). */
	playing: boolean;
	/**
	 * Wall-clock reading (ms, e.g. `performance.now()`) captured WHEN `positionSec` was last anchored.
	 * Only consulted while playing.
	 */
	anchoredAtMs: number;
	/** Current wall-clock reading (ms). Only consulted while playing. */
	nowMs: number;
}

/**
 * The position the reel and highlight should be drawn at, in seconds.
 *
 * Path-independent while paused: the result is `positionSec` and depends on nothing that a stopped or
 * throttled animation loop could fail to keep alive. While playing it extrapolates forward from the
 * anchor by the elapsed wall time, and the elapsed term is floored at 0 so a clock that went backwards
 * (or an anchor captured slightly in the future) can never pull the draw position below the anchor.
 */
export function drawPosition(inp: LyricsPositionInputs): number {
	if (!inp.playing) return inp.positionSec;
	const elapsedSec = Math.max(0, (inp.nowMs - inp.anchoredAtMs) / 1000);
	return inp.positionSec + elapsedSec;
}
