import { test, expect } from 'bun:test';
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
	STAGE_BG_L,
	SINGER_L
} from './colors';

// Every colour the wheel can emit. Derived here, not exported from `colors.ts`: production picks a
// colour with `hueToHex(hue)` for an arbitrary hue (the wheel is free-hue), so a precomputed array
// was a second, unread representation of this same set.
const SINGER_WHEEL: readonly string[] = SINGER_HUES.map((h) => hueToHex(h));

const BG = '#0b0b12'; // --bg
const CARD = '#1a1a28'; // --card

test('parseHex accepts 3- and 6-digit hex and rejects everything else', () => {
	expect(parseHex('#7c5cff')).toEqual([124, 92, 255]);
	expect(parseHex('#0af')).toEqual([0, 170, 255]);
	expect(parseHex('  #0AF  ')).toEqual([0, 170, 255]);
	// the forms that used to slip through and break CSS interpolation downstream
	expect(parseHex('rgb(1,2,3)')).toBeNull();
	expect(parseHex('oklch(0.7 0.16 280)')).toBeNull();
	expect(parseHex('rebeccapurple')).toBeNull();
	expect(parseHex('#7c5cff30')).toBeNull(); // 8-digit: the old alpha-concat artefact
	expect(parseHex('')).toBeNull();
});

test('contrastRatio matches known WCAG values', () => {
	// white on black is the definitional maximum
	expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
	expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
	// the measurement that condemned white-on-gradient: white on --accent2
	expect(contrastRatio('#ffffff', '#ff5cae')).toBeCloseTo(2.84, 1);
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
	// The reason chroma is reduced to fit the gamut instead of letting the conversion clip: clipping
	// hue-shifts, so two neighbouring stops could otherwise render as the same hex.
	expect(new Set(SINGER_WHEEL).size).toBe(SINGER_WHEEL.length);
});

test('all eight presets remain legible — existing singers keep their colour', () => {
	// This is the assertion that rules out a lightness-BAND validator: #7c5cff is at OKLCH L≈0.56,
	// outside the wheel's L≈0.70, so a band check would reject every singer who ever joined.
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
	expect(isLegibleSingerColor('#0b0b12')).toBe(false); // exactly the page background
	expect(isLegibleSingerColor('#1a1a28')).toBe(false); // exactly a card
	expect(isLegibleSingerColor('#101018')).toBe(false);
});

test('the 3:1 dot rule is pinned at its boundary, not just far below it', () => {
	// The rest of the negative coverage sits at or below 1.22:1 — a factor of ~2.5 under the bar —
	// so a validator enforcing any looser threshold (1.5:1, 2:1, 2.9:1) would pass unnoticed. These
	// cases sit inside the 1.3–3.0 band the rule exists to reject, and bracket the exact 3:1 edge.

	// Mid-band: below 3:1 against BOTH surfaces (bg 2.97, card 2.60). A ~2:1 rule would wrongly pass it.
	expect(contrastRatio('#5c5c66', BG)).toBeCloseTo(2.97, 1);
	expect(contrastRatio('#5c5c66', CARD)).toBeCloseTo(2.6, 1);
	expect(isLegibleSingerColor('#5c5c66')).toBe(false);

	// Just under the edge, and only against ONE surface: bg 3.40 clears 3:1 but card 2.98 does not.
	// This pins both the exact threshold AND that BOTH surfaces must clear it (the `.every`), so
	// dropping MIN_DOT_CONTRAST to 2.9, or switching `.every` to `.some`, would wrongly accept it.
	expect(contrastRatio('#65656f', BG)).toBeCloseTo(3.4, 1);
	expect(contrastRatio('#65656f', CARD)).toBeCloseTo(2.98, 2);
	expect(isLegibleSingerColor('#65656f')).toBe(false);

	// Just at/above the edge on both surfaces (bg 3.45, card 3.03) — the nearest legible colour.
	// Raising MIN_DOT_CONTRAST above ~3.03 would wrongly reject it.
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
	// The regression that would silently undo the whole feature: a validator that accepts the wheel in
	// principle but rewrites its output in practice.
	for (const c of SINGER_WHEEL) expect(normalizeSingerColor(c)).toBe(c);
});

test('nearestSingerHue keeps the slider and the swatches as one selection', () => {
	// Without this the thumb sat at hue 0 (red) while displaying violet, so the two controls disagreed
	// about what was selected.
	for (const h of SINGER_HUES) expect(nearestSingerHue(hueToHex(h))).toBe(h);
});

test('nearestSingerHue maps each preset to a plausible hue', () => {
	// Not exact — the presets are outside the wheel's lightness band — but it must land in the right
	// part of the circle, not the opposite side.
	expect(nearestSingerHue('#ff5cae')).toBeGreaterThan(300); // pink
	expect(nearestSingerHue('#33d6a6')).toBeGreaterThan(120); // green/teal
	expect(nearestSingerHue('#33d6a6')).toBeLessThan(210);
	expect(nearestSingerHue('#nope')).toBe(0); // unparseable degrades quietly
});

// ── stage tier ─────────────────────────────────────────────────────────────
// These test the BOUND, not literal hexes. A hex assertion would freeze the palette and break on any
// gamut-clipping tweak; the thing that must never regress is that lyrics stay readable on the stage.

const WHITE = '#ffffff';
const ACCENT2 = '#ff5cae'; // the "sing this now" active-word colour

test('every stage background is far darker than the singer dot palette', () => {
	// The dot tier on a full screen would wash out the lyric reel. This is the whole reason the stage
	// tier exists, so assert the ordering rather than trusting the two constants to stay apart.
	expect(STAGE_BG_L).toBeLessThan(SINGER_L);
	for (const hue of SINGER_HUES) {
		expect(stageLightnessForHue(hue)).toBeLessThanOrEqual(STAGE_BG_L);
	}
});

test('sung-white lyrics clear WCAG AA on every stage background', () => {
	// White is the `.word.done` colour and the brightest thing in the reel. 4.5:1 is the text bar —
	// applicable here because these ARE glyphs, unlike the singer dot which is a 3:1 non-text fill.
	for (const hue of SINGER_HUES) {
		const bg = stageHueToHex(hue);
		expect(contrastRatio(WHITE, bg)).toBeGreaterThanOrEqual(4.5);
	}
});

test('the active-word pink separates from every stage background', () => {
	// The defect the mockups caught: a stage generated from a hue near --accent2 steals the active
	// word's cue, because highlight and field become the same hue family. The guard trades brightness
	// for that separation, so the invariant is a CONTRAST floor between the pink and the stage.
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
	// and the guard must actually buy separation, not merely darken
	expect(contrastRatio(ACCENT2, stageHueToHex(pinkHue))).toBeGreaterThan(
		contrastRatio(ACCENT2, hueToHex(pinkHue, STAGE_BG_L, 0.07))
	);
});

test('the guard ramps rather than stepping — no cliff between adjacent wheel stops', () => {
	// A binary threshold gave two neighbouring stops wildly different stages for a 15° change. Assert
	// smoothness directly: no adjacent pair may jump more than one step's worth of the ramp.
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
	// #33d6a6 and #5cffd6 both quantize to hue 165, so `singer` cannot tell those two apart. That is
	// a documented cosmetic limitation of the wheel's chroma clipping — pinned here so it is a known
	// fact rather than a surprise, and so it fails loudly if the wheel ever changes.
	const stages = SINGER_COLORS.map((c) => stageHueToHex(nearestSingerHue(c)));
	for (const bg of stages) {
		expect(parseHex(bg)).not.toBeNull();
		expect(contrastRatio(WHITE, bg)).toBeGreaterThanOrEqual(4.5);
	}
	expect(stageHueToHex(nearestSingerHue('#33d6a6'))).toBe(stageHueToHex(nearestSingerHue('#5cffd6')));
});

// ── preset roving tab order ──────────────────────────────────────────────────
// The eight presets are a roving-tabindex radiogroup: exactly one swatch is tabbable and arrow keys
// move within. The tab stop is normally the checked preset — but the wheel emits colours that are
// NEVER presets, and without a fallback a single wheel pick drops all eight out of the tab order for
// good, locking a keyboard/switch-access guest out of the only named colours. presetTabStopIndex is
// the pure decision the picker's `tabindex` reads; these pin that a valid tab stop ALWAYS exists.

test('presetTabStopIndex points at the matching swatch for a preset value', () => {
	SINGER_COLORS.forEach((c, i) => {
		expect(presetTabStopIndex(c)).toBe(i);
	});
});

test('presetTabStopIndex keeps a tab stop after a wheel pick — the closed-door bug', () => {
	// The bug (#88): after any hue pick, value is a wheel hex, no swatch matches, and the old
	// `value === c ? 0 : -1` expression left EVERY swatch at -1 — the whole group fell out of the tab
	// order and the wheel provably cannot return to a preset. The fallback keeps swatch 0 tabbable.
	//
	// Mutation proof: revert presetTabStopIndex to `SINGER_COLORS.indexOf(value)` (no fallback) and it
	// returns -1 for every wheel hue below — this expectation then fails with `-1 to be 0`.
	for (const wheelHex of SINGER_WHEEL) {
		// premise: the wheel never lands on a preset, so there is genuinely no match to fall back from
		expect(SINGER_COLORS as readonly string[]).not.toContain(wheelHex);
		expect(presetTabStopIndex(wheelHex)).toBe(0);
	}
});

test('presetTabStopIndex always yields exactly one in-range tab stop', () => {
	// The invariant the picker relies on: for ANY value — preset, wheel hue, or garbage — precisely
	// one swatch ends up with tabindex 0, and it is a real index into the rendered swatches.
	const inputs = [...SINGER_COLORS, ...SINGER_WHEEL, '#000000', 'not a colour', ''];
	for (const v of inputs) {
		const stop = presetTabStopIndex(v);
		const tabbable = SINGER_COLORS.map((_, i) => i).filter((i) => i === stop);
		expect(tabbable.length).toBe(1);
		expect(stop).toBeGreaterThanOrEqual(0);
		expect(stop).toBeLessThan(SINGER_COLORS.length);
	}
});

// #215: the arrow-key handler used to anchor movement on a bare `indexOf(value)`, which returns -1
// for a wheel hex, while the tab stop anchored on presetTabStopIndex (falls back to 0). After a wheel
// pick the two disagreed: the focus ring sat on swatch 0 but arrow movement computed from -1, so the
// FIRST ArrowRight did not move (checked 0) and ArrowLeft skipped mint (7), landing on purple (6).
// nextSwatchIndex now shares presetTabStopIndex's anchor so movement matches the ring. These pin the
// concrete post-fix landings. Expected indices are written as LITERALS (7, 1, ...) — not computed
// from indexOf/presetTabStopIndex — so a regression to the old bare-indexOf base reds them.

test('nextSwatchIndex moves correctly from a preset value (the control case)', () => {
	// violet is SINGER_COLORS[0]. Right -> pink (1), Left wraps -> mint (7).
	expect(nextSwatchIndex(SINGER_COLORS[0]!, 1)).toBe(1);
	expect(nextSwatchIndex(SINGER_COLORS[0]!, -1)).toBe(7);
	// green is [2]. Right -> amber (3), Left -> pink (1).
	expect(nextSwatchIndex(SINGER_COLORS[2]!, 1)).toBe(3);
	expect(nextSwatchIndex(SINGER_COLORS[2]!, -1)).toBe(1);
});

test('nextSwatchIndex after a wheel pick matches the tab stop, not indexOf(-1) — #215', () => {
	// value is a wheel hex (no preset matches), reproducing the exact reported state.
	const wheelHex = hueToHex(120);
	expect(SINGER_COLORS as readonly string[]).not.toContain(wheelHex); // premise: genuinely non-preset
	// The focus ring sits on swatch 0 (presetTabStopIndex fallback). Movement must start from there:
	// ArrowRight -> 1 (pink), ArrowLeft -> 7 (mint). Not 0 (dead) and not 6 (purple, the old bug).
	expect(nextSwatchIndex(wheelHex, 1)).toBe(1);
	expect(nextSwatchIndex(wheelHex, -1)).toBe(7);
	// Mutation proof: reverting the base in nextSwatchIndex to `SINGER_COLORS.indexOf(value)` makes this
	// (1 + -1 + 8) % 8 => wheelHex gives base -1, so step +1 -> 0 (fails toBe(1)) and step -1 -> 6
	// (fails toBe(7)). Both assertions red exactly as #215 describes.
});
