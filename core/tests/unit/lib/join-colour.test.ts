import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';
import { PALETTE_STOPS, SINGER_COLORS, nearestPaletteStop } from '$lib/contract';
import { defaultJoinColor } from '$lib/join-colour';

/*
 * guard: a guest who skips the colour ring does not get the colour someone already holds. A fixed default made
 * three default joins three identical dots on the TV roster ("● Maya ● Theo ● Ana", one purple).
 */

const preset = (i: number) => nearestPaletteStop(SINGER_COLORS[i]!).fill;

test('an empty room gets the first preset, as before', () => {
	expect(defaultJoinColor([])).toBe(preset(0));
});

test('each default join takes the next free preset, so three skips are three colours', () => {
	const taken: string[] = [];
	for (let k = 0; k < 3; k++) taken.push(defaultJoinColor(taken));
	expect(taken).toEqual([preset(0), preset(1), preset(2)]);
});

test('taken is compared by ring STOP, so a raw preset in the room still counts as held', () => {
	expect(defaultJoinColor([SINGER_COLORS[0]])).toBe(preset(1));
});

test('past the presets it takes any free stop, and a full ring falls back to the first preset', () => {
	const allPresets = SINGER_COLORS.map((_, i) => preset(i));
	const next = defaultJoinColor(allPresets);
	expect(allPresets).not.toContain(next);
	expect(PALETTE_STOPS.map((s) => s.fill)).toContain(next);
	expect(defaultJoinColor(PALETTE_STOPS.map((s) => s.fill))).toBe(preset(0));
});

test('the landing seeds from the preview, and only over its own untouched seed', () => {
	const landing = readFileSync(at('src/lib/components/JoinLanding.svelte'), 'utf8');
	expect(landing).toContain('if (color === seededColor) color = seededColor = defaultJoinColor(preview.colors ?? []);');
});
