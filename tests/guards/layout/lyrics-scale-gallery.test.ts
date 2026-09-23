// guard: the lyrics-scale demo frames in the components gallery demonstrate the ACTUAL band.
//
// The gallery renders one card at the scale floor and one at the ceiling so a reviewer can see the range.
// When the shared band moves — as it did when the scale was rebased — the demo values must move with it, or
// the gallery quietly shows a value no longer in range. The band's own values are pinned where they are
// declared; this only ties the demo to them.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { MIN_LYRICS_SCALE_PCT, MAX_LYRICS_SCALE_PCT } from '$lib/contract';

const src = read('src/routes/components/+page.svelte');

test('the gallery scale frames demonstrate the real MIN and MAX of the band', () => {
	const demoed = [...src.matchAll(/scalePct:\s*(\d+)/g)].map((m) => Number(m[1]));
	expect(demoed.length).toBeGreaterThanOrEqual(2);
	// Both ends of the band must be shown, and nothing out of it.
	expect(demoed).toContain(MIN_LYRICS_SCALE_PCT);
	expect(demoed).toContain(MAX_LYRICS_SCALE_PCT);
	for (const v of demoed) {
		expect(v).toBeGreaterThanOrEqual(MIN_LYRICS_SCALE_PCT);
		expect(v).toBeLessThanOrEqual(MAX_LYRICS_SCALE_PCT);
	}
});
