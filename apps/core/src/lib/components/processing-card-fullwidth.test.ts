// Guard for issue #176: the ProcessingCard progress block (bar + stage line) must occupy the
// card's FULL inner width, independent of whether the action cluster
// (remove / reorder) renders. Before the fix the bar and chips lived INSIDE .meta, which shared a
// single flex row with .actions, so a viewer's OWN cooking song (which shows up to three 44px
// buttons = ~148px) got a 134px bar while a stranger's action-less card kept a 294px bar —
// different geometry for the same component in the same list. (The per-stage chip strip this guard
// also once covered was removed in #253; the bar's width-invariance is what #176 pins.)
//
// The fix lifts the progress block onto its own full-width grid row. This guard pins the two
// structural facts that make the bar's width invariant to the actions column, and reds if either
// is reverted:
//   1. the .bar / .stage markup is NOT nested inside .meta (the row that carries .actions);
//   2. the card is a grid and the .progress block spans every column (grid-column: 1 / -1).
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(import.meta.dir, 'ProcessingCard.svelte'), 'utf8');

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
function metaInner(code: string): string {
	const start = code.indexOf('<div class="meta">');
	expect(start).toBeGreaterThanOrEqual(0); // not-vacuous: .meta must exist
	let i = code.indexOf('>', start) + 1;
	let depth = 1;
	const bodyStart = i;
	while (i < code.length && depth > 0) {
		const openDiv = code.indexOf('<div', i);
		const closeDiv = code.indexOf('</div>', i);
		if (closeDiv === -1) break;
		if (openDiv !== -1 && openDiv < closeDiv) {
			depth++;
			i = openDiv + 4;
		} else {
			depth--;
			if (depth === 0) return code.slice(bodyStart, closeDiv);
			i = closeDiv + 6;
		}
	}
	throw new Error('.meta close not found');
}

test('#176: the progress block is NOT nested inside .meta (which shares the row with .actions)', () => {
	const inner = metaInner(CODE);
	// The row-sharing container must not carry the progress bar or the stage line — that is exactly
	// the squeeze this issue fixed. Reverting the fix puts them back here and reds this test.
	expect(inner).not.toContain('class="bar"');
	expect(inner).not.toContain('class="stage"');
});

test('#176: the card is a grid and the .progress block spans every column', () => {
	// not-vacuous sentinel: the .progress block must exist and hold the bar.
	const progIdx = CODE.indexOf('<div class="progress">');
	expect(progIdx).toBeGreaterThanOrEqual(0);
	expect(CODE.slice(progIdx)).toContain('class="bar"');

	// the card overrides .list-row's flex to a grid, and .progress spans column 1 through the last.
	expect(CODE).toMatch(/\.qrow\.proc\s*\{[^}]*display:\s*grid/);
	expect(CODE).toMatch(/\.progress\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
});
