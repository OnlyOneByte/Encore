/*
 * EVERY ELEMENT'S CLASS LIST MUST BE MATCHABLE BY SOME RULE.
 *
 * THE DEFECT, WHICH SHIPPED: `LyricsReselect.svelte` rendered `<button class="chip">` with only
 * `.chip.ghost { … }` in the tree, so "Use these lyrics" matched NOTHING and — Preflight off — rendered as a
 * ~21px native OS button in the wrong font. `app-class-resolution.test.ts` is blind to it by construction: its
 * `classNamesIn()` pulls every `.token` out of a selector, so a compound vouches for each of its parts.
 *
 * The question is about the ELEMENT, not the token: for each element take its static class list L and require
 * some selector to contain a compound whose class-set is a SUBSET of L. "Every class written alone must be
 * reachable alone" is WRONG — it reported five ordinary modifier idioms (`class="stage bad"` with a `.stage.bad`
 * rule) as defects immediately. Ancestors are ignored on purpose (`.row .chip` counts the rightmost compound
 * only): that can only produce false negatives, and proving ancestry needs a DOM this rung has no engine for.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';

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

function styleOf(src: string): string {
	return (src.match(/<style[\s\S]*?<\/style>/g) ?? []).join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function markupOf(src: string): string {
	return src
		.replace(/<style[\s\S]*?<\/style>/g, ' ')
		.replace(/<script[\s\S]*?<\/script>/g, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * Selector texts (the part before each `{`), skipping at-rule preludes. `{` is in the leading delimiter set
 * because a selector nested INSIDE an at-rule block is preceded by the at-rule's own `{`; omitting it made every
 * rule living only inside a media query invisible.
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
 * Every REQUIREMENT SET a stylesheet can satisfy: one entry per compound selector, holding the classes that
 * compound needs on a single element. `:global(...)` is unwrapped; pseudo-classes and attribute selectors are
 * stripped, since they constrain the same element without being another class. A compound with no classes yields
 * the empty set, a subset of everything, which is correct.
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
 * Class lists as WRITTEN on elements, one entry per `class="…"`. `{…}` spans become a marker rather than a
 * space, so `class="hl-{i}"` reads as one dynamic name instead of leaving `hl-` looking static. A list with ANY
 * dynamic span is skipped: a `class:foo` directive or `{expr}` can add the very token a compound rule needs.
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

function matchable(list: string[], reqs: Set<string>[]): boolean {
	const have = new Set(list);
	return reqs.some((req) => [...req].every((c) => have.has(c)));
}

/*
 * Class lists that match no rule and are NOT defects, each with why. What makes the list safe: the shipped bug
 * was a CONTROL, and with Preflight off an unstyled control gets full UA chrome while an unstyled `<div>` gets
 * nothing at all. Every entry is also in app-class-resolution's PRE_EXISTING, so the two guards agree.
 *
 * Do NOT add a control here. If a button, input or select lands in this list, that is the defect.
 */
const ALLOWED_UNSTYLED: Record<string, string> = {
	'reselect-body': 'LyricsReselect.svelte — a layout-neutral disclosure body wrapper; its children carry every rule',
	meta: 'tv/JoinBadge.svelte — the TV badge lays its own children out by grid; this wrapper adds nothing'
};

describe('every element class list is matchable by some rule', () => {
	const files = svelteFiles(join(SRC, 'lib'))
		.concat(svelteFiles(join(SRC, 'routes')))
		.filter((f) => !f.includes(VENDORED));

	test('no app element carries a class list that no rule can match (the shadcn migration)', () => {
		expect(files.length).toBeGreaterThanOrEqual(20); // @nvf-floor files.length

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

		// The allowlist stays honest the other way too: an entry that now matches a rule is stale and must go.
		const stale = Object.keys(ALLOWED_UNSTYLED).filter((k) => !allowedHit.has(k));
		expect(stale, 'these entries no longer match an unstyled element — delete them from ALLOWED_UNSTYLED').toEqual([]);
	});

	test('the matcher is not vacuous — it models subset semantics, not token presence', () => {
		// THE SHIPPED BUG: a compound-only rule does not style an element carrying just the base. The MODIFIER IDIOM
		// must NOT be flagged, since the element also carries a base class with a rule.
		const chipGhost = requirementSets('.chip.ghost { color: red }');
		expect(matchable(['chip', 'ghost'], chipGhost)).toBe(true);
		expect(matchable(['chip'], chipGhost)).toBe(false);
		const stage = requirementSets('.stage { color: red } .stage.bad { color: blue }');
		expect(matchable(['stage', 'bad'], stage)).toBe(true);
		expect(matchable(['stage'], stage)).toBe(true);
		expect(matchable(['whatever'], requirementSets('button { color: red }'))).toBe(false);
		expect(matchable(['whatever'], requirementSets('.whatever { color: red }'))).toBe(true);
		expect(matchable(['chip'], requirementSets('.chip:hover { color: red }'))).toBe(true);
		expect(matchable(['chip'], requirementSets('.chip[disabled] { color: red }'))).toBe(true);
		expect(matchable(['chip'], requirementSets('.row .chip { color: red }'))).toBe(true);
		expect(matchable(['chip'], requirementSets(':global(.chip) { color: red }'))).toBe(true);
		expect(matchable(['a'], requirementSets('.a, .b.c { color: red }'))).toBe(true);
		expect(matchable(['b'], requirementSets('.a, .b.c { color: red }'))).toBe(false);
		expect(matchable(['chip'], requirementSets('@media (max-width: 380px) { .chip { color: red } }'))).toBe(true);
	});

	test('the markup reader is not vacuous — it skips undecidable lists and reads static ones', () => {
		expect(classListsIn('<b class="chip ghost">')).toEqual([['chip', 'ghost']]);
		// Any interpolation makes the list undecidable: a `class:` directive can supply the token a rule needs.
		expect(classListsIn('<b class="hl-{i}">')).toEqual([]);
		expect(classListsIn('<b class="topbar {cls}">')).toEqual([]);
		expect(classListsIn(markupOf('<style>.chip{}</style><!-- class="ghost" -->'))).toEqual([]);
	});
});
