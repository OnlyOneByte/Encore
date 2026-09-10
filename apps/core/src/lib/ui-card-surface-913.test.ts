/*
 * THE SHARED `.card` SURFACE AND ITS CALLERS STAY TOGETHER (#913).
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────────────────────────
 *
 * #913 S4 migrated 28 content cards onto shadcn's <Card.Root> and then deleted `.card` from app.css,
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

const SRC = join(import.meta.dir, '..');

/**
 * The elements that take the shared surface rather than a <Card.Root>, each with why it is not one.
 * A <Card.Root> is a container with Header/Title/Content; none of these want that structure.
 */
const CALLERS: { file: string; why: string }[] = [
	{ file: 'lib/components/SongRow.svelte', why: 'a library/search row — its structure is Item, not Card' },
	{ file: 'lib/components/QueueRow.svelte', why: 'a queue row — Item, plus its own drag and state classes' },
	{ file: 'lib/components/ProcessingCard.svelte', why: 'a cooking row — Item, plus a progress bar and stage line' },
	{ file: 'lib/components/NowPlayingHero.svelte', why: 'the hero: a transport and a disclosure, not a titled card' },
	{ file: 'lib/components/MyPositionCard.svelte', why: 'a single line telling a singer where they are' },
	{ file: 'lib/components/CodeEntry.svelte', why: 'one character box of a room-code entry' },
	{ file: 'lib/components/JoinLanding.svelte', why: 'the scanned-room row on the landing surface' },
	{ file: 'lib/tv/TvProgress.svelte', why: 'the TV progress track — a ten-foot surface, no card structure' },
	{ file: 'routes/+page.svelte', why: 'the reorder bar, and the search dock which carries its own copy' }
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
function callersInTree(): string[] {
	const out = new Set<string>();
	for (const f of svelteFiles(SRC)) {
		const src = readFileSync(f, 'utf8');
		for (const m of src.matchAll(/class="([^"]*)"/g)) {
			if (m[1]!.split(/\s+/).includes('card')) out.add(f.slice(SRC.length + 1));
		}
	}
	return [...out].sort();
}

test('while anything uses `card`, app.css defines it WITH a background (#913)', () => {
	const callers = callersInTree();
	// Non-vacuity: the population is real. An empty set would make the rule below unfalsifiable.
	expect(callers.length).toBeGreaterThanOrEqual(8);

	const css = readFileSync(join(SRC, 'app.css'), 'utf8');
	const rule = /(?:^|\n)\.card\s*\{([^}]*)\}/.exec(css);
	expect(
		rule,
		`${callers.length} element(s) list \`card\` as a class — ${callers.join(', ')} — but app.css defines ` +
			`no \`.card\` rule. Every one of them renders with no surface. Restore the rule, or migrate those ` +
			`elements and delete the class from their markup in the same change.`
	).not.toBeNull();
	// A rule that paints nothing is the same defect wearing a rule.
	expect(rule![1], '`.card` must actually paint a surface').toMatch(/background:\s*var\(--card\)/);
	expect(rule![1], '`.card` must carry its border').toMatch(/border:\s*1px solid var\(--line\)/);
});

test('every `card` caller is enumerated, so a new one is a decision (#913)', () => {
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
	expect(gone, 'these no longer list `card`; remove them from CALLERS in the change that migrated them').toEqual(
		[]
	);

	// Each entry carries a reason a reader can weigh, not a bare path.
	for (const c of CALLERS) expect(c.why.length, `${c.file} needs a substantive reason`).toBeGreaterThan(25);
});
