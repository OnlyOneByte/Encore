// guard: the TV lyric highlight is painted in the CURRENT SINGER's colour, and that colour actually reaches
// the per-word spans. The ruling was to KEEP the singer's hue and lean on the reel's existing stroke, so the
// only rule that applies is the identity floor (`lyricHighlightColor` -> `isLegibleSingerColor`). ONE
// assertion per production hunk, so reverting any single hunk reds a NAMED test.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { flattenDoc, stripComments } from '@encore/test-support/scan';

const OVERLAY = 'src/lib/tv/LyricsOverlay.svelte';
const TV_ROUTE = 'src/routes/tv/+page.svelte';

const overlaySrc = () => stripComments(read(OVERLAY), { markup: true });
const routeSrc = () => stripComments(read(TV_ROUTE), { markup: true });
/** The overlay WITH comments intact — only the comment/code parity guard reads this. */
const overlayRaw = () => read(OVERLAY);

// Non-vacuity: a read that silently produced nothing would fail the positive tests loudly but pass every
// NEGATIVE one vacuously.
test('the wiring scan reads two non-empty sources', () => {
	expect(overlaySrc().length).toBeGreaterThan(2000);
	expect(routeSrc().length).toBeGreaterThan(2000);
});

test('the overlay takes a singerColor prop and defaults it to no singer', () => {
	const src = overlaySrc();
	// Nullable on the Props interface — "nobody is up" has to be expressible…
	expect(src).toMatch(/singerColor\?:\s*string\s*\|\s*null\s*;/);
	// …and destructured with a default, so an omitted prop is the accent rather than `undefined` reaching the
	// helper by accident.
	expect(src).toMatch(/singerColor\s*=\s*null/);
});

test('the overlay resolves the highlight colour through the shared helper, not the raw prop', () => {
	const src = overlaySrc();
	expect(src).toMatch(/import\s*\{[^}]*\blyricHighlightColor\b[^}]*\}\s*from\s*['"]\$lib\/contract['"]/);
	// The prop goes THROUGH the helper: interpolating `singerColor` straight into the style attribute would
	// put an unvalidated wire value into CSS, which is why the helper is a boundary and not a convenience.
	expect(src).toMatch(/\$derived\s*\(\s*lyricHighlightColor\s*\(\s*singerColor\s*\)\s*\)/);
});

test('the resolved colour is appended as --reel-singer, and only when there is one', () => {
	const src = overlaySrc();
	// CONDITIONAL, so the stylesheet's own default is the single place the accent fallback is named; an
	// unconditional write would put the literal `null` into CSS.
	expect(src).toMatch(/singerHighlight\s*\?\s*`;\s*--reel-singer:\s*\$\{singerHighlight\}`\s*:\s*''/);
	// and that string is what the wrapper actually renders
	expect(src).toMatch(/style=\{typeStyle\}/);
});

test('both highlight treatments read the reel colour chain, and neither names --accent2 any more (layered by the part colour)', () => {
	const src = overlaySrc();
	// The default: the room accent, declared once.
	expect(src).toMatch(/--reel-singer:\s*var\(--accent2\)\s*;/);
	// BOTH treatments read the chain — `--reel-now` is the sung WORD, `--reel-line` the whole current lyric
	// under the `line` room setting — or the two settings can disagree about whose colour is showing. The
	// part-colour layer sits between them and `--reel-singer`, so the singer colour flows through unchanged.
	expect(src).toMatch(/--reel-part:\s*var\(--reel-singer\)\s*;/);
	expect(src).toMatch(/--reel-now:\s*var\(--reel-part\)\s*;/);
	expect(src).toMatch(/--reel-line:\s*var\(--reel-part\)\s*;/);
	// Neither highlight property may name the accent directly. Scoped to these two declarations rather than
	// banning `--accent2` from the file, because the active-word MARKER is a position cue rather than the
	// sung-text highlight and legitimately keeps it.
	expect(src).not.toMatch(/--reel-now:\s*var\(--accent2\)/);
	expect(src).not.toMatch(/--reel-line:\s*var\(--accent2\)/);
});

test('the amber provenance override still wins for the line treatment, and still leaves the word alone', () => {
	const src = overlaySrc();
	// `.lyrics.unverified` overrides `--reel-line` but NOT `--reel-now`: trustworthiness is a different
	// question from position and identity, so an auto-transcribed song still carries the singer's colour on
	// the word being sung.
	const unverified = /\.lyrics\.unverified\s*\{([^}]*)\}/.exec(src);
	expect(unverified).not.toBeNull();
	expect(unverified![1]).toMatch(/--reel-line:\s*#ffe6b8\s*;/);
	expect(unverified![1]).not.toMatch(/--reel-now:/);
});

// COMMENT/CODE PARITY. The overlay's own prose used to ASSERT that the highlight is pink on every song,
// which this wiring falsified, and a comment contradicting its code is a real defect. These assertions ban
// the discredited CLAIM and require the corrected paragraphs to name what replaced it, without pinning
// wording, so an unrelated reword passes.
test('the provenance comment no longer claims the highlight is pink (comment/code parity)', () => {
	// Comment markers stripped and whitespace collapsed, so each claim is matched as a SENTENCE: re-flowing
	// the paragraph otherwise puts `//` between two of its words and a live claim reads as deleted.
	const raw = flattenDoc(overlayRaw(), { line: true });
	// The active word is the SINGER's colour, not pink on every song…
	expect(raw).not.toMatch(/Pink means "sing this word now" on every song/i);
	// …and the source must still state that `--reel-now` is deliberately left alone, which is the fact a
	// future editor would otherwise "fix" by overriding it. Anchored on the CLAIM, so this bites on the prose
	// being deleted as well as on the discredited claim returning.
	expect(raw).toMatch(/`--reel-now` is deliberately NOT overridden/i);
	// Same for the `line` treatment, whose override is against `--reel-singer` now rather than pink.
	expect(raw).not.toMatch(/leaving it pink would mean the `line` treatment/i);
	expect(raw).toMatch(/`--reel-line` IS overridden/i);
});

test('the TV route hands the overlay the current singer — the non-test caller', () => {
	const src = routeSrc();
	// The route already derives the current singer's colour for the stage glow and the lower-third dot, and
	// the reel is given the same value. Reverting this ONE line leaves the feature with zero non-test callers.
	expect(src).toMatch(/singerColor=\{currentSingerColor\}/);
	// …and it is on the LyricsOverlay call, not merely somewhere in a ~1400-line route: matched from the
	// opening tag to its self-closing `/>` with no intervening `<`.
	const call = /<LyricsOverlay\b[^<]*?\/>/.exec(src);
	expect(call).not.toBeNull();
	expect(call![0]).toMatch(/singerColor=\{currentSingerColor\}/);
	// The value is the derived roster lookup, not re-derived here.
	expect(src).toMatch(/const\s+currentSingerColor\s*=\s*\$derived\(/);
});
