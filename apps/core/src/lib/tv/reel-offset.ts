// The VERTICAL scroll offset the lyrics reel is drawn at, as a pure function of the measured DOM
// geometry — and specifically why the offset must be clamped to the READABLE window, not the derived
// reel height and not even the full clipped band.
//
// — the sung row off the TOP of the reel. Raise the TV Text size while Lines-ahead exceeds
// Lines-sung and the line being sung scrolled off the top: the singer was left with only dim upcoming
// lines and no marker. The anchor places the current row by biasing it away from centre so an
// asymmetric row split (more lines after than before) can be honoured:
//
//   bias   = ((linesBefore - linesAfter) / 2) * rowHeight
//   offset = -(rowCenter - target - bias)            // rowCenter = rowTop + rowHeight/2
//
// That bias is measured against the DERIVED reel height (rowCount x rowHeight). But the reel is then
// clipped by max-height 100vh - --tv-chrome-h, so the height it is actually SEEN through — band
// (the viewport clientHeight) — is smaller whenever that cap binds. Clamping the biased offset into
// the band kept the sung row on screen; symmetric splits have bias 0, which is why the shipped 2/2
// default never showed it.
//
// — the sung row parked INSIDE the edge-fade ramp. Clamping to [0, band] is not enough, because
// the viewport box FADES 1.9em (one row) to transparent at each edge that has context rows (the mask
// in LyricsOverlay.svelte). The region a singer can actually READ is the UNMASKED window
// [fadeTop, band - fadeBot], and the earlier clamp parked the row at top === 0 / bottom === band —
// congruent with a ramp, the worst available position: the line being sung rendered fainter than the
// line after it, and the ball (drawn above its word) sat in the lowest-alpha slice of the ramp. The
// fade is correct (it makes the reel read as a continuous scroll, and a no-context edge is deliberately
// unfaded); the clamp TARGET was wrong. So the clamp is now the unmasked window:
//
//   the window can hold the row -> place it by the bias about the window centre, then slide it just
//     enough to bring the row fully inside [fadeTop, band - fadeBot] if the bias pushed an edge into a
//     ramp. Where the bias already fits, nothing moves.
//   the window cannot hold even one row (a wrapped current row, or a panel so short the two ramps
//     leave < one row of plateau) -> centre the row IN THE WINDOW, so as much of the sung words as
//     possible sits in fully-opaque pixels rather than pinning one edge inside a ramp.
//
// fadeTop/fadeBot are the ACTUAL rendered ramp depths in px, keyed off whether each edge has
// context rows (LyricsOverlay passes 0 for a no-context edge and the CSS-capped depth otherwise). With
// both 0 the window IS [0, band], so this reduces to the earlier clamp exactly.
//
// Pure (no DOM, no globals — the measured rects are passed in) so the clamp invariant is unit-testable
// without a real element, matching transport.ts, guide-sync.ts and lyrics-position.ts.

export interface ReelOffsetInputs {
	/** .row.current offsetTop within the reel, in px (measured). */
	rowTop: number;
	/** .row.current offsetHeight in px (measured — a wrapped current row is taller than one line). */
	rowHeight: number;
	/** The VISIBLE band height: the viewport element clientHeight AFTER the max-height cap, in px. */
	band: number;
	/** Room setting: context rows shown before the current line. */
	linesBefore: number;
	/** Room setting: context rows shown after the current line. */
	linesAfter: number;
	/**
	 * Rendered depth of the TOP edge-fade ramp in px (0 when the top edge has no context rows and is
	 * therefore unfaded). Defaults to 0 so a caller that does not measure the fade gets the [0, band]
	 * clamp unchanged.
	 */
	fadeTop?: number;
	/** Rendered depth of the BOTTOM edge-fade ramp in px (0 when the bottom edge is unfaded). */
	fadeBot?: number;
}

/**
 * The translateY the reel should be drawn at (px), such that the current row is placed by the
 * asymmetric bias AND is guaranteed to stay within the UNMASKED window [fadeTop, band - fadeBot]
 * whenever that window can hold it. Falls back to centring the current row in the window when the window
 * is shorter than one row.
 *
 * A positive linesBefore - linesAfter pushes the current line DOWN (more room below); a negative one
 * pushes it UP. The clamp only ever moves the offset back TOWARD keeping the current row inside the
 * unmasked window, so it cannot re-introduce the asymmetry it removed.
 */
export function reelOffset(inp: ReelOffsetInputs): number {
	const { rowTop, rowHeight, band, linesBefore, linesAfter } = inp;
	const fadeTop = inp.fadeTop ?? 0;
	const fadeBot = inp.fadeBot ?? 0;
	// The window a singer can actually read: the band minus each rendered ramp. Clamped to [0, band] so
	// pathological measured depths can never invert the window.
	const winTop = Math.max(0, Math.min(fadeTop, band));
	const winBot = Math.max(winTop, Math.min(band - fadeBot, band));
	const winHeight = winBot - winTop;
	const winCentre = winTop + winHeight / 2;
	if (rowHeight >= winHeight) {
		// Window too short to hold the current row at all (a wrapped row, or ramps that leave < one row
		// of plateau): centre the row IN THE WINDOW — bias ignored, there is no room to honour it and
		// honouring it would push the sung words further into a ramp.
		return -(rowTop + rowHeight / 2 - winCentre);
	}
	const bias = ((linesBefore - linesAfter) / 2) * rowHeight;
	let offset = -(rowTop + rowHeight / 2 - winCentre - bias);
	const top = rowTop + offset;
	if (top < winTop)
		offset += winTop - top; // current row top fell into the TOP ramp — pull it down to the plateau
	else if (top + rowHeight > winBot) offset -= top + rowHeight - winBot; // bottom fell into the BOTTOM ramp — pull it up
	return offset;
}
