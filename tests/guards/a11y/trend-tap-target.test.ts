// guard: /stats' trend makes every day a real <button>, so a phone can read that day's count — and a day
// whose only reader is a tap must be tappable. The window is a literal 31 days, so at a phone's width
// `.col { flex: 1 1 0; min-width: 3px }` sized each day ~9px: 0 of 31 reaching the standard, with five
// distinct days under one fingertip. See docs/GUARDS.md#touch-targets.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { TAP, TAP_FLOOR, stripComments } from '@encore/test-support/scan';

const TREND = read('src/lib/charts/Trend.svelte');
const CSS = read('src/app.css');
// The containment claim moved to ui/card with the rule; the tap-target arms read Trend.svelte directly.
const CARD_COMPONENT = 'src/lib/components/ui/card/card.svelte';

/** Body of one scoped-CSS rule by class name; a crude split is enough for hand-written CSS. */
function ruleBody(src: string, cls: string): string {
	const m = stripComments(src, { markup: true, keepLine: true }).match(new RegExp(`\\.${cls}\\s*\\{([^{}]*)\\}`, 's'));
	if (!m) throw new Error(`no .${cls} rule found in the source given`);
	return m[1]!;
}

test('--tap still holds the tap standard this guard leans on', () => {
	// `TAP` is PARSED from app.css, so asserting `--tap: ${TAP}px` compares the value to itself. The real
	// question is whether the token still holds the committed floor: lowering it would let a column
	// expressed in the token — which is what `.col` does — drop under the reliable-tap threshold.
	expect(CSS).toMatch(/--tap:\s*[0-9.]+px\s*;/);
	expect(TAP).toBeGreaterThanOrEqual(TAP_FLOOR);
});

test('each trend day-button claims a >=44px tap target, not a 3px sliver', () => {
	const col = ruleBody(TREND, 'col');

	// var(--tap) or a literal >= 44px, never the 3px sliver.
	const varTap = /min-width:\s*var\(--tap\)/.test(col);
	const litPx = [...col.matchAll(/min-width:\s*([0-9.]+)px/g)].map((x) => Number(x[1]!));
	const litOk = litPx.some((w) => w >= TAP);
	expect(varTap || litOk).toBe(true);

	// …and no min-width below the standard survives on the button.
	const tooNarrow = litPx.filter((w) => w > 0 && w < TAP);
	expect(tooNarrow).toEqual([]);

	// A grow-only basis is what lets 44px columns hold their size instead of being squeezed by the row: a
	// shrinkable one defeats the min-width on a tight phone row.
	expect(/flex:\s*1\s+1\s+0\b/.test(col)).toBe(false);
});

test('the chart scrolls horizontally so 31 full-size days overflow rather than shrink', () => {
	const chart = ruleBody(TREND, 'chart');
	// With every day at >=44px, 31 columns exceed a phone's width by design, so the row must scroll instead
	// of compressing the days back below the floor.
	expect(/overflow-x:\s*(?:auto|scroll)/.test(chart)).toBe(true);
});

test('the /stats card lets the chart scroll instead of overflowing the page', () => {
	// The chart lives in a `.card` that is a grid item, and a grid item defaults to `min-width: auto`
	// (= min-content) — so without `min-width: 0` the row of 44px buttons sizes the card to its full 1424px
	// scroll width and overflows the document horizontally, turning the tap-target fix into a layout
	// regression. Measured: document overflow 21px -> 0, chart scrollable.
	const card = ruleBody(read(CARD_COMPONENT), 'encore-card');
	expect(/min-width:\s*0\b/.test(card)).toBe(true);
});
