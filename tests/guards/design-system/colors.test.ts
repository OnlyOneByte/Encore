import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import {
	SINGER_COLORS,
	SINGER_HUES,
	SINGER_HUE_STEP,
	hueToHex,
	parseHex,
	contrastRatio,
	isLegibleSingerColor,
	normalizeSingerColor,
	nearestSingerHue,
	nextSwatchIndex,
	presetTabStopIndex,
	stageHueToHex,
	stageLightnessForHue,
	normalizeStageColor,
	hueOfColor,
	DEFAULT_STAGE_COLOR,
	dimTowardBlack,
	normalizeStageDim,
	DEFAULT_STAGE_DIM,
	MIN_STAGE_DIM,
	MAX_STAGE_DIM,
	STAGE_BG_L,
	SINGER_L,
	SURFACES,
	ACCENT2,
	oklchToRgb,
	duetPartColors
} from '$lib/contract';

// Every colour the wheel can emit, derived here rather than exported: production picks with
// `hueToHex(hue)` for an arbitrary hue, so a precomputed array would be a second, unread representation.
const SINGER_WHEEL: readonly string[] = SINGER_HUES.map((h) => hueToHex(h));

const appCss = read('src/app.css');

/** Pull a `--name: #hex;` out of `app.css`. Throws, so a renamed token reds rather than defaulting. */
function token(name: string): string {
	const m = appCss.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
	if (!m) throw new Error(`token --${name} not found in src/app.css (renamed? then update this guard)`);
	return m[1]!;
}

// The two surfaces production measures a dot against, read FROM production rather than restated as
// literals tied to `--bg`/`--card` by a comment only.
const [BG, CARD] = SURFACES;

test('parseHex accepts 3- and 6-digit hex and rejects everything else', () => {
	expect(parseHex('#7c5cff')).toEqual([124, 92, 255]);
	expect(parseHex('#0af')).toEqual([0, 170, 255]);
	expect(parseHex('  #0AF  ')).toEqual([0, 170, 255]);
	expect(parseHex('rgb(1,2,3)')).toBeNull();
	expect(parseHex('oklch(0.7 0.16 280)')).toBeNull();
	expect(parseHex('rebeccapurple')).toBeNull();
	expect(parseHex('#7c5cff30')).toBeNull(); // 8-digit: the old alpha-concat artefact
	expect(parseHex('')).toBeNull();
});

test('contrastRatio matches known WCAG values', () => {
	expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
	expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
	// the measurement that condemned white-on-gradient
	expect(contrastRatio('#ffffff', ACCENT2)).toBeCloseTo(2.84, 1);
});

test('the surfaces production measures against are the tokens app.css declares', () => {
	// `SURFACES` cannot read `app.css` (browser bundle, no filesystem), so this is all that stands between
	// `isLegibleSingerColor` and a surface the app stopped painting. `readonly string[]` rather than the
	// `as const` tuple, or `toEqual` narrows to the literals under test and refuses a `string`.
	const measured: readonly string[] = SURFACES;
	expect([...measured]).toEqual([token('bg'), token('card')]);
	// Same for the stage centre: `ACCENT2` is a bundled copy of `--accent2` and the whole ramp derives from it.
	expect(ACCENT2).toBe(token('accent2'));
});

test('every wheel hue is visible on both dark surfaces (3:1 non-text)', () => {
	const weak = SINGER_WHEEL.filter((c) => contrastRatio(c, BG) < 3 || contrastRatio(c, CARD) < 3);
	expect(weak).toEqual([]);
});

test('the wheel covers the full hue circle at the declared step', () => {
	expect(SINGER_HUES[0]).toBe(0);
	expect(SINGER_HUES.length).toBe(360 / SINGER_HUE_STEP);
	expect(SINGER_HUES.at(-1)).toBe(360 - SINGER_HUE_STEP);
});

test('adjacent wheel stops are visually distinct — no two collapse onto one colour', () => {
	// Chroma is reduced to fit the gamut rather than clipped, because clipping hue-shifts and two
	// neighbouring stops could then render as the same hex.
	expect(new Set(SINGER_WHEEL).size).toBe(SINGER_WHEEL.length);
});

test('all eight presets remain legible — existing singers keep their colour', () => {
	// Rules out a lightness-BAND validator: #7c5cff is at OKLCH L≈0.56, outside the wheel's L≈0.70, so a band
	// check would reject every singer who ever joined.
	const rejected = SINGER_COLORS.filter((c) => !isLegibleSingerColor(c));
	expect(rejected).toEqual([]);
});

test('hueToHex is canonical 6-digit hex and wraps hues', () => {
	for (const c of SINGER_WHEEL) expect(c).toMatch(/^#[0-9a-f]{6}$/);
	expect(hueToHex(370)).toBe(hueToHex(10));
	expect(hueToHex(-15)).toBe(hueToHex(345));
});

test('near-black and near-surface picks are refused', () => {
	expect(isLegibleSingerColor('#000000')).toBe(false);
	expect(isLegibleSingerColor(BG)).toBe(false); // exactly the page background
	expect(isLegibleSingerColor(CARD)).toBe(false); // exactly a card
	expect(isLegibleSingerColor('#101018')).toBe(false);
});

test('the 3:1 dot rule is pinned at its boundary, not just far below it', () => {
	// The rest of the negative coverage sits at or below 1.22:1, so these four bracket the exact 3:1 edge.

	// Mid-band: below 3:1 against BOTH surfaces (bg 2.97, card 2.60). A ~2:1 rule would wrongly pass it.
	expect(contrastRatio('#5c5c66', BG)).toBeCloseTo(2.97, 1);
	expect(contrastRatio('#5c5c66', CARD)).toBeCloseTo(2.6, 1);
	expect(isLegibleSingerColor('#5c5c66')).toBe(false);

	// Under the edge on ONE surface only: bg 3.40 clears 3:1, card 2.98 does not — so `.every` -> `.some` or a
	// 2.9 floor wrongly accepts it.
	expect(contrastRatio('#65656f', BG)).toBeCloseTo(3.4, 1);
	expect(contrastRatio('#65656f', CARD)).toBeCloseTo(2.98, 2);
	expect(isLegibleSingerColor('#65656f')).toBe(false);

	// At/above the edge on both (bg 3.45, card 3.03) — the nearest legible colour, so raising the floor above
	// ~3.03 wrongly rejects it.
	expect(contrastRatio('#666670', BG)).toBeCloseTo(3.45, 1);
	expect(contrastRatio('#666670', CARD)).toBeCloseTo(3.03, 2);
	expect(isLegibleSingerColor('#666670')).toBe(true);
});

test('normalizeSingerColor canonicalises rather than rejecting shorthand', () => {
	expect(normalizeSingerColor('#0AF')).toBe('#00aaff');
	expect(normalizeSingerColor('#7C5CFF')).toBe('#7c5cff');
});

test('normalizeSingerColor falls back to a preset for unusable input', () => {
	expect(normalizeSingerColor('#000000')).toBe(SINGER_COLORS[0]);
	expect(normalizeSingerColor('not a colour')).toBe(SINGER_COLORS[0]);
	expect(normalizeSingerColor('')).toBe(SINGER_COLORS[0]);
	expect(normalizeSingerColor('oklch(0.7 0.16 280)')).toBe(SINGER_COLORS[0]);
});

test('a wheel pick survives a normalize round-trip unchanged', () => {
	// A validator that accepts the wheel in principle but rewrites its output would undo the whole feature.
	for (const c of SINGER_WHEEL) expect(normalizeSingerColor(c)).toBe(c);
});

test('nearestSingerHue keeps the slider and the swatches as one selection', () => {
	// Without this the thumb sat at hue 0 (red) while the swatch displayed violet.
	for (const h of SINGER_HUES) expect(nearestSingerHue(hueToHex(h))).toBe(h);
});

test('nearestSingerHue maps each preset to a plausible hue', () => {
	// Not exact — the presets sit outside the wheel's lightness band — but in the right part of the circle.
	expect(nearestSingerHue('#ff5cae')).toBeGreaterThan(300); // pink
	expect(nearestSingerHue('#33d6a6')).toBeGreaterThan(120); // green/teal
	expect(nearestSingerHue('#33d6a6')).toBeLessThan(210);
	expect(nearestSingerHue('#nope')).toBe(0); // unparseable degrades quietly
});

// The stage tier tests the BOUND, not literal hexes: a hex assertion would freeze the palette and break on
// any gamut tweak, while what must never regress is lyrics staying readable on the stage.

const WHITE = '#ffffff';

test('every stage background is far darker than the singer dot palette', () => {
	// The dot tier on a full screen would wash out the lyric reel, so the ordering is asserted rather than
	// trusted to two constants staying apart.
	expect(STAGE_BG_L).toBeLessThan(SINGER_L);
	for (const hue of SINGER_HUES) {
		expect(stageLightnessForHue(hue)).toBeLessThanOrEqual(STAGE_BG_L);
	}
});

test('sung-white lyrics clear WCAG AA on every stage background', () => {
	// White is the `.word.done` colour and the brightest thing in the reel. 4.5:1 is the TEXT bar, which
	// applies because these are glyphs — unlike the singer dot, a 3:1 non-text fill.
	for (const hue of SINGER_HUES) {
		const bg = stageHueToHex(hue);
		expect(contrastRatio(WHITE, bg)).toBeGreaterThanOrEqual(4.5);
	}
});

test('the active-word pink separates from every stage background', () => {
	// A stage generated near --accent2 steals the active word's cue, because highlight and field become one
	// hue family, so the guard trades brightness for that separation.
	for (const hue of SINGER_HUES) {
		const bg = stageHueToHex(hue);
		expect(contrastRatio(ACCENT2, bg)).toBeGreaterThanOrEqual(3);
	}
});

test('the pink singer — the worst case — is guarded harder than a distant hue', () => {
	const pinkHue = nearestSingerHue(ACCENT2); // 345
	const distant = 165; // mint/aqua, ~180° away
	expect(stageLightnessForHue(pinkHue)).toBeLessThan(stageLightnessForHue(distant));
	expect(stageLightnessForHue(distant)).toBeCloseTo(STAGE_BG_L, 5);
	// …and it must buy separation, not merely darken
	expect(contrastRatio(ACCENT2, stageHueToHex(pinkHue))).toBeGreaterThan(
		contrastRatio(ACCENT2, hueToHex(pinkHue, STAGE_BG_L, 0.07))
	);
});

test('the guard ramps rather than stepping — no cliff between adjacent wheel stops', () => {
	// A binary threshold gave neighbouring stops wildly different stages for a 15° change, so no adjacent
	// pair may jump more than one step's worth of the ramp.
	const maxStep = 0.09 / (60 / SINGER_HUE_STEP) + 1e-9; // full ramp spread over its 60° band
	for (const hue of SINGER_HUES) {
		const next = (hue + SINGER_HUE_STEP) % 360;
		expect(Math.abs(stageLightnessForHue(hue) - stageLightnessForHue(next))).toBeLessThanOrEqual(maxStep);
	}
});

test('stageHueToHex normalizes out-of-range and negative hues', () => {
	expect(stageHueToHex(375)).toBe(stageHueToHex(15));
	expect(stageHueToHex(-15)).toBe(stageHueToHex(345));
	expect(stageHueToHex(720)).toBe(stageHueToHex(0));
});

test('every singer preset yields a usable stage, including the two that collapse', () => {
	// #33d6a6 and #5cffd6 both quantize to hue 165, so `singer` cannot tell them apart — a cosmetic
	// limitation of the wheel's chroma clipping, pinned so it fails loudly if the wheel changes.
	const stages = SINGER_COLORS.map((c) => stageHueToHex(nearestSingerHue(c)));
	for (const bg of stages) {
		expect(parseHex(bg)).not.toBeNull();
		expect(contrastRatio(WHITE, bg)).toBeGreaterThanOrEqual(4.5);
	}
	expect(stageHueToHex(nearestSingerHue('#33d6a6'))).toBe(stageHueToHex(nearestSingerHue('#5cffd6')));
});

// The eight presets are a roving-tabindex radiogroup: exactly one swatch is tabbable. The wheel emits
// colours that are NEVER presets, so without a fallback one wheel pick drops all eight out of the tab order
// for good and locks a keyboard or switch-access guest out of the only named colours.

test('presetTabStopIndex points at the matching swatch for a preset value', () => {
	SINGER_COLORS.forEach((c, i) => {
		expect(presetTabStopIndex(c)).toBe(i);
	});
});

test('presetTabStopIndex keeps a tab stop after a wheel pick — the closed-door bug', () => {
	// After any hue pick no swatch matches, and `value === c ? 0 : -1` left EVERY swatch at -1. Reverting
	// presetTabStopIndex to a bare `indexOf` makes this fail with `-1 to be 0`.
	for (const wheelHex of SINGER_WHEEL) {
		// premise: the wheel never lands on a preset, so there is genuinely no match to fall back from
		expect(SINGER_COLORS as readonly string[]).not.toContain(wheelHex);
		expect(presetTabStopIndex(wheelHex)).toBe(0);
	}
});

test('presetTabStopIndex always yields exactly one in-range tab stop', () => {
	// For ANY value — preset, wheel hue or garbage — precisely one swatch ends up with tabindex 0, and it is a
	// real index into the rendered swatches.
	const inputs = [...SINGER_COLORS, ...SINGER_WHEEL, '#000000', 'not a colour', ''];
	for (const v of inputs) {
		const stop = presetTabStopIndex(v);
		const tabbable = SINGER_COLORS.map((_, i) => i).filter((i) => i === stop);
		expect(tabbable.length).toBe(1);
		expect(stop).toBeGreaterThanOrEqual(0);
		expect(stop).toBeLessThan(SINGER_COLORS.length);
	}
});

// A bare `indexOf(value)` returns -1 for a wheel hex while the tab stop falls back to 0, so after a wheel
// pick the first ArrowRight did not move and ArrowLeft skipped mint, landing on purple. Expected indices
// are LITERALS, not computed, so a regression to the bare base reds them.

test('nextSwatchIndex moves correctly from a preset value (the control case)', () => {
	// violet is SINGER_COLORS[0]. Right -> pink (1), Left wraps -> mint (7).
	expect(nextSwatchIndex(SINGER_COLORS[0]!, 1)).toBe(1);
	expect(nextSwatchIndex(SINGER_COLORS[0]!, -1)).toBe(7);
	// green is [2]. Right -> amber (3), Left -> pink (1).
	expect(nextSwatchIndex(SINGER_COLORS[2]!, 1)).toBe(3);
	expect(nextSwatchIndex(SINGER_COLORS[2]!, -1)).toBe(1);
});

test('nextSwatchIndex after a wheel pick matches the tab stop, not indexOf(-1)', () => {
	const wheelHex = hueToHex(120);
	expect(SINGER_COLORS as readonly string[]).not.toContain(wheelHex); // premise: genuinely non-preset
	// The ring sits on swatch 0, so movement starts there: ArrowRight -> 1 (pink), ArrowLeft -> 7 (mint).
	// Not 0 (dead) and not 6 (purple), which is what a bare-indexOf base returns.
	expect(nextSwatchIndex(wheelHex, 1)).toBe(1);
	expect(nextSwatchIndex(wheelHex, -1)).toBe(7);
});

test('hueToHex fully reduces chroma into sRGB gamut, even from a high starting chroma (no clip)', () => {
	// The no-clip guarantee: chroma is reduced UNTIL the colour fits, because clipping an out-of-gamut blue
	// hue-shifts it. A FIXED 40-iteration -0.005 loop covers only 0.20 of chroma, so from 0.30 it bottoms out
	// at 0.10; L=0.5 is chosen because the teal hues cap around 0.084, inside that range.
	const L = 0.5;
	const START = 0.3;
	const STEP = 0.005;
	const FIXED_FLOOR = START - 40 * STEP; // 0.10 - where the buggy fixed-count loop stopped
	const toHexLocal = (rgb: [number, number, number]) =>
		'#' +
		rgb
			.map((v) =>
				Math.max(0, Math.min(255, Math.round(v)))
					.toString(16)
					.padStart(2, '0')
			)
			.join('');
	let sawStartOutOfGamut = false;
	let sawFixedFloorOutOfGamut = false; // the hue the OLD loop could not rescue
	for (let h = 0; h < 360; h += 5) {
		if (!oklchToRgb(L, START, h).inGamut) sawStartOutOfGamut = true;
		if (!oklchToRgb(L, FIXED_FLOOR, h).inGamut) sawFixedFloorOutOfGamut = true;
		let c = START;
		let expected: string | null = null;
		while (c > 0) {
			const { rgb, inGamut } = oklchToRgb(L, c, h);
			if (inGamut) {
				expected = toHexLocal(rgb);
				break;
			}
			c -= STEP;
		}
		if (expected === null) expected = toHexLocal(oklchToRgb(L, 0, h).rgb);
		expect(hueToHex(h, L, START)).toBe(expected);
	}
	// START is genuinely out of gamut for some hue, AND the fixed loop's 0.10 endpoint still is.
	expect(sawStartOutOfGamut).toBe(true);
	expect(sawFixedFloorOutOfGamut).toBe(true);
});

// A hand-written literal because SQL cannot run an OKLCH conversion — the SQLite column default and the
// migration backfill both need these bytes. This stops that duplication rotting.
test('DEFAULT_STAGE_COLOR is exactly what the old hue-240 default rendered as', () => {
	expect(DEFAULT_STAGE_COLOR).toBe(stageHueToHex(240));
});

test('normalizeStageColor canonicalises to 6-digit lowercase hex', () => {
	// Interpolated straight into a style attribute, and a 3-digit hex concatenated with alpha digits is what
	// silently dropped the singer halo once already.
	expect(normalizeStageColor('#ABC', DEFAULT_STAGE_COLOR)).toBe('#aabbcc');
	expect(normalizeStageColor('#AABBCC', DEFAULT_STAGE_COLOR)).toBe('#aabbcc');
	expect(normalizeStageColor('  #001d31  ', DEFAULT_STAGE_COLOR)).toBe('#001d31');
});

test('normalizeStageColor keeps the caller current colour for anything unparseable', () => {
	// a junk write must not reset a choice the room already made
	for (const junk of [
		'rebeccapurple',
		'rgb(1,2,3)',
		'oklch(.2 .07 240)',
		'#7c5cff30',
		'',
		'#12',
		240,
		null,
		undefined,
		{}
	]) {
		expect(normalizeStageColor(junk as never, '#123456')).toBe('#123456');
	}
});

// The stage deliberately has NO legibility bound while the sibling `normalizeSingerColor` enforces one, so a
// reviewer cannot tell the two apart by reading either alone. Reinstating a bound here reds and says why.
test('normalizeStageColor does NOT gate on legibility, unlike the singer validator', () => {
	// White is the extreme case: brighter than anything the stage ramp emits.
	expect(normalizeStageColor('#ffffff', DEFAULT_STAGE_COLOR)).toBe('#ffffff');
	expect(isLegibleSingerColor('#ffffff')).toBe(true); // white passes the DOT rule, so pick a real failure
	// a near-black dot fails the dot bound and the singer path rewrites it; the stage path keeps it
	expect(isLegibleSingerColor('#050505')).toBe(false);
	expect(normalizeSingerColor('#050505')).toBe(SINGER_COLORS[0]);
	expect(normalizeStageColor('#050505', DEFAULT_STAGE_COLOR)).toBe('#050505');
});

/** Shortest angular distance between two hues, in degrees (0–180). */
function hueGap(a: number, b: number): number {
	const d = Math.abs(a - b) % 360;
	return Math.min(d, 360 - d);
}

test('hueOfColor recovers the hue of a stage-tier colour, which nearestSingerHue cannot', () => {
	// The visualizers build a palette by hue ARITHMETIC around the room's colour, so they need an angle back
	// out of the stored hex. atan2 of the OKLab chromatic axes is scale-free and round-trips every legal stop
	// within one wheel step; nearestSingerHue compares those axes against WHEEL-tier candidates and mis-snaps.
	let worst = 0;
	let sawNearestMismatch = false;
	for (const h of SINGER_HUES) {
		const hex = stageHueToHex(h);
		worst = Math.max(worst, hueGap(hueOfColor(hex), h));
		if (nearestSingerHue(hex) !== h) sawNearestMismatch = true;
	}
	expect(worst).toBeLessThan(SINGER_HUE_STEP);
	// the rejected alternative genuinely fails on this input set
	expect(sawNearestMismatch).toBe(true);
});

test('hueOfColor is independent of lightness and chroma, and greys have no hue', () => {
	// Scale-freedom is the property that makes it work across tiers, so it is asserted directly.
	for (const h of [0, 75, 165, 240, 345]) {
		const wheel = hueOfColor(hueToHex(h, SINGER_L, 0.16));
		const stage = hueOfColor(hueToHex(h, STAGE_BG_L, 0.07));
		expect(hueGap(wheel, stage)).toBeLessThan(SINGER_HUE_STEP);
	}
	expect(hueOfColor('#000000')).toBe(0);
	expect(hueOfColor('not a colour')).toBe(0);
});

test('dimTowardBlack with dim 0 returns the colour untouched', () => {
	// 0 is the default, so no dim must mean no change at the pixel level.
	for (const c of ['#000000', '#001d31', '#7c5cff', '#ff5cae', '#ffffff', '#123456']) {
		expect(dimTowardBlack(c, 0)).toBe(c);
	}
});

test('dimTowardBlack with dim 1 pulls any colour to black', () => {
	for (const c of ['#001d31', '#7c5cff', '#ffffff', '#123456']) {
		expect(dimTowardBlack(c, 1)).toBe('#000000');
	}
});

test('dimTowardBlack scales every channel by (1 - dim), rounded', () => {
	// 255 * 0.5 = 127.5 → 128 (0x80), derived from the rule rather than transcribed from a fixture.
	expect(dimTowardBlack('#ffffff', 0.5)).toBe('#808080');
	// per channel: 0x33=51→round(20.4)=0x14, 0x66=102→round(40.8)=0x29, 0x99=153→round(61.2)=0x3d
	expect(dimTowardBlack('#336699', 0.6)).toBe('#14293d');
	expect(dimTowardBlack('#abc', 0)).toBe('#aabbcc');
});

test('dimTowardBlack is monotone — more dim is never brighter on any channel', () => {
	const c = '#7c5cff';
	let prev = parseHex(dimTowardBlack(c, 0))!;
	for (let d = 0.1; d <= 1.0001; d += 0.1) {
		const cur = parseHex(dimTowardBlack(c, Number(d.toFixed(2))))!;
		for (let i = 0; i < 3; i++) expect(cur[i]!).toBeLessThanOrEqual(prev[i]!);
		prev = cur;
	}
});

test('dimTowardBlack clamps an out-of-range dim into [0,1] rather than inverting', () => {
	// A negative dim must not BRIGHTEN (f > 1) and a dim past 1 must not go negative.
	expect(dimTowardBlack('#336699', -0.5)).toBe('#336699');
	expect(dimTowardBlack('#336699', 2)).toBe('#000000');
});

test('dimTowardBlack returns an unparseable input verbatim (the token safety net)', () => {
	// A CSS-variable gradient string passes through unchanged rather than throwing: a pure function cannot
	// darken a var().
	const grad = 'radial-gradient(80% 60% at 50% 30%, var(--stage-glow) 0%, var(--bg) 70%)';
	expect(dimTowardBlack(grad, 0.5)).toBe(grad);
	expect(dimTowardBlack('rebeccapurple', 0.5)).toBe('rebeccapurple');
});

test('normalizeStageDim clamps to [0,1], rounds to a hundredth, and keeps the base on junk', () => {
	expect(DEFAULT_STAGE_DIM).toBe(0);
	expect(MIN_STAGE_DIM).toBe(0);
	expect(MAX_STAGE_DIM).toBe(1);
	expect(normalizeStageDim(0, 0.3)).toBe(0);
	expect(normalizeStageDim(1, 0.3)).toBe(1);
	expect(normalizeStageDim(0.5, 0)).toBe(0.5);
	// rounded to 1/100, matching guideLevelDefault
	expect(normalizeStageDim(0.126, 0)).toBe(0.13);
	expect(normalizeStageDim(-1, 0.3)).toBe(0);
	expect(normalizeStageDim(9, 0.3)).toBe(1);
	// junk keeps the caller's current value, like every other field
	for (const junk of [NaN, Infinity, -Infinity, '0.5', null, undefined, {}]) {
		expect(normalizeStageDim(junk as never, 0.42)).toBe(0.42);
	}
});

// Duet part colours: the worker writes an abstract `part` letter on each line of a CONFIDENT duet and
// NOTHING on a solo or undiarized song, and `duetPartColors` maps letters onto DISTINCT, LEGIBLE colours
// from the singer-identity palette. The rendered `--reel-part` wiring is scanned separately.

test('a diarized duet gets two DISTINCT, LEGIBLE part colours', () => {
	const lines = [{ part: 'A' }, { part: 'B' }, { part: 'A' }, { part: 'B' }];
	const colours = duetPartColors(lines);
	expect([...colours.keys()].sort()).toEqual(['A', 'B']);
	const a = colours.get('A')!;
	const b = colours.get('B')!;
	// DISTINCT, or the feature is pointless…
	expect(a).not.toBe(b);
	// …and LEGIBLE: a hard-coded pair would skip the 3:1 identity floor.
	expect(isLegibleSingerColor(a)).toBe(true);
	expect(isLegibleSingerColor(b)).toBe(true);
	// …drawn from the established vocabulary, not an invented pair.
	expect(SINGER_COLORS as readonly string[]).toContain(a);
	expect(SINGER_COLORS as readonly string[]).toContain(b);
});

test('part colours are assigned by ORDER OF APPEARANCE and are stable per doc', () => {
	// "B" opens the song here, so it takes the first palette colour: content-driven and deterministic.
	const opensWithB = duetPartColors([{ part: 'B' }, { part: 'A' }, { part: 'B' }]);
	const opensWithA = duetPartColors([{ part: 'A' }, { part: 'B' }, { part: 'A' }]);
	// Non-vacuous: an always-empty helper would satisfy the equality arms below.
	expect(opensWithB.size).toBe(2);
	expect(opensWithA.size).toBe(2);
	expect(opensWithB.get('B')).toBe(opensWithA.get('A')); // both are the first-appearing part
	expect(opensWithB.get('A')).toBe(opensWithA.get('B')); // both are the second-appearing part
	expect([...duetPartColors([{ part: 'B' }, { part: 'A' }])]).toEqual([...opensWithB].slice(0, 2));
});

test('an UNDIARIZED song gets NO part colour — the single-colour fallback, by absence', () => {
	// No line carries a part (a solo, or diarization could not split): the EMPTY map is what the reel reads
	// as "keep the single-colour path".
	expect(duetPartColors([{}, {}, {}]).size).toBe(0);
	// A blank or whitespace part is not a part (mirrors parseLyricsDoc's if-available rule).
	expect(duetPartColors([{ part: '' }, { part: '   ' }]).size).toBe(0);
	// A lone attributed voice is not a duet worth two colours.
	expect(duetPartColors([{ part: 'A' }, { part: 'A' }]).size).toBe(1);
	// Null/undefined never throws — every model-derived field is untrusted.
	expect(duetPartColors(null).size).toBe(0);
	expect(duetPartColors(undefined).size).toBe(0);
});
