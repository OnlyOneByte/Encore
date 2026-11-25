import { it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';
import { reelOffset } from '$lib/tv/reel-offset';

// The LINE BEING SUNG must stay visible across every legal combination of Text size, Lines-sung and
// Lines-ahead — never scrolled off the top, as the unclamped bias did once the max-height cap began
// binding. The predicate is computed a DIFFERENT way from reelOffset()'s own arithmetic: it converts
// translateY into the current row's rect within the visible band, so a pass means "the sung row is on
// screen" rather than "the formula returned what the formula returns".

/** Fraction of the current row that lies inside the visible band [0, band], given the reel offset. */
function visibleFraction(rowTop: number, rowHeight: number, band: number, offset: number): number {
	const top = rowTop + offset; // where the row's top edge lands within the band
	const bottom = top + rowHeight;
	const visible = Math.max(0, Math.min(bottom, band) - Math.max(top, 0));
	return visible / rowHeight;
}

// The pre-clamp placement, reproduced verbatim so the before-row measures the shipped behaviour.
function oldOffsetUnclamped(rowTop: number, rowHeight: number, band: number, before: number, after: number): number {
	const bias = ((before - after) / 2) * rowHeight;
	return -(rowTop + rowHeight / 2 - band / 2 - bias);
}

// A reel geometry sized like /tv's, matching measureReel: rowTop = before * rowHeight, band = the clipped
// clientHeight.
function geom(before: number, after: number, rowHeight: number, band: number) {
	const rowTop = before * rowHeight;
	return { rowTop, rowHeight, band, linesBefore: before, linesAfter: after };
}

// Text sizes as MULTIPLES of the base 1.9em row (100–300% of a ~91px base row at 1280x800). rowHeight grows with scale
// while band is fixed by the panel, so the cap binds harder as scale rises — the axis that breaks.
const BAND = 508; // the measured band at 1280x800, innerHeight 713
const ROW_AT_SCALE: Record<number, number> = { 100: 91, 150: 137, 200: 182, 250: 228, 300: 273 };

it('reelOffset keeps the current row fully visible at the default 2/2 split at every Text size (control) — the sung row stays on the reel', () => {
	for (const scale of Object.keys(ROW_AT_SCALE).map(Number)) {
		const rh = ROW_AT_SCALE[scale];
		const g = geom(2, 2, rh, BAND);
		const off = reelOffset(g);
		expect(visibleFraction(g.rowTop, g.rowHeight, BAND, off)).toBe(1);
	}
});

it('reelOffset keeps the current row ON SCREEN for the failing 1-sung/4-ahead split at every Text size — the sung row stays on the reel', () => {
	// The unclamped formula takes the sung row to 0 (fully gone) at 300%; the clamp must keep a positive
	// visible fraction at every size.
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

it('reelOffset holds across the whole legal rows x Text-size grid (0..3 before, 0..4 after) — the sung row stays on the reel', () => {
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

it('reelOffset centres the current row when the band is shorter than one row (extreme scale, short panel) — the sung row stays on the reel', () => {
	// The band cannot hold one row, so honouring the bias would hide the sung words at an edge: centring
	// maximises the visible fraction at band/rowHeight and the row straddles the centre.
	const rh = 273; // 300%
	const shortBand = 200; // shorter than one row
	const g = geom(1, 4, rh, shortBand);
	const off = reelOffset(g);
	const top = g.rowTop + off;
	const centreOfRow = top + rh / 2;
	expect(centreOfRow).toBeCloseTo(shortBand / 2, 5); // row centred in the band
	expect(visibleFraction(g.rowTop, rh, shortBand, off)).toBeCloseTo(shortBand / rh, 5);
});

it('reelOffset — the sung row stays on the reel — BEFORE-ROW: the unclamped shipped formula scrolls the 1/4 sung row off the top at 300%', () => {
	// The measured failure the clamp closes, which is what proves the invariant arm above bites.
	const rh = ROW_AT_SCALE[300];
	const g = geom(1, 4, rh, BAND);
	const oldOff = oldOffsetUnclamped(g.rowTop, g.rowHeight, BAND, g.linesBefore, g.linesAfter);
	expect(visibleFraction(g.rowTop, g.rowHeight, BAND, oldOff)).toBe(0); // gone, as the issue reports
	// ...and the clamped offset from the fix keeps that same case on screen.
	const newOff = reelOffset(g);
	expect(visibleFraction(g.rowTop, g.rowHeight, BAND, newOff)).toBeGreaterThan(0);
});

it('reelOffset honours the asymmetric bias where the band has room (A1 — bias is not silently discarded) — the sung row stays on the reel', () => {
	// A "just centre it" implementation (bias forced to 0) still passes every visibility arm, so the ACTUAL
	// placement is pinned where the clamp does NOT fire: the current row sits HIGHER than centre, because more
	// lines are wanted AFTER it.
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

it('reelOffset gives the BOTTOM clamp its own guard: a before>after split at large scale (A3) — the sung row stays on the reel', () => {
	// The full grid is the only thing exercising the bottom clamp, so it is pinned explicitly: before>after
	// biases the row DOWN and the band clips at a large scale, so without the clamp it falls off the BOTTOM.
	const rh = ROW_AT_SCALE[250];
	const g = geom(3, 0, rh, BAND); // 3 before / 0 after, 250% — bias pushes down, band clips
	const off = reelOffset(g);
	const top = g.rowTop + off;
	expect(top).toBeGreaterThanOrEqual(-0.001); // top edge not above the band
	expect(top + rh).toBeLessThanOrEqual(BAND + 0.001); // bottom edge not below the band
	expect(visibleFraction(g.rowTop, rh, BAND, off)).toBe(1);
});

// The sung row must land in the UNMASKED window, not merely inside the band: the band includes the two
// edge-fade ramps (one row masked to transparent at each edge that HAS context rows). A clamp to [0, band]
// parked the sung row congruent with a ramp, so the line being sung rendered FAINTER than the one after it.

// Fraction of the current row inside the UNMASKED window [fadeTop, band - fadeBot], given the offset.
function unmaskedFraction(
	rowTop: number,
	rowHeight: number,
	band: number,
	fadeTop: number,
	fadeBot: number,
	offset: number
): number {
	const top = rowTop + offset;
	const bottom = top + rowHeight;
	const winTop = fadeTop;
	const winBot = band - fadeBot;
	const visible = Math.max(0, Math.min(bottom, winBot) - Math.max(top, winTop));
	return visible / rowHeight;
}

// The rendered ramp depth per edge: one rowHeight, ON iff that edge has context rows. Two models —
// UNCAPPED, where two ramps can invert the window, and CAPPED at min(row-h, (band - row-h) / 2), which is
// the cap measureReel mirrors in px.
function fadeUncapped(rowHeight: number, on: boolean): number {
	return on ? rowHeight : 0;
}
function fadeCapped(rowHeight: number, band: number, on: boolean): number {
	return on ? Math.max(0, Math.min(rowHeight, (band - rowHeight) / 2)) : 0;
}

// The fade-unaware clamp over [0, band], reproduced so the before-row measures that behaviour.
function baseOffsetBandClamp(rowTop: number, rowHeight: number, band: number, before: number, after: number): number {
	const bias = ((before - after) / 2) * rowHeight;
	let offset = -(rowTop + rowHeight / 2 - band / 2 - bias);
	if (rowHeight >= band) return -(rowTop + rowHeight / 2 - band / 2);
	const top = rowTop + offset;
	if (top < 0) offset += -top;
	else if (top + rowHeight > band) offset -= top + rowHeight - band;
	return offset;
}

it('reelOffset keeps a NON-ZERO fully-opaque fraction of the sung row across the whole legal grid - the sung row lands in the UNMASKED window, not inside a fade ramp', () => {
	for (const before of [0, 1, 2, 3]) {
		for (const after of [0, 1, 2, 3, 4]) {
			for (const scale of Object.keys(ROW_AT_SCALE).map(Number)) {
				const rh = ROW_AT_SCALE[scale];
				const fadeTop = fadeCapped(rh, BAND, before > 0);
				const fadeBot = fadeCapped(rh, BAND, after > 0);
				const off = reelOffset({
					rowTop: before * rh,
					rowHeight: rh,
					band: BAND,
					linesBefore: before,
					linesAfter: after,
					fadeTop,
					fadeBot
				});
				const frac = unmaskedFraction(before * rh, rh, BAND, fadeTop, fadeBot, off);
				expect(frac).toBeGreaterThan(0);
			}
		}
	}
});

it('reelOffset - the sung row lands in the UNMASKED window, not inside a fade ramp - BEFORE-ROW: the shipped [0, band] clamp parks 21 grid cells with ZERO opaque sung-row pixels', () => {
	const offenders: Array<[number, number, number]> = [
		[1, 1, 300],
		[1, 2, 300],
		[1, 3, 200],
		[1, 3, 250],
		[1, 3, 300],
		[1, 4, 150],
		[1, 4, 200],
		[1, 4, 250],
		[1, 4, 300],
		[2, 1, 300],
		[2, 2, 300],
		[2, 3, 300],
		[2, 4, 200],
		[2, 4, 250],
		[2, 4, 300],
		[3, 1, 200],
		[3, 1, 250],
		[3, 1, 300],
		[3, 2, 300],
		[3, 3, 300],
		[3, 4, 300]
	];
	for (const [before, after, scale] of offenders) {
		const rh = ROW_AT_SCALE[scale];
		const fadeTop = fadeUncapped(rh, before > 0);
		const fadeBot = fadeUncapped(rh, after > 0);
		const off = baseOffsetBandClamp(before * rh, rh, BAND, before, after);
		const frac = unmaskedFraction(before * rh, rh, BAND, fadeTop, fadeBot, off);
		expect(frac).toBe(0);
	}
});

it('reelOffset - the sung row lands in the UNMASKED window, not inside a fade ramp - the DEFAULT 2/2 split reaches the defect too (2/2 at 300% is an offender), and the fix opens it', () => {
	const rh = ROW_AT_SCALE[300];
	const baseOff = baseOffsetBandClamp(2 * rh, rh, BAND, 2, 2);
	expect(unmaskedFraction(2 * rh, rh, BAND, fadeUncapped(rh, true), fadeUncapped(rh, true), baseOff)).toBe(0);
	const fT = fadeCapped(rh, BAND, true);
	const fB = fadeCapped(rh, BAND, true);
	const fixOff = reelOffset({
		rowTop: 2 * rh,
		rowHeight: rh,
		band: BAND,
		linesBefore: 2,
		linesAfter: 2,
		fadeTop: fT,
		fadeBot: fB
	});
	expect(unmaskedFraction(2 * rh, rh, BAND, fT, fB, fixOff)).toBeGreaterThan(0);
});

it('reelOffset gives the BOTTOM ramp its own guard (before>after biases the row DOWN into the bottom fade) - the sung row lands in the UNMASKED window, not inside a fade ramp', () => {
	const rh = ROW_AT_SCALE[300];
	const fadeTop = fadeCapped(rh, BAND, true);
	const fadeBot = fadeCapped(rh, BAND, true);
	const off = reelOffset({
		rowTop: 3 * rh,
		rowHeight: rh,
		band: BAND,
		linesBefore: 3,
		linesAfter: 1,
		fadeTop,
		fadeBot
	});
	const top = 3 * rh + off;
	expect(top).toBeGreaterThanOrEqual(fadeTop - 0.001);
	expect(top + rh).toBeLessThanOrEqual(BAND - fadeBot + 0.001);
	const baseOff = baseOffsetBandClamp(3 * rh, rh, BAND, 3, 1);
	expect(unmaskedFraction(3 * rh, rh, BAND, fadeUncapped(rh, true), fadeUncapped(rh, true), baseOff)).toBe(0);
});

it('reelOffset - the sung row lands in the UNMASKED window, not inside a fade ramp - a NO-CONTEXT edge is not faded, so its pinned row is fully opaque (negative control)', () => {
	const rh = ROW_AT_SCALE[300];
	const fadeTop = fadeCapped(rh, BAND, true);
	const fadeBot = fadeCapped(rh, BAND, false);
	const off = reelOffset({
		rowTop: 2 * rh,
		rowHeight: rh,
		band: BAND,
		linesBefore: 2,
		linesAfter: 0,
		fadeTop,
		fadeBot
	});
	const frac = unmaskedFraction(2 * rh, rh, BAND, fadeTop, fadeBot, off);
	expect(frac).toBeGreaterThan(0);
});

it('reelOffset - the sung row lands in the UNMASKED window, not inside a fade ramp - with both fades 0 the clamp is EXACTLY [0, band] (no regression of the earlier fix)', () => {
	for (const before of [0, 1, 2, 3]) {
		for (const after of [0, 1, 2, 3, 4]) {
			for (const scale of Object.keys(ROW_AT_SCALE).map(Number)) {
				const rh = ROW_AT_SCALE[scale];
				const g = geom(before, after, rh, BAND);
				const withFadesZero = reelOffset({ ...g, fadeTop: 0, fadeBot: 0 });
				expect(withFadesZero).toBeCloseTo(reelOffset(g), 9);
			}
		}
	}
});

// The clamp is a pure module, so it only takes effect if measureReel CONSUMES it with the measured band.
// Reverting that call site restores the inline arithmetic with every gate green.
const OVERLAY = readFileSync(at('src/lib/tv/LyricsOverlay.svelte'), 'utf8');
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/\/\/[^\n]*/g, '');
}
const CODE = stripComments(OVERLAY);

it('LyricsOverlay is wired to the clamp (the fix must stay on the render path): imports the pure reel-offset module', () => {
	expect(/from '\.\/reel-offset'/.test(CODE)).toBe(true);
});

it('LyricsOverlay is wired to the clamp (the fix must stay on the render path): measureReel assigns reelOffset from the pure function called with the measured band', () => {
	// The assignment must consume the imported helper AND pass the CLIPPED clientHeight as band, which is
	// the whole point of the clamp: the bias has to be measured against the clipped height.
	expect(/reelOffset\s*=\s*reelOffsetFor\s*\(/.test(CODE)).toBe(true);
	expect(/band\s*:\s*viewportEl\.clientHeight/.test(CODE)).toBe(true);
});

it('LyricsOverlay is wired to the clamp (the fix must stay on the render path): does NOT reintroduce the unclamped inline offset arithmetic (negative arm)', () => {
	// The inline maths could be re-added ALONGSIDE the call and pass a positive-only guard, so the
	// expression itself is banned: `reelOffset` assigned from an inline `- bias)` form.
	expect(/reelOffset\s*=\s*-\(/.test(CODE)).toBe(false);
	expect(/-\s*viewportEl\.clientHeight\s*\/\s*2\s*-\s*bias\s*\)/.test(CODE)).toBe(false);
});

// The clamp only insets the sung row out of a ramp if measureReel PASSES the rendered depths. Dropping
// them leaves the grid arm green, because the args default to 0 => [0, band].
it('LyricsOverlay is wired to the clamp (the fix must stay on the render path): measureReel passes fadeTop AND fadeBot to reelOffset (the ramp depths reach the clamp)', () => {
	expect(/fadeTop\s*:/.test(CODE)).toBe(true);
	expect(/fadeBot\s*:/.test(CODE)).toBe(true);
	// keyed on the context-row flags, not a blind 1.9em: a no-context edge stays unfaded (0), and so does every edge in
	// fit mode (Words only), whose box holds exactly its lines.
	expect(/fadeTop\s*:\s*linesBefore\s*>\s*0\s*&&\s*!fit\s*\?/.test(CODE)).toBe(true);
	expect(/fadeBot\s*:\s*linesAfter\s*>\s*0\s*&&\s*!fit\s*\?/.test(CODE)).toBe(true);
});

// The two ramps must be CAPPED, or they consume the whole band and leave no opaque plateau.
it('LyricsOverlay is wired to the clamp (the fix must stay on the render path): caps each edge-fade ramp so the unmasked window can always hold one row (F2)', () => {
	expect(/--lyrics-fade-cap\s*:\s*min\(/.test(CODE)).toBe(true);
	expect(/--lyrics-fade-top\s*:\s*calc\(var\(--lyrics-fade-cap\)/.test(CODE)).toBe(true);
	expect(/--lyrics-fade-bot\s*:\s*calc\(var\(--lyrics-fade-cap\)/.test(CODE)).toBe(true);
});

// ── the ROW BUDGET: a romanised row is taller than its leading ────────────────────────────────────────
//
// The viewport is a FIXED height — `--lyrics-rows` x the per-row budget, with `overflow: hidden` — so the
// budget has to be what a row actually renders. Every row of the reel draws its own `romanization` (not just
// the current one), which adds a second, smaller line plus a gap; with the budget at the text leading alone,
// a zh/ja/ko doc fitted 3 rows where the room asked for 5 and lost a context row per edge. The arithmetic
// here is computed from the component's OWN declarations, so it fails if either side moves alone.
const SNUG = parseFloat(readFileSync(at('src/app.css'), 'utf8').match(/--lh-snug:\s*([\d.]+)/)![1]);

/** A custom property's declared value, read out of the component's stylesheet. */
function declared(name: string, from: string = OVERLAY): string {
	const found = from.match(new RegExp(`${name}:\\s*([^;]+);`));
	expect(found, `${name} is declared`).not.toBeNull();
	return found![1].trim();
}

/** One `em` number out of a declaration like `1.9em` or a bare `0.15`. */
function em(value: string): number {
	return parseFloat(value.replace(/em$/, ''));
}

/** The `.lyrics.romanized .viewport` block, which is where the extra enters the budget. */
function romanizedBlock(): string {
	const found = OVERLAY.match(/\.lyrics\.romanized\s+\.viewport\s*\{([\s\S]*?)\}\s*\n/);
	expect(found, 'a romanised doc overrides the row budget').not.toBeNull();
	return found![1];
}

it('the viewport height is rows x the ROW BUDGET, not rows x the text leading (a romanised row is taller than its leading)', () => {
	// The height must multiply the budget. Reverting to `--lyrics-row-h` here is the defect itself. The wrap factor and
	// the slack are Words only's (1 and 0 everywhere else).
	expect(
		/height:\s*calc\(\s*var\(--lyrics-rows,\s*5\)\s*\*\s*var\(--lyrics-wrap,\s*1\)\s*\*\s*var\(--lyrics-row-budget\)\s*\+\s*var\(--lyrics-slack,\s*0em\)\s*\)/.test(
			OVERLAY
		)
	).toBe(true);
	expect(/--lyrics-row-budget:\s*calc\(var\(--lyrics-row-h\)\s*\+\s*var\(--lyrics-row-extra\)\)/.test(OVERLAY)).toBe(
		true
	);
	// ...and the extra must be 0 by default, so an English doc reserves exactly what it always did.
	expect(em(declared('--lyrics-row-extra'))).toBe(0);
});

it('the row budget of a romanised doc covers what a romanised row RENDERS, computed from the same declarations', () => {
	const rowH = em(declared('--lyrics-row-h'));
	const size = em(declared('--romanization-size'));
	const gap = em(declared('--romanization-gap'));
	// What a row with a romanisation renders: its own leading, plus the second script's line (its leading is
	// a multiple of ITS font-size) plus the gap (a margin on the romanisation, so also in its own em).
	const rendered = rowH + size * SNUG + size * gap;
	// What the viewport reserves for it, read out of the override block the `romanized` flag turns on.
	const extra = romanizedBlock().match(/--lyrics-row-extra:\s*calc\(([\s\S]*?)\)\s*;/);
	expect(extra, 'the extra is a calc of the romanisation tokens').not.toBeNull();
	expect(extra![1]).toContain('--romanization-size');
	expect(extra![1]).toContain('--romanization-leading');
	expect(extra![1]).toContain('--romanization-gap');
	const reserved = rowH + size * (SNUG + gap);
	expect(reserved).toBeCloseTo(rendered, 9);
	expect(reserved).toBeGreaterThan(rowH); // the whole point: the budget grew
	// The default room setting is 2 before + 1 + 2 after. With the pre-fix budget those five rows needed
	// 5 x 2.768em of a 5 x 1.9em box — 3.4 rows fit, so a context row per edge was clipped.
	const DEFAULT_ROWS = 5;
	expect(DEFAULT_ROWS * rowH).toBeLessThan(DEFAULT_ROWS * rendered);
	expect(DEFAULT_ROWS * reserved).toBeGreaterThanOrEqual(DEFAULT_ROWS * rendered);
});

it('the romanisation renders at the tokens the budget is computed from (one source, so the two cannot drift)', () => {
	const block = OVERLAY.match(/\.romanization\s*\{([\s\S]*?)\n\t\}/);
	expect(block, '.romanization is declared').not.toBeNull();
	expect(block![1]).toContain('font-size: var(--romanization-size)');
	expect(block![1]).toContain('line-height: var(--romanization-leading)');
	expect(block![1]).toContain('margin-top: calc(var(--romanization-gap) * 1em)');
});

it('the budget is turned on by the DOC carrying a romanisation, not by the language or a prop', () => {
	expect(/romanized\s*=\s*\$derived\(!!doc\?\.lines\.some\(\(l\)\s*=>\s*l\.romanization\)\)/.test(CODE)).toBe(true);
	expect(/class=\{\['lyrics',[\s\S]{0,160}?romanized/.test(CODE)).toBe(true);
});
