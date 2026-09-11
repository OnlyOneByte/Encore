import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * EVERY CLASS IN APP MARKUP RESOLVES TO A RULE (#913)
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
 *      slot and the three stats tiles stair-stepped by 50.9px at desktop width.
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

const SRC = join(import.meta.dir, '..');
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
 * none is a #913 regression. They are recorded rather than fixed so that a NEW unresolved class is a hard
 * failure instead of noise in a list nobody reads. Fixing one means deleting its line here.
 */
const PRE_EXISTING: Record<string, string> = {
	panel: 'settings/+page.svelte ×3 — a wrapper whose rule was dropped before #913; unstyled on main too',
	qrow: 'QueueRow.svelte — only `.qrow.proc` exists, and it is scoped to ProcessingCard, so the bare token has never resolved',
	'reselect-body': 'LyricsReselect.svelte — dialog body wrapper, no rule on main',
	'opt-src': 'LyricsReselect.svelte — per-option source label, no rule on main',
	'reselect-paste': 'LyricsReselect.svelte — paste affordance, no rule on main',
	meta: 'tv/JoinBadge.svelte — the TV badge lays out by its own grid; this token adds nothing on main either',
	'stub-controls': 'phone-home-832.harness.svelte — a TEST fixture, never rendered in the app'
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
		for (const m of markupOf(src).matchAll(/class="([^"{}]*)"/g)) {
			for (const tok of m[1]!.split(/\s+/)) {
				// Only plain lowercase tokens. An interpolated or dynamic class cannot be checked statically.
				if (!/^[a-z][\w-]*$/.test(tok)) continue;
				if (own.has(tok) || global.has(tok)) continue;
				(out[tok] ??= []).push(f.slice(SRC.length + 1));
			}
		}
	}
	return out;
}

test('every static class in app markup resolves to a rule that can reach it (#913)', () => {
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

test('the pre-existing list stays honest in both directions (#913)', () => {
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

test('the resolution check catches all six shapes the migration actually shipped (#913)', () => {
	/*
	 * Mutation proof on synthetic sources. Each arm is one of the real defects, so a future refactor of
	 * this file cannot quietly stop detecting them.
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
	expect(resolves(`<Table.Cell class="name">x</Table.Cell>`, `.scroller { overflow: auto }`)).toEqual([
		'name'
	]);
	// …and quiet once a :global rule can reach it, which is where it had to go.
	expect(
		resolves(`<Table.Cell class="name">x</Table.Cell>`, ``, new Set(['name']))
	).toEqual([]);

	// 1. the mid-list token the original `class="card[ "]` grep could not see
	expect(resolves(`<div class="row card list-row">x</div>`, `.row {} .list-row {}`)).toEqual(['card']);

	// A comment naming a class must NOT count as defining it.
	expect(resolves(`<div class="ghost">x</div>`, `/* .ghost is intentionally unstyled */`)).toEqual([
		'ghost'
	]);

	// …and a class only mentioned in a style block or script must not count as APPLIED.
	expect(resolves(`<style>.only-here {}</style>`, `.only-here {}`)).toEqual([]);

	// A fully resolved file reports nothing.
	expect(resolves(`<div class="a b">x</div>`, `.a {} .b {}`)).toEqual([]);
});
