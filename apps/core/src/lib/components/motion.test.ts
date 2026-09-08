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
function animatedProps(css: string, isSvelte: boolean): string[] {
	const props: string[] = [];
	for (const id of transitionPropsInStylesheet(css, isSvelte)) props.push(id);
	if (isSvelte) for (const id of inlineTransitionProps(css)) props.push(id);
	return props;
}

// REGION SPLIT (issue #699). The #648 CSS-vs-markup discriminator was LEXICAL, not regional: it
// blanked every tag (a less-than-to-greater-than strip) then boundary-scanned the result. That class
// was UNBOUNDED, so ONE less-than anywhere in a stylesheet blanked every transition: up to the next
// greater-than, dropping test 1 primary layout catch for the rest of the file (issue #699 finding 1).
// A stylesheet body and Svelte markup are different REGIONS, not different lexical shapes: partition
// by region and scan each with the rule that fits it. The stylesheet scan then never sees a less-than
// to blank nor a directive to misread; the markup scan reads inline motion in every delimiter.

// The stylesheet region: for a .svelte source, the concatenated bodies of its style blocks; a .css
// source is entirely CSS. Comments are stripped by the caller; the transition scan is boundaried.
function stylesheetRegion(css: string, isSvelte: boolean): string {
	if (!isSvelte) return css;
	const bodies: string[] = [];
	for (const m of css.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) bodies.push(m[1]!);
	return bodies.join('\n');
}

// The markup region of a .svelte source: everything with style blocks removed. Inline motion
// (style= attributes in every delimiter, style:transition, or a string built in a script block)
// lives here. Removing only style (not script) is deliberate: a transition string assigned in the
// script block (finding 2, mutant 5) must stay visible to the markup scan.
function markupRegion(css: string): string {
	return css.replace(/<style[\s\S]*?<\/style>/gi, ' ');
}

// Blank the interior of every `style={ … }` attribute, brace-BALANCED (issue #719 advisory a). #699's
// blank used the character class `\{[^}]*\}`, which stops at the FIRST `}` -- in a template literal
// that is the `}` closing an interpolation `${…}`, so the transition-carrying TAIL survived unblanked
// and the directive scan below misread it (same declaration, opposite verdict depending only on an
// earlier interpolation -- the #242/#290/#615/#699 shape). Walk braces from the opening `{` to its
// true match and blank the whole span so no `transition:`/directive text leaks out of a style value.
function blankBalancedStyleBraces(markup: string): string {
	let out = markup;
	const re = /style=\{/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(out))) {
		let depth = 1;
		let i = m.index + m[0].length;
		for (; i < out.length && depth > 0; i++) {
			if (out[i] === '{') depth++;
			else if (out[i] === '}') depth--;
		}
		const end = i; // one past the matching `}`
		out = out.slice(0, m.index) + ' '.repeat(end - m.index) + out.slice(end);
		re.lastIndex = end;
	}
	return out;
}

// CSS transition:/transition-property: layout scan over the STYLESHEET region ONLY. With no markup in
// the region, no directive nor inline style= attribute can reach it, and no less-than exists to blank
// anything (issue #699 finding 1). Read the first identifier of each comma entry.
//
// Vendor prefix (issue #719 finding 1): recognise `-webkit-transition`/`-moz-transition` too. #481's
// scoping decision rested on this scan being "accidentally immune" (its regex once had NO left
// boundary, so `-webkit-transition: width` matched and redded); #648 added the `[;{\s]` boundary and
// killed that immunity, since a boundary class cannot match the `-` that precedes `-webkit-transition`.
// Add the same optional `(?:-(?:webkit|moz)-)?` group that :448 (animation) and :178 (keyframes) already
// carry, so a prefix-only spelling is caught, not just the unprefixed one. iOS Safari is this app's
// phone client and every `-webkit-appearance`/`-webkit-line-clamp` site is written prefix-only.
function transitionPropsInStylesheet(css: string, isSvelte: boolean): string[] {
	const out: string[] = [];
	const region = stylesheetRegion(css, isSvelte);
	for (const m of region.matchAll(/(?:^|[;{\s])(?:-(?:webkit|moz)-)?transition(?:-property)?:\s*([^;}]+)/g)) {
		for (const entry of m[1]!.split(',')) {
			const id = entry.trim().match(/^[a-z-]+/);
			if (!id || id[0] === 'none') continue;
			out.push(id[0]);
		}
	}
	return out;
}

// Inline transition: in the MARKUP region, DELIMITER-AGNOSTIC (issue #699 finding 2). #648 read only a
// quote-delimited style= attribute value, so the braced style={...} form (live on tv/+page.svelte:544
// and LyricsOverlay.svelte:254), a template literal, and a string built in the script block all escaped
// -- the #590/#615 finding-2 class with nothing watching two of its four spellings. Read every
// transition: in the markup regardless of surrounding delimiter: classify when the first identifier is
// a readable CSS property; when opaque (opens with a brace or dollar-brace) report it via the same
// style-transition-directive sentinel the style:transition loop uses. A bare transition: DIRECTIVE
// (a function name, no value colon) is not matched by the value patterns below; test 3 names it.
function inlineTransitionProps(css: string): string[] {
	const out: string[] = [];
	const markup = markupRegion(css);
	// DOM style-object write (issue #719 finding 2): a transition set through the script style object has
	// NO colon after the property name, so neither value scan below (both require `transition:`) can see
	// it -- yet it lands as a real inline style, which no @media wrapper or reduce reset can ever cover.
	// Three spellings: `el.style.transition = ...`, the camelCased `el.style.webkitTransition = ...` /
	// `el.style.transitionProperty = ...`, and `el.style.setProperty('transition', ...)`
	// (this repo already writes setProperty on documentElement.style at routes/+page.svelte:510 and
	// QueueSheet.svelte:60, so a `transition` write is one identifier away from a live idiom). The value
	// is script-computed and opaque at scan time, so report it via the SAME sentinel a braced directive
	// uses -- two spellings of one inline-transition defect must not read as two causes.
	for (const _m of markup.matchAll(/\.style\.(?:transition|webkitTransition|transitionProperty)\s*=/g)) {
		out.push('style-transition-directive');
	}
	for (const _m of markup.matchAll(
		/\.style\.setProperty\(\s*(['"`])(?:-(?:webkit|moz)-)?transition(?:-property)?\1/g
	)) {
		out.push('style-transition-directive');
	}
	// opaque value: transition: immediately followed by an interpolation opener (a brace or dollar-brace).
	// Vendor prefix (issue #719 finding 1): recognise `-webkit-transition`/`-moz-transition` inline too.
	for (const _m of markup.matchAll(/(?<!style)\b(?:-(?:webkit|moz)-)?transition(?:-property)?:\s*[$]?[{]/g)) {
		out.push('style-transition-directive');
	}
	// readable value: transition: then a value up to the next delimiter (; quote backtick brace OR a tag
	// boundary < >). Bounding at the tag boundary (issue #719 finding 3) is what lets a Svelte
	// `transition:<fn>` DIRECTIVE be told from a CSS declaration: a real inline CSS value is delimited by a
	// quote/backtick/brace/semicolon, never by the surrounding element tag, so a value that runs to `>` is
	// a directive, not a declaration.
	for (const m of markup.matchAll(/(?<!style)\b(?:-(?:webkit|moz)-)?transition(?:-property)?:\s*([^;"'`}<>]+)/g)) {
		const readable = m[1]!;
		// A Svelte `transition:<fn>` DIRECTIVE (issue #719 finding 3): the value is a bare identifier (the
		// transition function name) and the char immediately after it is a tag boundary (`>`/`/`) or a
		// directive modifier (`|`). #648 moved directive reporting to test 3's directive scan (:520), which
		// names the DIRECTIVE; #713's markup value scan then ALSO misread the same `slide` as a CSS property,
		// so `<div transition:slide>` redded TWICE (once here as `transition: slide`, once there correctly).
		// Skip it here so test 3 stays its sole, accurate reporter. `transition:color` never doubled only by
		// coincidence (color is composited); slide/fly/fade/blur/scale all tripped it.
		const tail = markup.slice((m.index ?? 0) + m[0].length);
		if (/^[a-z][a-zA-Z0-9]*$/.test(readable.trim()) && /^\s*[>/|]/.test(tail)) continue;
		if (/^[\s]*[{$]/.test(readable)) {
			out.push('style-transition-directive');
			continue;
		}
		let any = false;
		for (const entry of readable.split(',')) {
			const id = entry.trim().match(/^(?:-(?:webkit|moz)-)?([a-z-]+)/);
			if (!id || id[1] === 'none' || id[1] === undefined) continue;
			out.push(id[1]);
			any = true;
		}
		if (!any) out.push('style-transition-directive');
	}
	// Svelte style:transition directive (char after transition is = or nothing), read separately: the
	// value patterns above require a : after transition, which style:transition lacks. Four spellings
	// (issue #615 advisory 2): quoted, single-quoted, ={expr}, bare shorthand; quoted classified, opaque flagged.
	for (const m of markup.matchAll(/style:transition(?:-property)?(?:=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g)) {
		const readable = m[1] ?? m[2] ?? m[3];
		if (readable === undefined || readable.trim() === '') {
			out.push('style-transition-directive');
			continue;
		}
		for (const entry of readable.split(',')) {
			const id = entry.trim().match(/^[a-z-]+/);
			if (!id || id[0] === 'none') continue;
			out.push(id[0]);
		}
	}
	return out;
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
		for (const prop of animatedProps(css, f.endsWith('.svelte'))) {
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
// Vendor prefix (issue #719 advisory c): strip a leading `-webkit-`/`-moz-` before the composited
// lookup, so `-webkit-transform` (an ALLOWED, GPU-composited property) is not falsely condemned. This
// is the mirror of finding 1: there a prefix HID a banned transition, here it CONDEMNED an allowed
// keyframe -- both are the one missing normalisation.
function keyframeProps(body: string): string[] {
	const props: string[] = [];
	for (const m of body.matchAll(/(?:^|[;{\s])([a-z-]+)\s*:/g)) props.push(m[1]!.replace(/^-(?:webkit|moz)-/, ''));
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
		for (const m of css.matchAll(/(^|[;{"'`\s])(?:-(?:webkit|moz)-)?animation(-name)?:\s*([^;}]+)/g)) {
			const value = m[3]!.trim();
			if (/^none\b/.test(value)) continue; // the reset itself
			const at = m.index! + m[1]!.length;
			if (m[1] === '"' || m[1] === "'" || m[1] === '`') {
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
		// DOM style-object animation write (issue #719 finding 2, animation half): `el.style.animation = …`,
		// the camelCased `el.style.webkitAnimation` / `el.style.animationName`, and
		// `el.style.setProperty('animation', …)` set a real inline animation with NO `animation:` colon, so
		// the css.matchAll boundary scan above cannot see them. Like every inline style they can never honour
		// Reduce Motion, so report them through the SAME message #590 §2 built. This is the spelling a
		// transition-only fix would leave uncaught, which is why the issue's gate 7 pins it separately.
		for (const _m of css.matchAll(/\.style\.(?:animation|webkitAnimation|animationName)\s*=/g)) {
			offenders.push(
				`${f}: animation in an inline style attribute (cannot honour Reduce Motion): <style-object write>`
			);
		}
		for (const _m of css.matchAll(/\.style\.setProperty\(\s*(['"`])(?:-(?:webkit|moz)-)?animation(?:-name)?\1/g)) {
			offenders.push(
				`${f}: animation in an inline style attribute (cannot honour Reduce Motion): <style-object write>`
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
			// Advisory (issue #699): blank style= attribute VALUE interiors before the directive scan, so an
			// inline compact style= transition (a space then transition:transform) is not misread as a directive
			// -- a real directive lives in markup OUTSIDE any style= value and survives the blanking.
			const markup = blankBalancedStyleBraces(
				markupRegion(css)
					.replace(/style="[^"]*"/g, (a) => ' '.repeat(a.length))
					.replace(/style='[^']*'/g, (a) => ' '.repeat(a.length))
			);
			for (const m of markup.matchAll(/(^|\s)(transition|in|out|animate):([a-z][a-zA-Z0-9]*)/g)) {
				offenders.push(`${f}: Svelte motion directive (cannot honour Reduce Motion): ${m[2]}:${m[3]}`);
			}
		}
	}
	expect(offenders).toEqual([]);
});
