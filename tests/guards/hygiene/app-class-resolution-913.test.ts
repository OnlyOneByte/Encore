import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appSrc } from '@encore/test-support';

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * EVERY CLASS IN APP MARKUP RESOLVES TO A RULE
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * A class token that matches no rule renders NOTHING, and nothing about it looks wrong in source. It is
 * the single most-repeated defect of the shadcn migration — SIX instances, four of which shipped past a
 * fully green suite and were found by looking at screenshots:
 *
 *   1. `.card` deleted from app.css after an audit whose grep (`class="card[ "]`) only matched class
 *      lists STARTING with card. Nine elements spell it mid-list and lost their surface.
 *   2-3. Two grids left on the wrong element when the markup gained a wrapper.
 *   4. `.encore-slider` scoped onto a Bits UI root, so the rule could never match (see
 *      ui-scoped-style-reach-913.test.ts, which owns that direction).
 *   5. `.tile-slot` — a wrapper introduced with no rule at all, so `Card.Root` never filled its grid
 *      slot and the three stats tiles stair-stepped at desktop width instead of lining up. The size of
 *      the gap depends on the tiles' text; the defect is the absent rule.
 *   6. `.name` — the rule deleted from the page while the class stayed on the markup, silently
 *      right-aligning the ASR table's syncMode column.
 *
 * Each was cheap to find once someone asked the question mechanically. This asks it every run.
 *
 * WHY THE APP SIDE NEEDS NO UTILITY RESOLUTION. `app.css` uses `source(none)` with a single `@source`
 * pointing at `lib/components/ui`, so Tailwind mints utilities from THAT directory only. A utility-shaped
 * token written in a page emits no CSS whatsoever — so on the app side there is no "maybe it's a utility"
 * escape hatch, and an unresolved token is unresolved. The vendored tree is excluded for the same reason
 * inverted: everything there legitimately resolves to a minted utility.
 *
 * SCOPE-AWARENESS. Resolution is per-file plus global, never bundle-wide-by-name. `.name` exists in the
 * built CSS — but under TvLobby's and JoinLanding's scope hashes, which cannot reach a metrics table cell.
 * A naive grep over the bundle reports it resolved and misses the defect.
 */

// `appSrc` (src), the repo-root anchor, rather than `at('src')` — which
// was a statement about where this TEST lived embedded in a statement about where the SOURCE lived.
// Every `join(SRC, …)` below is unchanged, and so is the `SRC.length + 1` slicing that turns an
// absolute hit into a `lib/…` / `routes/…` offender string.
const SRC = appSrc;
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

/** Markup only: style blocks, script blocks and comments cannot apply a class. */
function markupOf(src: string): string {
	return src
		.replace(/<style[\s\S]*?<\/style>/g, ' ')
		.replace(/<script[\s\S]*?<\/script>/g, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ');
}

/** Style text with CSS comments removed, so prose cannot define a class. */
function styleOf(src: string): string {
	return (src.match(/<style[\s\S]*?<\/style>/g) ?? []).join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function classNamesIn(css: string): Set<string> {
	return new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!));
}

/**
 * Classes reachable from ANY file: `app.css`, plus every `:global(...)` selector in the tree.
 *
 * `:global()` is deliberately global — it is how a vendored component reaches an element a page renders,
 * and how `ui/table` reaches `[data-slot='table-cell'].name`. A page's own scoped rules are NOT here;
 * those are matched per-file, because that is the limit of where they apply.
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
 * Class tokens present on main and still unresolved, each with why it is not this PR's business.
 *
 * Measured against `origin/main`, not assumed: the same scan run on main reports exactly these seven, so
 * none is a new regression. They are recorded rather than fixed so that a NEW unresolved class is a hard
 * failure instead of noise in a list nobody reads. Fixing one means deleting its line here.
 */
const PRE_EXISTING: Record<string, string> = {
	qrow: 'QueueRow.svelte — only `.qrow.proc` exists, and it is scoped to ProcessingCard, so the bare token has never resolved',
	'reselect-body': 'LyricsReselect.svelte — dialog body wrapper, no rule on main',
	'reselect-paste': 'LyricsReselect.svelte — paste affordance, no rule on main',
	meta: 'tv/JoinBadge.svelte — the TV badge lays out by its own grid; this token adds nothing on main either'
	// `stub-controls` was here, justified by phone-home-832.harness.svelte. That harness moved out of
	// src with its test, so the token is no longer in this scan's population and the entry had to
	// go — which the both-directions arm below detected and refused to let pass. If a harness ever returns
	// to the app tree, its entry returns with it.
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
		 * `{…}` spans are BLANKED, not used to skip the attribute.
		 *
		 * This matched `class="([^"{}]*)"`, so one interpolation anywhere in the attribute discarded every
		 * static token beside it. `class="topbar {cls}"` checked nothing at all, silently — and turning
		 * `class="topbar"` into `class="topbar {cls}"` is a refactor nobody would think of as reducing
		 * coverage.
		 *
		 * The expression is replaced with a MARKER rather than a space, because a token can be built across
		 * the boundary: `class="hl-{i}"` is one dynamic name, and blanking to a space leaves `hl-` looking
		 * like a static token with no rule. Any token still carrying the marker is dynamic and skipped;
		 * tokens that are whole words on their own are checked as normal.
		 */
		const scannable = markupOf(src).replace(/\{[^{}]*\}/g, DYNAMIC);
		for (const m of scannable.matchAll(/class="([^"]*)"/g)) {
			for (const tok of m[1]!.split(/\s+/)) {
				// Only plain lowercase tokens. An interpolated or dynamic class cannot be checked statically.
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
	// Non-vacuity: the walk found the app side. An empty walk reports zero offenders like a clean tree.
	expect(files.length).toBeGreaterThanOrEqual(30); // @nvf-floor files.length

	const unresolved = unresolvedTokens();
	const news = Object.entries(unresolved)
		.filter(([tok]) => !(tok in PRE_EXISTING))
		.map(([tok, fs]) => `${[...new Set(fs)].join(', ')}: class "${tok}" matches no rule that can reach it`);

	expect(
		news,
		'a class token in app markup resolves to nothing, so it renders nothing. Either add the rule, or ' +
			'delete the token. If the class sits on a COMPONENT, the rule cannot live in the page — see ' +
			'ui-scoped-style-reach-913.test.ts. If it is genuinely pre-existing, prove it against origin/main ' +
			'and record it in PRE_EXISTING with why.'
	).toEqual([]);
});

test('the pre-existing list stays honest in both directions', () => {
	const unresolved = unresolvedTokens();

	// A recorded token that now resolves must LEAVE the list, or the list rots into a record of what used
	// to be true — which is what makes an allowlist stop meaning anything.
	const fixed = Object.keys(PRE_EXISTING).filter((tok) => !(tok in unresolved));
	expect(
		fixed,
		'these tokens resolve now. Delete their PRE_EXISTING entries so the list keeps describing the tree.'
	).toEqual([]);

	// Every entry carries a real reason, not a placeholder.
	for (const [tok, why] of Object.entries(PRE_EXISTING)) {
		expect(why.length, `${tok} needs a real reason`).toBeGreaterThan(30);
	}
});

test('the resolution check catches the shapes it can reach', () => {
	/*
	 * Mutation proof on synthetic sources, so a refactor of this file cannot quietly stop detecting them.
	 *
	 * THREE of the six shapes above, not all six, and the difference is structural rather than laziness:
	 *   - shapes 1, 5 and 6 are missing-rule defects in app markup, which is what this file scans, so each
	 *     has an arm below.
	 *   - shapes 2 and 3 were layout on the wrong ELEMENT. Both classes resolved fine; what was wrong was
	 *     which box carried them. No class-resolution check can see that, and nothing here claims to.
	 *   - shape 4 (`.encore-slider`) is a scoped rule that cannot reach a child component's element. That
	 *     is `ui-scoped-style-reach-913.test.ts`'s territory and is mutation-proved there, including the
	 *     `data-slot` direction the fix opened.
	 * The remaining arms are hygiene, not shapes: a comment must not define a class, a style-block-only
	 * class must not count as applied, and a clean file must report nothing.
	 */
	const resolves = (markup: string, style: string, global = new Set<string>()) => {
		const own = classNamesIn(style.replace(/\/\*[\s\S]*?\*\//g, ' '));
		const toks = [...markupOf(markup).matchAll(/class="([^"{}]*)"/g)]
			.flatMap((m) => m[1]!.split(/\s+/))
			.filter((t) => /^[a-z][\w-]*$/.test(t));
		return toks.filter((t) => !own.has(t) && !global.has(t));
	};

	// 5. a wrapper with no rule anywhere — `.tile-slot`
	expect(resolves(`<div class="tile-slot primary">x</div>`, `.tiles { display: grid }`)).toEqual([
		'tile-slot',
		'primary'
	]);

	// 6. the rule deleted while the class stayed — `.name`
	expect(resolves(`<Table.Cell class="name">x</Table.Cell>`, `.scroller { overflow: auto }`)).toEqual(['name']);
	// …and quiet once a :global rule can reach it, which is where it had to go.
	expect(resolves(`<Table.Cell class="name">x</Table.Cell>`, ``, new Set(['name']))).toEqual([]);

	// 1. the mid-list token the original `class="card[ "]` grep could not see
	expect(resolves(`<div class="row card list-row">x</div>`, `.row {} .list-row {}`)).toEqual(['card']);

	// A comment naming a class must NOT count as defining it.
	expect(resolves(`<div class="ghost">x</div>`, `/* .ghost is intentionally unstyled */`)).toEqual(['ghost']);

	// …and a class only mentioned in a style block or script must not count as APPLIED.
	expect(resolves(`<style>.only-here {}</style>`, `.only-here {}`)).toEqual([]);

	// A fully resolved file reports nothing.
	expect(resolves(`<div class="a b">x</div>`, `.a {} .b {}`)).toEqual([]);
});

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * THE VENDORED TREE IS NOT EXEMPT FROM ITS OWN NAMESPACE
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Everything above skips `components/ui` by path, on the argument that every class there resolves to a
 * minted utility. That is true of `flex` and `bg-card`. It is NOT true of `encore-*`, which is our own
 * namespace: `source(none)` means Tailwind mints only what it finds in this directory, and it can never
 * mint `.encore-table` because no utility grammar produces it. So a path exemption switched this guard
 * off across the largest, newest and least-reviewed hundred files in the change — laundering exactly the
 * defect class it was written for.
 *
 * It was not theoretical. Five `encore-*` tokens were being written into the DOM with no rule anywhere:
 * `encore-bar`, `encore-table`, `encore-tab`, `encore-seg` and `encore-chip-neutral` — leftovers from the
 * pre-`data-slot` form the slider defect forced these files off. Nothing rendered wrong, because
 * `:global([data-slot='…'])` had taken over the painting, but every one was a live invitation to the same
 * mistake: a reader sees the class, assumes it carries the styling, and writes a rule for it that lands
 * nowhere.
 *
 * Splitting on our own prefix keeps the predicate honest without needing to model Tailwind's grammar.
 */
const ENCORE_PREFIX = /^encore-/;

test('every `encore-*` class in the vendored tree has a rule', () => {
	const global = globallyDefined();
	// Named distinctly from the app-side arm's `files`: two floors in one file with the same subject are
	// indistinguishable to the anti-laundering check in non-vacuity-floors.test.ts, which matches on it.
	const vendoredFiles = svelteFiles(join(SRC, 'lib', 'components', 'ui'));
	// Non-vacuity: the vendored tree was reached. 62 files at the time of writing.
	expect(vendoredFiles.length).toBeGreaterThanOrEqual(55); // @nvf-floor vendoredFiles.length

	let tokensSeen = 0;
	const orphans: string[] = [];
	for (const f of vendoredFiles) {
		const src = readFileSync(f, 'utf8');
		const own = classNamesIn(styleOf(src));
		// Class strings reach these elements through cn() and tv() bases as well as plain attributes, so
		// every string literal in the markup and the module script counts.
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

	// Non-vacuity: the namespace is really in use, so an empty orphan list means clean rather than blind.
	expect(tokensSeen).toBeGreaterThanOrEqual(15); // @nvf-floor tokensSeen

	expect(
		[...new Set(orphans)],
		'an `encore-*` class is applied with no rule to match it. Tailwind cannot mint this namespace, so ' +
			'the token does nothing: either add the rule, or delete the token. If the styling moved to ' +
			"`:global([data-slot='…'])`, the old class is residue and should go with it."
	).toEqual([]);
});
