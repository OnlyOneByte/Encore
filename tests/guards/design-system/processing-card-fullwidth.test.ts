// Guard: the ProcessingCard progress block (bar + stage line) must occupy the
// card's FULL inner width, independent of whether the action cluster
// (remove / reorder) renders. Before the fix the bar and chips lived INSIDE .meta, which shared a
// single flex row with .actions, so a viewer's OWN processing song (which shows up to three 44px
// buttons = ~148px) got a 134px bar while a stranger's action-less card kept a 294px bar —
// different geometry for the same component in the same list. (The per-stage chip strip this guard
// also once covered has since been removed; the bar's width-invariance is what this guard pins.)
//
// The fix lifts the progress block onto its own full-width grid row. This guard pins the two
// structural facts that make the bar's width invariant to the actions column, and reds if either
// is reverted:
//   1. the .bar / .stage markup is NOT nested inside .meta (the row that carries .actions);
//   2. the card is a grid and the .progress block spans every column (grid-column: 1 / -1).
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

// A SIBLING READ, re-anchored explicitly. This was `at('src/lib/components/ProcessingCard.svelte')` —
// "the component next to me" — which no longer names anything once the test leaves lib/components/.
// The subject is that directory's ProcessingCard, and `read` throws if it is missing, so a wrong path
// is a loud PATH failure rather than a guard that silently examines an empty string.
const SRC = read('src/lib/components/ProcessingCard.svelte');

// Strip HTML/JS/CSS comments so a comment mentioning `class="bar"` or the old layout cannot
// satisfy or trip any check below.
function strip(s: string): string {
	return s
		.replace(/<!--[\s\S]*?-->/g, '') // svelte/html comments
		.replace(/\/\*[\s\S]*?\*\//g, '') // css/js block comments
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid eating http://)
}
const CODE = strip(SRC);

// Slice out the .meta element's inner content: from `<div class="meta">` to its matching close.
// A simple depth counter over <div ...>/</div> within the markup region is enough here because
// .meta contains only divs.
/*
 * The row-sharing container's interior. S8: that container is <Item.Content> now, not
 * `<div class="meta">` — the row's grammar moved onto ui/item, whose `min-width: 0; flex: 1` is what
 * `.meta` used to carry. The CLAIM is unchanged: whatever shares the row with the action cluster must
 * not also hold the progress bar or the stage line, because that is the squeeze the fix removed.
 */
function metaInner(code: string): string {
	const start = code.indexOf('<Item.Content>');
	expect(start, 'not vacuous: the row-sharing container must exist').toBeGreaterThanOrEqual(0);
	const bodyStart = code.indexOf('>', start) + 1;
	let i = bodyStart;
	let depth = 1;
	while (i < code.length && depth > 0) {
		const open = code.indexOf('<Item.Content', i);
		const close = code.indexOf('</Item.Content>', i);
		if (close === -1) break;
		if (open !== -1 && open < close) {
			depth++;
			i = open + '<Item.Content'.length;
		} else {
			depth--;
			if (depth === 0) return code.slice(bodyStart, close);
			i = close + '</Item.Content>'.length;
		}
	}
	throw new Error('the row-sharing container is never closed');
}

test('the progress block is NOT nested inside .meta (which shares the row with .actions)', () => {
	const inner = metaInner(CODE);
	// The row-sharing container must not carry the progress bar or the stage line — that is exactly
	// the squeeze this issue fixed. Reverting the fix puts them back here and reds this test.
	expect(inner).not.toContain('class="bar"');
	expect(inner).not.toContain('class="stage"');
});

test('the card is a grid and the .progress block spans every column', () => {
	// not-vacuous sentinel: the .progress block must exist and hold the bar.
	const progIdx = CODE.indexOf('<div class="progress">');
	expect(progIdx).toBeGreaterThanOrEqual(0);
	// S6: the bar is <Progress> now — same idiom, consolidated out of two components, and it
	// finally carries role="progressbar" with aria-valuenow. The claim is unchanged.
	expect(CODE.slice(progIdx)).toContain('<Progress');

	// the card overrides .list-row's flex to a grid, and .progress spans column 1 through the last.
	expect(CODE).toMatch(/\.qrow\.proc\s*\{[^}]*display:\s*grid/);
	expect(CODE).toMatch(/\.progress\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
});
