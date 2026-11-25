import { expect, it } from 'bun:test';
import { screenTag } from '$lib/screens';

it('screenTag says which screen has the sound, and how far a copy runs from it', () => {
	expect(screenTag({ isTv: true, driftMs: null })).toBe('The TV · sound');
	expect(screenTag({ isTv: false, driftMs: null })).toBe('Quiet');
	expect(screenTag({ isTv: false, driftMs: -12.4 })).toBe('Quiet · 12 ms behind');
	expect(screenTag({ isTv: false, driftMs: 30 })).toBe('Quiet · 30 ms ahead');
	expect(screenTag({ isTv: false, driftMs: 0.2 })).toBe('Quiet · in step');
});
