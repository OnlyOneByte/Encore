import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reelOffset } from './reel-offset';

// The invariant this pins (issue #270): the LINE BEING SUNG must stay visible on the reel across every
// legal combination of Text size, Lines-sung and Lines-ahead — never scrolled off the top the way the
// unclamped bias did once the reel's max-height cap started binding.
//
// The measured predicate is deliberately computed a DIFFERENT way from reelOffset()'s own arithmetic:
// reelOffset() reasons in translateY; the test converts that translateY into the current row's rect
// WITHIN the visible band and measures how much of that rect intersects [0, band]. So a test pass means
// "the sung row is actually on screen", not "the formula returned what the formula returns".

/** Fraction of the current row that lies inside the visible band [0, band], given the reel offset. */
function visibleFraction(rowTop: number, rowHeight: number, band: number, offset: number): number {
	const top = rowTop + offset; // where the row's top edge lands within the band
	const bottom = top + rowHeight;
	const visible = Math.max(0, Math.min(bottom, band) - Math.max(top, 0));
	return visible / rowHeight;
}

// The OLD, buggy placement — biased offset with NO clamp — reproduced verbatim so the before-row is a
// measurement of the shipped behaviour, not a paraphrase of it.
function oldOffsetUnclamped(rowTop: number, rowHeight: number, band: number, before: number, after: number): number {
	const bias = ((before - after) / 2) * rowHeight;
	return -(rowTop + rowHeight / 2 - band / 2 - bias);
}

// A reel geometry sized like /tv's: N rows stacked, current row at index `before`, each `rowHeight`
// tall, then the whole thing clipped to `band` (the max-height cap). Matches how measureReel reads the
// live DOM: rowTop = before * rowHeight (rows above the current one), band = the clipped clientHeight.
function geom(before: number, after: number, rowHeight: number, band: number) {
	const rowTop = before * rowHeight;
	return { rowTop, rowHeight, band, linesBefore: before, linesAfter: after };
}

// Text sizes as MULTIPLES of the base 1.9em row: the numbers from the issue's own measurement table
// (100/150/200/250/300% of a ~91px base row at 1280x800). rowHeight grows with scale; band is fixed by
// the panel, so the cap binds harder as scale rises — exactly the axis that breaks.
const BAND = 508; // ~508.2px band from the issue (1280x800, innerHeight 713)
const ROW_AT_SCALE: Record<number, number> = { 100: 91, 150: 137, 200: 182, 250: 228, 300: 273 };

describe('reelOffset — the sung row stays on the reel (#270)', () => {
	it('keeps the current row fully visible at the default 2/2 split at every Text size (control)', () => {
		for (const scale of Object.keys(ROW_AT_SCALE).map(Number)) {
			const rh = ROW_AT_SCALE[scale];
			const g = geom(2, 2, rh, BAND);
			const off = reelOffset(g);
			expect(visibleFraction(g.rowTop, g.rowHeight, BAND, off)).toBe(1);
		}
	});

	it('keeps the current row ON SCREEN for the failing 1-sung/4-ahead split at every Text size', () => {
		// The issue reports the sung row reaching 0 (fully gone) at 300% with the OLD formula. The clamp
		// must keep a positive visible fraction at every size — the sung line is never off the reel.
		for (const scale of Object.keys(ROW_AT_SCALE).map(Number)) {
			const rh = ROW_AT_SCALE[scale];
			const g = geom(1, 4, rh, BAND);
			const off = reelOffset(g);
			const frac = visibleFraction(g.rowTop, g.rowHeight, BAND, off);
			expect(frac).toBeGreaterThan(0);
			// Where the band can hold a whole row, the sung row is not just partly visible but FULLY on.
			if (rh <= BAND) expect(frac).toBe(1);
		}
	});

	it('holds across the whole legal rows x Text-size grid (0..3 before, 0..4 after)', () => {
		for (const before of [0, 1, 2, 3]) {
			for (const after of [0, 1, 2, 3, 4]) {
				for (const scale of Object.keys(ROW_AT_SCALE).map(Number)) {
					const rh = ROW_AT_SCALE[scale];
					const g = geom(before, after, rh, BAND);
					const off = reelOffset(g);
					const frac = visibleFraction(g.rowTop, g.rowHeight, BAND, off);
					expect(frac).toBeGreaterThan(0);
				}
			}
		}
	});

	it('centres the current row when the band is shorter than one row (extreme scale, short panel)', () => {
		// Band cannot hold even one row: honouring the bias would hide the sung words at one edge, so we
		// centre — the visible fraction is maximised at band/rowHeight and the row straddles the centre.
		const rh = 273; // 300%
		const shortBand = 200; // shorter than one row
		const g = geom(1, 4, rh, shortBand);
		const off = reelOffset(g);
		const top = g.rowTop + off;
		const centreOfRow = top + rh / 2;
		expect(centreOfRow).toBeCloseTo(shortBand / 2, 5); // row centred in the band
		expect(visibleFraction(g.rowTop, rh, shortBand, off)).toBeCloseTo(shortBand / rh, 5);
	});

	it('BEFORE-ROW: the unclamped shipped formula scrolls the 1/4 sung row off the top at 300%', () => {
		// This is the measured failure the fix closes — proving the invariant test above actually bites.
		const rh = ROW_AT_SCALE[300];
		const g = geom(1, 4, rh, BAND);
		const oldOff = oldOffsetUnclamped(g.rowTop, g.rowHeight, BAND, g.linesBefore, g.linesAfter);
		expect(visibleFraction(g.rowTop, g.rowHeight, BAND, oldOff)).toBe(0); // gone, as the issue reports
		// ...and the clamped offset from the fix keeps that same case on screen.
		const newOff = reelOffset(g);
		expect(visibleFraction(g.rowTop, g.rowHeight, BAND, newOff)).toBeGreaterThan(0);
	});

	it('honours the asymmetric bias where the band has room (A1 — bias is not silently discarded)', () => {
		// A "just centre it" implementation (bias forced to 0) would still keep the row visible and pass
		// the visibility tests. Pin the ACTUAL placement where the clamp does NOT fire (1/4 at 100%, the
		// band easily holds the row): the current row must sit HIGHER than centre, because more lines are
		// wanted AFTER it. Its top within the band is `band/2 - rowHeight/2 + bias` with bias negative.
		const rh = ROW_AT_SCALE[100];
		const g = geom(1, 4, rh, BAND); // rowTop = 91, rowHeight = 91, band 508 — clamp does not fire
		const off = reelOffset(g);
		const topInBand = g.rowTop + off;
		const centredTop = BAND / 2 - rh / 2; // where a bias-0 (centred) placement would put it
		expect(topInBand).toBeLessThan(centredTop); // asymmetric intent honoured, not centred
		// ...and it is exactly the biased position, not merely "somewhere above centre".
		const expectedBias = ((g.linesBefore - g.linesAfter) / 2) * rh; // sourced from the row split, not reelOffset's return
		expect(topInBand).toBeCloseTo(centredTop + expectedBias, 5);
	});

	it('gives the BOTTOM clamp its own guard: a before>after split at large scale (A3)', () => {
		// The full grid is the only thing exercising the bottom clamp; pin it explicitly so narrowing the
		// grid for speed cannot silently un-guard the bottom end. before>after biases the row DOWN, and at
		// a large scale the band clips, so without the bottom clamp the row would fall off the BOTTOM.
		const rh = ROW_AT_SCALE[250];
		const g = geom(3, 0, rh, BAND); // 3 before / 0 after, 250% — bias pushes down, band clips
		const off = reelOffset(g);
		const top = g.rowTop + off;
		expect(top).toBeGreaterThanOrEqual(-0.001); // top edge not above the band
		expect(top + rh).toBeLessThanOrEqual(BAND + 0.001); // bottom edge not below the band
		expect(visibleFraction(g.rowTop, rh, BAND, off)).toBe(1);
	});

});


// The clamp lives in a pure module, but the fix only takes effect if LyricsOverlay.svelte's measureReel
// actually CONSUMES it with the measured band. Reverting that call site restores the pre-fix inline
// arithmetic with every gate green (the pure function keeps passing its own tests while nothing on the
// render path calls it) — this repo's built-and-unit-tested-but-unwired shape. This source-scan guard,
// modelled on the drawPosition wiring guard in lyrics-position.test.ts (same directory, same extraction
// shape), reds the moment measureReel stops consuming reelOffset with viewportEl.clientHeight.
const OVERLAY = readFileSync(join(import.meta.dir, 'LyricsOverlay.svelte'), 'utf8');
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/\/\/[^\n]*/g, '');
}
const CODE = stripComments(OVERLAY);

describe('LyricsOverlay is wired to the clamp (#270 — the fix must stay on the render path)', () => {
	it('imports the pure reel-offset module', () => {
		expect(/from '\.\/reel-offset'/.test(CODE)).toBe(true);
	});

	it('measureReel assigns reelOffset from the pure function called with the measured band', () => {
		// The call site: `reelOffset = reelOffsetFor({ ... band: viewportEl.clientHeight ... })`.
		// Assert the assignment consumes the imported helper AND passes the CLIPPED clientHeight as band —
		// clientHeight is the whole point of #270 (the bias must be measured against the clipped height).
		expect(/reelOffset\s*=\s*reelOffsetFor\s*\(/.test(CODE)).toBe(true);
		expect(/band\s*:\s*viewportEl\.clientHeight/.test(CODE)).toBe(true);
	});

	it('does NOT reintroduce the unclamped inline offset arithmetic (negative arm)', () => {
		// The pre-#270 code was `reelOffset = -(row.offsetTop + ... - viewportEl.clientHeight / 2 - bias);`.
		// A later edit could re-add that inline maths ALONGSIDE the call and pass a positive-only guard, so
		// this negative arm bans the inline expression: reelOffset assigned from an inline `- bias)` form.
		expect(/reelOffset\s*=\s*-\(/.test(CODE)).toBe(false);
		expect(/-\s*viewportEl\.clientHeight\s*\/\s*2\s*-\s*bias\s*\)/.test(CODE)).toBe(false);
	});
});
