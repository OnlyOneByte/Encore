// guard: the TV lower-third (singer name, key, provenance marker) carries a hard OUTLINE, not only a soft
// glow, so it stays legible on ANY stage colour a room picks, including white. Caught: `.lower-third` leaned
// solely on `text-shadow: 0 2px 14px rgba(0,0,0,.9)`, a blurred shadow that dissolves against a bright field
// of similar luminance — on a white stage the white singer name measured ~1.10:1 and the amber provenance
// marker ~1.72:1. The fix is `-webkit-text-stroke` + `paint-order: stroke fill`.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { stripComments } from '@encore/test-support/scan';

const ROUTE = 'src/routes/tv/+page.svelte';

/** Blank comments out, keeping newlines so a comment describing the stroke cannot satisfy the scan. */
const src = stripComments(read(ROUTE), { markup: true });

/** The `.lower-third { ... }` rule body, comments already stripped. */
function lowerThirdRule(): string {
	const m = src.match(/\.lower-third\s*\{([\s\S]*?)\}/);
	expect(m, 'expected a .lower-third rule in tv/+page.svelte').not.toBeNull();
	return m![1]!;
}

test('the lower-third is stroked so the singer name/key/marker stay legible on any background', () => {
	const body = lowerThirdRule();
	const stroke = [...body.matchAll(/-webkit-text-stroke:\s*([^;]+);/g)].map((m) => m[1]!.trim());
	expect(stroke.length).toBe(1);
	// A non-zero width, and the same dark wash the reel's stroke and the glow use — one source of truth.
	expect(stroke[0]).toMatch(/^0*\.0*[1-9]/); // e.g. 0.04em
	expect(stroke[0]).toContain('var(--scrim-strong)');
});

test('the lower-third stroke paints BEHIND the glyph so it does not eat the ink', () => {
	// Load-bearing: the default paint order (fill, then stroke on top) thickens the type.
	expect(lowerThirdRule()).toMatch(/paint-order:\s*stroke\s+fill\s*;/);
});

test('the lower-third stroke colour clears WCAG body contrast on a white stage', () => {
	// The machine-checkable half of the legibility claim: the STROKE is what the eye reads at the glyph edge,
	// so its contrast against the background is the readable contrast, independent of the white/amber fill
	// underneath. `--scrim-strong` is read from app.css so a change to the token is caught rather than assumed.
	const css = read('src/app.css');
	const m = css.match(/--scrim-strong:\s*rgba?\(([^)]+)\)\s*;/);
	expect(m, '--scrim-strong not found in app.css (renamed? update this guard)').not.toBeNull();
	const parts = m![1]!.split(',').map((s) => parseFloat(s.trim()));
	const [r, g, b] = parts as [number, number, number];
	const a = parts.length > 3 ? parts[3]! : 1;

	const WHITE: [number, number, number] = [255, 255, 255];
	// The stroke is semi-transparent, so composite it over the white stage — that is the pixel the eye reads.
	const composited: [number, number, number] = [r, g, b].map((c) => Math.round(c * a + 255 * (1 - a))) as [
		number,
		number,
		number
	];

	const srgbToLin = (c: number) => {
		const u = c / 255;
		return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
	};
	const lum = ([rr, gg, bb]: [number, number, number]) =>
		0.2126 * srgbToLin(rr) + 0.7152 * srgbToLin(gg) + 0.0722 * srgbToLin(bb);
	const contrast = (x: [number, number, number], y: [number, number, number]) => {
		const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
		return (hi + 0.05) / (lo + 0.05);
	};

	// 4.5:1 is the WCAG AA body-text bar; the lower-third is large text (3:1), so clearing 4.5 is strictly
	// stronger than required.
	expect(contrast(composited, WHITE)).toBeGreaterThanOrEqual(4.5);
});
