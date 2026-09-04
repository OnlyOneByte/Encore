import { test, expect } from 'bun:test';
import {
	SINGER_COLORS,
	SINGER_WHEEL,
	SINGER_HUES,
	SINGER_HUE_STEP,
	hueToHex,
	parseHex,
	contrastRatio,
	isLegibleSingerColor,
	normalizeSingerColor,
	nearestSingerHue
} from './colors';

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
	const weak = SINGER_WHEEL.filter(
		(c) => contrastRatio(c, BG) < 3 || contrastRatio(c, CARD) < 3
	);
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
