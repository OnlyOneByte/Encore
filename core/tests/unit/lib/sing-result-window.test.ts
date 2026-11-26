import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';
import { libraryWindow, LIBRARY_PAGE } from '$lib/library-browse';

/*
 * guard: the Sing tab's three result groups stay WINDOWED, and the de-duplication and the zero-state stay OFF the
 * window.
 *
 * Neither half is runtime-assertable here — `bun test` has no layout and this tree mounts no components (see
 * bunfig.toml) — but both halves of the defect are WIRING, and wiring is exactly what this file reads.
 *
 * WHAT THE DEFECT WAS. `partitionSearch`'s catalog arm walks the whole persisted catalog with no cap (only the
 * resolvers are bounded, at PER_SOURCE_LIMIT = 12), and /api/search MATERIALISES AND PERSISTS every hit, so the
 * column is sized by the install's lifetime catalog rather than by the query. Measured at 390x844 on the shared
 * copy, `q=a`: 3,412 rows / 56,260 DOM nodes / 320,120px of scroll, 1,235ms for the first `+` to read `queued`,
 * and `Not it? Search everything` at y=319,949 — 379 viewports down. `wonderwall` (68 rows) confirms the same tap
 * in 47ms on the same server, so the second is the column.
 *
 * THOSE ARE ONE SESSION'S FIGURES, quoted from the note on `revealedProcessing` in `+page.svelte` rather than
 * re-measured here — every reading on that surface climbs between runs, because /api/search persists what it
 * resolves, so an independently taken set in a second file would disagree with the component's and neither could
 * carry the "on the same server" clause the 47ms-against-1,235ms argument rests on.
 *
 * THE OTHER HALF IS THE TRAP, and it is why this is a guard rather than just an arithmetic test: swapping the
 * de-duplication or the zero-state onto `.shown` would make the window silently change what the page CLAIMS. A
 * 200-row answer whose first 60 are ready would print "Nothing matches “…”" under sixty visible rows.
 */

const home = readFileSync(at('src/routes/(phone)/+page.svelte'), 'utf8');

test('each group renders its WINDOW, never the full list', () => {
	// The three `{#each}` sources. Written as separate assertions rather than one block match because prettier
	// reflows the multi-line `<SongRow>` attribute lists that follow them.
	expect(home).toContain('{#each processingView.shown as c (c.id)}');
	expect(home).toContain('{#each readyView.shown as m (m.id)}');
	expect(home).toContain('{#each rawView.shown as m (m.id)}');
	// And none of them iterates the unwindowed list any more.
	expect(home).not.toContain('{#each processingRows as');
	expect(home).not.toContain('{#each readyResults as');
	expect(home).not.toContain('{#each rawRows as');

	// Each window is a `libraryWindow` over the FULL list, paired with its own counter — one shared counter would
	// let the long `Needs karaoke` tail decide how many ready songs a guest can see.
	expect(home).toContain('const processingView = $derived(libraryWindow(processingRows, revealedProcessing));');
	expect(home).toContain('const readyView = $derived(libraryWindow(readyResults, revealedReady));');
	// The unmade rows split by what can be made now (proposal 24), each half windowed on its own counter.
	expect(home).toContain('const rawView = $derived(libraryWindow(makeRows, revealedRaw));');
	expect(home).toContain('const cantView = $derived(libraryWindow(cantRows, revealedCant));');
	expect(home).toContain('{#each cantView.shown as m (m.id)}');
});

test('the window resets with the ROWS — in clearResults, and nowhere else', () => {
	// `clearResults()` is the one seam where all three groups are already dropped, and it runs at the top of
	// `runSearch`. Resetting on the keystroke instead collapses rows a guest is still looking at.
	const start = home.indexOf('function clearResults() {');
	expect(start).toBeGreaterThan(-1);
	const body = home.slice(start, home.indexOf('\t}', start));
	for (const counter of ['revealedProcessing', 'revealedReady', 'revealedRaw']) {
		expect(body).toContain(`${counter} = LIBRARY_PAGE`);
		// Declared with the page size as its floor, so the first render of any query is one page.
		expect(home).toContain(`let ${counter} = $state(LIBRARY_PAGE);`);
	}
	/* AND NOWHERE ELSE means `onQueryInput` in particular, read as a WHOLE BODY rather than as one formatting of
	   its first line: an earlier version of this assertion pinned the literal `function onQueryInput() {\n\t\t
	   revealed`, which a reset two statements lower, or the same reset after a prettier reflow, walked straight
	   past. Any `revealedX =` inside this function is the defect; the empty-box path is still free to call
	   `clearResults()`, which is where the reset legitimately lives. */
	const onInput = home.indexOf('function onQueryInput() {');
	expect(onInput).toBeGreaterThan(-1);
	const inputBody = home.slice(onInput, home.indexOf('\n\t}', onInput));
	expect(inputBody).not.toMatch(/revealed\w*\s*=/);
	expect(inputBody).toContain('clearResults();');
});

test('three doors, each gated on something actually being hidden', () => {
	// A control promising more than it has is worse than no control — `libraryWindow`'s own note.
	expect(home).toContain('{#if processingView.hidden > 0}');
	expect(home).toContain('{#if readyView.hidden > 0}');
	expect(home).toContain('{#if rawView.hidden > 0}');
	// The copy /library ships, verbatim, including the remaining count riding ON the control.
	expect(home).toContain('Show {Math.min(LIBRARY_PAGE, rawView.hidden)} more');
	expect(home).toContain('<span class="chip-n">{rawView.hidden} left</span>');
	// The reveal GROWS by a page; it must not jump to the whole list, which is the state being fixed.
	expect(home).toContain('revealedRaw += LIBRARY_PAGE');
});

test('the door carries the 320px reflow clause, because its label is long', () => {
	/* MEASURED, not precautionary. The remaining count rides on the label, so at 320px with the root at 32px
	   (200% text-only zoom) the `Needs karaoke` door laid out 344.56px wide with its right edge at 332.28 in a
	   320px viewport — which p15 reds on BOTH of its arms, documentElement `scrollWidth` 332 against `clientWidth`
	   320 and that button past the right edge, and is an SC 1.4.10 failure. The Button base carries BOTH
	   `whitespace-nowrap` and `shrink-0`, so wrapping alone does not fix it: `flex-shrink` is the half that does,
	   and `min-width: 0` is its documented companion. With all five the control reads 256px / right=288, the same
	   as `.showall-row` directly below it. */
	const clause = home.slice(home.indexOf(".reveal :global([data-slot='button'])"));
	expect(clause.indexOf('}')).toBeGreaterThan(-1);
	const body = clause.slice(0, clause.indexOf('}'));
	for (const decl of [
		'white-space: normal',
		'overflow-wrap: anywhere',
		'flex-shrink: 1',
		'min-width: 0',
		'max-width: 100%'
	]) {
		expect(body).toContain(decl);
	}
	/* ANCHORED, every time it appears. `:global()` is unavoidable — a class handed to a component is stripped at
	   the caller, so the vendored button is only reachable through its own `data-slot` — and an UNANCHORED
	   `:global([data-slot='button'])` in this file would re-flow every button in the app. Checked across the whole
	   file rather than just this rule, because `.showall-row` carries the identical clause and the hazard is
	   shared. The trailing brace in the pattern is load-bearing: without it the match also swept the PROSE above,
	   which names the sibling selector, and the test failed on a correct tree. */
	for (const m of home.matchAll(/(\S*)\s*:global\(\[data-slot='button'\]\)\s*\{/g)) {
		expect(['.reveal', '.showall-row', '.me-slot']).toContain(m[1]);
	}
});

test('de-duplication and the zero-state read the FULL lists, not the windows', () => {
	// `accountedFor` decides which group OWNS a song. Off `.shown` it would stop suppressing a duplicate the
	// moment that duplicate fell past the window, and the same song would draw two rows and two progress bars.
	const acc = home.slice(home.indexOf('const accountedFor = $derived.by(()'), home.indexOf('function unaccounted'));
	expect(acc).toContain('for (const m of readyResults)');
	expect(acc).toContain('for (const c of processingRows)');
	expect(acc).not.toContain('View.shown');

	// `showsNoRows` answers "did the search find anything at all". Its three counts are the full lists.
	expect(home).toContain('readyCount: readyResults.length');
	expect(home).toContain('rawCount: rawRows.length');
	expect(home).toContain('processingCount: processingRows.length');
	expect(home).not.toContain('readyCount: readyView.shown.length');

	// Same for the group headings and the widen gate: a heading is a claim about the GROUP, and the widen is
	// offered because the query returned rows, not because sixty of them are painted.
	expect(home).toContain('{#if readyResults.length}');
	expect(home).toContain('{#if makeRows.length}');
	expect(home).toContain('{#if cantRows.length}');
	expect(home).toContain('{#if processingRows.length}');
	expect(home).toContain('(rawRows.length || readyResults.length)');
});

test('the arithmetic this leans on is the arithmetic /library measured', () => {
	// Not a re-test of libraryWindow (library-browse has its own suite) — a check that the contract the Sing tab
	// now depends on is the one it thinks it depends on: a page-sized first render, and `hidden` reaching 0.
	expect(LIBRARY_PAGE).toBe(60);
	const rows = Array.from({ length: 150 }, (_, i) => i);
	expect(libraryWindow(rows, LIBRARY_PAGE)).toEqual({ shown: rows.slice(0, 60), hidden: 90 });
	expect(libraryWindow(rows, LIBRARY_PAGE * 3).hidden).toBe(0);
});
