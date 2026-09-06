// guard: the public /stats trend makes every day a real <button> so a phone can read that day's count
// (Trend.svelte:60-61, :96-97 explain why). The window is a literal 31 days, so at a phone's width the
// old `.col { flex: 1 1 0; min-width: 3px }` sized each day ~9px wide — 0 of 31 reaching the 44px tap
// standard, with five distinct days under a single fingertip (#144). A day whose only reader is a tap
// must be tappable.
//
// This is a source-scan guard, matching the repo's other geometry guards (touch-targets.test.ts,
// design-system.test.ts): it pins the CSS rules that PRODUCE the target size. The rendered numeric
// proof (measured column width / days-under-thumb) lives in the PR body via CDP.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', '..'); // src/
const TREND = readFileSync(join(SRC, 'lib', 'charts', 'Trend.svelte'), 'utf8');
const CSS = readFileSync(join(SRC, 'app.css'), 'utf8');
const STATS = readFileSync(join(SRC, 'routes', 'stats', '+page.svelte'), 'utf8');
const TAP = 44;

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

/** Body of a single scoped-CSS rule matched by class name (crude split is enough for hand-written CSS). */
function ruleBody(src: string, cls: string): string {
	const m = stripComments(src).match(new RegExp(`\\.${cls}\\s*\\{([^{}]*)\\}`, 's'));
	if (!m) throw new Error(`no .${cls} rule found in Trend.svelte`);
	return m[1]!;
}

test('--tap is still the 44px standard this guard leans on', () => {
	// If --tap ever drifts below 44, accepting a column expressed in it would silently lower the bar.
	expect(CSS).toMatch(new RegExp(`--tap:\\s*${TAP}px\\s*;`));
});

test('each trend day-button claims a >=44px tap target, not a 3px sliver', () => {
	const col = ruleBody(TREND, 'col');

	// The width floor must be var(--tap) or a literal >= 44px — never the old 3px sliver.
	const varTap = /min-width:\s*var\(--tap\)/.test(col);
	const litPx = [...col.matchAll(/min-width:\s*([0-9.]+)px/g)].map((x) => Number(x[1]!));
	const litOk = litPx.some((w) => w >= TAP);
	expect(varTap || litOk).toBe(true);

	// And no min-width below the standard survives on the button.
	const tooNarrow = litPx.filter((w) => w > 0 && w < TAP);
	expect(tooNarrow).toEqual([]);

	// A grow-only flex basis (`flex: 1 0 ...`) is what lets 44px columns hold their size instead of
	// being squeezed by the row; a shrinkable basis would defeat the min-width on a tight phone row.
	// Accept either an explicit flex-shrink:0-style basis or the min-width floor above; require flex
	// to NOT be the old fully-shrinkable `1 1 0`.
	expect(/flex:\s*1\s+1\s+0\b/.test(col)).toBe(false);
});

test('the chart scrolls horizontally so 31 full-size days overflow rather than shrink', () => {
	const chart = ruleBody(TREND, 'chart');
	// With every day at >=44px, 31 columns exceed a phone's width by design; the row must be able to
	// scroll instead of compressing the days back below the tap floor.
	expect(/overflow-x:\s*(?:auto|scroll)/.test(chart)).toBe(true);
});

test('the /stats card lets the chart scroll instead of overflowing the page', () => {
	// The chart lives in a .card that is a grid item of .stats. A grid item defaults to
	// min-width:auto (= min-content), so without min-width:0 the row of 44px day buttons sizes the
	// card to its full 1424px scroll width and overflows the document horizontally — turning the
	// tap-target fix into a layout regression. Pin the containment that makes overflow-x actually
	// scroll (measured: docOver 21px -> 0, chart scrollable true, in the PR body).
	const card = ruleBody(STATS, 'card');
	expect(/min-width:\s*0\b/.test(card)).toBe(true);
});
