// guard: the TV lyric highlight paints a diarized duet's two PARTS in two distinct legible colours,
// and that colour actually reaches the reel — the visible half of the duet feature.
//
// THE FEATURE. The worker's diarization writes an abstract `part` letter ("A", "B") on each
// line of a CONFIDENT duet, and NOTHING on a solo or a song it could not split. The duet part-colour feature paints
// each part in its own colour as it is sung, so two singers see which lines are theirs without agreeing in
// advance. The colours come from the singer-identity palette (`SINGER_COLORS`) through the same
// legibility floor (`isLegibleSingerColor`) the singer colour uses — a hard-coded second colour is
// rejected by the owner precisely because it would skip that floor over video with a scrim.
//
// This extends the singer-colour mechanism rather than competing with it: part colour LAYERS OVER singer colour,
// which layers over the room accent. `--reel-part` defaults to `--reel-singer` (itself `--accent2`),
// and the two highlight treatments read `--reel-part`. On an undiarized song no line carries a part,
// `--reel-part` is never written, and the reel renders EXACTLY as today — the owner's fallback,
// reached by absence, mirroring the worker.
//
// WHY A SOURCE SCAN HERE, and why it is not mutation-blind. There is no Svelte compiler and no DOM
// under `bun test`, so a custom property appended to an inline `style` string and a CSS variable
// indirection cannot be read at runtime in this lane. These assertions read the real component source
// and strip comments first, so the explanatory prose can never satisfy one of them; there is
// deliberately one assertion per production hunk, so reverting any single wiring hunk reds a NAMED
// test rather than the suite staying green on a half-connected feature. The mutation-STRONG proof
// that the mapping is correct (two distinct legible colours vs an empty map) is behavioural, on the
// pure `duetPartColors` in `apps/core/src/lib/contract/presentation/colors.test.ts`; the RENDERED pixels are the CDP
// frames in the PR body.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

/** Blank out block, line and HTML comments, PRESERVING newlines so a commented-out wiring line can
 *  never satisfy a positive assertion nor a commented-out retired reference fail a negative one. */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/(^|[^:'"\\`])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
}

// Was `at('apps/core/src/lib/tv/LyricsOverlay.svelte')` — the subject was this guard's own SIBLING in
// apps/core/src/lib/tv, so it is now named in full and anchored on the repo root. `read` throws when
// the file is absent, which is what keeps the NEGATIVE assertions below from passing on an empty string.
const OVERLAY = 'apps/core/src/lib/tv/LyricsOverlay.svelte';
const overlaySrc = () => stripComments(read(OVERLAY));

// Non-vacuity floor: every assertion below matches a file's text, so a read that silently produced
// nothing would fail the positive tests loudly but pass the NEGATIVE ones vacuously.
test('the duet-part wiring scan reads a non-empty overlay source', () => {
	expect(overlaySrc().length).toBeGreaterThan(2000);
});

test('the overlay imports the shared part-colour helper (import hunk)', () => {
	expect(overlaySrc()).toMatch(/import\s*\{[^}]*\bduetPartColors\b[^}]*\}\s*from\s*['"]\$lib\/contract['"]/);
});

test('the overlay derives the CURRENT line part colour through the helper (derived hunk)', () => {
	const src = overlaySrc();
	// The map is derived per DOC from the shared helper — not re-implemented at the call site.
	expect(src).toMatch(/partColors\s*=\s*\$derived\(\s*duetPartColors\s*\(\s*doc\?\.lines\s*\)\s*\)/);
	// …and the CURRENT line's colour is picked out of that map. This is the line whose revert this
	// exists to catch: without it the map is computed and never consulted, so nothing paints.
	expect(src).toMatch(/partColor\s*=\s*\$derived\(/);
	expect(src).toMatch(/partColors\.get\(\s*curLine\.part\s*\)/);
});

test('the part colour is appended as --reel-part, and ONLY when the current line has one (typeStyle hunk)', () => {
	const src = overlaySrc();
	// Emitted into the SAME inline style string, CONDITIONALLY: with no part nothing is written, so
	// the stylesheet default is the single place the fallback is named. An unconditional write would
	// put the literal `null` into CSS and break the undiarized-identical guarantee.
	expect(src).toMatch(/partColor\s*\?\s*`;\s*--reel-part:\s*\$\{partColor\}`\s*:\s*''/);
	// …and that string is what the wrapper actually renders.
	expect(src).toMatch(/style=\{typeStyle\}/);
});

test('the stylesheet defaults --reel-part to the singer colour, and both treatments read it (CSS hunks)', () => {
	const src = overlaySrc();
	// The default: part colour falls back to the singer colour (itself the accent), so an undiarized
	// song is byte-identical to today. This is the single place the duet fallback is named.
	expect(src).toMatch(/--reel-part:\s*var\(--reel-singer\)\s*;/);
	// Both treatments now read --reel-part — `--reel-now` the sung WORD, `--reel-line` the whole
	// current lyric under the `line` setting. Splitting them would let the two settings disagree about
	// which part's colour is showing, so both are asserted.
	expect(src).toMatch(/--reel-now:\s*var\(--reel-part\)\s*;/);
	expect(src).toMatch(/--reel-line:\s*var\(--reel-part\)\s*;/);
	// The pre-part-colour form is gone: neither highlight property may read `--reel-singer` directly any
	// more, which is exactly what reverting either CSS consumer hunk would restore. Scoped to these
	// two declarations (the default line legitimately still names `--reel-singer`).
	expect(src).not.toMatch(/--reel-now:\s*var\(--reel-singer\)/);
	expect(src).not.toMatch(/--reel-line:\s*var\(--reel-singer\)/);
});

test('the amber provenance override still leaves the sung word alone under the part colour (fallback precedence)', () => {
	const src = overlaySrc();
	// `.lyrics.unverified` overrides `--reel-line` (so the `line` treatment shows provenance) but NOT
	// `--reel-now`. The part-colour hunks changed where `--reel-now` reads its colour (now `--reel-part`); this pins
	// that it did NOT change that precedence — an auto-transcribed duet still carries the PART colour
	// on the word being sung, the same reasoning recorded for the singer colour.
	const unverified = /\.lyrics\.unverified\s*\{([^}]*)\}/.exec(src);
	expect(unverified).not.toBeNull();
	expect(unverified![1]).toMatch(/--reel-line:\s*#ffe6b8\s*;/);
	expect(unverified![1]).not.toMatch(/--reel-now:/);
});
