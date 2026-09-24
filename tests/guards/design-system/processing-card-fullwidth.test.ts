// guard: the ProcessingCard progress bar occupies the card's FULL inner width, whether or not the action
// cluster renders. The bar and chips once lived inside the container that shares a flex row with
// `.actions`, so a viewer's OWN processing song got a 134px bar while a stranger's action-less card kept
// 294px. Two structural facts make it invariant: the bar and stage line are NOT nested inside the
// row-sharing container, and the card is a grid whose progress block spans every column.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

// `read` throws if the path is wrong, so a bad anchor is a loud PATH failure rather than a guard that
// silently examines an empty string.
const SRC = read('src/lib/components/ProcessingCard.svelte');

// Strip comments so prose mentioning `class="bar"` cannot satisfy or trip a check below.
function strip(s: string): string {
	return s
		.replace(/<!--[\s\S]*?-->/g, '') // svelte/html comments
		.replace(/\/\*[\s\S]*?\*\//g, '') // css/js block comments
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid eating http://)
}
const CODE = strip(SRC);

/**
 * The row-sharing container's interior, by brace-free depth count over its own tags. Whatever shares the row with the
 * action cluster must not also hold the progress bar or the stage line, because that is the squeeze this removes.
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
	// Reverting the fix puts them back here.
	expect(inner).not.toContain('class="bar"');
	expect(inner).not.toContain('class="stage"');
});

test('the card is a grid and the .progress block spans every column', () => {
	// Not vacuous: the progress block must exist and hold the bar.
	const progIdx = CODE.indexOf('<div class="progress">');
	expect(progIdx).toBeGreaterThanOrEqual(0);
	expect(CODE.slice(progIdx)).toContain('<Progress');

	// The card overrides `.list-row`'s flex to a grid, and the block spans column 1 through the last.
	expect(CODE).toMatch(/\.qrow\.proc\s*\{[^}]*display:\s*grid/);
	expect(CODE).toMatch(/\.progress\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
});
