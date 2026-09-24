import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';

/*
 * EVERY CLASS IN APP MARKUP RESOLVES TO A RULE. A token that matches no rule renders NOTHING and looks fine in
 * source — the most-repeated defect of the shadcn migration, six instances, four of which shipped past a green
 * suite. `app.css` uses `source(none)` with one `@source` over `lib/components/ui`, so a utility-shaped token
 * written in a page emits no CSS and an unresolved token stays unresolved. Resolution is per-file plus global,
 * never bundle-wide-by-name — `.name` exists in the bundle under other scope hashes.
 */

const SRC = srcDir;
/** Stands in for a `{…}` expression, so a token fused to one is recognisable as dynamic. */
const DYNAMIC = '\u0000';
const VENDORED = join('components', 'ui');

function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) out.push(...svelteFiles(p));
		else if (e.endsWith('.svelte')) out.push(p);
	}
	return out;
}

function markupOf(src: string): string {
	return src
		.replace(/<style[\s\S]*?<\/style>/g, ' ')
		.replace(/<script[\s\S]*?<\/script>/g, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ');
}

function styleOf(src: string): string {
	return (src.match(/<style[\s\S]*?<\/style>/g) ?? []).join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function classNamesIn(css: string): Set<string> {
	return new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!));
}

/**
 * Classes reachable from ANY file: `app.css`, plus every `:global(...)` selector in the tree — how a vendored
 * component reaches an element a page renders, and how `ui/table` reaches `[data-slot='table-cell'].name`. A
 * page's own scoped rules are matched per-file, the limit of where they apply.
 */
function globallyDefined(): Set<string> {
	const out = classNamesIn(readFileSync(join(SRC, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' '));
	for (const f of svelteFiles(join(SRC, 'lib')).concat(svelteFiles(join(SRC, 'routes')))) {
		for (const g of styleOf(readFileSync(f, 'utf8')).matchAll(/:global\(([^)]*)\)/g)) {
			for (const c of classNamesIn(g[1]!)) out.add(c);
		}
	}
	return out;
}

/**
 * Class tokens present on main and still unresolved, each with why it is not this change's business. Recorded
 * rather than fixed so a NEW unresolved class is a hard failure rather than noise in a list nobody reads.
 */
const PRE_EXISTING: Record<string, string> = {
	qrow: 'QueueRow.svelte — only `.qrow.proc` exists, and it is scoped to ProcessingCard, so the bare token has never resolved',
	'reselect-body': 'LyricsReselect.svelte — dialog body wrapper, no rule on main',
	meta: 'tv/JoinBadge.svelte — the TV badge lays out by its own grid; this token adds nothing on main either'
};

function unresolvedTokens(): Record<string, string[]> {
	const global = globallyDefined();
	const out: Record<string, string[]> = {};
	const files = svelteFiles(join(SRC, 'lib'))
		.concat(svelteFiles(join(SRC, 'routes')))
		.filter((f) => !f.includes(VENDORED));

	for (const f of files) {
		const src = readFileSync(f, 'utf8');
		const own = classNamesIn(styleOf(src));
		/*
		 * `{…}` spans are BLANKED TO A MARKER, not used to skip the attribute: matching `class="([^"{}]*)"` let one
		 * interpolation discard every static token beside it, so `class="topbar {cls}"` checked nothing at all. A
		 * marker rather than a space because a token can be built ACROSS the boundary — `class="hl-{i}"` is one
		 * dynamic name, and blanking to a space leaves `hl-` looking like a static token with no rule.
		 */
		const scannable = markupOf(src).replace(/\{[^{}]*\}/g, DYNAMIC);
		for (const m of scannable.matchAll(/class="([^"]*)"/g)) {
			for (const tok of m[1]!.split(/\s+/)) {
				if (tok.includes(DYNAMIC)) continue; // built across an interpolation boundary
				if (!/^[a-z][\w-]*$/.test(tok)) continue;
				if (own.has(tok) || global.has(tok)) continue;
				(out[tok] ??= []).push(f.slice(SRC.length + 1));
			}
		}
	}
	return out;
}

test('every static class in app markup resolves to a rule that can reach it', () => {
	const files = svelteFiles(join(SRC, 'lib'))
		.concat(svelteFiles(join(SRC, 'routes')))
		.filter((f) => !f.includes(VENDORED));
	expect(files.length).toBeGreaterThanOrEqual(30); // @nvf-floor files.length

	const unresolved = unresolvedTokens();
	const news = Object.entries(unresolved)
		.filter(([tok]) => !(tok in PRE_EXISTING))
		.map(([tok, fs]) => `${[...new Set(fs)].join(', ')}: class "${tok}" matches no rule that can reach it`);

	expect(
		news,
		'a class token in app markup resolves to nothing, so it renders nothing. Either add the rule, or ' +
			'delete the token. If the class sits on a COMPONENT, the rule cannot live in the page — see ' +
			'ui-scoped-style-reach.test.ts. If it is genuinely pre-existing, prove it against origin/main ' +
			'and record it in PRE_EXISTING with why.'
	).toEqual([]);
});

test('the pre-existing list stays honest in both directions', () => {
	const unresolved = unresolvedTokens();

	const fixed = Object.keys(PRE_EXISTING).filter((tok) => !(tok in unresolved));
	expect(
		fixed,
		'these tokens resolve now. Delete their PRE_EXISTING entries so the list keeps describing the tree.'
	).toEqual([]);

	for (const [tok, why] of Object.entries(PRE_EXISTING)) {
		expect(why.length, `${tok} needs a real reason`).toBeGreaterThan(30);
	}
});

test('the resolution check catches the shapes it can reach', () => {
	/*
	 * Mutation proof on SYNTHETIC sources, so a refactor of this file cannot quietly stop detecting them. THREE of
	 * the six shapes: 1, 5 and 6 are missing-rule defects in app markup, which is what this file scans; 2 and 3
	 * were layout on the wrong ELEMENT, which no check of this kind can see; 4 is a scoped rule that cannot reach a
	 * child component's element, mutation-proved in `ui-scoped-style-reach.test.ts`.
	 */
	const resolves = (markup: string, style: string, global = new Set<string>()) => {
		const own = classNamesIn(style.replace(/\/\*[\s\S]*?\*\//g, ' '));
		const toks = [...markupOf(markup).matchAll(/class="([^"{}]*)"/g)]
			.flatMap((m) => m[1]!.split(/\s+/))
			.filter((t) => /^[a-z][\w-]*$/.test(t));
		return toks.filter((t) => !own.has(t) && !global.has(t));
	};

	expect(resolves(`<div class="tile-slot primary">x</div>`, `.tiles { display: grid }`)).toEqual([
		'tile-slot',
		'primary'
	]);

	expect(resolves(`<Table.Cell class="name">x</Table.Cell>`, `.scroller { overflow: auto }`)).toEqual(['name']);
	expect(resolves(`<Table.Cell class="name">x</Table.Cell>`, ``, new Set(['name']))).toEqual([]);

	expect(resolves(`<div class="row card list-row">x</div>`, `.row {} .list-row {}`)).toEqual(['card']);

	expect(resolves(`<div class="ghost">x</div>`, `/* .ghost is intentionally unstyled */`)).toEqual(['ghost']);

	expect(resolves(`<style>.only-here {}</style>`, `.only-here {}`)).toEqual([]);

	expect(resolves(`<div class="a b">x</div>`, `.a {} .b {}`)).toEqual([]);
});

/*
 * THE VENDORED TREE IS NOT EXEMPT FROM ITS OWN NAMESPACE. Skipping `components/ui` by path is right for `flex`
 * and wrong for `encore-*`, which is our own namespace: no utility grammar produces `.encore-table`, so a path
 * exemption switched this guard off across the largest and least-reviewed hundred files in the change, and five
 * `encore-*` tokens were being written into the DOM with no rule anywhere.
 */
const ENCORE_PREFIX = /^encore-/;

test('every `encore-*` class in the vendored tree has a rule', () => {
	const global = globallyDefined();
	// Named distinctly from the app-side arm's `files`: two floors in one file with the same subject are
	// indistinguishable to the anti-laundering check in non-vacuity-floors.test.ts, which matches on it.
	const vendoredFiles = svelteFiles(join(SRC, 'lib', 'components', 'ui'));
	expect(vendoredFiles.length).toBeGreaterThanOrEqual(55); // @nvf-floor vendoredFiles.length

	let tokensSeen = 0;
	const orphans: string[] = [];
	for (const f of vendoredFiles) {
		const src = readFileSync(f, 'utf8');
		const own = classNamesIn(styleOf(src));
		const region = src.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
		for (const lit of region.matchAll(/["'`]([^"'`\n]*)["'`]/g)) {
			for (const tok of lit[1]!.split(/\s+/)) {
				if (!ENCORE_PREFIX.test(tok)) continue;
				tokensSeen++;
				if (own.has(tok) || global.has(tok)) continue;
				orphans.push(`${f.slice(SRC.length + 1)}: "${tok}" is written into the DOM with no rule`);
			}
		}
	}

	expect(tokensSeen).toBeGreaterThanOrEqual(15); // @nvf-floor tokensSeen

	expect(
		[...new Set(orphans)],
		'an `encore-*` class is applied with no rule to match it. Tailwind cannot mint this namespace, so ' +
			'the token does nothing: either add the rule, or delete the token. If the styling moved to ' +
			"`:global([data-slot='…'])`, the old class is residue and should go with it."
	).toEqual([]);
});
