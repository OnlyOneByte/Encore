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

const src = stripComments(readFileSync(join(import.meta.dir, 'SongRow.svelte'), 'utf8'));

// Collect EVERY rule for a class selector, matching the selector repeatedly and brace-matching each
// body — the same read tests 2 and 3 rely on. Returns one entry per rule with its declaration body.
//
// #482 established the reason this must read every rule, not the first: SongRow declares its layout
// selectors more than once — a base rule PLUS a redeclaration inside `@media (max-width: 380px)` that
// WINS the cascade at <=380px (same specificity, later in source). A first/any-match check is blind to
// the override branch, so a media-query redeclaration can reopen a fixed defect with the gate green.
//
// `sel` is a literal class token; the `(^|[^-\w])` prefix stops `.t` matching inside `.title-line` and
// keeps each selector distinct. `lastIndex` resumes past each body so a nested `{` cannot misalign.
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

// Read the effective flex-grow / flex-shrink a rule DECLARES, or null if it declares no flex axis.
function flexOf(body: string): { grow: string | null; shrink: string | null; declares: boolean } {
	const shorthand = body.match(/(?:^|;)\s*flex\s*:\s*([^;]+)/);
	const growLong = body.match(/(?:^|;)\s*flex-grow\s*:\s*([^;]+)/);
	const shrinkLong = body.match(/(?:^|;)\s*flex-shrink\s*:\s*([^;]+)/);
	const declares = !!(shorthand || growLong || shrinkLong);
	// flex-grow: explicit flex-grow, else the FIRST value of the `flex` shorthand.
	const grow = growLong ? growLong[1].trim() : shorthand ? shorthand[1].trim().split(/\s+/)[0] : null;
	// flex-shrink: explicit flex-shrink, else the SECOND value of the `flex` shorthand. A shorthand
	// with only one <number> (e.g. `flex: 0`) leaves shrink at its CSS default of 1, so a missing
	// second token means shrink 1 — but only when a shorthand is actually present.
	const shrink = shrinkLong ? shrinkLong[1].trim() : shorthand ? (shorthand[1].trim().split(/\s+/)[1] ?? '1') : null;
	return { grow, shrink, declares };
}

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

test('.title-line stays a flex row and .sparkle stays a non-shrinking flex item, on EVERY rule (issue #551)', () => {
	// The layout contract that keeps the mark off the clamped line: a flex ROW whose mark cannot grow.
	//
	// #482 named the hole and #523 closed it for `.t` only (see test 3): every `.t` rule is now read.
	// The other two selectors in the SAME contract were left on any-match `toMatch`, satisfied forever
	// by the base rules at `.title-line`/`.sparkle`. So a redeclaration inside `@media (max-width: 380px)`
	// — this file's established idiom, the block already redeclares six selectors — was invisible:
	//   • `.title-line { flex-direction: column }` (or `display: block`/`grid`) drops the mark onto its
	//     OWN line, reading as a metadata bullet rather than a mark on the title — #194's loss by another
	//     route.
	//   • `.sparkle { flex: 1 1 auto }` lets the inline-grid box grow and floats the centred glyph into
	//     the empty tail — #334's exact symptom.
	// Both left the old test at 3 pass / 0 fail. Read EVERY rule (collectRules) and hold each to its
	// contract, mirroring test 3's `.t` widening.

	// --- .title-line: must be a flex row, and no rule may turn it into a column/block/grid ---------
	const titleLineRules = collectRules('.title-line');
	// not-vacuous, keyed on the selector examined (NOT a raw count elsewhere): the base rule must exist.
	expect(titleLineRules.length).toBeGreaterThanOrEqual(1);

	// at least one rule must establish the flex row (the base rule) — otherwise the contract is unpinned.
	const titleLineFlexRow = titleLineRules.filter((r) => /display:\s*flex/.test(r.body));
	expect(titleLineFlexRow.length).toBeGreaterThanOrEqual(1);

	for (const r of titleLineRules) {
		// Any rule that sets `display` at all must set it to flex — a `display: block`/`grid` override
		// stacks the mark under the title (Finding 1). Rules that do not touch display inherit the base.
		const display = r.body.match(/(?:^|;)\s*display\s*:\s*([^;]+)/);
		if (display) expect(display[1].trim()).toBe('flex');
		// The flex row must stay a ROW. `flex-direction: column` puts the mark on its own line below the
		// title (Finding 1). `row` (the initial value) is fine; anything else reds.
		const dir = r.body.match(/(?:^|;)\s*flex-direction\s*:\s*([^;]+)/);
		if (dir) expect(dir[1].trim()).toBe('row');
	}

	// --- .sparkle: must not GROW, on every rule that declares a flex axis --------------------------
	const sparkleRules = collectRules('.sparkle');
	expect(sparkleRules.length).toBeGreaterThanOrEqual(1);

	// the base rule pins the full `flex: 0 0 auto` (grow 0, shrink 0 — the mark neither grows nor shrinks).
	const sparkleDeclaring = sparkleRules.filter((r) => flexOf(r.body).declares);
	expect(sparkleDeclaring.length).toBeGreaterThanOrEqual(1);

	for (const r of sparkleDeclaring) {
		const { grow } = flexOf(r.body);
		// grow MUST be 0: `.sparkle` is `display: inline-grid; place-items: center`, so any grow lets the
		// box swell and centres the glyph out in the empty tail, separating it from the title (Finding 2,
		// #334's symptom). `flex: 1 1 auto` => grow "1" reds here where the any-match guard let it pass.
		expect(grow).toBe('0');
	}
});

test('.t does not grow and always shrinks — the clamp box hugs its text so the mark stays adjacent, on EVERY .t rule (issue #334)', () => {
	// With flex-grow:1 (flex: 1) the two-line clamp box grew to fill the whole .title-line, pushing the
	// flex:0 0 auto mark to the metadata column's right edge — up to 116px from a short title (#334).
	// The mark's meaning is "this title is cooking", so it must sit beside the title, not float in the
	// empty tail. .t must be flex: 0 1 auto — grow 0 AND shrink 1: grow 0 stops the clamp box filling the
	// row and floating the mark out to the column's right edge, and shrink > 0 lets the box shrink to hug
	// its (clamped) text so the mark still sits adjacent. Pinning grow alone (#389) left a hole: setting
	// flex-shrink:0 / flex: 0 0 auto keeps grow 0 and passes, but the box stops shrinking and the mark is
	// pushed back to the column right edge (title-length-independent) — #334 reopened, gate green.
	//
	// #482: SongRow declares .t TWICE — the base rule AND a redeclaration inside @media (max-width: 380px).
	// The old guard used String.prototype.search, which returns only the FIRST match, so a `flex` written
	// into that media-query rule (which WINS the cascade at <=380px, same specificity + later in source)
	// was invisible. Read EVERY .t rule by matching the selector repeatedly, brace-match each body, and
	// hold every rule that declares a flex axis to the same grow-0 / shrink->0 contract. A rule that
	// declares no flex is fine — it inherits the base rule's flex, so it cannot reopen #334 on its own.
	const bodies = collectRules('.t');
	// not-vacuous: SongRow declares .t at least TWICE today (base + @media). A floor on the count means a
	// future edit that stops one rule matching (renamed selector, merged rules) cannot silently shrink the
	// set the contract is applied to and slip a regression through an unexamined rule.
	expect(bodies.length).toBeGreaterThanOrEqual(2);

	// at least ONE .t rule must declare its flex explicitly (the base rule) — a repo with zero flex on
	// any .t rule would leave the whole contract unpinned.
	const declaring = bodies.filter((b) => flexOf(b.body).declares);
	expect(declaring.length).toBeGreaterThanOrEqual(1);

	// EVERY .t rule that declares a flex axis must satisfy the contract: grow 0 AND shrink > 0. This is
	// the #482 widening — `.t { …; flex: 1 }` inside @media (max-width: 380px) now reds here, where the
	// first-rule-only guard let it survive.
	for (const b of declaring) {
		const { grow, shrink } = flexOf(b.body);
		// grow: `flex: 1` => "1" (the #334 defect); `flex: 0 1 auto` => "0" (the fix). Anything > 0 reds.
		expect(grow).toBe('0');
		// shrink MUST be > 0 so the two-line clamp box shrinks to hug its text. `flex: 0 0 auto`
		// (shrink 0) is the #334-reopening edit the grow-only guard misses; it must red here.
		expect(shrink).not.toBeNull();
		expect(Number(shrink)).toBeGreaterThan(0);
	}
});
