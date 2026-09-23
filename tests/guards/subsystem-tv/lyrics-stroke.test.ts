// Guard: the TV lyric reel carries a hard OUTLINE, not only a soft glow.
//
// The rule is to keep the lyrics readable on ANY background by stroking the text, because `.lyrics` had only
// `text-shadow: 0 2px 18px var(--scrim-strong)` — a blurred shadow, which lifts the ink off a dark video but
// dissolves against a mid-tone stage colour of similar brightness, exactly the field a hue-only background
// paints. `-webkit-text-stroke` is a crisp edge that survives any backdrop, with `paint-order: stroke fill`
// so the outline paints BEHIND the glyph and does not eat the white ink.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

// `read` throws on a missing subject, which matters more than usual here: both assertions below are
// satisfiable by nothing at all if the source ever came back empty.
const OVERLAY = 'src/lib/tv/LyricsOverlay.svelte';

/** Blank comments out, keeping newlines so reported line numbers stay true (matches lyrics-reel-cap). */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/(^|[^:'"\\`])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
}

const src = stripComments(read(OVERLAY));

test('the lyric reel is stroked so the words stay legible on any background', () => {
	const stroke = [...src.matchAll(/-webkit-text-stroke:\s*([^;]+);/g)].map((m) => m[1]!.trim());
	expect(stroke.length).toBe(1);
	// Some non-zero width, and the same dark wash the glow uses — one outline source of truth.
	expect(stroke[0]).toMatch(/^0*\.0*[1-9]/); // starts with a non-zero fractional width, e.g. 0.06em
	expect(stroke[0]).toContain('var(--scrim-strong)');
});

test('the stroke paints BEHIND the glyph so it does not eat the white ink', () => {
	// Load-bearing: the default paint order (fill, then stroke on top) would thicken the type.
	expect(src).toMatch(/paint-order:\s*stroke\s+fill\s*;/);
});
