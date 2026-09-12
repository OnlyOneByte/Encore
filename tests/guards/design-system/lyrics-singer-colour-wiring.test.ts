// guard: the TV lyric highlight is painted in the CURRENT SINGER's colour, and that colour actually
// reaches the per-word spans.
//
// THE FEATURE. The reel used to paint both highlight treatments in the room-wide accent:
// `--reel-line: var(--accent2)` and `--reel-now: var(--accent2)`. This wiring replaces the source of that
// colour with whoever is singing, so a guest sees "their" colour follow the words and, with two
// singers taking turns, the stage visibly changes hands. The owner's ruling on the legibility question
// (2026-09-07) was to KEEP the singer's hue and lean on the outline the reel already paints — see
// `lyrics-stroke.test.ts`, which asserts there is exactly one `-webkit-text-stroke` — rather than
// deriving a per-frame brightness variant or clamping illegible colours to the accent. So there is no
// new contrast rule to test here; the rule that does apply is the identity floor
// (`lyricHighlightColor` -> `isLegibleSingerColor`), and that is exercised behaviourally on the pure
// function in `apps/core/src/lib/contract/presentation/colors.test.ts`.
//
// WHY A SOURCE SCAN, and why it is not mutation-blind. There is no Svelte compiler and no DOM under
// `bun test`, so a `$props()` declaration, a custom property appended to an inline `style` string, and
// a CSS variable indirection cannot be read at runtime in this lane — and reverting a markup line
// mostly breaks the BUILD (an undefined symbol) rather than reding a named test, which is not a proof.
// These assertions read the real component and route sources and strip comments first, so the
// explanatory prose in either file can never satisfy one of them. The RENDERED result — the sung words
// carrying the singer's colour, and staying legible on a stage colour that collides with it — is proven
// by the committed CDP frames in the PR body, not here.
//
// WHAT EACH ASSERTION IS FOR. There is deliberately one per production hunk, because the whole point is
// that reverting any single hunk reds a NAMED test rather than the suite staying green on a
// half-connected feature:
//   - the shared helper is imported by the component            (import hunk)
//   - the component takes and defaults a `singerColor` prop     (Props + destructure hunks)
//   - the prop is passed through the helper, not used raw       (derived hunk)
//   - the result is appended as `--reel-singer` CONDITIONALLY   (typeStyle hunk)
//   - the stylesheet defaults `--reel-singer` to the accent     (CSS default hunk)
//   - BOTH highlight treatments read it, and neither still
//     names `--accent2` directly                                (CSS consumer hunks)
//   - the TV route hands the component the current singer       (route hunk — the non-test caller)
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

/**
 * Blank out block, line and HTML comments, PRESERVING newlines so reported line numbers stay true. A
 * commented-out wiring line therefore cannot satisfy a positive assertion, and a commented-out retired
 * reference cannot fail a negative one. The `[^:'"\`]` guard before `//` keeps `https://` inside a
 * string or a URL from being treated as the start of a line comment.
 */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/(^|[^:'"\\`])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
}

const OVERLAY = 'apps/core/src/lib/tv/LyricsOverlay.svelte';
const TV_ROUTE = 'apps/core/src/routes/tv/+page.svelte';

const overlaySrc = () => stripComments(read(OVERLAY));
const routeSrc = () => stripComments(read(TV_ROUTE));
/** The overlay WITH its comments intact — only the parity guard below reads this. */
const overlayRaw = () => read(OVERLAY);

// Non-vacuity floor: every assertion below is a match against a file's text, so a read that silently
// produced nothing would make the positive tests fail loudly but the NEGATIVE ones pass vacuously.
test('the wiring scan reads two non-empty sources', () => {
	expect(overlaySrc().length).toBeGreaterThan(2000);
	expect(routeSrc().length).toBeGreaterThan(2000);
});

test('the overlay takes a singerColor prop and defaults it to no singer', () => {
	const src = overlaySrc();
	// Declared on the Props interface as nullable — "nobody is up" has to be expressible.
	expect(src).toMatch(/singerColor\?:\s*string\s*\|\s*null\s*;/);
	// …and destructured with a default, so an omitted prop is the accent rather than `undefined`
	// reaching the helper by accident.
	expect(src).toMatch(/singerColor\s*=\s*null/);
});

test('the overlay resolves the highlight colour through the shared helper, not the raw prop', () => {
	const src = overlaySrc();
	// The helper is imported from the shared package…
	expect(src).toMatch(/import\s*\{[^}]*\blyricHighlightColor\b[^}]*\}\s*from\s*['"]\$lib\/contract['"]/);
	// …and the prop goes THROUGH it. This is the line whose revert this assertion exists to catch:
	// interpolating `singerColor` straight into the style attribute would put an unvalidated wire value
	// into CSS, which is the whole reason the helper is a boundary and not a convenience.
	expect(src).toMatch(/\$derived\s*\(\s*lyricHighlightColor\s*\(\s*singerColor\s*\)\s*\)/);
});

test('the resolved colour is appended as --reel-singer, and only when there is one', () => {
	const src = overlaySrc();
	// The custom property is emitted into the SAME inline style string the rest of the type rides, and
	// it is CONDITIONAL: with no legible singer colour nothing is written, so the stylesheet's own
	// default is the single place the accent fallback is named. An unconditional write would put the
	// literal `null` into CSS.
	expect(src).toMatch(/singerHighlight\s*\?\s*`;\s*--reel-singer:\s*\$\{singerHighlight\}`\s*:\s*''/);
	// and that string is what the wrapper actually renders
	expect(src).toMatch(/style=\{typeStyle\}/);
});

test('both highlight treatments read the reel colour chain, and neither names --accent2 any more (layered by the part colour)', () => {
	const src = overlaySrc();
	// The default: the room accent, declared once.
	expect(src).toMatch(/--reel-singer:\s*var\(--accent2\)\s*;/);
	// Both treatments read the reel colour — `--reel-now` is the sung WORD, `--reel-line` the whole
	// current lyric under the `line` room setting. Splitting them would let the two settings disagree
	// about whose colour is showing, so both are asserted. The part-colour layer inserted `--reel-part` between the
	// treatments and `--reel-singer` (part colour layers over singer colour), so the treatments now
	// read `--reel-part` and `--reel-part` falls back to `--reel-singer` — the singer colour still
	// flows through unchanged when no part applies, which is what this test protects.
	expect(src).toMatch(/--reel-part:\s*var\(--reel-singer\)\s*;/);
	expect(src).toMatch(/--reel-now:\s*var\(--reel-part\)\s*;/);
	expect(src).toMatch(/--reel-line:\s*var\(--reel-part\)\s*;/);
	// The retired form is gone: neither highlight property may name the accent directly, which is what
	// reverting either CSS hunk would restore. Scoped to these two declarations rather than banning
	// `--accent2` from the file, because the marker and the underline bar legitimately keep it (the
	// active-word MARKER is a position cue, not the sung-text highlight — deliberately untouched here).
	expect(src).not.toMatch(/--reel-now:\s*var\(--accent2\)/);
	expect(src).not.toMatch(/--reel-line:\s*var\(--accent2\)/);
});

test('the amber provenance override still wins for the line treatment, and still leaves the word alone', () => {
	const src = overlaySrc();
	// `.lyrics.unverified` overrides `--reel-line` (so the `line` treatment shows provenance) but NOT
	// `--reel-now` (position and identity are a different question from trustworthiness). This wiring changed
	// where `--reel-now` gets its colour, and this pins that it did NOT change that precedence: an
	// auto-transcribed song must still carry the singer's colour on the word being sung.
	const unverified = /\.lyrics\.unverified\s*\{([^}]*)\}/.exec(src);
	expect(unverified).not.toBeNull();
	expect(unverified![1]).toMatch(/--reel-line:\s*#ffe6b8\s*;/);
	expect(unverified![1]).not.toMatch(/--reel-now:/);
});

// COMMENT/CODE PARITY for the provenance block. `prove_per_hunk.py` reports a comment-only hunk as
// UNVERIFIED by construction — reverting prose changes no behaviour, so nothing can red — and the two
// hunks this closes are exactly that. They are not cosmetic, though: both retired sentences ASSERT that
// the highlight is pink ("Pink means 'sing this word now' on every song", "leaving it pink"), which is
// the claim this wiring falsified. COMMON.md's own taxonomy counts a comment contradicting its code as a real
// defect, so leaving them would have been the cheaper and worse option.
//
// These two assertions are deliberately narrow. They ban the discredited CLAIM and require the
// corrected paragraphs to name what replaced it — they do not pin wording, so an unrelated reword
// passes. What cannot pass is re-asserting that the sung word is the room accent while the code says it
// is the singer's.
test('the provenance comment no longer claims the highlight is pink (comment/code parity)', () => {
	const raw = overlayRaw();
	// Retired with hunk 7: the active word is the SINGER's colour now, not pink on every song.
	expect(raw).not.toMatch(/Pink means "sing this word now" on every song/);
	// …and the paragraph that replaced it says why `--reel-now` is still left alone here, so this
	// bites on the prose being deleted as well as on it being restored.
	// Anchored on the CLAIM, not on the issue number that used to close the sentence. The number went with
	// every other issue reference in production source; what the guard is actually for is that the source
	// still states `--reel-now` is deliberately left alone, which is the fact a future editor would
	// otherwise "fix" by overriding it.
	expect(raw).toMatch(/`--reel-now` is deliberately NOT overridden/);
	// Retired with hunk 8: the `line` treatment's override is against `--reel-singer` now, not pink.
	expect(raw).not.toMatch(/leaving it pink would mean the `line` treatment/);
	expect(raw).toMatch(/leaving it on `--reel-singer` would mean the `line` treatment/);
});

test('the TV route hands the overlay the current singer — the non-test caller', () => {
	const src = routeSrc();
	// The route already derives the current singer's stored colour for the stage glow and the
	// lower-third dot; this feature's whole wiring is that the reel is given the same value. Reverting this ONE
	// line leaves the feature with zero non-test callers, which is the failure mode this test exists
	// for — a correct component that nothing ever hands a colour to.
	expect(src).toMatch(/singerColor=\{currentSingerColor\}/);
	// and it is on the LyricsOverlay call, not merely somewhere in a ~1400-line route. Anchored by
	// matching from the opening tag to its self-closing `/>` with no intervening `<`, so a stray
	// occurrence in another component's props cannot satisfy this.
	const call = /<LyricsOverlay\b[^<]*?\/>/.exec(src);
	expect(call).not.toBeNull();
	expect(call![0]).toMatch(/singerColor=\{currentSingerColor\}/);
	// The value is the derived roster lookup, not re-derived at the call site.
	expect(src).toMatch(/const\s+currentSingerColor\s*=\s*\$derived\(/);
});
