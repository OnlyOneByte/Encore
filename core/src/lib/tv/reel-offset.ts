// The VERTICAL scroll offset the lyrics reel is drawn at, as a pure function of measured DOM geometry.
//
// The current row is placed by an asymmetric bias, then clamped into the UNMASKED window `[fadeTop, band - fadeBot]` —
// NOT the band, because clamping to the band parks the sung row inside an edge-fade ramp.
// See docs/FRONTEND.md#the-lyrics-reel.

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
	/** Rendered TOP ramp depth in px, 0 when that edge has no context rows. Defaults reduce to [0, band]. */
	fadeTop?: number;
	/** Rendered depth of the BOTTOM edge-fade ramp in px (0 when the bottom edge is unfaded). */
	fadeBot?: number;
}

/**
 * The translateY the reel is drawn at, in px. A positive `linesBefore - linesAfter` pushes the current line DOWN — the
 * sign is easy to get backwards, since wanting MORE lines after means the sung line sits HIGHER.
 */
export function reelOffset(inp: ReelOffsetInputs): number {
	const { rowTop, rowHeight, band, linesBefore, linesAfter } = inp;
	const fadeTop = inp.fadeTop ?? 0;
	const fadeBot = inp.fadeBot ?? 0;
	// Clamped to [0, band] so pathological measured depths can never invert the window.
	const winTop = Math.max(0, Math.min(fadeTop, band));
	const winBot = Math.max(winTop, Math.min(band - fadeBot, band));
	const winHeight = winBot - winTop;
	const winCentre = winTop + winHeight / 2;
	if (rowHeight >= winHeight) {
		// Window too short to hold the row (a wrapped row, or ramps leaving under one row of plateau): centre it, because
		// honouring the bias here pushes the sung words further into a ramp.
		return -(rowTop + rowHeight / 2 - winCentre);
	}
	const bias = ((linesBefore - linesAfter) / 2) * rowHeight;
	let offset = -(rowTop + rowHeight / 2 - winCentre - bias);
	const top = rowTop + offset;
	if (top < winTop) offset += winTop - top;
	else if (top + rowHeight > winBot) offset -= top + rowHeight - winBot;
	return offset;
}
