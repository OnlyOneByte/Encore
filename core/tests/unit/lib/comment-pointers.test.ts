import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { at } from '$test';

/*
 * guard: a comment under `src/` may not point at another file by LINE NUMBER, and the two cross-file claims that
 * rotted worst are pinned to the thing they actually name.
 *
 * This file exists because of a measured failure, not a style preference. `app.css`'s `.grouphead` note and
 * `/settings`' landscape claw-back both cross-referenced the four routes carrying the
 * `@media (max-height: 480px)` arm by line. Two of those pointers drifted: `/`'s arm moved to 1183 while the
 * comments still said 1175 (where a `padding-bottom` now sits) and `/settings`' moved to 1108 while they said
 * 1091 (blank). Nobody edited the comments, because nobody edits a comment in another file when they insert a
 * rule. A third pointer, in `/`'s zero-state note, named a `$derived.by` as the precedent for `Card.Title`'s
 * heading role. All three were true when written. That is the whole problem: a line pointer is a claim that goes
 * false without anyone touching it, which is the one kind of false comment a reviewer cannot catch by reading
 * the diff.
 *
 * So the rule is: name the SELECTOR, the RULE, the token or the element. Those move with the code they describe.
 */

const SRC_FILES = readdirSync(at('src'), { recursive: true, encoding: 'utf8' }).filter((p) =>
	/\.(css|svelte|ts)$/.test(p)
);

/** `foo/bar.svelte:123`, `app.css:45-48` — a pointer into a file by line. */
const FILE_LINE = /[A-Za-z0-9_[\]./+-]+\.(?:svelte|ts|css|py|json|md):\d+(?:-\d+)?/g;

/** ``/`:1175``, ``` `song/[mediaId]`:292 ``` — the same thing spelled as a ROUTE, which is how the
 *  `.grouphead` note spelled it and so the form the first sweep missed. */
const ROUTE_LINE = /`[A-Za-z/[\]+._-]*`:\d+/g;

test('no comment under src/ points at another file by line number', () => {
	const found: string[] = [];
	for (const p of SRC_FILES) {
		const body = readFileSync(at(`src/${p}`), 'utf8');
		for (const m of body.matchAll(FILE_LINE)) found.push(`src/${p}: ${m[0]}`);
		for (const m of body.matchAll(ROUTE_LINE)) found.push(`src/${p}: ${m[0]}`);
	}
	// Listed rather than counted, so a regression prints the pointer and the file that has to be reworded.
	expect(found).toEqual([]);
});

test('the four hosts of the landscape claw-back are named by RULE, and all four still carry it', () => {
	// The claim both reworded comments now make, re-derived: every one of these files declares the arm. If a route
	// drops it, this reds — which is the check the line numbers were never able to perform.
	const hosts = [
		'routes/+page.svelte',
		'routes/library/+page.svelte',
		// The settings host is the SHELL, not a route: `/settings` is three scope routes now and the grid the arm acts
		// on is declared once, in the component all three wear.
		'lib/ui/SettingsScope.svelte',
		'routes/song/[mediaId]/+page.svelte'
	];
	for (const h of hosts) {
		expect(readFileSync(at(`src/${h}`), 'utf8')).toContain('@media (max-height: 480px)');
	}
	// Three of them spend it on `.grouphead` with IDENTICAL values — that identity is the substance of app.css's
	// "a sideways phone reads one geometry", and it is what a reader previously had to chase four line numbers to
	// confirm. `/library` needs `.refine .grouphead` beside it on specificity grounds; that is asserted too,
	// because dropping it silently restores the portrait margin inside the disclosure.
	const CLAWBACK = 'margin: var(--space-sm) var(--space-2xs) var(--space-2xs);';
	const SETTINGS_SHELL = 'lib/ui/SettingsScope.svelte';
	for (const h of hosts.filter((f) => f !== SETTINGS_SHELL)) {
		expect(readFileSync(at(`src/${h}`), 'utf8')).toContain(CLAWBACK);
	}
	const library = readFileSync(at('src/routes/library/+page.svelte'), 'utf8');
	expect(library).toContain('.refine .grouphead');
	// Settings is the exception the notes call out: it spends the rung as a grid gap, so its arm moves `.panel`'s
	// row-gap instead of a `.grouphead` margin.
	const settings = readFileSync(at(`src/${SETTINGS_SHELL}`), 'utf8');
	expect(settings).toContain('row-gap: var(--space-lg);');
	expect(settings).not.toContain(CLAWBACK);
	// And app.css, which owns the shared base, points at the mechanism rather than at a line.
	const appCss = readFileSync(at('src/app.css'), 'utf8');
	expect(appCss).toContain('NAMED BY RULE AND NOT BY LINE');
});

test('the Sing tab renders no library shelf, so it reads no viewport width in JS at all', () => {
	/* THE SUCCESSOR to a claim about the shelf's cap. That claim was there because the doc read "a SHELF of
	 * `LIBRARY_SHELF` rows (eight at `--bp-lg`)", which says one constant changes value at a width — it did not; there
	 * were two constants and the route picked one off a `matchMedia` read. The shelf is gone from `/` entirely now
	 * (/library is the library, and the Library tab is on screen at every width), which retires the whole
	 * question. What is worth pinning is the CONSEQUENCE: this surface no longer reads a width in JS. */
	const home = readFileSync(at('src/routes/+page.svelte'), 'utf8');
	expect(home).not.toContain('libraryShelf');
	expect(home).not.toContain('LIBRARY_SHELF');
	/* The cap was the only reason `/` ever read a width in JS, and the reason it had to be JS rather than CSS is that
	 * the extra rows did not EXIST in the DOM for a stylesheet to reveal. With no shelf, a `matchMedia` here would be
	 * a width read with nothing to decide — and the same hazard as before, because a media condition cannot resolve a
	 * custom property, so the literal and the token drift apart silently. */
	expect(home).not.toContain('matchMedia');
	// --bp-lg keeps its declaration and its CSS callers; it is the JS one that is gone. Both survivors are asserted,
	// because app.css's own `--bp-*` note names them.
	expect(readFileSync(at('src/app.css'), 'utf8')).toMatch(/--bp-lg:\s*1200px;/);
	expect(readFileSync(at('src/app.css'), 'utf8')).toContain('@media (min-width: 1200px)');
	expect(readFileSync(at('src/routes/library/+page.svelte'), 'utf8')).toContain('@media (min-width: 1200px)');
	// And the doc's own section says the same. The negative is kept from the retired test: that exact sentence is the
	// one that was wrong, and reviving it would be wrong twice over now.
	const frontend = readFileSync(at('../docs/FRONTEND.md'), 'utf8');
	expect(frontend).not.toContain('a SHELF of `LIBRARY_SHELF` rows (eight');
	const start = frontend.indexOf('### The Sing tab');
	const end = frontend.indexOf('### The library page');
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	// A past-tense mention of where the rows went is fine; a live claim that `/` caps a shelf is not.
	expect(frontend.slice(start, end)).not.toContain('LIBRARY_SHELF');
});
