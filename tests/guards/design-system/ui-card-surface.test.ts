/*
 * THE SHARED `.card` SURFACE AND ITS CALLERS STAY TOGETHER.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────────────────────────
 *
 * S4 migrated 28 content cards onto shadcn's <Card.Root> and then deleted `.card` from app.css,
 * on the premise that nothing referenced it any more. Nine elements still did, and every one of them
 * lost its background, border and radius:
 *
 *     class="row card list-row"      the search / library row
 *     class="qrow card list-row …"   the queue row
 *     class="hero card"              the now-playing hero
 *     class="track card"            the TV progress track
 *
 * The audit that cleared the deletion grepped `class="card[ "]`, which only matches a class list that
 * STARTS with `card`. Every survivor spells it in the middle.
 *
 * Nothing in the suite could catch it. A global class has no unused-selector warning when the RULE
 * disappears — that warning fires the other way round, for a rule with no markup. And no guard asserted
 * that these elements have a surface at all, because until S4 nothing could take it away. Search
 * results rendered as a flat list on the page background, with no separation between rows and no border
 * for the ready row's green ring to colour. It was found by comparing before/after screenshots.
 *
 * ── WHAT IT ASSERTS ────────────────────────────────────────────────────────────────────────────
 *
 * The rule and its callers move together, in both directions:
 *
 *   1. While any markup lists `card` as a class, app.css must define `.card` with a background — a rule
 *      that exists but paints nothing is the same defect wearing a rule.
 *   2. Every caller is named here. A new one is fine; it just has to be added, which is the moment a
 *      reader asks whether it wants this surface or a <Card.Root>.
 *
 * The second half is what makes the first half honest: a floor on a set nobody enumerates can be
 * satisfied by an empty set.
 */
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';

const SRC = srcDir;

/**
 * The elements that take the shared surface rather than a <Card.Root>, each with why it is not one.
 * A <Card.Root> is a container with Header/Title/Content; none of these want that structure.
 */
const CALLERS: { file: string; why: string }[] = [
	{ file: 'lib/components/SongRow.svelte', why: 'a library/search row — its structure is Item, not Card' },
	{ file: 'lib/components/QueueRow.svelte', why: 'a queue row — Item, plus its own drag and state classes' },
	{ file: 'lib/components/ProcessingCard.svelte', why: 'a processing row — Item, plus a progress bar and stage line' },
	{
		file: 'routes/song/[mediaId]/+page.svelte',
		why:
			"the song page's facts panel — a labelled fact list (key, range, the band sentence, the range " +
			"visualizer), not a Card with a Header and a Title. Its heading is the route's own h1 in " +
			'PageHeader, so a <Card.Title> inside it would be a second heading for the same subject'
	},
	/*
	 * REMOVED, not repointed: `lib/components/NowPlayingHero.svelte` (`class="hero card"`, one of the nine
	 * S4 survivors named at the top of this file). The hero was deleted and its job moved into
	 * `lib/components/NowPlayingDrawer.svelte`, a bottom drawer mounted from `routes/+layout.svelte`.
	 *
	 * The successor does NOT belong on this list, and that is a property of what it became rather than an
	 * omission: the drawer has no shell of its own to paint. Its outermost element is the vendored
	 * `Drawer.Content`, whose surface comes from the registry's `bg-popover` + `border-t` + `rounded-t-xl`
	 * (see `lib/components/ui/drawer/drawer-content.svelte`). The drawer adds only `.np-drawer`, which
	 * sets `padding-bottom` and nothing else. So there is no element in it that wants `.card`, and adding
	 * one would paint a second surface on top of the sheet's own.
	 *
	 * This is the direction the second test below is for: the caller left, so the entry leaves with it.
	 */
	{ file: 'lib/components/MyPositionCard.svelte', why: 'a single line telling a singer where they are' },
	{ file: 'lib/components/CodeEntry.svelte', why: 'one character box of a room-code entry' },
	{ file: 'lib/tv/TvProgress.svelte', why: 'the TV progress track — a ten-foot surface, no card structure' }
	/*
	 * `routes/+page.svelte` LEFT THIS LIST (2026-09-21). Its two `card` surfaces were the reorder bar and the
	 * search dock, and both are gone: the dock moved to /find when search became a route, and the bar went
	 * with the reorder MODE when the drag became a live sort (no Done, no Cancel, nothing to dress). The
	 * route paints no shared surface of its own now — its rows are QueueRow and ProcessingCard, which are
	 * listed above and carry their own.
	 */
];

function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...svelteFiles(p));
		else if (name.endsWith('.svelte')) out.push(p);
	}
	return out;
}

/** Files whose markup lists `card` as a whole class token. */
/** Markup with style blocks, script blocks and HTML comments removed. */
function markupOf(src: string): string {
	return src
		.replace(/<style[\s\S]*?<\/style>/g, ' ')
		.replace(/<script[\s\S]*?<\/script>/g, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ');
}

function callersInTree(): string[] {
	const out = new Set<string>();
	for (const f of svelteFiles(SRC)) {
		/*
		 * MARKUP ONLY. A class list written inside a comment, a style block or a script string applies to
		 * nothing, and counting it makes this guard fire on its own documentation: a comment explaining that
		 * S8 replaced `<div class="card tile primary">` registered the stats page as a live `card` caller and
		 * redded the suite. Several guards on this branch were defeated by prose about themselves, this file
		 * twice — once on the CSS side and once here on the markup side. The stripper is applied rather than
		 * the sentence reworded, because a rule you cannot describe next to the code it governs is a rule
		 * that goes undocumented.
		 */
		const src = markupOf(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/class="([^"]*)"/g)) {
			if (m[1]!.split(/\s+/).includes('card')) out.add(f.slice(SRC.length + 1));
		}
	}
	return [...out].sort();
}

test('while anything uses `card`, app.css defines it WITH a background', () => {
	const callers = callersInTree();
	// Non-vacuity: the population is real. An empty set would make the rule below unfalsifiable.
	// 7, WAS 8 (2026-09-21): `routes/+page.svelte` left the population when the reorder bar was deleted with
	// the mode it dressed (the drag is a live sort — nothing to confirm or abandon), and its other `card`
	// surface, the search dock, had already moved to /find. The floor tracks the population; it must never be
	// lowered to accommodate a caller that quietly stopped being scanned.
	expect(callers.length).toBeGreaterThanOrEqual(7); // @nvf-floor callers.length

	const css = readFileSync(join(SRC, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');

	/*
	 * EVERY `.card` rule, not the first one.
	 *
	 * This read `.exec()` and looked at one rule in a thousand-line stylesheet, which made the claim below
	 * — "a rule that paints nothing is the same defect wearing a rule" — one the check did not actually
	 * deliver. Appending six characters of override stripped the surface from all nine enumerated callers
	 * with the suite fully green:
	 *
	 *     .card { background: none; border: 0; }
	 *
	 * In the cascade the LAST matching declaration wins, so that is the one to assert on. Collecting every
	 * rule also means a refactor that splits `.card` across two blocks cannot hide the paint.
	 */
	const rules = [...css.matchAll(/(?:^|\n)\s*\.card\s*\{([^}]*)\}/g)].map((m) => m[1]!);
	const rule: [unknown, string] | null = rules.length ? [true, rules.join('\n')] : null;
	expect(
		rule,
		`${callers.length} element(s) list \`card\` as a class — ${callers.join(', ')} — but app.css defines ` +
			`no \`.card\` rule. Every one of them renders with no surface. Restore the rule, or migrate those ` +
			`elements and delete the class from their markup in the same change.`
	).not.toBeNull();
	// Non-vacuity: at least one rule was collected, so the assertions below read something.
	expect(rules.length).toBeGreaterThanOrEqual(1); // @nvf-floor rules.length

	// Assert on what SURVIVES the cascade: `lastOf` takes the final declaration of a property across every
	// `.card` rule, which is what the browser will actually use.
	const lastOf = (prop: string): string | null => {
		const hits = [...rules.join('\n').matchAll(new RegExp(`(?:^|;|\\{)\\s*${prop}\\s*:\\s*([^;}]+)`, 'g'))];
		return hits.length ? hits[hits.length - 1]![1]!.trim() : null;
	};
	expect(lastOf('background'), '`.card` must actually paint a surface').toMatch(/var\(--card\)/);
	expect(lastOf('border'), '`.card` must carry its border').toMatch(/1px solid var\(--line\)/);

	/*
	 * …and no OTHER rule un-paints it.
	 *
	 * "The last declaration wins" holds only at equal specificity and equal importance, so collecting the
	 * bare `.card` rules closed one case and left two open. Both of these strip the surface from all nine
	 * callers with everything above still green:
	 *
	 *     body .card { background: none }        higher specificity, and not matched by the bare-rule regex
	 *     .card { background: none !important }  wins from anywhere, including earlier in the file
	 *
	 * Neither shape exists in the tree today, which is why this is a guard rather than a fix. The check is
	 * deliberately narrow: any rule whose selector mentions `.card` and which sets background or border to
	 * something that is not the token. A legitimate future variant (`.card.compact { padding: … }`) is
	 * untouched because it sets neither.
	 */
	const suspicious: string[] = [];
	for (const m of css.matchAll(/(?:^|\n)([^{}\n]*\.card[^{}\n]*)\{([^}]*)\}/g)) {
		const [selector, body] = [m[1]!.trim(), m[2]!];
		if (/^\.card\s*$/.test(selector)) continue; // the canonical rule, asserted above
		for (const prop of ['background', 'border'] as const) {
			const decl = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;}]+)`).exec(body);
			if (!decl) continue;
			const value = decl[1]!.trim();
			const paints = prop === 'background' ? /var\(--card/.test(value) : /var\(--line/.test(value);
			if (!paints || /!important/.test(value)) {
				suspicious.push(`${selector} { ${prop}: ${value} }`);
			}
		}
	}
	expect(
		suspicious,
		'another rule sets `background` or `border` on a `.card` selector to something other than the ' +
			'surface tokens. At higher specificity, or with !important, that wins over the canonical rule and ' +
			'every caller silently loses its surface — the regression this file was written after.'
	).toEqual([]);
});

test('every `card` caller is enumerated, so a new one is a decision', () => {
	const inTree = new Set(callersInTree());
	const known = new Set(CALLERS.map((c) => c.file));

	const unlisted = [...inTree].filter((f) => !known.has(f));
	expect(
		unlisted,
		'a new element takes the shared surface. Add it to CALLERS with why it is not a <Card.Root> — or ' +
			'make it one. This list exists so that choice is made deliberately rather than by copying a class.'
	).toEqual([]);

	// …and the other direction: a caller that migrated should leave the list, or the list rots into a
	// record of what USED to be true, which is what makes a floor stop meaning anything.
	const gone = [...known].filter((f) => !inTree.has(f));
	expect(gone, 'these no longer list `card`; remove them from CALLERS in the change that migrated them').toEqual([]);

	// Each entry carries a reason a reader can weigh, not a bare path.
	for (const c of CALLERS) expect(c.why.length, `${c.file} needs a substantive reason`).toBeGreaterThan(25);
});

test('a later rule that un-paints `card` is caught, not just a deleted one', () => {
	/*
	 * Mutation proof for the override direction, which the `.exec()` version could not see. Deleting the
	 * rule already redded; NEUTRALISING it with a second rule did not, and that is the more likely
	 * accident — a reset block, a theme override, a well-meant `background: none`.
	 */
	const lastOf = (css: string, prop: string): string | null => {
		const rules = [...css.matchAll(/(?:^|\n)\s*\.card\s*\{([^}]*)\}/g)].map((m) => m[1]!);
		const hits = [...rules.join('\n').matchAll(new RegExp(`(?:^|;|\\{)\\s*${prop}\\s*:\\s*([^;}]+)`, 'g'))];
		return hits.length ? hits[hits.length - 1]![1]!.trim() : null;
	};

	const healthy = `.card {\n\tbackground: var(--card);\n\tborder: 1px solid var(--line);\n}`;
	expect(lastOf(healthy, 'background')).toMatch(/var\(--card\)/);

	const overridden = `${healthy}\n.card {\n\tbackground: none;\n\tborder: 0;\n}`;
	expect(lastOf(overridden, 'background')).toBe('none');
	expect(lastOf(overridden, 'background')).not.toMatch(/var\(--card\)/);

	// …and a comment mentioning the property must not count as a declaration.
	const commented = `/* background: none would break this */\n${healthy}`;
	expect(lastOf(commented.replace(/\/\*[\s\S]*?\*\//g, ' '), 'background')).toMatch(/var\(--card\)/);
});

test('a class list inside a comment is not a caller', () => {
	/*
	 * Both directions, so the stripper cannot become a hole: prose mentioning the class must not register a
	 * caller, and real markup must still register one.
	 */
	const prose = `<!-- S8 replaced <div class="card tile primary"> with a wrapper -->\n<div class="tiles"></div>`;
	expect(markupOf(prose)).not.toContain('card');

	const inStyle = `<style>/* .card is defined in app.css */</style>\n<div class="tiles"></div>`;
	expect(markupOf(inStyle)).not.toContain('card');

	const real = `<div class="row card list-row"></div>`;
	expect(markupOf(real)).toContain('card');

	// …and a mid-list token is still found, which is the defect that started this file.
	const tokens = [...markupOf(real).matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/));
	expect(tokens).toContain('card');
});

test('a higher-specificity or !important override is caught too', () => {
	/*
	 * The two shapes the "last wins" model missed. Both are realistic accidents — a reset block, a theme
	 * layer, a print stylesheet — and both un-paint all nine callers.
	 */
	const suspects = (css: string) => {
		const out: string[] = [];
		for (const m of css.matchAll(/(?:^|\n)([^{}\n]*\.card[^{}\n]*)\{([^}]*)\}/g)) {
			const [selector, body] = [m[1]!.trim(), m[2]!];
			if (/^\.card\s*$/.test(selector)) continue;
			const decl = /(?:^|;)\s*background\s*:\s*([^;}]+)/.exec(body);
			if (!decl) continue;
			const v = decl[1]!.trim();
			if (!/var\(--card/.test(v) || /!important/.test(v)) out.push(`${selector} -> ${v}`);
		}
		return out;
	};

	expect(suspects(`body .card { background: none; }`)).toHaveLength(1);
	expect(suspects(`.theme-x .card { background: red; }`)).toHaveLength(1);
	// A variant that sets neither background nor border is legitimate and must not be flagged.
	expect(suspects(`.card.compact { padding: 4px; }`)).toEqual([]);
	// …and one that re-states the real token is fine.
	expect(suspects(`@media print { .card { background: var(--card); } }`)).toEqual([]);
});
