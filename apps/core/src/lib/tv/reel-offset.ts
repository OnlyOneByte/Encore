// The VERTICAL scroll offset the lyrics reel is drawn at, as a pure function of the measured DOM
// geometry — and specifically why the offset must be clamped to the VISIBLE band, not the derived one.
//
// THE BUG THIS CLOSES (issue #270). Raise the TV Text size while Lines-ahead exceeds Lines-sung and the
// line being sung scrolls off the TOP of the reel — the singer is left with only dim upcoming lines and
// no marker anywhere. The anchor places the current row by biasing it away from centre so an asymmetric
// row split (more lines after than before) can be honoured:
//
//   bias   = ((linesBefore - linesAfter) / 2) * rowHeight
//   offset = -(rowCenter - band/2 - bias)            // rowCenter = rowTop + rowHeight/2
//
// That bias is measured against the DERIVED reel height (rowCount x rowHeight). But the reel is then
// clipped by `max-height: 100vh - --tv-chrome-h`, so the height it is actually SEEN through — `band`
// (the viewport's clientHeight) — is smaller whenever that cap binds. The bias moves the row by a
// distance sized for the taller box, so once `band < (1 + linesAfter - linesBefore) * rowHeight` the
// current row's top edge crosses above the band and disappears. Symmetric splits have bias 0, which is
// why the shipped 2/2 default never showed it.
//
// The fix is to clamp the biased offset so the current row stays inside the band it is actually drawn
// through, while keeping the asymmetric intent wherever there is room:
//
//   • the band can hold the row → keep the biased offset, but slide it just enough to bring the row
//     fully inside [0, band] if the bias pushed an edge out. Where the bias already fits, nothing moves.
//   • the band cannot hold even one row (extreme scale on a short panel) → centre the row, so as much
//     of the sung words as possible is visible, rather than pinning one edge and hiding the rest.
//
// Pure (no DOM, no globals — the measured rects are passed in) so the clamp invariant is unit-testable
// without a real element, matching `transport.ts`, `guide-sync.ts` and `lyrics-position.ts`.

export interface ReelOffsetInputs {
	/** `.row.current` offsetTop within the reel, in px (measured). */
	rowTop: number;
	/** `.row.current` offsetHeight in px (measured — a wrapped current row is taller than one line). */
	rowHeight: number;
	/** The VISIBLE band height: the viewport element's clientHeight AFTER the max-height cap, in px. */
	band: number;
	/** Room setting: context rows shown before the current line. */
	linesBefore: number;
	/** Room setting: context rows shown after the current line. */
	linesAfter: number;
}

/**
 * The `translateY` the reel should be drawn at (px), such that the current row is placed by the
 * asymmetric bias AND is guaranteed to stay within the visible band `[0, band]` whenever the band can
 * hold it. Falls back to centring the current row when the band is shorter than one row.
 *
 * A positive `linesBefore - linesAfter` pushes the current line DOWN (more room below); a negative one
 * pushes it UP. The clamp only ever moves the offset back TOWARD keeping the current row visible, so it
 * cannot re-introduce the asymmetry it removed.
 */
export function reelOffset(inp: ReelOffsetInputs): number {
	const { rowTop, rowHeight, band, linesBefore, linesAfter } = inp;
	const bias = ((linesBefore - linesAfter) / 2) * rowHeight;
	let offset = -(rowTop + rowHeight / 2 - band / 2 - bias);
	if (rowHeight >= band) {
		// Band too short to hold the current row at all: centre it (bias ignored — there is no room to
		// honour it and honouring it would hide the sung words at one edge).
		return -(rowTop + rowHeight / 2 - band / 2);
	}
	const top = rowTop + offset;
	if (top < 0)
		offset += -top; // current row's top fell above the band — pull it back to the top
	else if (top + rowHeight > band) offset -= top + rowHeight - band; // bottom fell below — pull it up
	return offset;
}
