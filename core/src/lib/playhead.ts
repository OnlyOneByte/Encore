// WHERE THE PLAYHEAD IS, between broadcasts. `positionSec` arrives on a ~4Hz telemetry feed, not per frame, so every
// surface showing elapsed time extrapolates from the last anchor — and three of them used to do that arithmetic
// themselves: the lyrics reel on the TV, the transport arc in the layout, and the seek bar on the phone home.
//
// NOT under `tv/`, which is where this lived: nothing about it is TV-specific, and the two phone surfaces were the
// ones hand-rolling it. Pure, so it is testable without a clock or a DOM.
//
// THE PAUSED CASE MUST NOT DEPEND ON A RUNNING CLOCK. A rAF- or interval-driven accumulator is the sole keeper of its
// own value, and a backgrounded tab throttles both, so the drawn position decays toward 0 and the reel snaps to line 0.
// Paused is therefore `positionSec` EXACTLY; while playing it extrapolates from the anchor, floored at the anchor, so a
// throttled tick only coarsens the sweep.

export interface LyricsPositionInputs {
	/** Authoritative playback position in seconds, from the player's telemetry (the anchor). */
	positionSec: number;
	/** Whether the transport is actually advancing right now (see `lyricsAdvancing`). */
	playing: boolean;
	/** Wall clock (ms) captured WHEN `positionSec` was last anchored. Only consulted while playing. */
	anchoredAtMs: number;
	/** Current wall-clock reading (ms). Only consulted while playing. */
	nowMs: number;
}

/** The elapsed term is floored at 0, so a backwards clock cannot draw behind the anchor. */
export function drawPosition(inp: LyricsPositionInputs): number {
	if (!inp.playing) return inp.positionSec;
	const elapsedSec = Math.max(0, (inp.nowMs - inp.anchoredAtMs) / 1000);
	return inp.positionSec + elapsedSec;
}

/** How often the two phone readouts re-extrapolate. ONCE A SECOND, NOT PER FRAME: both move sub-pixel between ticks
 *  and their CSS transition covers the gap, so a frame loop would burn battery to no visible effect. */
export const PLAYHEAD_TICK_MS = 1000;

/**
 * Arm the once-a-second re-draw, returning its teardown. Does nothing when not playing — which is what keeps a paused
 * readout at the anchor rather than letting a tick carry it — so a caller can arm unconditionally and let the argument
 * decide. Returns a no-op teardown in that case, so an effect's cleanup needs no null check.
 */
export function secondTicker(playing: boolean, onTick: () => void): () => void {
	if (!playing) return () => {};
	const id = setInterval(onTick, PLAYHEAD_TICK_MS);
	return () => clearInterval(id);
}
