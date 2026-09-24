// guard: the duet part colour reaches the reel. Part colour LAYERS OVER singer colour, which layers over the
// room accent: `--reel-part` defaults to `--reel-singer` and both treatments read `--reel-part`, so on an
// undiarized song the fallback is reached by ABSENCE, mirroring the worker. Colours come from
// `SINGER_COLORS` through `isLegibleSingerColor`, never hard-coded. One assertion per production hunk.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/(^|[^:'"\\`])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
}

// `read` throws when the file is absent, which is what keeps the NEGATIVE assertions below from passing on an
// empty string.
const OVERLAY = 'src/lib/tv/LyricsOverlay.svelte';
const overlaySrc = () => stripComments(read(OVERLAY));

test('the duet-part wiring scan reads a non-empty overlay source', () => {
	expect(overlaySrc().length).toBeGreaterThan(2000);
});

test('the overlay imports the shared part-colour helper (import hunk)', () => {
	expect(overlaySrc()).toMatch(/import\s*\{[^}]*\bduetPartColors\b[^}]*\}\s*from\s*['"]\$lib\/contract['"]/);
});

test('the overlay derives the CURRENT line part colour through the helper (derived hunk)', () => {
	const src = overlaySrc();
	expect(src).toMatch(/partColors\s*=\s*\$derived\(\s*duetPartColors\s*\(\s*doc\?\.lines\s*\)\s*\)/);
	// Without the lookup below the map is computed and never consulted, so nothing paints.
	expect(src).toMatch(/partColor\s*=\s*\$derived\(/);
	expect(src).toMatch(/partColors\.get\(\s*curLine\.part\s*\)/);
});

test('the part colour is appended as --reel-part, and ONLY when the current line has one (typeStyle hunk)', () => {
	const src = overlaySrc();
	// CONDITIONAL: an unconditional write puts the literal `null` into CSS and breaks the
	// undiarized-identical guarantee, since the stylesheet default is the only place the fallback is named.
	expect(src).toMatch(/partColor\s*\?\s*`;\s*--reel-part:\s*\$\{partColor\}`\s*:\s*''/);
	expect(src).toMatch(/style=\{typeStyle\}/);
});

test('the stylesheet defaults --reel-part to the singer colour, and both treatments read it (CSS hunks)', () => {
	const src = overlaySrc();
	// The only place the duet fallback is named.
	expect(src).toMatch(/--reel-part:\s*var\(--reel-singer\)\s*;/);
	// BOTH treatments — `--reel-now` the sung word, `--reel-line` the whole current lyric under the `line`
	// setting. Splitting them lets the two settings disagree about which part's colour is showing.
	expect(src).toMatch(/--reel-now:\s*var\(--reel-part\)\s*;/);
	expect(src).toMatch(/--reel-line:\s*var\(--reel-part\)\s*;/);
	// Neither highlight property may read `--reel-singer` DIRECTLY. Scoped to these two declarations, since
	// the default line above legitimately still names it.
	expect(src).not.toMatch(/--reel-now:\s*var\(--reel-singer\)/);
	expect(src).not.toMatch(/--reel-line:\s*var\(--reel-singer\)/);
});

test('the amber provenance override still leaves the sung word alone under the part colour (fallback precedence)', () => {
	const src = overlaySrc();
	// `.lyrics.unverified` overrides `--reel-line` so the `line` treatment shows provenance, but NOT
	// `--reel-now`: an auto-transcribed duet still carries the PART colour on the word being sung.
	const unverified = /\.lyrics\.unverified\s*\{([^}]*)\}/.exec(src);
	expect(unverified).not.toBeNull();
	expect(unverified![1]).toMatch(/--reel-line:\s*#ffe6b8\s*;/);
	expect(unverified![1]).not.toMatch(/--reel-now:/);
});
