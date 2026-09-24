// guard: the motion policy. Only GPU-composited properties may animate, every animation honours
// prefers-reduced-motion, and Svelte's motion directives are banned. See docs/GUARDS.md#motion.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { styleFiles, svelteFiles } from '@encore/test-support/scan';
import { at, srcDir } from '@encore/test-support';

// ALLOWLIST: anything animated and absent here reds, so `transition: all` and every layout property
// outside the set is caught without anyone enumerating them.
const COMPOSITED_PROPS = new Set([
	'transform',
	'opacity',
	'background',
	'background-color',
	'background-position', // paint-only, compositor-safe; the shimmer skeleton loader
	'color',
	'box-shadow'
]);

// A scan restricted to .svelte is blind to src/app.css, the shared design system.
function assertScanIntact(files: string[]): void {
	expect(files.some((f) => f.endsWith('app.css'))).toBe(true);
	expect(files.some((f) => f.includes(join('lib', 'tv')) && f.endsWith('.svelte'))).toBe(true);
}

// non-test .ts sources for the utility-name net: a class list can be composed in TypeScript as easily as in markup.
function tsSources(dir: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) out.push(...tsSources(p));
		else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) out.push(p);
	}
	return out;
}

// BOTH comment forms, or a `transition:` in prose inside an HTML comment false-positives.
function stripAllComments(src: string): string {
	return src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// Each comma-separated entry of a `transition:` shorthand names its animated property first.
function animatedProps(css: string, isSvelte: boolean): string[] {
	const props: string[] = [];
	for (const id of transitionPropsInStylesheet(css, isSvelte)) props.push(id);
	if (isSvelte) for (const id of inlineTransitionProps(css)) props.push(id);
	return props;
}

// Regions, not lexical shapes: a discriminator that blanked every tag made one `<` anywhere in a
// stylesheet blank every `transition:` to the next `>`.
/** The stylesheet region: the concatenated <style> bodies of a .svelte source; all of a .css source. */
function stylesheetRegion(css: string, isSvelte: boolean): string {
	if (!isSvelte) return css;
	const bodies: string[] = [];
	for (const m of css.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) bodies.push(m[1]!);
	return bodies.join('\n');
}

/** Style is removed but NOT script: a transition string assigned in the script block stays visible. */
function markupRegion(css: string): string {
	return css.replace(/<style[\s\S]*?<\/style>/gi, ' ');
}

// Brace-BALANCED: a `\{[^}]*\}` class stops at the first `}` — in a template literal the one closing an
// interpolation — leaving the transition-carrying tail unblanked for the directive scan to misread.
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

// STYLESHEET region only, where no directive or inline style= reaches. The `[;{\s]` left boundary cannot
// match the `-` of `-webkit-transition`, and iOS Safari makes prefix-only spellings idiomatic here.
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

// Inline transition in the MARKUP region, DELIMITER-AGNOSTIC: quoted attribute, braced `style={…}`,
// template literal and script-built string are all inline styles no reduce reset can cover. Opaque values
// go through one sentinel, so two spellings of one defect do not read as two causes.
function inlineTransitionProps(css: string): string[] {
	const out: string[] = [];
	const markup = markupRegion(css);
	// DOM style-object writes have NO colon after the property name, so neither value scan below sees them.
	for (const _m of markup.matchAll(/\.style\.(?:transition|webkitTransition|transitionProperty)\s*=/g)) {
		out.push('style-transition-directive');
	}
	for (const _m of markup.matchAll(
		/\.style\.setProperty\(\s*(['"`])(?:-(?:webkit|moz)-)?transition(?:-property)?\1/g
	)) {
		out.push('style-transition-directive');
	}
	// opaque value: `transition:` immediately followed by an interpolation opener.
	for (const _m of markup.matchAll(/(?<!style)\b(?:-(?:webkit|moz)-)?transition(?:-property)?:\s*[$]?[{]/g)) {
		out.push('style-transition-directive');
	}
	// Readable value, bounded at the next delimiter OR a tag boundary: a real inline value ends at a quote,
	// backtick, brace or semicolon and never at the element tag, which is what tells it from a directive.
	for (const m of markup.matchAll(/(?<!style)\b(?:-(?:webkit|moz)-)?transition(?:-property)?:\s*([^;"'`}<>]+)/g)) {
		const readable = m[1]!;
		// A directive's value is a bare identifier followed by `>`/`/`/`|`; skipped so the directive scan stays
		// its sole reporter, instead of `<div transition:slide>` redding twice.
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
	// `style:transition` has no `:` after `transition`, so the patterns above miss it. All four spellings.
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
	const files = styleFiles(srcDir);
	expect(files.length).toBeGreaterThanOrEqual(24); // @nvf-floor files.length
	assertScanIntact(files);
	const offenders: string[] = [];
	for (const f of files) {
		const css = stripAllComments(readFileSync(f, 'utf8'));
		for (const prop of animatedProps(css, f.endsWith('.svelte'))) {
			if (!COMPOSITED_PROPS.has(prop)) offenders.push(`${f}: transition: ${prop}`);
		}
	}
	expect(offenders).toEqual([]);
});

// Brace-depth walk: a `\}\s*\}` terminator let a trailing comment before the close skip the ENTIRE block.
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

// The prefix is STRIPPED before the composited lookup, so `-webkit-transform` is not falsely condemned.
function keyframeProps(body: string): string[] {
	const props: string[] = [];
	for (const m of body.matchAll(/(?:^|[;{\s])([a-z-]+)\s*:/g)) props.push(m[1]!.replace(/^-(?:webkit|moz)-/, ''));
	return props;
}

test('@keyframes animate only GPU-composited properties', () => {
	const files = styleFiles(srcDir);
	expect(files.length).toBeGreaterThanOrEqual(24); // @nvf-floor files.length
	assertScanIntact(files);
	const bad: string[] = [];
	for (const f of files) {
		const css = stripAllComments(readFileSync(f, 'utf8'));
		for (const body of keyframeBodies(css)) {
			for (const prop of keyframeProps(body)) {
				if (!COMPOSITED_PROPS.has(prop)) bad.push(`${f}: keyframe animates ${prop}`);
			}
		}
	}
	expect(bad).toEqual([]);
});

/*
 * The reduced-motion arm; the two accepted shapes are in docs/GUARDS.md#motion. The exemption is
 * SELECTOR-scoped and the reset must sit LATER in source. Caught QueueRow's `.qrow { animation: pop … }`
 * running under Reduce Motion while the guarded helper had no callers.
 */

// A query LIST is an OR, so `(prefers-reduced-motion: no-preference), (min-width: 700px)` fires under
// Reduce Motion on every TV: a list qualifies only when EVERY branch does.
function firesOnlyWhenMotionAllowed(prelude: string): boolean {
	return splitTopLevelCommas(prelude).every(branchFiresOnlyWhenMotionAllowed);
}
// True when a `not` binds to THIS feature rather than a sibling — `… and (not (min-width: 700px))` leaves
// the reduce feature un-negated. Three spellings: `not (…)`, `(not (…))`, MQ3 `not all and (…)`.
function featureIsNegated(prelude: string, featureParenIdx: number): boolean {
	const before = prelude.slice(0, featureParenIdx);
	// MQ4: `not` then only `(`/whitespace — `not (`, `(not (`, `and (not (`
	if (/\bnot\s*\(*\s*$/.test(before)) return true;
	// MQ3: `not all and (`, `not screen and (`
	if (/\bnot\s+[a-z-]+\s+and\s*\(*\s*$/.test(before)) return true;
	return false;
}
/** A non-negated `no-preference` or a NEGATED `reduce` fires only when motion is allowed. */
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
/** TOP-LEVEL commas only — a comma inside `(…)` is not a query-list separator. */
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
type Rule = { selector: string; bodyStart: number; bodyEnd: number; underReduce: boolean };

/** Collapse internal whitespace so `.hero  .qr` and `.hero .qr` compare equal; case is preserved. */
function normSelector(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

// A reset must fire in exactly the reduce state and no narrower one: a substring test accepts a
// `not`-inverted prelude (which fires when motion is ALLOWED) and one gated by `and (min-width: 5000px)`.
function isUnconditionalReduce(prelude: string): boolean {
	if (!/prefers-reduced-motion:\s*reduce/.test(prelude)) return false;
	if (/\bnot\b/.test(prelude)) return false;
	if (/\band\b/.test(prelude)) return false;
	return true;
}

// Flat list of rule blocks: a prelude not starting with `@` is a plain style RULE, and only those own
// `animation:` declarations.
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

// Covered selector -> the source OFFSET of its reset body. A media query adds no specificity, so the
// LATER declaration wins and a reset above the animation it defeats is not coverage. The EARLIEST offset
// is recorded, since a later reset cannot rescue what the earliest fails to cover.
function reduceResetSelectors(css: string, rules: Rule[]): Map<string, number> {
	const covered = new Map<string, number>();
	for (const r of rules) {
		if (!r.underReduce) continue;
		const body = css.slice(r.bodyStart, r.bodyEnd);
		// a reset may group selectors: `.a, .b, .c { animation: none }` covers each
		if (/animation(-name)?:\s*none/.test(body))
			for (const sel of r.selector.split(',')) {
				const key = normSelector(sel);
				const prev = covered.get(key);
				if (prev === undefined || r.bodyStart < prev) covered.set(key, r.bodyStart);
			}
	}
	return covered;
}

/** The innermost plain rule whose body contains offset `at`. */
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
	const svelte = [...svelteFiles(at('src/lib')), ...svelteFiles(at('src/routes'))];
	const files = [...svelte, at('src/app.css')];
	expect(files.length).toBeGreaterThanOrEqual(24); // @nvf-floor files.length
	assertScanIntact(files);
	const offenders: string[] = [];
	for (const f of files) {
		const css = stripAllComments(readFileSync(f, 'utf8'));
		const spans = noPreferenceSpans(css);
		const rules = ruleBlocks(css);
		const resetSelectors = reduceResetSelectors(css, rules);
		// The boundary class carries `"` and `'` so an inline `style="animation: …"` is seen — a quote boundary
		// means the declaration is inline, which no wrapper or reset can cover.
		for (const m of css.matchAll(/(^|[;{"'`\s])(?:-(?:webkit|moz)-)?animation(-name)?:\s*([^;}]+)/g)) {
			const value = m[3]!.trim();
			if (/^none\b/.test(value)) continue; // the reset itself
			const at = m.index! + m[1]!.length;
			if (m[1] === '"' || m[1] === "'" || m[1] === '`') {
				offenders.push(
					`${f}: animation in an inline style attribute (cannot honour Reduce Motion): ${value.slice(0, 40)}`
				);
				continue;
			}
			const guarded = spans.some(([s, e]) => at >= s && at < e);
			// Exempt only when the OWN selector's reset sits AFTER it; a grouped owner only if EVERY part is covered.
			const owner = owningSelector(rules, at);
			const reset =
				owner !== null &&
				owner.split(',').every((sel) => {
					const resetAt = resetSelectors.get(normSelector(sel));
					return resetAt !== undefined && resetAt > at;
				});
			if (!guarded && !reset) offenders.push(`${f}: unguarded animation: ${value.slice(0, 40)}`);
		}
		// `style:animation` puts a `:` before `animation`, which the boundary class misses. VALUE-AGNOSTIC across
		// all four spellings: pinning one quoted form leaves the expression form a hole.
		for (const m of css.matchAll(/style:animation(?:-name)?(?:=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g)) {
			const value = (m[1] ?? m[2] ?? m[3] ?? '').trim();
			if (/^none\b/.test(value) || /^'none'$|^"none"$/.test(value)) continue; // the reset itself
			offenders.push(
				`${f}: animation in an inline style attribute (cannot honour Reduce Motion): ${(value || '<shorthand>').slice(0, 40)}`
			);
		}
		// DOM style-object writes set a real inline animation with NO `animation:` colon.
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
		// Svelte's `transition:`/`in:`/`out:`/`animate:` are BANNED: they compile to a runtime keyframes rule
		// plus an inline animation, and the runtime never consults prefers-reduced-motion. MARKUP ONLY with
		// style= values blanked, so a compact inline `transition:transform` is not misread as a directive.
		if (f.endsWith('.svelte')) {
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

/*
 * The utility-class arm. `class="transition-all"` puts no `transition:` anywhere in source, so without a
 * NAME ban the whole motion policy stops being enforced rather than failing. Each key is resolved against
 * COMPOSITED_PROPS, so an unknown one is an OFFENDER; the response to a red is adding the property there.
 */

// Built-in `transition-*` keys plus the layout-hazard keys a config can mint. `all` resolves to the
// pseudo-property `all`, never composited — that is how `transition-all` reds.
const UTILITY_TRANSITION_PROPS: Record<string, string[]> = {
	// built-ins
	'': ['color', 'background-color', 'border-color', 'opacity', 'box-shadow', 'transform', 'filter'],
	none: [],
	all: ['all'],
	colors: ['color', 'background-color', 'border-color', 'fill', 'stroke'],
	opacity: ['opacity'],
	shadow: ['box-shadow'],
	transform: ['transform'],
	// layout-hazard keys
	width: ['width'],
	height: ['height'],
	spacing: ['margin', 'padding'],
	inset: ['inset'],
	margin: ['margin'],
	padding: ['padding'],
	gap: ['gap'],
	flex: ['flex']
};

// A motion utility of any family: `transition-*`, `animate-*`, and the timing families.
const MOTION_UTILITY = /^(?:transition|animate|duration|ease|delay)(?:-[a-zA-Z0-9[\]./%_-]+)?$/;

/** Judge ONE tokenised class list. `UNRESOLVED` is the extractor's sentinel for an unreadable expression. */
function utilityOffenders(tokens: string[]): string[] {
	const out: string[] = [];
	const motion = tokens.filter((t) => MOTION_UTILITY.test(t));
	// A fully-composited transition means the timing utilities beside it are tuning it, not findings.
	const allowedTransition = motion.some((t) => {
		if (!/^transition(-|$)/.test(t)) return false;
		const key = t === 'transition' ? '' : t.slice('transition-'.length);
		const props = UTILITY_TRANSITION_PROPS[key];
		return props !== undefined && props.every((p) => COMPOSITED_PROPS.has(p));
	});
	for (const t of tokens) {
		if (t === 'UNRESOLVED') {
			out.push('unresolvable class expression (a motion utility here would be invisible)');
			continue;
		}
		if (!MOTION_UTILITY.test(t)) continue;
		if (/^transition(-|$)/.test(t)) {
			const key = t === 'transition' ? '' : t.slice('transition-'.length);
			const props = UTILITY_TRANSITION_PROPS[key];
			if (props === undefined) {
				out.push(`unknown transition utility \`${t}\` — cannot resolve which property it animates`);
				continue;
			}
			for (const p of props) {
				if (!COMPOSITED_PROPS.has(p)) out.push(`utility \`${t}\` animates ${p}`);
			}
			continue;
		}
		if (/^animate(-|$)/.test(t)) {
			// No wrapper or reset can cover a keyframes animation applied from a class.
			out.push(`utility \`${t}\` applies a keyframes animation that cannot honour Reduce Motion`);
			continue;
		}
		// duration/ease/delay are inert alone; reported only when nothing in the list says WHAT they time.
		if (!allowedTransition) out.push(`timing utility \`${t}\` with no resolvable transition property`);
	}
	return out;
}

/** Split a literal class value into tokens, marking each unreadable `{…}` interpolation. */
function classTokens(value: string): string[] {
	const out: string[] = [];
	// Every string literal in an interpolation, so `{a ? 'x' : 'y'}` contributes x and y.
	let rest = value;
	for (const m of value.matchAll(/\{([\s\S]*?)\}/g)) {
		const expr = m[1]!;
		const lits = [...expr.matchAll(/'([^']*)'|"([^"]*)"|`([^`$]*)`/g)].map((l) => l[1] ?? l[2] ?? l[3] ?? '');
		for (const l of lits) out.push(...l.split(/\s+/).filter(Boolean));
		// A CALL or CONCATENATION is how a utility list is composed, so it must be readable or reported. A bare
		// identifier is a value from the component's own domain, exempt by name and kept honest by the net below.
		const composed = /[(+]|\$\{/.test(expr);
		if (composed && lits.length === 0) out.push('UNRESOLVED');
		rest = rest.replace(m[0]!, ' ');
	}
	out.push(...rest.split(/\s+/).filter(Boolean));
	return out;
}

/** Every class list in a Svelte source, from each of the four spellings a class can be written in. */
function classLists(markup: string): { where: string; tokens: string[] }[] {
	const out: { where: string; tokens: string[] }[] = [];
	// quoted attribute, both delimiters, interpolations included
	for (const m of markup.matchAll(/\bclass=("([^"]*)"|'([^']*)')/g)) {
		out.push({ where: 'class attribute', tokens: classTokens(m[2] ?? m[3] ?? '') });
	}
	// the whole-expression form — Tailwind's composition site. No literal means UNRESOLVED, never skipped.
	for (const m of markup.matchAll(/\bclass=\{([\s\S]*?)\}/g)) {
		const expr = m[1]!;
		const lits = [...expr.matchAll(/'([^']*)'|"([^"]*)"|`([^`$]*)`/g)].map((l) => l[1] ?? l[2] ?? l[3] ?? '');
		const tokens = lits.flatMap((l) => l.split(/\s+/).filter(Boolean));
		out.push({ where: 'class={…} expression', tokens: tokens.length ? tokens : ['UNRESOLVED'] });
	}
	// the `class:name` directive — the token IS the class name
	for (const m of markup.matchAll(/\bclass:([a-zA-Z0-9_-]+)/g)) {
		out.push({ where: 'class: directive', tokens: [m[1]!] });
	}
	return out;
}

test('no utility class expresses motion the declaration scans cannot see', () => {
	const svelte = [...svelteFiles(at('src/lib')), ...svelteFiles(at('src/routes'))];
	expect(svelte.length).toBeGreaterThanOrEqual(20); // @nvf-floor svelte.length
	expect(svelte.some((f) => f.includes(join('lib', 'tv')))).toBe(true);

	/*
	 * THE ONE NAMED EXEMPTION, scoped to `ui/**` by PATH: a copied-in shadcn component computes its class list
	 * through `tailwind-variants` at runtime, so every static extractor reports it as UNRESOLVED. It costs no
	 * coverage, because the name net below greps `tv()` variant strings too — where the stock Button carries it.
	 */
	const UI_COPY_IN = join('lib', 'components', 'ui') + sep;
	const offenders: string[] = [];
	for (const f of svelte) {
		const isCopyIn = f.includes(UI_COPY_IN);
		const markup = markupRegion(stripAllComments(stripAllComments(readFileSync(f, 'utf8'))));
		for (const { where, tokens } of classLists(markup)) {
			for (const o of utilityOffenders(tokens)) {
				if (isCopyIn && o.startsWith('unresolvable class expression')) continue;
				offenders.push(`${f}: ${where}: ${o}`);
			}
		}
	}
	expect(offenders).toEqual([]);
	// If `ui/**` stops being scanned the skip is unnecessary and this arm has quietly narrowed.
	expect(svelte.some((f) => f.includes(UI_COPY_IN))).toBe(true);
});

test('no motion utility name appears anywhere in source, in any position', () => {
	// THE NET, and why the extractor above may take a named exemption: a class list can be composed in a
	// `.ts` constant or a `classList.add`, but the NAMES not occurring in source at all is decidable.
	const netFiles = [...svelteFiles(at('src/lib')), ...svelteFiles(at('src/routes')), ...tsSources(at('src/lib'))];
	expect(netFiles.length).toBeGreaterThanOrEqual(40); // @nvf-floor netFiles.length

	// Only unambiguous names: a bare `duration-`/`ease-` is ordinary English the extractor judges in context.
	const LAYOUT_KEYS = Object.keys(UTILITY_TRANSITION_PROPS).filter(
		(k) => k !== '' && k !== 'none' && !UTILITY_TRANSITION_PROPS[k]!.every((p) => COMPOSITED_PROPS.has(p))
	);
	const NET = new RegExp(String.raw`\b(?:transition-(?:${LAYOUT_KEYS.join('|')})|animate-[a-z][a-zA-Z0-9-]*)\b`, 'g');
	expect(LAYOUT_KEYS).toContain('all');
	expect(LAYOUT_KEYS.length).toBeGreaterThanOrEqual(8);

	const offenders: string[] = [];
	for (const f of netFiles) {
		for (const m of stripAllComments(stripAllComments(readFileSync(f, 'utf8'))).matchAll(NET)) {
			offenders.push(`${f}: motion utility name \`${m[0]}\` in source`);
		}
	}
	expect(offenders).toEqual([]);
});

test('stripAllComments hides a utility named in prose and keeps one written in code', () => {
	// The name-scanning arms read through the stripper, so a component may DOCUMENT a removed utility —
	// safe only while the stripper touches comments and nothing else.
	const inComment = '<!-- we deleted transition-all here -->\n<div class="grid"></div>';
	expect(stripAllComments(inComment)).not.toContain('transition-all');
	expect(stripAllComments(inComment)).toContain('grid');

	const inBlockComment = '/* transition-colors was removed */\nconst c = "flex";';
	expect(stripAllComments(inBlockComment)).not.toContain('transition-colors');
	expect(stripAllComments(inBlockComment)).toContain('flex');

	const inCode = '<div class="transition-all grid"></div>';
	expect(stripAllComments(inCode)).toContain('transition-all');
});
