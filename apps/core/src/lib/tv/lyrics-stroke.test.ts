// Guard: the TV lyric reel carries a hard OUTLINE, not only a soft glow (issue #425, piece 1).
//
// THE DEFECT. The owner ruled (2026-09-06) to drop the pinned stage lightness/chroma and instead
// keep the lyrics readable on ANY background by stroking the text. Before this fix `.lyrics` had
// only `text-shadow: 0 2px 18px var(--scrim-strong)` — a blurred shadow, which lifts the ink off a
// dark video but dissolves against a mid-tone stage colour of similar brightness (exactly the field
// a hue-only background paints). The fix adds `-webkit-text-stroke` — a crisp edge that survives any
// backdrop — with `paint-order: stroke fill` so the outline paints BEHIND the glyph and does not eat
// the white ink.
//
// WHY A SOURCE SCAN AND NOT A RENDER TEST. bun test has no Svelte compiler and no browser, so the
// painted stroke cannot be read at runtime here — the rendered A/B is proven by the committed CDP
// screenshots in the PR body, not by this file. What this file pins is the declaration in the
// component source, and it is NOT mutation-blind: it reads LyricsOverlay.svelte itself and strips
// comments first (so the explanatory comment describing the stroke cannot satisfy it), so the
// production declaration IS what it asserts — reverting either line reds this directly. Verified both
// ways: with the fix it passes; with the two declarations removed it reds on the first/second assert.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OVERLAY = join(import.meta.dir, 'LyricsOverlay.svelte');

/** Blank comments out, keeping newlines so reported line numbers stay true (matches lyrics-reel-cap). */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/(^|[^:'"\\`])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
}

const src = stripComments(readFileSync(OVERLAY, 'utf8'));

test('the lyric reel is stroked so the words stay legible on any background', () => {
	// A real outline, not just the blurred glow. Reverting this line reds here.
	const stroke = [...src.matchAll(/-webkit-text-stroke:\s*([^;]+);/g)].map((m) => m[1]!.trim());
	expect(stroke.length).toBe(1);
	// Some non-zero width, and the same dark wash the glow uses (one outline source of truth).
	expect(stroke[0]).toMatch(/^0*\.0*[1-9]/); // starts with a non-zero fractional width, e.g. 0.06em
	expect(stroke[0]).toContain('var(--scrim-strong)');
});

test('the stroke paints BEHIND the glyph so it does not eat the white ink', () => {
	// paint-order: stroke fill is load-bearing — the default (fill then stroke on top) would thicken
	// the type. Reverting/removing this line reds here.
	expect(src).toMatch(/paint-order:\s*stroke\s+fill\s*;/);
});
