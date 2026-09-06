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

test('.t does not grow — the clamp box shrinks to its text so the mark hugs the title (issue #334)', () => {
	// With flex-grow:1 (flex: 1) the two-line clamp box grew to fill the whole .title-line, pushing the
	// flex:0 0 auto mark to the metadata column's right edge — up to 116px from a short title (#334).
	// The mark's meaning is "this title is cooking", so it must sit beside the title, not float in the
	// empty tail. .t must be flex: 0 1 auto — grow 0 AND shrink 1: grow 0 stops the clamp box filling the
	// row and floating the mark out to the column's right edge, and shrink > 0 lets the box shrink to hug
	// its (clamped) text so the mark still sits adjacent. Pinning grow alone (#389) left a hole: setting
	// flex-shrink:0 / flex: 0 0 auto keeps grow 0 and passes, but the box stops shrinking and the mark is
	// pushed back to x=1151.5 (column right edge, title-length-independent) — #334 reopened, gate green.
	// Slice the .t rule body by brace-matching from its selector so a `flex` elsewhere cannot satisfy or
	// trip this, then read the effective flex-grow AND flex-shrink from whichever of `flex:`/`flex-*:` is
	// present.
	const tSel = src.search(/(^|[^-\w])\.t\s*\{/m);
	expect(tSel).toBeGreaterThanOrEqual(0); // not-vacuous: the .t rule exists
	const braceOpen = src.indexOf('{', tSel);
	const braceClose = src.indexOf('}', braceOpen);
	expect(braceClose).toBeGreaterThan(braceOpen);
	const tBody = src.slice(braceOpen + 1, braceClose);

	// flex-grow is the FIRST value of the `flex` shorthand, or an explicit `flex-grow`. Read it and pin 0.
	const shorthand = tBody.match(/(?:^|;)\s*flex\s*:\s*([^;]+)/);
	const longhand = tBody.match(/(?:^|;)\s*flex-grow\s*:\s*([^;]+)/);
	// flex-grow is the FIRST value of the `flex` shorthand, or an explicit `flex-grow`.
	const grow = longhand
		? longhand[1].trim()
		: shorthand
			? shorthand[1].trim().split(/\s+/)[0]
			: null;
	// .t must declare its flex behaviour explicitly (not-vacuous: a missing rule cannot pass as grow 0).
	expect(grow).not.toBeNull();
	// `flex: 1` => grow 1 (the #334 defect); `flex: 0 1 auto` => grow 0 (the fix). Anything > 0 reds.
	expect(grow).toBe('0');

	// flex-shrink is the SECOND value of the `flex` shorthand, or an explicit `flex-shrink`. A shorthand
	// with only one <number> (e.g. `flex: 0`) leaves shrink at its CSS default of 1, so absence of a
	// second token means shrink 1 — read it that way rather than treating it as unset. This is the axis
	// #389 left unpinned: `flex: 0 0 auto` / `flex-shrink: 0` keeps grow 0 but stops the clamp box
	// shrinking to hug its text, floating the mark back to the column's right edge and reopening #334.
	const shrinkLong = tBody.match(/(?:^|;)\s*flex-shrink\s*:\s*([^;]+)/);
	const shrink = shrinkLong
		? shrinkLong[1].trim()
		: shorthand
			? (shorthand[1].trim().split(/\s+/)[1] ?? '1')
			: null;
	// .t must declare a shrink axis (not-vacuous: a missing rule cannot pass as shrink 1).
	expect(shrink).not.toBeNull();
	// shrink MUST be > 0 so the two-line clamp box shrinks to hug its (clamped) text. `flex: 0 0 auto`
	// (shrink 0) is the #334-reopening edit the grow-only guard misses; it must red here.
	expect(Number(shrink)).toBeGreaterThan(0);
});
