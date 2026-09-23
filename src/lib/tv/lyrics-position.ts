// The position the lyrics reel DRAWS at, as a pure function of the authoritative playback position. Pure
// (the clock is passed in), so it needs neither an element nor an animation frame to test.
//
// The paused case MUST NOT depend on a running clock: a rAF-driven accumulator is the sole keeper of its own
// value, and a backgrounded tab throttles or stops rAF, so the drawn position decays toward its initial 0 and
// the reel snaps to line 0. Paused is therefore `positionSec` EXACTLY, so play-there, seek-there and
// background-and-return all draw the same offset. While playing it extrapolates from the anchor, which each
// ~4Hz telemetry tick re-anchors; a throttled rAF only coarsens the sweep, because the floor is the anchor.

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

/**
 * The elapsed term is floored at 0, so a backwards clock — or an anchor captured slightly in the future —
 * cannot draw behind the anchor.
 */
export function drawPosition(inp: LyricsPositionInputs): number {
	if (!inp.playing) return inp.positionSec;
	const elapsedSec = Math.max(0, (inp.nowMs - inp.anchoredAtMs) / 1000);
	return inp.positionSec + elapsedSec;
}
