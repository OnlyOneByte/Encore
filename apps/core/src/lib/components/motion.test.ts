// guard: animations/transitions must be GPU-composited (transform/opacity/background/
// color/box-shadow only) — NEVER layout-triggering props (width/height/top/left/margin), which
// cause jank. Source-scan every .svelte + .css file under src/ (incl. src/lib/tv, src/lib/ui and
// src/app.css, the shared design system). See docs/ARCHITECTURE.md.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) out.push(...svelteFiles(p));
		else if (ent.name.endsWith('.svelte')) out.push(p);
	}
	return out;
}

// every .svelte AND .css file under a directory — the CSS lives in both component <style> blocks
// and the shared design system (src/app.css), so a scan restricted to .svelte is blind to app.css.
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
// (issue #287 gap 1 / #290 :55,:67). Test 3 keeps the CSS-only stripComments — its scan is CSS-scoped.
function stripAllComments(src: string): string {
	return src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// extract EVERY property animated by each `transition:` shorthand or `transition-property:` longhand.
// A shorthand may list several comma-separated animations (`transform 0.2s, height 0.2s`), each of
// whose FIRST identifier is the animated property — so we cannot read only the first token of the
// declaration. The longhand `transition-property: a, b` lists bare property names directly.
function animatedProps(css: string): string[] {
	const props: string[] = [];
	// captures both the shorthand and the longhand; the value after the colon runs to `;` or `}`.
	for (const m of css.matchAll(/transition(-property)?:\s*([^;}]+)/g)) {
		for (const entry of m[2]!.split(',')) {
			// the property is the FIRST identifier of each comma entry (timing/easing follow it in the
			// shorthand; the longhand lists bare property names, so the same rule reads both)
			const id = entry.trim().match(/^[a-z-]+/);
			if (!id) continue;
			if (id[0] === 'none') continue; // `transition: none` animates nothing
			props.push(id[0]);
		}
	}
	return props;
}

test('no transition animates a layout-triggering property (transform/opacity only)', () => {
	// scan every .svelte + .css under src/ — including src/lib/tv, src/lib/ui and src/app.css
	const files = styleFiles(join(import.meta.dir, '..', '..'));
	// count floor (issue #287 gap 3): a directory rename / moved src / glob typo would make this
	// scan pass VACUOUSLY. Pin it around the current scanned-file count (16 today) so a broken walk
	// reds instead of silently passing — the exact failure mode #140 shipped under.
	expect(files.length).toBeGreaterThanOrEqual(12);
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
	const re = /@keyframes[^{]*\{/g;
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
	expect(files.length).toBeGreaterThanOrEqual(12);
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
function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, '');
}
// spans of every `@media (prefers-reduced-motion: no-preference)` block, as [start, end) offsets
function noPreferenceSpans(css: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	const re = /@media[^{]*prefers-reduced-motion:\s*no-preference[^{]*\{/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(css))) {
		// walk braces from the opening `{` to its match
		let depth = 1;
		let i = m.index + m[0].length;
		for (; i < css.length && depth > 0; i++) {
			if (css[i] === '{') depth++;
			else if (css[i] === '}') depth--;
		}
		spans.push([m.index, i]);
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
			const reduce =
				(stack.length ? stack[stack.length - 1]!.reduce : false) ||
				isUnconditionalReduce(prelude);
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
	const offenders: string[] = [];
	for (const f of files) {
		const css = stripComments(readFileSync(f, 'utf8'));
		const spans = noPreferenceSpans(css);
		const rules = ruleBlocks(css);
		const resetSelectors = reduceResetSelectors(css, rules);
		// match `animation:` / `animation-name:` shorthand declarations (not @keyframes, not the guard media queries)
		for (const m of css.matchAll(/(^|[;{\s])animation(-name)?:\s*([^;}]+)/g)) {
			const value = m[3]!.trim();
			if (/^none\b/.test(value)) continue; // the reset itself
			const at = m.index! + m[1]!.length;
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
	}
	expect(offenders).toEqual([]);
});
