// The processing sparkle must be a SIBLING of the title text, not a child of it: SongRow's `.t` is a two-line
// clamp (`-webkit-line-clamp: 2; overflow: hidden`), so a mark rendered INSIDE `.t` is laid out on the discarded
// third line and never paints on a phone, where a real YouTube title needs both lines. The title text and the
// mark are siblings in a `.title-line` flex row; this pins that structure and the flex contract behind it.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';

function stripComments(src: string): string {
	return src
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const src = stripComments(readFileSync(at('src/lib/components/SongRow.svelte'), 'utf8'));

// Collect EVERY rule for a class selector, brace-matching each body — not the first: SongRow declares its layout
// selectors more than once, a base rule PLUS a redeclaration inside `@media (max-width: 380px)` that WINS the
// cascade at <=380px, so a first-match check is blind to the override branch. The `(^|[^-\w])` prefix stops `.t`
// matching inside `.title-line`; `lastIndex` resumes past each body so a nested `{` cannot misalign.
function collectRules(sel: string): { body: string; index: number }[] {
	const re = new RegExp('(^|[^-\\w])' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{', 'gm');
	const out: { body: string; index: number }[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(src)) !== null) {
		const braceOpen = src.indexOf('{', m.index);
		const braceClose = src.indexOf('}', braceOpen);
		expect(braceClose).toBeGreaterThan(braceOpen);
		out.push({ body: src.slice(braceOpen + 1, braceClose), index: braceOpen });
		re.lastIndex = braceClose; // resume past this rule's body so nested `{` inside can't misalign
	}
	return out;
}

function flexOf(body: string): { grow: string | null; shrink: string | null; declares: boolean } {
	const shorthand = body.match(/(?:^|;)\s*flex\s*:\s*([^;]+)/);
	const growLong = body.match(/(?:^|;)\s*flex-grow\s*:\s*([^;]+)/);
	const shrinkLong = body.match(/(?:^|;)\s*flex-shrink\s*:\s*([^;]+)/);
	const declares = !!(shorthand || growLong || shrinkLong);
	const grow = growLong ? growLong[1].trim() : shorthand ? shorthand[1].trim().split(/\s+/)[0] : null;
	// flex-shrink: explicit, else the SECOND value of the shorthand — one <number> leaves shrink at its CSS default
	// of 1, but only when a shorthand is present at all.
	const shrink = shrinkLong ? shrinkLong[1].trim() : shorthand ? (shorthand[1].trim().split(/\s+/)[1] ?? '1') : null;
	return { grow, shrink, declares };
}

test('the processing sparkle is a sibling of .t inside .title-line, never nested in the clamped .t', () => {
	const titleLineOpen = src.indexOf('class="title-line"');
	expect(titleLineOpen).toBeGreaterThanOrEqual(0);
	expect(src).toContain('class="t"');
	expect(src).toContain('class="sparkle"');

	// Capture `.t` from its opening tag to its MATCHING close by counting <span> depth: a first-match `</span>` would
	// be truncated by ANY nested <span> inside `.t`, letting a re-nested mark past the check.
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

	expect(tInner).not.toContain('class="sparkle"');

	const titleLineClose = (() => {
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

test('.title-line stays a flex row and .sparkle stays a non-shrinking flex item, on EVERY rule', () => {
	// The layout contract that keeps the mark off the clamped line: a flex ROW whose mark cannot grow, held on EVERY
	// rule rather than any. `.title-line { flex-direction: column }` (or `display: block`/`grid`) drops the mark onto
	// its own line, and `.sparkle { flex: 1 1 auto }` lets the inline-grid box grow and floats the glyph into the
	// empty tail — both survived an any-match `toMatch` forever, satisfied by the base rules.
	const titleLineRules = collectRules('.title-line');
	// not-vacuous, keyed on the selector examined: the base rule must exist, or the contract is unpinned.
	expect(titleLineRules.length).toBeGreaterThanOrEqual(1);

	const titleLineFlexRow = titleLineRules.filter((r) => /display:\s*flex/.test(r.body));
	expect(titleLineFlexRow.length).toBeGreaterThanOrEqual(1);

	for (const r of titleLineRules) {
		// Any rule that sets `display` must set it to flex, and the row must stay a ROW: `block`/`grid`/`column` each
		// stack the mark under the title.
		const display = r.body.match(/(?:^|;)\s*display\s*:\s*([^;]+)/);
		if (display) expect(display[1].trim()).toBe('flex');
		const dir = r.body.match(/(?:^|;)\s*flex-direction\s*:\s*([^;]+)/);
		if (dir) expect(dir[1].trim()).toBe('row');
	}

	const sparkleRules = collectRules('.sparkle');
	expect(sparkleRules.length).toBeGreaterThanOrEqual(1);

	const sparkleDeclaring = sparkleRules.filter((r) => flexOf(r.body).declares);
	expect(sparkleDeclaring.length).toBeGreaterThanOrEqual(1);

	for (const r of sparkleDeclaring) {
		const { grow } = flexOf(r.body);
		// grow MUST be 0: `.sparkle` is `display: inline-grid; place-items: center`, so any grow swells the box and
		// centres the glyph out in the empty tail, away from the title.
		expect(grow).toBe('0');
	}
});

test('.t does not grow and always shrinks — the clamp box hugs its text so the mark stays adjacent, on EVERY .t rule', () => {
	// `.t` must be `flex: 0 1 auto`: grow 0 stops the two-line clamp box filling `.title-line` and pushing the
	// `flex: 0 0 auto` mark out to the metadata column's right edge (up to 116px from a short title), and shrink > 0
	// lets the box shrink to hug its clamped text so the mark stays adjacent. Pinning grow alone left a hole —
	// `flex: 0 0 auto` keeps grow 0, passes, and pushes the mark back out regardless of title length. EVERY `.t`
	// rule declaring a flex axis must satisfy both halves, and at least one must declare flex at all.
	const bodies = collectRules('.t');
	// not-vacuous: `.t` is declared at least TWICE (base + @media), and the floor stops an edit shrinking the set.
	expect(bodies.length).toBeGreaterThanOrEqual(2);

	const declaring = bodies.filter((b) => flexOf(b.body).declares);
	expect(declaring.length).toBeGreaterThanOrEqual(1);

	for (const b of declaring) {
		const { grow, shrink } = flexOf(b.body);
		expect(grow).toBe('0');
		// shrink MUST be > 0 so the clamp box shrinks to hug its text; `flex: 0 0 auto` is the reopening edit.
		expect(shrink).not.toBeNull();
		expect(Number(shrink)).toBeGreaterThan(0);
	}
});
