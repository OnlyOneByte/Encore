import { test, expect } from 'bun:test';
import { stageBackgroundCss } from '$lib/tv/background';
import {
	TV_BACKGROUND_STYLES,
	stageHueToHex,
	SINGER_COLORS,
	nearestSingerHue,
	hueOfColor,
	SINGER_HUES,
	DEFAULT_STAGE_COLOR,
	dimTowardBlack
} from '$lib/contract';

test('every registered style resolves to a non-empty CSS value', () => {
	// A style with no branch returns undefined and paints nothing, which on the TV reads as a broken build
	// rather than a missing case.
	for (const s of TV_BACKGROUND_STYLES) {
		const css = stageBackgroundCss(s.id, DEFAULT_STAGE_COLOR, '#ff5cae');
		expect(typeof css).toBe('string');
		expect(css.length).toBeGreaterThan(0);
	}
});

test('off is plain black — the default must reproduce today TV exactly', () => {
	expect(stageBackgroundCss('off', DEFAULT_STAGE_COLOR, '#ff5cae')).toBe('#000');
	// Nothing else may equal it, or the option is indistinguishable.
	expect(stageBackgroundCss('gradient', DEFAULT_STAGE_COLOR, null)).not.toBe('#000');
	expect(stageBackgroundCss('solid', DEFAULT_STAGE_COLOR, null)).not.toBe('#000');
});

test('gradient is the room glow, expressed in the existing tokens', () => {
	const css = stageBackgroundCss('gradient', DEFAULT_STAGE_COLOR, null);
	// Tokens, not literals: a hardcoded hex stops tracking a theme change to --stage-glow.
	expect(css).toContain('var(--stage-glow)');
	expect(css).toContain('var(--bg)');
	expect(css).toContain('radial-gradient');
});

// The stored colour must reach the CSS UNTOUCHED. The old legibility pin ran `solid` through
// `stageHueToHex` so the stage tier decided brightness and no room could wash out the reel; the reel now
// defends itself with its own stroked outline, so that bound is retired and the assertion is inverted.
test('solid renders the room colour VERBATIM — no tier, no guard', () => {
	for (const colour of ['#000000', '#001d31', '#7c5cff', '#ff5cae', '#ffffff']) {
		expect(stageBackgroundCss('solid', colour, null)).toBe(colour);
	}
});

test('solid can reach a colour the retired stage tier could not produce', () => {
	// White is reachable, and the retired pin provably could not emit it: every hue at STAGE_BG_L (0.22) is
	// far darker than white, so reinstating the tier on this path reds here.
	expect(stageBackgroundCss('solid', '#ffffff', null)).toBe('#ffffff');
	for (let hue = 0; hue < 360; hue += 15) expect(stageHueToHex(hue)).not.toBe('#ffffff');
});

test('solid ignores the singer, and singer ignores the room colour', () => {
	// The two colour-bearing styles must not bleed into each other.
	expect(stageBackgroundCss('solid', '#123456', '#ff5cae')).toBe('#123456');
	const a = stageBackgroundCss('singer', '#123456', '#5cb8ff');
	const b = stageBackgroundCss('singer', '#654321', '#5cb8ff');
	expect(a).toBe(b);
});

// The `singer` glow KEEPS the stage tier deliberately: a room picks its own solid colour and is looking at
// the result, but nobody picks the singer glow — its hue comes from somebody else's identity dot, so a
// bright field would arrive unasked.
test('singer follows the singer colour through the stage tier — the tier survives here', () => {
	for (const dot of SINGER_COLORS) {
		const css = stageBackgroundCss('singer', DEFAULT_STAGE_COLOR, dot);
		expect(css).toContain(stageHueToHex(nearestSingerHue(dot)));
	}
});

test('singer degrades to the room glow when nobody is up yet', () => {
	// A missing singer is a missing FACT (roster not arrived, nobody on stage), and blinking to black while
	// waiting reads as a fault, so it falls back to the glow.
	const glow = stageBackgroundCss('gradient', DEFAULT_STAGE_COLOR, null);
	expect(stageBackgroundCss('singer', DEFAULT_STAGE_COLOR, null)).toBe(glow);
	expect(stageBackgroundCss('singer', DEFAULT_STAGE_COLOR, undefined)).toBe(glow);
	expect(stageBackgroundCss('singer', DEFAULT_STAGE_COLOR, '')).toBe(glow);
});

test('an unparseable singer colour still yields a usable stage', () => {
	// singers.color is text NOT NULL and has held non-wheel values, so this must not throw.
	for (const junk of ['rebeccapurple', 'rgb(1,2,3)', '#7c5cff30', 'not a colour']) {
		const css = stageBackgroundCss('singer', DEFAULT_STAGE_COLOR, junk);
		expect(typeof css).toBe('string');
		expect(css.length).toBeGreaterThan(0);
	}
});

test('visualizer resolves to the stage floor, not to a colour', () => {
	// Only what shows beneath the canvas before its first frame. Black rather than `transparent`: a
	// transparent layer reveals whatever is under the stage.
	expect(stageBackgroundCss('visualizer', DEFAULT_STAGE_COLOR, '#ff5cae')).toBe('#000');
});

// The CONTRACT `tv/+page.svelte` wires together, asserted headlessly because those lines live in a `.svelte` file this
// lane cannot render: the visualizer is fed `hueOfColor(color)` and that angle must recover the hue the stored colour was
// generated from, or a room's visualizer palette rotates off its chosen colour; the solid stage is fed the colour
// verbatim. Which is why the derive is `hueOfColor` and not `nearestSingerHue`.
test('the visualizer angle recovers the stored stage colour hue; the solid stage is verbatim (tv/+page wiring)', () => {
	for (const h of SINGER_HUES) {
		const stored = stageHueToHex(h); // what a room that picked hue h now stores as a colour
		// What the component derives and hands to VisualizerStage.
		const angleFedToVisualizer = hueOfColor(stored);
		// It must land back on the hue the colour was built from, within one wheel step, which is what keeps
		// the visualizer palette centred on the room's colour. `nearestSingerHue` fails this for most stops.
		const gap = Math.min(
			Math.abs(((angleFedToVisualizer - h + 540) % 360) - 180),
			360 - Math.abs(((angleFedToVisualizer - h + 540) % 360) - 180)
		);
		expect(gap).toBeLessThan(SINGER_HUES[1]!); // < one wheel step (15°)
		// The solid stage is passed the colour, not the angle.
		expect(stageBackgroundCss('solid', stored, null)).toBe(stored);
	}
});

test('adding the visualizer style left the four colour styles untouched', () => {
	// The new case must not have changed its neighbours in the same switch.
	expect(stageBackgroundCss('off', DEFAULT_STAGE_COLOR, null)).toBe('#000');
	expect(stageBackgroundCss('solid', DEFAULT_STAGE_COLOR, null)).toBe(DEFAULT_STAGE_COLOR);
	expect(stageBackgroundCss('gradient', DEFAULT_STAGE_COLOR, null)).toContain('var(--stage-glow)');
	expect(stageBackgroundCss('singer', DEFAULT_STAGE_COLOR, '#5cb8ff')).toContain(
		stageHueToHex(nearestSingerHue('#5cb8ff'))
	);
});

// The stage dim.

test('an omitted dim defaults to 0 — every style renders exactly as before', () => {
	// The fourth arg is optional and defaults to 0, so every three-arg call site keeps its result.
	for (const s of TV_BACKGROUND_STYLES) {
		expect(stageBackgroundCss(s.id, DEFAULT_STAGE_COLOR, '#ff5cae')).toBe(
			stageBackgroundCss(s.id, DEFAULT_STAGE_COLOR, '#ff5cae', 0)
		);
	}
});

test('dim darkens the solid room colour toward black', () => {
	// solid is the room's own colour, and the dim is a lightness control on it.
	expect(stageBackgroundCss('solid', '#ffffff', null, 0)).toBe('#ffffff');
	expect(stageBackgroundCss('solid', '#ffffff', null, 0.5)).toBe(dimTowardBlack('#ffffff', 0.5));
	expect(stageBackgroundCss('solid', '#ffffff', null, 1)).toBe('#000000');
	expect(stageBackgroundCss('solid', '#336699', null, 0.6)).toBe(dimTowardBlack('#336699', 0.6));
});

test('dim darkens the singer glow inner colour but keeps the geometry and the outer token', () => {
	const dot = '#5cb8ff';
	const undimmed = stageBackgroundCss('singer', DEFAULT_STAGE_COLOR, dot, 0);
	const dimmed = stageBackgroundCss('singer', DEFAULT_STAGE_COLOR, dot, 0.5);
	expect(dimmed).toContain('radial-gradient(80% 60% at 50% 30%');
	expect(dimmed).toContain('var(--bg) 70%');
	const hue = nearestSingerHue(dot);
	expect(undimmed).toContain(stageHueToHex(hue));
	expect(dimmed).toContain(dimTowardBlack(stageHueToHex(hue), 0.5));
	expect(dimmed).not.toBe(undimmed);
});

test('dim is a no-op on the styles that resolve to no chosen colour', () => {
	// off and visualizer are already the black floor, and dimming black is still black.
	expect(stageBackgroundCss('off', DEFAULT_STAGE_COLOR, null, 1)).toBe('#000');
	expect(stageBackgroundCss('visualizer', DEFAULT_STAGE_COLOR, '#ff5cae', 1)).toBe('#000');
	// gradient is the room glow in CSS-variable tokens a pure function cannot darken.
	expect(stageBackgroundCss('gradient', DEFAULT_STAGE_COLOR, null, 0.7)).toBe(
		stageBackgroundCss('gradient', DEFAULT_STAGE_COLOR, null, 0)
	);
	// The singer FALLBACK is that same glow, so dim leaves it untouched too.
	expect(stageBackgroundCss('singer', DEFAULT_STAGE_COLOR, null, 0.7)).toBe(
		stageBackgroundCss('gradient', DEFAULT_STAGE_COLOR, null, 0)
	);
});

test('dim 1 collapses the solid stage to the same black as off', () => {
	// Dim is "toward black", so full dim on solid must actually REACH black — indistinguishable from off
	// on the pixel, which is the honest end of the range.
	expect(stageBackgroundCss('solid', '#7c5cff', null, 1)).toBe('#000000');
});
