// The position the lyrics reel DRAWS at, as a pure function of the authoritative playback position.
//
// The paused case MUST NOT depend on a running clock: a rAF-driven accumulator is the sole keeper of its own value, and
// a backgrounded tab throttles rAF, so the drawn position decays toward 0 and the reel snaps to line 0. Paused is
// therefore `positionSec` EXACTLY; while playing it extrapolates from the anchor, floored at the anchor, so a throttled
// rAF only coarsens the sweep.

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
