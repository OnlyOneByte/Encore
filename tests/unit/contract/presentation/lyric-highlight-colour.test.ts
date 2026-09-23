// `lyricHighlightColor` — the boundary between a stored singer colour and the CSS custom property the TV
// lyric reel paints its highlight with.
//
// IMPORTED AS A NAMESPACE, not by name, and that is a mutation-proof requirement: with a named import, a
// removed export makes the module unresolvable and the whole file fails to LOAD, so the suite exits nonzero
// with zero named failures — a broken build, not a proof that an assertion bit. As a namespace,
// `colors.lyricHighlightColor` is `undefined`, the call raises inside the test body, and the failure is
// reported against a NAMED test.
//
// Every expected value is a hard-coded literal, never produced by calling `parseHex`/`toHex`/
// `isLegibleSingerColor` and feeding the result back in — which is what would let these pass against an
// implementation that returned its input unchanged.
import { test, expect } from 'bun:test';
import * as colors from '$lib/contract';

// `--card`, the binding surface — read FROM `colors.SURFACES` rather than restated, so it cannot drift from
// the token `app.css` declares. `SURFACES` is `[--bg, --card]`, and the highlight rule binds on the card.
const [, CARD] = colors.SURFACES;

test('lyricHighlightColor returns a legible singer colour, canonicalised', () => {
	expect(colors.lyricHighlightColor('#7c5cff')).toBe('#7c5cff');
	// UPPERCASE and 3-digit shorthand both come back canonical 6-digit lowercase. Load-bearing, not
	// cosmetic: a 3-digit hex reaching CSS silently dropped the phone avatar halo once, so `#0af` must NOT
	// pass through unchanged even though it is valid CSS by itself.
	expect(colors.lyricHighlightColor('#7C5CFF')).toBe('#7c5cff');
	expect(colors.lyricHighlightColor('#0af')).toBe('#00aaff');
	// Presets a real singer can hold survive the gate.
	expect(colors.lyricHighlightColor('#ff5cae')).toBe('#ff5cae');
	expect(colors.lyricHighlightColor('#5cffd6')).toBe('#5cffd6');
});

test('lyricHighlightColor returns null for an absent singer, so the reel keeps the room accent', () => {
	// The three ways "nobody is up" reaches the component: no prop, an explicit null, an empty string.
	expect(colors.lyricHighlightColor(null)).toBeNull();
	expect(colors.lyricHighlightColor(undefined)).toBeNull();
	expect(colors.lyricHighlightColor('')).toBeNull();
});

test('lyricHighlightColor returns null rather than a preset — it is NOT normalizeSingerColor', () => {
	// THE DISCRIMINATOR between the two functions. The sibling coerces unusable input to SINGER_COLORS[0],
	// because a STORED colour must always be something; doing that here paints the sung words violet for a
	// guest who is not violet. Asserting the sibling's value on the same inputs is what makes this bite: an
	// implementation that delegated to `normalizeSingerColor` reds both pairs.
	expect(colors.normalizeSingerColor('#000000')).toBe('#7c5cff');
	expect(colors.lyricHighlightColor('#000000')).toBeNull();
	expect(colors.normalizeSingerColor('not a colour')).toBe('#7c5cff');
	expect(colors.lyricHighlightColor('not a colour')).toBeNull();
});

test('lyricHighlightColor rejects the forms that would break CSS interpolation', () => {
	// The same set `parseHex` refuses. Any of these reaching a `--reel-singer:` declaration is an invalid
	// custom property, and the highlight then renders as NOTHING rather than falling back to the accent —
	// which is why the rejection happens here and not in the stylesheet.
	expect(colors.lyricHighlightColor('rgb(124,92,255)')).toBeNull();
	expect(colors.lyricHighlightColor('oklch(0.7 0.16 280)')).toBeNull();
	expect(colors.lyricHighlightColor('rebeccapurple')).toBeNull();
	expect(colors.lyricHighlightColor('#7c5cff30')).toBeNull(); // 8-digit alpha-concat artefact
	expect(colors.lyricHighlightColor('var(--accent2)')).toBeNull();
});

test('lyricHighlightColor applies the 3:1 identity floor at its exact boundary', () => {
	// The three bracketing greys the dot rule is pinned with, ratios restated as literals so this does not
	// depend on the sibling file. Reusing that boundary is what proves the gate IS `isLegibleSingerColor`:
	// a 2:1 rule returns a colour for the first two, and no gate at all returns one for all three.
	expect(colors.contrastRatio('#5c5c66', CARD)).toBeCloseTo(2.6, 1); // mid-band, fails both surfaces
	expect(colors.lyricHighlightColor('#5c5c66')).toBeNull();
	expect(colors.contrastRatio('#65656f', CARD)).toBeCloseTo(2.98, 2); // clears --bg, fails --card
	expect(colors.lyricHighlightColor('#65656f')).toBeNull();
	expect(colors.contrastRatio('#666670', CARD)).toBeCloseTo(3.03, 2); // nearest legible colour
	expect(colors.lyricHighlightColor('#666670')).toBe('#666670');
});

test('every colour the wheel and the presets can produce is accepted, so no real singer loses their colour', () => {
	// Worth nothing if the guard rejects colours guests actually hold: the eight presets and all 24 stops.
	for (const c of colors.SINGER_COLORS) {
		expect(colors.lyricHighlightColor(c)).toBe(c);
	}
	const wheel = colors.SINGER_HUES.map((h) => colors.hueToHex(h));
	expect(wheel.length).toBe(24);
	const refused = wheel.filter((c) => colors.lyricHighlightColor(c) === null);
	expect(refused).toEqual([]);
});
