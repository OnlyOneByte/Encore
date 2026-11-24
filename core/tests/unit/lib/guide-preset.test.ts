import { expect, test } from 'bun:test';
import { GUIDE_PRESETS, guidePresetOf } from '$lib/guide-preset';

test('Off, Low and Full are the three presets, in that order', () => {
	expect(GUIDE_PRESETS.map((p) => p.label)).toEqual(['Off', 'Low', 'Full']);
	expect(GUIDE_PRESETS.map((p) => p.level)).toEqual([0, 0.3, 1]);
});

test('a level is a preset only when it is exactly one', () => {
	expect(guidePresetOf(0)).toBe('off');
	expect(guidePresetOf(0.3)).toBe('low');
	expect(guidePresetOf(0.301)).toBe('low'); // rounded to whole percent, like the slider
	expect(guidePresetOf(1)).toBe('full');
	expect(guidePresetOf(1.4)).toBe('full'); // clamped
	// A slider level between them claims no segment, rather than the nearest one.
	expect(guidePresetOf(0.6)).toBeNull();
	expect(guidePresetOf(null)).toBeNull();
	expect(guidePresetOf(Number.NaN)).toBeNull();
});
