// guard: the motion policy. Only GPU-composited properties may animate, every animation honours
// prefers-reduced-motion, and Svelte's motion directives are banned. See docs/GUARDS.md#motion.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { styleFiles, svelteFiles } from '@encore/test-support/scan';
import { at, srcDir } from '@encore/test-support';

// ALLOWLIST, not a denylist: anything animated that is not here reds, so `transition: all` and every
// layout property outside a fixed list (max-height, inset, gap, flex-basis, font-size, …) is caught
// without anyone having to enumerate them.
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

// BOTH comment forms: these tests read whole .svelte files, so a `transition:` in prose inside an HTML
// comment must not false-positive.
function stripAllComments(src: string): string {
	return src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// Every property animated by a `transition:` shorthand or `transition-property:` longhand. A shorthand may
// list several comma-separated animations, each of whose FIRST identifier is the animated property.
function animatedProps(css: string, isSvelte: boolean): string[] {
	const props: string[] = [];
	for (const id of transitionPropsInStylesheet(css, isSvelte)) props.push(id);
	if (isSvelte) for (const id of inlineTransitionProps(css)) props.push(id);
	return props;
}

/**
 * A stylesheet body and Svelte markup are different REGIONS, not different lexical shapes, so each is
 * scanned with the rule that fits it. A lexical discriminator that blanked every tag meant ONE `<` anywhere
 * in a stylesheet blanked every `transition:` to the next `>`.
 */
/** The stylesheet region: the concatenated <style> bodies of a .svelte source; all of a .css source. */
function stylesheetRegion(css: string, isSvelte: boolean): string {
	if (!isSvelte) return css;
	const bodies: string[] = [];
	for (const m of css.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) bodies.push(m[1]!);
	return bodies.join('\n');
}

/** The markup region. Removing style but NOT script is deliberate: a transition string assigned in the
 *  script block must stay visible to the markup scan. */
function markupRegion(css: string): string {
	return css.replace(/<style[\s\S]*?<\/style>/gi, ' ');
}

/**
 * Blank the interior of every `style={ … }` attribute, brace-BALANCED: a `\{[^}]*\}` class stops at the first
 * `}`, which in a template literal is the one closing an interpolation, so the transition-carrying tail
 * survived unblanked and the directive scan misread it.
 */
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

// The CSS scan, over the STYLESHEET region only, where no directive or inline style= can reach it. Vendor
// prefixes are recognised because the `[;{\s]` left boundary cannot match the `-` of `-webkit-transition`,
// and iOS Safari is this app's phone client, so prefix-only spellings are idiomatic.
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

// Inline transition in the MARKUP region, DELIMITER-AGNOSTIC: a quoted attribute, the braced `style={…}`
// form, a template literal and a string built in the script block are all real inline styles, and no
// @media wrapper or reduce reset can ever cover one. Readable values are classified; opaque ones go through
// one sentinel, so two spellings of a single defect do not read as two causes.
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
	// readable value, bounded at the next delimiter OR a tag boundary — which is what tells a Svelte
	// `transition:<fn>` DIRECTIVE from a CSS declaration, since a real inline value is delimited by a
	// quote, backtick, brace or semicolon and never by the surrounding element tag.
	for (const m of markup.matchAll(/(?<!style)\b(?:-(?:webkit|moz)-)?transition(?:-property)?:\s*([^;"'`}<>]+)/g)) {
		const readable = m[1]!;
		// A directive's value is a bare identifier followed by `>`/`/`/`|`. Skipped here so the directive scan below stays
		// its sole reporter — otherwise `<div transition:slide>` reds twice, once misread as a CSS property named `slide`.
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
	// `style:transition` has no `:` after `transition`, so the patterns above cannot see it. All four
	// spellings: quoted, single-quoted, ={expr}, bare shorthand.
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
	// A directory rename, a moved src/ or a glob typo would make this pass VACUOUSLY.
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

// Brace-depth walk rather than a `\}\s*\}` terminator, which required two braces separated by whitespace
// only — so a trailing comment before the block's close made the regex skip the ENTIRE block.
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

// The prefix is STRIPPED before the composited lookup, so `-webkit-transform` is not falsely condemned —
// the mirror of the transition scan, where a prefix could HIDE a banned property.
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
 * The reduced-motion arm. An animation is suppressible if it is EITHER inside an
 * `@media (prefers-reduced-motion: no-preference)` block OR paired with an unconditional
 * `@media (prefers-reduced-motion: reduce) { … animation: none }` reset covering ITS OWN selector, later in
 * source. The exemption is SELECTOR-scoped, so a new unguarded animation in the same file still reds.
 * QueueRow's `.qrow { animation: pop … }` ran under Reduce Motion while the guarded helper had no callers.
 */

/**
 * True when a prelude fires ONLY when motion is allowed. A query LIST is an OR, so
 * `(prefers-reduced-motion: no-preference), (min-width: 700px)` fires under Reduce Motion on any ≥700px
 * viewport — and every TV is one — so a list qualifies only when EVERY branch does.
 */
function firesOnlyWhenMotionAllowed(prelude: string): boolean {
	return splitTopLevelCommas(prelude).every(branchFiresOnlyWhenMotionAllowed);
}
/**
 * True when a `not` negates the prefers-reduced-motion feature opening at `featureParenIdx` — i.e. binds to
 * THIS feature rather than a sibling (`(prefers-reduced-motion: no-preference) and (not (min-width: 700px))`
 * leaves the reduce feature un-negated). Three spellings: `not (…)`, `(not (…))`, MQ3 `not all and (…)`.
 */
function featureIsNegated(prelude: string, featureParenIdx: number): boolean {
	const before = prelude.slice(0, featureParenIdx);
	// MQ4: `not` then only `(`/whitespace — `not (`, `(not (`, `and (not (`
	if (/\bnot\s*\(*\s*$/.test(before)) return true;
	// MQ3: `not all and (`, `not screen and (`
	if (/\bnot\s+[a-z-]+\s+and\s*\(*\s*$/.test(before)) return true;
	return false;
}
/** One comma-branch: a non-negated `no-preference` or a NEGATED `reduce` fires only when motion is
 *  allowed, and the two mirror cases fire under Reduce Motion. */
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

/**
 * A reset only wins when the OS asks for reduced motion, so its @media must fire in exactly that state and
 * no narrower one. A substring test accepts two preludes CSS discards: a `not`-inverted one (fires when
 * motion is ALLOWED) and one gated by `and (min-width: 5000px)`.
 */
function isUnconditionalReduce(prelude: string): boolean {
	if (!/prefers-reduced-motion:\s*reduce/.test(prelude)) return false;
	if (/\bnot\b/.test(prelude)) return false;
	if (/\band\b/.test(prelude)) return false;
	return true;
}

/**
 * Forward-scan into a flat list of rule blocks, keeping a stack of open blocks with the prelude that opened each. A
 * block is a plain style RULE when its prelude does not start with `@`, and only those own `animation:` declarations.
 */
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

/**
 * Covered selector -> the source OFFSET of its reset body. A media query adds no specificity, so the LATER
 * declaration wins and a reset placed above the animation it means to defeat is not coverage. The EARLIEST
 * offset is recorded, since a later reset cannot rescue an animation the earliest already fails to cover.
 */
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
		// The boundary class carries `"` and `'` so an inline `style="animation: …"` is seen: the char before
		// `animation` there is a quote, which `^`, `;`, `{` and whitespace all miss. A quote boundary means
		// the declaration is inline, which no wrapper or reset can cover, so it is reported directly.
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
			// Exempt only when the declaration's OWN selector has a reset that sits AFTER it, and a grouped
			// owner `.a, .b` only if EVERY part is covered.
			const owner = owningSelector(rules, at);
			const reset =
				owner !== null &&
				owner.split(',').every((sel) => {
					const resetAt = resetSelectors.get(normSelector(sel));
					return resetAt !== undefined && resetAt > at;
				});
			if (!guarded && !reset) offenders.push(`${f}: unguarded animation: ${value.slice(0, 40)}`);
		}
		// `style:animation` is the same inline declaration, but the char before `animation` is the `:` of the
		// `style:` prefix, which the boundary class misses. Same message, and VALUE-AGNOSTIC across all four
		// spellings: pinning one quoted form and waving the expression form through is a narrower hole.
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
		// Svelte's own motion API — `transition:` / `in:` / `out:` / `animate:` — is unread by every CSS-declaration scan
		// and is BANNED: it compiles to a runtime keyframes rule plus an inline animation, so the animated property list
		// cannot be recovered from the call site (`slide` animates height/padding/margin/border, none composited) and the
		// runtime never consults prefers-reduced-motion. The DIRECTIVE is rejected, not its properties, which do not exist
		// in source. MARKUP ONLY with style= values blanked, so a compact inline `transition:transform` cannot be misread
		// as one; a real directive survives the blanking.
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
 * The utility-class arm. Every scan above reads a CSS DECLARATION or a Svelte DIRECTIVE, and a
 * Tailwind-style utility expresses the same motion with NEITHER — `class="transition-all"` puts no
 * `transition:` anywhere in source — so the moment utilities enter the tree the ban above silently stops
 * being enforced rather than failing, and a guard that stops biting must go red.
 *
 * ALLOWLIST, like the rest of the file: a `transition-x` utility is resolved to the properties it animates
 * and each looked up in COMPOSITED_PROPS, so an UNKNOWN key is an OFFENDER rather than a skip, and a
 * utility resolving to a real property outside the set reds and NAMES it — whose correct response is adding
 * the property to COMPOSITED_PROPS, never deleting this arm.
 */

// Tailwind's built-in `transition-*` keys plus the layout-hazard keys a config can mint. `all` resolves to
// the pseudo-property `all`, which is never composited — that is how `transition-all` reds.
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

/** Judge ONE tokenised class list. `UNRESOLVED` is the sentinel the extractor pushes for an expression it
 *  could not read, and it is reported rather than dropped, which is the whole point. */
function utilityOffenders(tokens: string[]): string[] {
	const out: string[] = [];
	const motion = tokens.filter((t) => MOTION_UTILITY.test(t));
	// A transition utility whose properties are ALL composited means the timing utilities beside it are
	// tuning an allowed transition rather than being findings themselves.
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
			// No wrapper or reset can cover a keyframes animation applied from a class, so the UTILITY is
			// rejected — the same argument as an inline `style="animation: …"`.
			out.push(`utility \`${t}\` applies a keyframes animation that cannot honour Reduce Motion`);
			continue;
		}
		// duration/ease/delay are inert alone and correct beside an allowed transition, so they are reported
		// only when nothing in the list says WHAT they are timing.
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
		// A CALL or CONCATENATION is the shape a utility list is composed with, so it must be readable or
		// reported. A bare identifier or member access is a value from the component's own closed domain and
		// is exempt by name; the whole-source net below keeps that honest, since a utility list assigned to
		// such a variable is still a source literal.
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
	// the whole-expression form — Tailwind's composition site. An expression yielding NO literal is
	// UNRESOLVED, never skipped.
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
	 * THE ONE NAMED EXEMPTION. A copied-in shadcn component computes its class list because `tailwind-variants` resolves
	 * at runtime, so NO static extractor can read it and this arm reports every such component as UNRESOLVED — correct,
	 * and unactionable, since satisfying it means hand-inlining every variant back into markup.
	 *
	 * It costs no COVERAGE, only the precise message: the net arm below greps every `.svelte` and `.ts`
	 * source for the utility NAMES in any position, including inside a `tv()` variant string, which is
	 * exactly where a copied component would carry `transition-all` (the stock Button ships it). Scoped to
	 * `ui/**` by PATH, because anywhere else a computed class list is a place to hide.
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
	// THE NET, and the reason the extractor above may take a named exemption: a class list can be composed
	// anywhere — a `.ts` constant, a `classList.add`, a component prop — and no extractor sees every
	// spelling, while what IS decidable is that these NAMES do not occur in source at all.
	const netFiles = [...svelteFiles(at('src/lib')), ...svelteFiles(at('src/routes')), ...tsSources(at('src/lib'))];
	expect(netFiles.length).toBeGreaterThanOrEqual(40); // @nvf-floor netFiles.length

	// Only unambiguous names. A bare `duration-`/`ease-` is deliberately out: those are ordinary English
	// fragments the extractor judges in context.
	const LAYOUT_KEYS = Object.keys(UTILITY_TRANSITION_PROPS).filter(
		(k) => k !== '' && k !== 'none' && !UTILITY_TRANSITION_PROPS[k]!.every((p) => COMPOSITED_PROPS.has(p))
	);
	const NET = new RegExp(String.raw`\b(?:transition-(?:${LAYOUT_KEYS.join('|')})|animate-[a-z][a-zA-Z0-9-]*)\b`, 'g');
	// The net must have something to look for.
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
	// The two name-scanning arms read through the stripper, so a component may DOCUMENT that it removed a
	// motion utility. That is only safe while the stripper touches comments and nothing else: widened into
	// markup or a class attribute, both arms go quietly green on a real offender.
	const inComment = '<!-- we deleted transition-all here -->\n<div class="grid"></div>';
	expect(stripAllComments(inComment)).not.toContain('transition-all');
	expect(stripAllComments(inComment)).toContain('grid');

	const inBlockComment = '/* transition-colors was removed */\nconst c = "flex";';
	expect(stripAllComments(inBlockComment)).not.toContain('transition-colors');
	expect(stripAllComments(inBlockComment)).toContain('flex');

	const inCode = '<div class="transition-all grid"></div>';
	expect(stripAllComments(inCode)).toContain('transition-all');
});
