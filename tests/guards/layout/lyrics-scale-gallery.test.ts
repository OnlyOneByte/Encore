// Guard: the lyrics-scale demo frames in the components gallery must demonstrate the ACTUAL band.
//
// The gallery (routes/components/+page.svelte) renders one card at the scale floor and one at the
// ceiling so a reviewer can see the widened range. When the shared band moves — as it did when the
// scale was rebased (80% became the new neutral 100% and the ceiling was raised) — the demo values
// must move with it, or the gallery quietly shows a value that is no longer even in range.
//
// A SOURCE SCAN because bun test has no Svelte compiler here: it reads the gallery source directly
// and pins the two scalePct demo frames to MIN_/MAX_LYRICS_SCALE_PCT from @encore/shared. It is not
// mutation-blind — reverting the gallery frames back to the old 80/160 reds this against the current
// constants. The band's own values are pinned in @encore/shared (separators.test.ts); this only ties
// the demo to them.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { MIN_LYRICS_SCALE_PCT, MAX_LYRICS_SCALE_PCT } from '@encore/shared';

const src = read('apps/core/src/routes/components/+page.svelte');

test('the gallery scale frames demonstrate the real MIN and MAX of the band', () => {
	// Collect every scalePct the gallery demos.
	const demoed = [...src.matchAll(/scalePct:\s*(\d+)/g)].map((m) => Number(m[1]));
	expect(demoed.length).toBeGreaterThanOrEqual(2);
	// The floor and the ceiling of the band must each be shown, and nothing out of band.
	expect(demoed).toContain(MIN_LYRICS_SCALE_PCT);
	expect(demoed).toContain(MAX_LYRICS_SCALE_PCT);
	for (const v of demoed) {
		expect(v).toBeGreaterThanOrEqual(MIN_LYRICS_SCALE_PCT);
		expect(v).toBeLessThanOrEqual(MAX_LYRICS_SCALE_PCT);
	}
});
