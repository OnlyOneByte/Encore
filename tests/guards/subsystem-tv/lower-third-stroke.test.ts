// Guard: the TV lower-third (singer name, key, provenance marker) carries a hard OUTLINE, not only a
// soft glow — so it stays legible on ANY stage colour a room now picks (piece 2).
//
// THE DEFECT this pins. Stage-colour piece 2 lets a room store a real stage COLOUR, including white. Piece 1
// stroked the lyric REEL for exactly this reason — but it stroked ONLY the reel
// (LyricsOverlay.svelte). The `.lower-third` block in tv/+page.svelte had `NO CARD` and leaned solely
// on `text-shadow: 0 2px 14px rgba(0,0,0,.9)`, a blurred shadow that dissolves against a bright field
// of similar luminance. On a white stage the white singer name measured ~1.10:1 and the amber
// `ls-asr` marker ~1.72:1 — the regression the retired stage pin used to prevent, and a violation of
// the owner's ratified stage-colour condition, "always visible regardless of the background". The fix gives
// `.lower-third` the same treatment the reel got: `-webkit-text-stroke` + `paint-order: stroke fill`,
// so a hard dark outline sits behind every glyph and the text reads on any backdrop.
//
// WHY A SOURCE SCAN AND A CONTRAST COMPUTATION, NOT A RENDER TEST. bun test has no Svelte compiler and
// no browser, so the painted stroke cannot be read at runtime. Two things are pinned instead, and
// together they are NOT mutation-blind:
//   (1) the DECLARATION in the component source — read from tv/+page.svelte with comments stripped, so
//       reverting either the stroke line or the paint-order line reds this directly; and
//   (2) the LEGIBILITY CLAIM as arithmetic — the stroke colour composited over white, measured with
//       the same WCAG maths the app ships (contrast.test.ts / colors.ts), must clear the 4.5:1 body
//       bar. This is the machine-checkable core of the reviewer's CDP measurement: the stroke is what
//       the eye reads at the glyph edge, so its contrast against the background is the readable
//       contrast, independent of the white/amber fill underneath.
import { test, expect } from 'bun:test';
import { read, at } from '@encore/test-support';

// Was `at('apps/core/src/routes/tv/+page.svelte')` counted from
// apps/core/src/lib/tv. Named from the repo root instead, so it does not depend on where this test sits.
const ROUTE = 'apps/core/src/routes/tv/+page.svelte';

/** Blank comments out, keeping newlines so a comment describing the stroke cannot satisfy the scan. */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/(^|[^:'"\\`])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
}

const src = stripComments(read(ROUTE));

/** The `.lower-third { ... }` rule body, comments already stripped. */
function lowerThirdRule(): string {
	const m = src.match(/\.lower-third\s*\{([\s\S]*?)\}/);
	expect(m, 'expected a .lower-third rule in tv/+page.svelte').not.toBeNull();
	return m![1]!;
}

test('the lower-third is stroked so the singer name/key/marker stay legible on any background', () => {
	const body = lowerThirdRule();
	// A real outline, not just the blurred glow. Reverting this line reds here.
	const stroke = [...body.matchAll(/-webkit-text-stroke:\s*([^;]+);/g)].map((m) => m[1]!.trim());
	expect(stroke.length).toBe(1);
	// A non-zero width, and the same dark wash the reel's stroke and the glow use (one source of truth).
	expect(stroke[0]).toMatch(/^0*\.0*[1-9]/); // e.g. 0.04em
	expect(stroke[0]).toContain('var(--scrim-strong)');
});

test('the lower-third stroke paints BEHIND the glyph so it does not eat the ink', () => {
	// paint-order: stroke fill is load-bearing — the default (fill then stroke on top) thickens the
	// type. Removing this line reds here.
	expect(lowerThirdRule()).toMatch(/paint-order:\s*stroke\s+fill\s*;/);
});

// The machine-checkable half of the reviewer's CDP measurement: prove the stroke colour actually
// clears the body-text bar against WHITE — the room's brightest legal stage, and the case that
// measured 1.10:1 before the fix. This is arithmetic, so it bites without a browser.
test('the lower-third stroke colour clears WCAG body contrast on a white stage', () => {
	// --scrim-strong, read from app.css so a change to the token is caught here rather than assumed.
	// Was `at('apps/core/src/app.css')` from apps/core/src/lib/tv; named in full now.
	const css = read('apps/core/src/app.css');
	const m = css.match(/--scrim-strong:\s*rgba?\(([^)]+)\)\s*;/);
	expect(m, '--scrim-strong not found in app.css (renamed? update this guard)').not.toBeNull();
	const parts = m![1]!.split(',').map((s) => parseFloat(s.trim()));
	const [r, g, b] = parts as [number, number, number];
	const a = parts.length > 3 ? parts[3]! : 1;

	const WHITE: [number, number, number] = [255, 255, 255];
	// The stroke is semi-transparent, so composite it over the white stage — that is the pixel the eye
	// reads at the glyph edge.
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

	// 4.5:1 is the WCAG AA body-text bar; the lower-third is large text (3:1), so clearing 4.5 is
	// strictly stronger than required. The white fill's own 1.10:1 is irrelevant — the outline reads.
	expect(contrast(composited, WHITE)).toBeGreaterThanOrEqual(4.5);
});
