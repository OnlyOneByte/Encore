// guard: animations/transitions must be GPU-composited (transform/opacity/background/
// color/box-shadow only) — NEVER layout-triggering props (width/height/top/left/margin), which
// cause jank. Source-scan every .svelte + .css file under src/ (incl. src/lib/tv, src/lib/ui and
// src/app.css, the shared design system). See docs/ARCHITECTURE.md.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { svelteFiles } from '../test-helpers';

// ALLOWLIST, not a denylist (issue #290): the file header states the rule positively —
// animations/transitions may touch ONLY GPU-composited properties. Flag anything animated
// that is not in this set, so `transition: all` (which animates width/height/…) and every
// layout prop outside a fixed denylist (max-height, inset, gap, flex-basis, font-size, …) red.
const COMPOSITED_PROPS = new Set([
	'transform',
	'opacity',
	'background',
	'background-color',
	'background-position', // paint-only, compositor-safe; used by the shimmer skeleton loader
	'color',
	'box-shadow'
]);

// every .svelte AND .css file under a directory — the CSS lives in both component <style> blocks
// and the shared design system (src/app.css), so a scan restricted to .svelte is blind to app.css.
function assertScanIntact(files: string[]): void {
	expect(files.some((f) => f.endsWith('app.css'))).toBe(true);
	expect(files.some((f) => f.includes(join('lib', 'tv')) && f.endsWith('.svelte'))).toBe(true);
}
function styleFiles(dir: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) out.push(...styleFiles(p));
		else if (ent.name.endsWith('.svelte') || ent.name.endsWith('.css')) out.push(p);
	}
	return out;
}

// strip BOTH comment forms before a whole-file scan: CSS `/* … */` AND HTML `<!-- … -->`. Tests 1 and 2
// read entire .svelte files (markup + <style>), so a `transition:` written in prose inside an HTML
// comment (e.g. tv/+page.svelte's 'not a transition: work in progress' note) must not false-positive
// (issue #287 gap 1 / #290 :55,:67). All three tests use this stripper — test 3 now scans Svelte
// markup for `style:animation` directives too, so it needs `<!-- -->` blanked (issue #615 advisory 1).
function stripAllComments(src: string): string {
	return src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// extract EVERY property animated by each `transition:` shorthand or `transition-property:` longhand.
// A shorthand may list several comma-separated animations (`transform 0.2s, height 0.2s`), each of
// whose FIRST identifier is the animated property — so we cannot read only the first token of the
// declaration. The longhand `transition-property: a, b` lists bare property names directly.
function animatedProps(css: string): string[] {
	const props: string[] = [];
	// CSS `transition:` declarations and Svelte `transition:` DIRECTIVES are lexically ambiguous — both
	// can be preceded by whitespace (`<div transition:slide>` vs a rule body's `transition: transform`),
	// so a left boundary alone cannot tell them apart (issue #648 §2). They live in different places: a
	// CSS declaration is inside a `<style>` block or `.css` file; a directive is in MARKUP. The CSS scan
	// therefore runs over TAG-STRIPPED text (every `<...>` blanked, which drops `<div transition:slide>`
	// and the `<style>`/`</style>` tags themselves while leaving each rule body intact), so a markup
	// directive can never be misread as a CSS property `slide` — it is caught, by name, by test 3.
	// (An inline `style="transition:…"` ATTRIBUTE is inside a tag too, so the tag-strip blanks it from
	// this scan — it is read back from the un-stripped `css` by a dedicated loop below, issue #648 review.)
	const styleText = css.replace(/<[^>]*>/g, ' ');
	for (const m of styleText.matchAll(/(?:^|[;{\s])transition(?:-property)?:\s*([^;}]+)/g)) {
		for (const entry of m[1]!.split(',')) {
			const id = entry.trim().match(/^[a-z-]+/);
			if (!id) continue;
			if (id[0] === 'none') continue;
			props.push(id[0]);
		}
	}
	// Svelte's inline `style:transition` directive (issue #615 §2) lives INSIDE a tag, so the tag-strip
	// above removes it — read it from the original `css`. Four spellings (issue #615 advisory 2):
	// `="…"`, `='…'`, `={expr}`, and the bare shorthand; a quoted value is classified, an opaque
	// expression/shorthand is flagged via a sentinel property name (never in COMPOSITED_PROPS).
	for (const m of css.matchAll(/style:transition(?:-property)?(?:=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g)) {
		const readable = m[1] ?? m[2] ?? m[3];
		if (readable === undefined || readable.trim() === '') {
			props.push('style-transition-directive');
			continue;
		}
		for (const entry of readable.split(',')) {
			const id = entry.trim().match(/^[a-z-]+/);
			if (!id) continue;
			if (id[0] === 'none') continue;
			props.push(id[0]);
		}
	}
	// An inline `style="transition: …"` / `style='…'` ATTRIBUTE also lives inside a tag, so the tag-strip
	// above blanks it from the CSS scan (issue #648 review of §2). It is a real inline transition no
	// `@media`/reduce can cover — the #590 §2 / #615 §2 class — so read it, like the `style:transition`
	// directive above, from the ORIGINAL `css` with the same first-identifier-per-comma-entry rule.
	for (const m of css.matchAll(/style=(?:"[^"]*?|'[^']*?)\btransition(?:-property)?:\s*([^;"']+)/g)) {
		for (const entry of m[1]!.split(',')) {
			const id = entry.trim().match(/^[a-z-]+/);
			if (!id) continue;
			if (id[0] === 'none') continue;
			props.push(id[0]);
		}
	}
	return props;
}

test('no transition animates a layout-triggering property (transform/opacity only)', () => {
	// scan every .svelte + .css under src/ — including src/lib/tv, src/lib/ui and src/app.css
	const files = styleFiles(join(import.meta.dir, '..', '..'));
	// count floor (issue #287 gap 3): a directory rename / moved src / glob typo would make this
	// scan pass VACUOUSLY. The asserted floor (>= 24) is the guard — a broken walk reds instead of
	// silently passing, the exact failure mode #140 shipped under. (No live count in prose: issue #615
	// advisory 3 — the parenthetical drifted across #575/#590/#615, so the assertion is the only number.)
	expect(files.length).toBeGreaterThanOrEqual(24);
	assertScanIntact(files);
	const offenders: string[] = [];
	for (const f of files) {
		// strip comments first (issue #287 gap 1): a `transition:` in a `/* … */` or `<!-- … -->` comment
		// must not false-positive — the #205 source-scan precedent.
		const css = stripAllComments(readFileSync(f, 'utf8'));
		for (const prop of animatedProps(css)) {
			if (!COMPOSITED_PROPS.has(prop)) offenders.push(`${f}: transition: ${prop}`);
		}
	}
	expect(offenders).toEqual([]);
});

// capture the full body of every @keyframes block via a brace-depth walk (issue #290 :71). The old
// `\}\s*\}` terminator required the block to end with two braces separated by whitespace ONLY, so a
// trailing comment — or any non-whitespace — between the last stop's `}` and the block's `}` made the
// regex skip the ENTIRE block. A depth counter from the block's opening `{` to its matching close is
// immune to what sits between the inner stops. Comments are stripped by the caller first.
function keyframeBodies(css: string): string[] {
	const bodies: string[] = [];
	const re = /@(?:-(?:webkit|moz)-)?keyframes[^{]*\{/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(css))) {
		let depth = 1;
		const bodyStart = m.index + m[0].length;
		let i = bodyStart;
		for (; i < css.length && depth > 0; i++) {
			if (css[i] === '{') depth++;
			else if (css[i] === '}') depth--;
		}
		bodies.push(css.slice(bodyStart, i - 1));
		re.lastIndex = i;
	}
	return bodies;
}

// every property animated inside a keyframes body: the FIRST identifier of each `prop:` declaration.
function keyframeProps(body: string): string[] {
	const props: string[] = [];
	for (const m of body.matchAll(/(?:^|[;{\s])([a-z-]+)\s*:/g)) props.push(m[1]!);
	return props;
}

test('@keyframes animate only GPU-composited properties', () => {
	const files = styleFiles(join(import.meta.dir, '..', '..'));
	expect(files.length).toBeGreaterThanOrEqual(24);
	assertScanIntact(files);
	const bad: string[] = [];
	for (const f of files) {
		// strip comments first so (a) a trailing comment can't defeat the block capture and (b) a
		// commented-out declaration does not false-positive; strips `/* */` and `<!-- -->` (issue #287 gap 1).
		const css = stripAllComments(readFileSync(f, 'utf8'));
		for (const body of keyframeBodies(css)) {
			for (const prop of keyframeProps(body)) {
				// `from`/`to`/percentage stops are selectors, not declarations; they never precede a `:` here.
				if (!COMPOSITED_PROPS.has(prop)) bad.push(`${f}: keyframe animates ${prop}`);
			}
		}
	}
	expect(bad).toEqual([]);
});

// guard (issue #148): every `animation:` declaration must honour Reduce Motion. An animation is
// suppressible if it is EITHER declared inside an `@media (prefers-reduced-motion: no-preference)`
// block, OR paired with an `@media (prefers-reduced-motion: reduce) { … animation: none }` reset that
// covers ITS OWN selector in the SAME file. `animation: none` declarations are themselves the reset
// and are exempt. This closes the drift hazard behind #148: QueueRow's `.qrow { animation: pop … }`
// ran under Reduce Motion while app.css's guarded `.pop-in` helper had no callers. Source-decidable in
// the same shape as the scans above.
//
// The exemption is SELECTOR-scoped, not file-scoped (issue #242): a reduce reset for `.hero .qr`
// exempts only `.hero .qr`, so a NEW unguarded animation added to the same file on a different
// selector still reds — the reset no longer waves the whole file through. Mutation proof: unguarding
// any animation (moving it out of the no-preference block, dropping its reduce reset, or adding a new
// animation on a selector no reduce block covers) reds this test.
// True when a media prelude fires ONLY when motion is allowed, never under Reduce Motion
// (issue #481). A media query LIST is an OR (issue #590): `@media (prefers-reduced-motion:
// no-preference), (min-width: 700px)` fires when EITHER branch matches, so on any >=700px viewport
// it fires under Reduce Motion — exactly the state the block must not fire in, and every TV is
// >=700px wide. A list is therefore motion-allowed only when EVERY top-level-comma branch is;
// one reduce-hostile branch (order irrelevant) disqualifies the whole list.
function firesOnlyWhenMotionAllowed(prelude: string): boolean {
	return splitTopLevelCommas(prelude).every(branchFiresOnlyWhenMotionAllowed);
}
// True when a `not` operator negates the prefers-reduced-motion FEATURE query that opens at
// `featureParenIdx` — i.e. the `not` binds to THIS feature, not to some sibling feature in the same
// branch (issue #615 §1, corrected for #615's own regression). Three spellings put a `not` in front
// of a feature `(…)`, and all three must be recognised while a `not` on an UNRELATED feature must not
// flip the verdict (issue #590 §3 gate 9: `(prefers-reduced-motion: no-preference) and
// (not (min-width: 700px))` — the `not` there governs min-width, so the reduce feature is un-negated):
//   • MQ4 adjacent:       `not (prefers-reduced-motion: …)`
//   • MQ4 parenthesised:  `(not (prefers-reduced-motion: …))`  ← the regression: an opening `(` sits
//                          before `not`, so a branch-LEADING `^not` anchor could not see it.
//   • MQ3 legacy:         `not all and (prefers-reduced-motion: …)` / `not screen and (…)`
// The deciding text is what sits immediately LEFT of this feature's `(`, ignoring only opening parens
// and whitespace: a `not` reachable across `not (`, `not all and (`, or `((not (` negates the feature;
// anything else (a bare `(`, `and (`, `,`, another feature) leaves it un-negated. We therefore read the
// prelude backward from `(` over `(`/whitespace, then require the immediately-preceding token to be
// `not` OR a `not <media-type> and` head.
function featureIsNegated(prelude: string, featureParenIdx: number): boolean {
	// text strictly before the feature's opening paren
	const before = prelude.slice(0, featureParenIdx);
	// MQ4: `not` then only `(`/whitespace up to our `(` — e.g. `not (`, `(not (`, `and (not (`
	if (/\bnot\s*\(*\s*$/.test(before)) return true;
	// MQ3: `not <media-type> and` immediately before the feature `(` — `not all and (`, `not screen and (`
	if (/\bnot\s+[a-z-]+\s+and\s*\(*\s*$/.test(before)) return true;
	return false;
}
// One comma-branch of a media prelude. A branch fires only when motion is allowed when its
// prefers-reduced-motion feature resolves that way: a NON-negated `no-preference` (fires only when
// motion is allowed → accept) or a NEGATED `reduce` (fires when motion is allowed → accept). The
// mirror cases fire under Reduce Motion and must be reported: a NEGATED `no-preference` (fires under
// Reduce Motion) and a non-negated `reduce`. Negation is decided per-FEATURE by `featureIsNegated`,
// so all three `not` spellings are caught and a `not` on an unrelated feature does not flip it.
function branchFiresOnlyWhenMotionAllowed(branch: string): boolean {
	const noPref = /prefers-reduced-motion:\s*no-preference/.exec(branch);
	if (noPref) {
		const paren = branch.lastIndexOf('(', noPref.index);
		return !featureIsNegated(branch, paren);
	}
	const reduce = /prefers-reduced-motion:\s*reduce/.exec(branch);
	if (reduce) {
		const paren = branch.lastIndexOf('(', reduce.index);
		return featureIsNegated(branch, paren);
	}
	return false;
}
// Split a media prelude on TOP-LEVEL commas only — commas inside `(…)` (a value list, a `not(...)`
// group) are not query-list separators.
function splitTopLevelCommas(prelude: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < prelude.length; i++) {
		const c = prelude[i];
		if (c === '(') depth++;
		else if (c === ')') depth--;
		else if (c === ',' && depth === 0) {
			parts.push(prelude.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(prelude.slice(start));
	return parts;
}
function noPreferenceSpans(css: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	const re = /@media([^{]*)\{/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(css))) {
		// walk braces from the opening `{` to its match
		let depth = 1;
		let i = m.index + m[0].length;
		for (; i < css.length && depth > 0; i++) {
			if (css[i] === '{') depth++;
			else if (css[i] === '}') depth--;
		}
		if (firesOnlyWhenMotionAllowed(m[1]!)) spans.push([m.index, i]);
	}
	return spans;
}
// A single CSS rule block: its selector (normalised), its body offset range, and whether any ancestor
// in the brace stack was an `@media (prefers-reduced-motion: reduce)` prelude.
type Rule = { selector: string; bodyStart: number; bodyEnd: number; underReduce: boolean };

// normalise a selector for set comparison: collapse internal whitespace, trim, lowercase nothing
// (class names are case-sensitive). `.hero  .qr` and `.hero .qr` compare equal.
function normSelector(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

// A reduce reset only WINS when the OS asks for reduced motion, so the reset @media must fire in
// exactly that state and no narrower one (issue #337). A bare substring test on the prelude accepts
// three preludes CSS discards: `@media not (prefers-reduced-motion: reduce)` (fires when motion is
// ALLOWED — inverted), and `@media (prefers-reduced-motion: reduce) and (min-width: 5000px)` (fires
// only on a 5000px viewport). Qualify a prelude as a reset carrier ONLY when it names the reduce
// feature, contains no `not`, and carries no extra `and (…)` term. A conditional reset is not coverage.
function isUnconditionalReduce(prelude: string): boolean {
	if (!/prefers-reduced-motion:\s*reduce/.test(prelude)) return false;
	if (/\bnot\b/.test(prelude)) return false; // `@media not (prefers-reduced-motion: reduce)` is inverted
	if (/\band\b/.test(prelude)) return false; // any extra `and (…)` term narrows when the reset fires
	return true;
}

// Forward-scan the CSS into a flat list of rule blocks. Maintains a stack of open blocks, each
// carrying the prelude text that opened it (the selector, or an at-rule prelude like `@media …`).
// A block is a plain style RULE (as opposed to an at-rule container) when its prelude does not start
// with `@`; only those own `animation:` declarations. `underReduce` is true when any ancestor prelude
// is an UNCONDITIONAL `prefers-reduced-motion: reduce` @media (issue #337) — a `not`-inverted or
// extra-`and`-gated reduce prelude does NOT count, since its reset does not win under Reduce Motion.
function ruleBlocks(css: string): Rule[] {
	const rules: Rule[] = [];
	const stack: Array<{ prelude: string; reduce: boolean }> = [];
	let preludeStart = 0;
	for (let i = 0; i < css.length; i++) {
		const c = css[i];
		if (c === '{') {
			const prelude = css.slice(preludeStart, i).trim();
			const isAt = prelude.startsWith('@');
			const reduce = (stack.length ? stack[stack.length - 1]!.reduce : false) || isUnconditionalReduce(prelude);
			stack.push({ prelude, reduce });
			if (!isAt) {
				// a plain style rule — record it (bodyEnd filled in on the matching `}`)
				rules.push({
					selector: normSelector(prelude),
					bodyStart: i + 1,
					bodyEnd: -1,
					underReduce: stack.length >= 2 ? stack[stack.length - 2]!.reduce : false
				});
			}
			preludeStart = i + 1;
		} else if (c === '}') {
			const top = stack.pop();
			if (top && !top.prelude.startsWith('@')) {
				// close the most-recently-opened still-open plain rule
				for (let r = rules.length - 1; r >= 0; r--) {
					if (rules[r]!.bodyEnd === -1) {
						rules[r]!.bodyEnd = i;
						break;
					}
				}
			}
			preludeStart = i + 1;
		} else if (c === ';') {
			preludeStart = i + 1;
		}
	}
	return rules;
}

// The selectors a reduce reset covers, mapped to the source OFFSET of the reset's own body
// (issue #337). A reset only wins the cascade when it sits AFTER the animation it defeats — a media
// query adds no specificity, so at equal specificity the later declaration wins. We therefore record
// each covered selector's reset `bodyStart` (the EARLIEST, if a selector is reset more than once — a
// later reset cannot rescue an animation the earliest reset already fails to cover). The caller
// exempts an animation only when its selector's reset offset is greater than the animation's offset.
// Only rules under an UNCONDITIONAL reduce @media qualify — `underReduce` already enforces that.
function reduceResetSelectors(css: string, rules: Rule[]): Map<string, number> {
	const covered = new Map<string, number>();
	for (const r of rules) {
		if (!r.underReduce) continue;
		const body = css.slice(r.bodyStart, r.bodyEnd);
		// a reset may group selectors — `.a, .b, .c { animation: none }` covers each of .a/.b/.c.
		if (/animation(-name)?:\s*none/.test(body))
			for (const sel of r.selector.split(',')) {
				const key = normSelector(sel);
				const prev = covered.get(key);
				if (prev === undefined || r.bodyStart < prev) covered.set(key, r.bodyStart);
			}
	}
	return covered;
}

// The selector owning a declaration at offset `at`: the innermost plain rule whose body contains it.
function owningSelector(rules: Rule[], at: number): string | null {
	let best: Rule | null = null;
	for (const r of rules) {
		if (at >= r.bodyStart && at < r.bodyEnd) {
			if (!best || r.bodyStart > best.bodyStart) best = r;
		}
	}
	return best ? best.selector : null;
}

test('every animation declaration honours prefers-reduced-motion', () => {
	const svelte = [
		...svelteFiles(join(import.meta.dir, '..', '..', 'lib')),
		...svelteFiles(join(import.meta.dir, '..', '..', 'routes'))
	];
	const files = [...svelte, join(import.meta.dir, '..', '..', 'app.css')];
	// test 3 had NO count floor (issue #481 finding 4): the exact vacuity gap #287 gap 3 added to
	// tests 1 and 2 was left out here. Give it the same real-count floor + which-files sentinel.
	expect(files.length).toBeGreaterThanOrEqual(24);
	assertScanIntact(files);
	const offenders: string[] = [];
	for (const f of files) {
		// strip BOTH comment forms (issue #615 advisory 1): test 3 now scans Svelte markup for
		// `style:animation` directives, and markup comments are `<!-- -->`, not `/* */`. The CSS-only
		// strip left a directive written inside an HTML comment to false-RED; stripAllComments (used by
		// tests 1 and 2 for the same reason) blanks `<!-- -->` and `/* */`, preserving newlines.
		const css = stripAllComments(readFileSync(f, 'utf8'));
		const spans = noPreferenceSpans(css);
		const rules = ruleBlocks(css);
		const resetSelectors = reduceResetSelectors(css, rules);
		// match `animation:` / `animation-name:` shorthand declarations (not @keyframes, not the guard media queries)
		// The boundary class carries `"` and `'` so an inline `style="animation: …"` in markup is seen
		// (issue #590 §2): the char before `animation` in a style attribute is the opening/closing quote
		// of a prior declaration or the attribute itself, which start-of-string, `;`, `{` and whitespace
		// all miss. When that boundary char is a quote the declaration lives in an inline attribute, which
		// no `@media` wrapper or reduce reset can ever cover — so it is reported directly.
		for (const m of css.matchAll(/(^|[;{"'\s])(?:-(?:webkit|moz)-)?animation(-name)?:\s*([^;}]+)/g)) {
			const value = m[3]!.trim();
			if (/^none\b/.test(value)) continue; // the reset itself
			const at = m.index! + m[1]!.length;
			if (m[1] === '"' || m[1] === "'") {
				// an inline style attribute — no media wrapper or reduce reset applies to it, so it can
				// never honour Reduce Motion (issue #590 §2).
				offenders.push(
					`${f}: animation in an inline style attribute (cannot honour Reduce Motion): ${value.slice(0, 40)}`
				);
				continue;
			}
			const guarded = spans.some(([s, e]) => at >= s && at < e);
			// exempt only when the declaration's OWN selector has a reduce reset (issue #242): a reset
			// for one selector no longer waves the whole file through. A grouped owner `.a, .b` is
			// exempt only if EVERY part is reset — a partial reset does not cover the whole rule.
			// Each part's reset must ALSO sit AFTER the animation in source order (issue #337): a reset
			// placed above the rule it means to defeat loses the cascade at equal specificity, so it is
			// not coverage even though it names the selector. `resetSelectors` maps selector -> reset
			// offset; `> at` is the cascade-wins test.
			const owner = owningSelector(rules, at);
			const reset =
				owner !== null &&
				owner.split(',').every((sel) => {
					const resetAt = resetSelectors.get(normSelector(sel));
					return resetAt !== undefined && resetAt > at;
				});
			if (!guarded && !reset) offenders.push(`${f}: unguarded animation: ${value.slice(0, 40)}`);
		}
		// Svelte's `style:animation` / `style:animation-name` directive is the SAME inline-style
		// declaration as the quoted `style="animation: …"` attribute above (issue #615 §2), but the char
		// before `animation` there is `:` (the `style:` prefix), which the boundary class above misses, so
		// it escapes the scan entirely. Like any inline style it can never be covered by an `@media`
		// wrapper or a reduce reset, so route it into the SAME direct-report branch #590 §2 built, with the
		// SAME message text — two spellings of one defect must not read as two different causes.
		// The match is VALUE-AGNOSTIC (issue #615 advisory 2): Svelte writes a directive four ways —
		// `style:animation="…"`, `style:animation='…'`, the expression form `style:animation={expr}`, and
		// the shorthand `style:animation` (reads a same-named variable). All four set a real inline
		// animation, so match the property name and report UNLESS the value is provably `none` — pinning one
		// quoted spelling and waving the expression form through would just be a narrower version of the
		// same hole this issue exists to close.
		for (const m of css.matchAll(/style:animation(?:-name)?(?:=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g)) {
			const value = (m[1] ?? m[2] ?? m[3] ?? '').trim();
			if (/^none\b/.test(value) || /^'none'$|^"none"$/.test(value)) continue; // the reset itself
			offenders.push(
				`${f}: animation in an inline style attribute (cannot honour Reduce Motion): ${(value || '<shorthand>').slice(0, 40)}`
			);
		}
		// Svelte's OWN motion API — the `transition:` / `in:` / `out:` / `animate:` directives — is unread
		// by every CSS-declaration scan (issue #648 §1). These are NOT CSS: Svelte compiles them to a
		// runtime-generated keyframes rule plus an inline `animation`, so the animated property list cannot
		// be recovered from the call site (`slide` animates height/padding/margin/border — none composited),
		// and the transition runtime never consults `prefers-reduced-motion`, so a directive runs at full
		// motion under Reduce Motion unless hand-gated — the #148 defect in another spelling. Like an inline
		// style, no `@media` wrapper or reduce reset can cover a directive, so the DIRECTIVE is what is
		// rejected (not its properties, which do not exist in source), in the same direct-report shape
		// #590 §2 / #615 §2 built. `transition:` alone was previously caught by ACCIDENT (test 1's CSS scan
		// had no left boundary and misread the function name `slide` as a property); §2 moved that scan to
		// tag-stripped text, so THIS scan is what replaces it, with a message that names the DIRECTIVE.
		// Scan MARKUP ONLY: strip `<style>…</style>` first, so a compact CSS `transition:transform` can
		// never be misread as a directive (`animate:`/`in:`/`out:` have no CSS form; only `transition:`
		// overlaps CSS, and the strip resolves it). Match the four prefixes on a markup boundary with a
		// function-name letter after the colon; modifier/parameter forms (`transition:slide|global`,
		// `in:fly={{ y: 200 }}`) share this prefix and are caught too.
		if (f.endsWith('.svelte')) {
			const markup = css.replace(/<style[\s\S]*?<\/style>/gi, '');
			for (const m of markup.matchAll(/(^|\s)(transition|in|out|animate):([a-z][a-zA-Z0-9]*)/g)) {
				offenders.push(`${f}: Svelte motion directive (cannot honour Reduce Motion): ${m[2]}:${m[3]}`);
			}
		}
	}
	expect(offenders).toEqual([]);
});
