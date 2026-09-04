import { test, expect } from 'bun:test';
import { stageBackgroundCss } from './background';
import { TV_BACKGROUND_STYLES, stageHueToHex, SINGER_COLORS, nearestSingerHue } from '@encore/shared';

test('every registered style resolves to a non-empty CSS value', () => {
	// The registry and this resolver must not drift: a style with no branch would return undefined and
	// paint nothing, which on the TV looks like a broken build rather than a missing case.
	for (const s of TV_BACKGROUND_STYLES) {
		const css = stageBackgroundCss(s.id, 240, '#ff5cae');
		expect(typeof css).toBe('string');
		expect(css.length).toBeGreaterThan(0);
	}
});

test('off is plain black — the default must reproduce today TV exactly', () => {
	expect(stageBackgroundCss('off', 240, '#ff5cae')).toBe('#000');
	// and nothing else may accidentally equal it, or the option would be indistinguishable
	expect(stageBackgroundCss('gradient', 240, null)).not.toBe('#000');
	expect(stageBackgroundCss('solid', 240, null)).not.toBe('#000');
});

test('gradient is the room glow, expressed in the existing tokens', () => {
	const css = stageBackgroundCss('gradient', 0, null);
	// tokens, not literals: a hardcoded hex here would stop tracking a theme change to --stage-glow
	expect(css).toContain('var(--stage-glow)');
	expect(css).toContain('var(--bg)');
	expect(css).toContain('radial-gradient');
});

test('solid renders the room hue at the pinned stage tier', () => {
	for (const hue of [0, 75, 165, 240, 345]) {
		expect(stageBackgroundCss('solid', hue, null)).toBe(stageHueToHex(hue));
	}
});

test('solid ignores the singer, and singer ignores the room hue', () => {
	// the two colour-bearing styles must not bleed into each other
	expect(stageBackgroundCss('solid', 165, '#ff5cae')).toBe(stageHueToHex(165));
	const a = stageBackgroundCss('singer', 165, '#5cb8ff');
	const b = stageBackgroundCss('singer', 0, '#5cb8ff');
	expect(a).toBe(b);
});

test('singer follows the singer colour through the stage tier', () => {
	for (const dot of SINGER_COLORS) {
		const css = stageBackgroundCss('singer', 240, dot);
		expect(css).toContain(stageHueToHex(nearestSingerHue(dot)));
	}
});

test('singer degrades to the room glow when nobody is up yet', () => {
	// a missing singer is a missing FACT (roster not arrived, nobody on stage). Blinking to black while
	// waiting for it would read as a fault, so it falls back to the glow instead.
	const glow = stageBackgroundCss('gradient', 0, null);
	expect(stageBackgroundCss('singer', 240, null)).toBe(glow);
	expect(stageBackgroundCss('singer', 240, undefined)).toBe(glow);
	expect(stageBackgroundCss('singer', 240, '')).toBe(glow);
});

test('an unparseable singer colour still yields a usable stage', () => {
	// singers.color is text NOT NULL and has held non-wheel values historically, so this cannot throw
	for (const junk of ['rebeccapurple', 'rgb(1,2,3)', '#7c5cff30', 'not a colour']) {
		const css = stageBackgroundCss('singer', 240, junk);
		expect(typeof css).toBe('string');
		expect(css.length).toBeGreaterThan(0);
	}
});

test('visualizer resolves to the stage floor, not to a colour', () => {
	// The canvas paints itself; this value is only what shows beneath it before the first frame. Black
	// rather than `transparent` on purpose — a transparent layer would reveal whatever is under the stage.
	expect(stageBackgroundCss('visualizer', 240, '#ff5cae')).toBe('#000');
});

test('adding the visualizer style left the four colour styles untouched', () => {
	// Guards against a regression in the same switch: the new case must not have changed its neighbours.
	expect(stageBackgroundCss('off', 240, null)).toBe('#000');
	expect(stageBackgroundCss('solid', 240, null)).toBe(stageHueToHex(240));
	expect(stageBackgroundCss('gradient', 240, null)).toContain('var(--stage-glow)');
	expect(stageBackgroundCss('singer', 240, '#5cb8ff')).toContain(stageHueToHex(nearestSingerHue('#5cb8ff')));
});
