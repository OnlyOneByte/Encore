// Behavioural tests for `lyricHighlightColor` — the boundary between a stored singer colour and the
// CSS custom property the TV lyric reel paints its highlight with.
//
// WHY THIS IS A SEPARATE FILE, and it is a mutation-proof requirement rather than tidiness. These tests
// were first added to `colors.test.ts`, which imports its subjects BY NAME. Under `prove_per_hunk.py`
// that made the production hunk read **WEAK**: reverting `lyricHighlightColor` out of `colors.ts` makes
// the named import unresolvable, so the whole 38-test file fails to LOAD — the suite exits nonzero with
// zero named failures, which is a broken build and not a proof that any assertion bit.
//
// So this file imports the module as a NAMESPACE. With the export removed, `colors.lyricHighlightColor`
// is `undefined`, the call raises inside the test body, and the failure is reported against a NAMED
// test — which is what the standard asks for. Measured both ways; see the proof table in the PR body.
//
// Every expected value below is a hard-coded literal. None is produced by calling `parseHex`/`toHex`/
// `isLegibleSingerColor` and feeding the result back in, which is the failure mode that would let
// these pass against an implementation that returned its input unchanged.
import { test, expect } from 'bun:test';
import * as colors from '$lib/contract';

// `--card`, the binding surface the dot rule tests here — read FROM `colors.SURFACES` rather than
// restated, so it cannot drift from the token `app.css` declares (the same fix made in
// `colors.test.ts`). `SURFACES` is `[--bg, --card]`; the highlight rule binds on the card.
const [, CARD] = colors.SURFACES;

test('lyricHighlightColor returns a legible singer colour, canonicalised', () => {
	// Already canonical — returned as-is.
	expect(colors.lyricHighlightColor('#7c5cff')).toBe('#7c5cff');
	// UPPERCASE and 3-digit shorthand both come back as canonical 6-digit lowercase. This half is
	// load-bearing rather than cosmetic: a 3-digit hex reaching CSS is what silently dropped the phone
	// avatar halo once already, so `#0af` must NOT be passed through unchanged even though it is by
	// itself valid CSS.
	expect(colors.lyricHighlightColor('#7C5CFF')).toBe('#7c5cff');
	expect(colors.lyricHighlightColor('#0af')).toBe('#00aaff');
	// Presets a real singer can hold survive the gate — including the two the gallery collision cards use.
	expect(colors.lyricHighlightColor('#ff5cae')).toBe('#ff5cae');
	expect(colors.lyricHighlightColor('#5cffd6')).toBe('#5cffd6');
});

test('lyricHighlightColor returns null for an absent singer, so the reel keeps the room accent', () => {
	// The three ways "nobody is up" reaches the component: no prop at all, an explicit null from the
	// route's roster lookup, and an empty stored string.
	expect(colors.lyricHighlightColor(null)).toBeNull();
	expect(colors.lyricHighlightColor(undefined)).toBeNull();
	expect(colors.lyricHighlightColor('')).toBeNull();
});

test('lyricHighlightColor returns null rather than a preset — it is NOT normalizeSingerColor', () => {
	// THE DISCRIMINATOR between the two functions, and the reason this one exists at all. The sibling
	// coerces unusable input to SINGER_COLORS[0] because a colour being STORED must always be something;
	// doing that here would paint the sung words violet for a guest who is not violet. Asserting the
	// sibling's actual value on the same inputs is what makes this bite — an implementation that
	// delegated to `normalizeSingerColor` reds both pairs.
	expect(colors.normalizeSingerColor('#000000')).toBe('#7c5cff');
	expect(colors.lyricHighlightColor('#000000')).toBeNull();
	expect(colors.normalizeSingerColor('not a colour')).toBe('#7c5cff');
	expect(colors.lyricHighlightColor('not a colour')).toBeNull();
});

test('lyricHighlightColor rejects the forms that would break CSS interpolation', () => {
	// The same set `parseHex` refuses. Any of these reaching a `--reel-singer:` declaration produces an
	// invalid custom property, and the highlight then renders as nothing at all rather than falling back
	// to the accent — a silent loss, which is why the rejection happens here and not in the stylesheet.
	expect(colors.lyricHighlightColor('rgb(124,92,255)')).toBeNull();
	expect(colors.lyricHighlightColor('oklch(0.7 0.16 280)')).toBeNull();
	expect(colors.lyricHighlightColor('rebeccapurple')).toBeNull();
	expect(colors.lyricHighlightColor('#7c5cff30')).toBeNull(); // 8-digit alpha-concat artefact
	expect(colors.lyricHighlightColor('var(--accent2)')).toBeNull();
});

test('lyricHighlightColor applies the 3:1 identity floor at its exact boundary', () => {
	// The three bracketing greys the dot rule is pinned with in colors.test.ts, with their ratios
	// restated here as literals so this test does not depend on that file still containing them.
	// Reusing that boundary is the point: it proves the gate IS `isLegibleSingerColor` and not a looser
	// check invented for this path — a 2:1 rule would wrongly return a colour for the first two, and no
	// gate at all would return one for all three.
	expect(colors.contrastRatio('#5c5c66', CARD)).toBeCloseTo(2.6, 1); // mid-band, fails both surfaces
	expect(colors.lyricHighlightColor('#5c5c66')).toBeNull();
	expect(colors.contrastRatio('#65656f', CARD)).toBeCloseTo(2.98, 2); // clears --bg, fails --card
	expect(colors.lyricHighlightColor('#65656f')).toBeNull();
	expect(colors.contrastRatio('#666670', CARD)).toBeCloseTo(3.03, 2); // nearest legible colour
	expect(colors.lyricHighlightColor('#666670')).toBe('#666670');
});

test('every colour the wheel and the presets can produce is accepted, so no real singer loses their colour', () => {
	// The feature is worth nothing if the guard rejects colours guests actually hold. Both sources are
	// checked: the eight presets every existing row carries, and all 24 wheel stops.
	for (const c of colors.SINGER_COLORS) {
		expect(colors.lyricHighlightColor(c)).toBe(c);
	}
	const wheel = colors.SINGER_HUES.map((h) => colors.hueToHex(h));
	expect(wheel.length).toBe(24);
	const refused = wheel.filter((c) => colors.lyricHighlightColor(c) === null);
	expect(refused).toEqual([]);
});
