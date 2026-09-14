/*
 * EVERY ELEMENT'S CLASS LIST MUST BE MATCHABLE BY SOME RULE (the shadcn migration Phase 3).
 *
 * ── THE DEFECT THIS EXISTS FOR, WHICH SHIPPED ─────────────────────────────────────────────────────
 *
 * `LyricsReselect.svelte` rendered two controls as `<button class="chip">` and
 * `<button class="chip ghost">`, and the only rule in the tree was `.chip.ghost { … }`. So:
 *
 *   - "Cancel" (`chip ghost`) matched the compound rule and got a border.
 *   - "Use these lyrics" (`chip` alone) matched NOTHING. With Preflight off and no global control
 *     reset, it rendered as a ~21px native OS button in the wrong font on a dark sheet.
 *
 * `app-class-resolution-913.test.ts` stayed green throughout, and its miss is mechanical rather than
 * careless: its `classNamesIn()` pulls every `.token` out of a selector with
 * `/\.([a-zA-Z][\w-]*)/g`, so the single rule `.chip.ghost` registers BOTH `chip` and `ghost` as
 * "defined". A compound selector vouches for each of its own parts — including parts no rule can match
 * on their own. That is exactly this bug, and it is invisible to a token-level check by construction.
 *
 * ── THE INVARIANT, AND WHY THE OBVIOUS PHRASING OF IT IS WRONG ────────────────────────────────────
 *
 * The tempting rule is "every class written alone must be reachable alone". That is WRONG, and running
 * it produced five false positives immediately: `class="stage bad"` with a `.stage.bad` rule,
 * `class="time r"` with `.time.r`, `class="leave confirm"` with `.leave.confirm`, `class="chip ok
 * chip-icon"` with `.chip.ok`, `class="qrow proc card list-row"` with `.qrow.proc`. Every one is the
 * ordinary MODIFIER idiom: the token is meaningless alone by design, and the element is still styled
 * because it also carries a base class that has its own rule.
 *
 * The question that actually distinguishes a defect from a modifier is about the ELEMENT, not the token:
 * can any rule match this element as written? So for each element, take its static class list L, and
 * require that some selector contains a compound whose class-set is a SUBSET of L. `.chip.ghost`
 * needs {chip, ghost}, which is not a subset of {chip} — the bug. `.stage.bad` needs {stage, bad},
 * which IS a subset of {stage, bad} — fine.
 *
 * ── DELIBERATE OVER-APPROXIMATION ─────────────────────────────────────────────────────────────────
 *
 * Ancestor requirements are ignored: for `.row .chip` this counts the rightmost compound {chip} and does
 * not check that an ancestor carries `row`. That direction is chosen on purpose — it can only produce
 * FALSE NEGATIVES (an element we call styled that isn't), never a false positive that would block a
 * legitimate refactor. Proving ancestry needs a DOM, and this repo deliberately has no layout engine on
 * the unit rung; the shipped bug did not need ancestry to catch, and a guard that cries wolf gets
 * disabled.
 *
 * Utilities are not a factor: `app.css` uses `source(none)` with a single `@source` over
 * `lib/components/ui`, so no utility is minted for app source and there is no "maybe Tailwind defines
 * it" escape hatch on this side of the tree — the same reasoning app-class-resolution-913 records.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';

// The tree anchor comes from @encore/test-support rather than a relative walk: this guard moved
// from src/lib/ into tests/ during the test-architecture refactor, and a relative path would have
// to change again on the next move. `srcDir` is the repo's single source for 'where is src'.
const SRC = srcDir;
const VENDORED = join('components', 'ui');

function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) out.push(...svelteFiles(p));
		else if (p.endsWith('.svelte') && !p.includes('.harness.')) out.push(p);
	}
	return out;
}

/** `<style>` text with CSS comments blanked, so prose cannot define a rule. */
function styleOf(src: string): string {
	return (src.match(/<style[\s\S]*?<\/style>/g) ?? []).join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Markup only: `<style>`, `<script>` and HTML comments removed. */
function markupOf(src: string): string {
	return src
		.replace(/<style[\s\S]*?<\/style>/g, ' ')
		.replace(/<script[\s\S]*?<\/script>/g, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * Selector texts (the part before each `{`), skipping at-rule preludes.
 *
 * `{` is in the leading delimiter set, not just `}` / `;` / start-of-input: a selector nested INSIDE an
 * at-rule block (`@media (...) { .pop-in { … } }`) is preceded by the at-rule's own `{`. Omitting it made
 * every rule living only inside a media query invisible — caught by this file's own predicate tests,
 * which reported `.pop-in` and `.ok` as unmatched when both have single-class rules inside
 * `@media (prefers-reduced-motion: no-preference)`.
 */
function selectorsIn(css: string): string[] {
	const out: string[] = [];
	for (const m of css.matchAll(/(^|[{};])\s*([^{};@]+?)\s*\{/g)) {
		const sel = m[2]!.trim();
		if (sel && !sel.startsWith('@')) out.push(sel);
	}
	return out;
}

/**
 * Every REQUIREMENT SET a stylesheet can satisfy: one entry per compound selector, holding the classes
 * that compound needs on a single element. `:global(...)` is unwrapped (that is how a component reaches
 * an element another file renders). Pseudo-classes/elements and attribute selectors are stripped — they
 * constrain the same element without being another class, so `.chip:hover` still requires only {chip}.
 * A compound with no classes at all (`button`, `[data-slot='x']`) yields the empty set, which is a
 * subset of everything — correct, since such a rule matches regardless of class list.
 */
function requirementSets(css: string): Set<string>[] {
	const out: Set<string>[] = [];
	for (const raw of selectorsIn(css)) {
		const unwrapped = raw.replace(/:global\(([^)]*)\)/g, '$1');
		for (const branch of unwrapped.split(',')) {
			for (const compound of branch.split(/[\s>+~]+/)) {
				if (!compound) continue;
				const bare = compound.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '').replace(/\[[^\]]*\]/g, '');
				const classes = [...bare.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!);
				if (classes.length) out.push(new Set(classes));
			}
		}
	}
	return out;
}

/**
 * Class lists as WRITTEN on elements, one entry per `class="…"` attribute, split into static tokens.
 * `{…}` spans become a marker rather than a space, so `class="hl-{i}"` reads as one dynamic name instead
 * of leaving `hl-` looking static — the treatment app-class-resolution-913 records as load-bearing.
 *
 * A list containing ANY dynamic span is skipped entirely: `class:foo` directives and interpolated names
 * can add the very token a compound rule needs, so the static text alone cannot decide the question.
 */
function classListsIn(markup: string): string[][] {
	const out: string[][] = [];
	for (const m of markup.matchAll(/class="([^"]*)"/g)) {
		const raw = m[1]!;
		if (/\{/.test(raw)) continue; // interpolated: not statically decidable
		const toks = raw.split(/\s+/).filter((t) => t && /^[a-z][\w-]*$/.test(t));
		if (toks.length) out.push(toks);
	}
	return out;
}

/** True when some rule's requirement set is a subset of this element's class list. */
function matchable(list: string[], reqs: Set<string>[]): boolean {
	const have = new Set(list);
	return reqs.some((req) => [...req].every((c) => have.has(c)));
}

/*
 * Class lists that match no rule and are NOT defects, each with why.
 *
 * The distinction that makes this list safe: the shipped bug was a CONTROL (a `<button>`) left with no
 * rule, and with Preflight off an unstyled control gets full UA chrome — OS button, wrong font, ~21px
 * tall. An unstyled `<div>` gets nothing at all, because a div has no UA appearance to inherit. So a
 * layout-neutral wrapper whose children are positioned by their own rules is genuinely inert, while a
 * control never is. Every entry below is a div/wrapper, and all three are already recorded as
 * intentionally-unresolved in app-class-resolution-913.test.ts's PRE_EXISTING list — this keeps the two
 * guards' pictures of the tree consistent rather than inventing a second, disagreeing set.
 *
 * Do NOT add a control here. If a button, input or select lands in this list, that is the defect.
 */
const ALLOWED_UNSTYLED: Record<string, string> = {
	'reselect-body': 'LyricsReselect.svelte — a layout-neutral disclosure body wrapper; its children carry every rule',
	// `reselect-paste` was here as an unstyled wrapper. Vendoring `ui/textarea` gave it a rule: the paste
	// field's top margin is the call site's spacing, not the field's, so it stays in LyricsReselect as
	// `.reselect-paste > :global([data-slot='textarea'])`. The margin is the incumbent's own value, kept
	// so the swap moves nothing. The wrapper is styled now, so this entry is stale and had to go.
	meta: 'tv/JoinBadge.svelte — the TV badge lays its own children out by grid; this wrapper adds nothing'
};

describe('every element class list is matchable by some rule', () => {
	const files = svelteFiles(join(SRC, 'lib'))
		.concat(svelteFiles(join(SRC, 'routes')))
		.filter((f) => !f.includes(VENDORED));

	test('no app element carries a class list that no rule can match (the shadcn migration)', () => {
		// Non-vacuity: the walk found the app side. An empty walk reports zero offenders like a clean tree.
		expect(files.length).toBeGreaterThanOrEqual(20); // @nvf-floor files.length

		// Global reach: app.css, plus every `:global()` anywhere in the tree (including the vendored
		// components, which is how ui/* reaches elements a page renders).
		const globalReqs = requirementSets(readFileSync(join(SRC, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' '));
		for (const f of svelteFiles(join(SRC, 'lib')).concat(svelteFiles(join(SRC, 'routes')))) {
			for (const g of styleOf(readFileSync(f, 'utf8')).matchAll(/:global\(([^)]*)\)/g)) {
				globalReqs.push(...requirementSets(`${g[1]!} {}`));
			}
		}

		let listsSeen = 0;
		const offenders: string[] = [];
		const allowedHit = new Set<string>();
		for (const f of files) {
			const src = readFileSync(f, 'utf8');
			const reqs = requirementSets(styleOf(src)).concat(globalReqs);
			for (const list of classListsIn(markupOf(src))) {
				listsSeen++;
				if (matchable(list, reqs)) continue;
				const key = list.join(' ');
				if (key in ALLOWED_UNSTYLED) {
					allowedHit.add(key);
					continue;
				}
				offenders.push(
					`${f.slice(SRC.length + 1)}: class="${key}" matches NO rule — every candidate ` +
						`selector needs a class this element does not carry (the .chip/.chip.ghost shape). With ` +
						`Preflight off, such an element renders as unstyled UA chrome. If it is a layout-neutral ` +
						`wrapper rather than a control, record it in ALLOWED_UNSTYLED with why.`
				);
			}
		}

		// Non-vacuity: real class lists were examined, so an empty offender list means clean, not blind.
		expect(listsSeen).toBeGreaterThanOrEqual(80); // @nvf-floor listsSeen
		expect([...new Set(offenders)]).toEqual([]);

		// The allowlist stays honest in the other direction too: an entry that now matches a rule is stale
		// and must go, or the list stops describing the tree (app-class-resolution-913's own rule).
		const stale = Object.keys(ALLOWED_UNSTYLED).filter((k) => !allowedHit.has(k));
		expect(stale, 'these entries no longer match an unstyled element — delete them from ALLOWED_UNSTYLED').toEqual([]);
	});

	test('the matcher is not vacuous — it models subset semantics, not token presence', () => {
		// THE SHIPPED BUG: a compound-only rule does not style an element carrying just the base.
		const chipGhost = requirementSets('.chip.ghost { color: red }');
		expect(matchable(['chip', 'ghost'], chipGhost)).toBe(true);
		expect(matchable(['chip'], chipGhost)).toBe(false);
		// THE MODIFIER IDIOM, which must NOT be flagged: the element also carries a base class with a rule.
		const stage = requirementSets('.stage { color: red } .stage.bad { color: blue }');
		expect(matchable(['stage', 'bad'], stage)).toBe(true);
		expect(matchable(['stage'], stage)).toBe(true);
		// A rule with no class requirement matches any element.
		expect(matchable(['whatever'], requirementSets('button { color: red }'))).toBe(false);
		expect(matchable(['whatever'], requirementSets('.whatever { color: red }'))).toBe(true);
		// Pseudo-classes and attribute selectors constrain the same element, not another class.
		expect(matchable(['chip'], requirementSets('.chip:hover { color: red }'))).toBe(true);
		expect(matchable(['chip'], requirementSets('.chip[disabled] { color: red }'))).toBe(true);
		// A descendant combinator: the rightmost compound is what the element must satisfy.
		expect(matchable(['chip'], requirementSets('.row .chip { color: red }'))).toBe(true);
		// :global() unwraps.
		expect(matchable(['chip'], requirementSets(':global(.chip) { color: red }'))).toBe(true);
		// A selector list is per-branch.
		expect(matchable(['a'], requirementSets('.a, .b.c { color: red }'))).toBe(true);
		expect(matchable(['b'], requirementSets('.a, .b.c { color: red }'))).toBe(false);
		// A rule inside an at-rule block still counts.
		expect(matchable(['chip'], requirementSets('@media (max-width: 380px) { .chip { color: red } }'))).toBe(true);
	});

	test('the markup reader is not vacuous — it skips undecidable lists and reads static ones', () => {
		expect(classListsIn('<b class="chip ghost">')).toEqual([['chip', 'ghost']]);
		// Any interpolation makes the list undecidable: a class: directive or {expr} can supply the very
		// token a compound rule needs, so a static-only reading would report a false offence.
		expect(classListsIn('<b class="hl-{i}">')).toEqual([]);
		expect(classListsIn('<b class="topbar {cls}">')).toEqual([]);
		// Comments and style/script text are not markup.
		expect(classListsIn(markupOf('<style>.chip{}</style><!-- class="ghost" -->'))).toEqual([]);
	});
});
