// guard (issue #194): the cooking sparkle must be a SIBLING of the title text, not a child of it.
//
// SongRow's `.t` is a two-line clamp: `display: -webkit-box; -webkit-line-clamp: 2; overflow: hidden`.
// A mark rendered INSIDE `.t` is laid out on the discarded third line of a two-line-clamped title, so
// on a phone (where a real YouTube title routinely needs both lines) the cooking mark never paints —
// it renders correctly only when the title is short or the column is wide (>=820px). The fix wraps the
// title text and the mark in a `.title-line` flex row so `.sparkle` is a `flex: 0 0 auto` sibling of
// the clamped `.t` and always paints. This guard pins that structure so a future edit cannot re-nest
// the mark inside the clamp. Source-decidable, always-on (no live server), comment-stripped.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// blank out /* */, <!-- --> and // comments so prose describing the old (nested) layout can neither
// satisfy nor trip the structural checks below.
function stripComments(src: string): string {
	return src
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const src = stripComments(
	readFileSync(join(import.meta.dir, 'SongRow.svelte'), 'utf8')
);

test('the cooking sparkle is a sibling of .t inside .title-line, never nested in the clamped .t', () => {
	// not-vacuous: the elements the invariant is about must actually exist.
	const titleLineOpen = src.indexOf('class="title-line"');
	expect(titleLineOpen).toBeGreaterThanOrEqual(0);
	expect(src).toContain('class="t"');
	expect(src).toContain('class="sparkle"');

	// locate the .t element and take its full span. .t is a <span> holding {title}; capture from its
	// opening tag to its MATCHING close by counting <span>/</span> depth — a first-match `</span>`
	// would be truncated by ANY nested <span> inside .t (e.g. a <span class="title-text"> wrapper, a
	// routine styling refactor), letting a re-nested mark past the check. The matching-close walk sees
	// the whole subtree, so a mark nested behind any number of intervening <span>s is still caught.
	const tOpen = src.indexOf('<span class="t">');
	expect(tOpen).toBeGreaterThanOrEqual(0);
	const tClose = (() => {
		let depth = 0;
		for (let i = tOpen; i < src.length; i++) {
			if (src.startsWith('<span', i)) depth++;
			else if (src.startsWith('</span>', i)) {
				depth--;
				if (depth === 0) return i;
			}
		}
		return -1;
	})();
	expect(tClose).toBeGreaterThan(tOpen);
	const tInner = src.slice(tOpen + '<span class="t">'.length, tClose);

	// (1) the mark must NOT live inside .t — that is exactly the clamp-swallowing bug.
	expect(tInner).not.toContain('class="sparkle"');

	// (2) the mark must live inside .title-line, AFTER .t closes (i.e. a following sibling).
	const titleLineClose = (() => {
		// walk from .title-line's opening <div ...> to its matching </div>
		const open = src.lastIndexOf('<div', titleLineOpen);
		let depth = 0;
		let i = open;
		for (; i < src.length; i++) {
			if (src.startsWith('<div', i)) depth++;
			else if (src.startsWith('</div>', i)) {
				depth--;
				if (depth === 0) return i;
			}
		}
		return -1;
	})();
	expect(titleLineClose).toBeGreaterThan(tClose);

	const sparkleAt = src.indexOf('class="sparkle"');
	expect(sparkleAt).toBeGreaterThan(tClose); // after .t closes
	expect(sparkleAt).toBeLessThan(titleLineClose); // still inside .title-line
});

test('.title-line is a flex row and .sparkle is a non-shrinking flex item', () => {
	// the layout contract that keeps the mark off the clamped line: a flex row whose mark cannot shrink.
	expect(src).toMatch(/\.title-line\s*\{[^}]*display:\s*flex/);
	expect(src).toMatch(/\.sparkle\s*\{[^}]*flex:\s*0\s+0\s+auto/);
});
