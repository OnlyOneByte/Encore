// The Your songs row's sub-line: only what is not zero, in guest words.
import { test, expect } from 'bun:test';
import { yourSongLine } from '$lib/your-songs';

const row = (o: Partial<Parameters<typeof yourSongLine>[0]> = {}) =>
	yourSongLine({ keyShift: null, guideLevel: null, sung: 0, saved: null, ...o });

test('a saved song you never sang says so and nothing else', () => {
	expect(row({ saved: { id: 's', savedAt: 1 } })).toBe('saved');
});

test('the key reads in keys up or down, one key singular', () => {
	expect(row({ keyShift: -2, sung: 3 })).toBe('2 keys down · sung 3 times');
	expect(row({ keyShift: 1, sung: 1 })).toBe('1 key up · sung once');
});

test('the guide shows only when it is on, by its preset name', () => {
	expect(row({ guideLevel: 0.3, sung: 1 })).toBe('guide low · sung once');
	expect(row({ guideLevel: 1, sung: 1 })).toBe('guide full · sung once');
	expect(row({ guideLevel: 0, sung: 1 })).toBe('sung once');
	// A level the song page's slider set between presets still says the guide is on.
	expect(row({ guideLevel: 0.6, sung: 1 })).toBe('guide on · sung once');
});
