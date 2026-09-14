// guard: the query-scope for the Processing group is WIRED into the phone page.
//
// THE DEFECT. A PROCESSING song showed up under a search it did not match — searching "never
// gonna give you up" still listed a processing "I want it that way" — because the Processing group's
// id-selection was an inline `$derived.by` that scanned the WHOLE live status map and the WHOLE
// catalog with no reference to `query`. The server already returns a query-scoped `processing` group;
// the phone threw it away and rebuilt query-blind.
//
// THE FIX moves the id-selection into the pure `processingGroupIds` helper (unit-tested in
// apps/core/src/lib/processing-group-query-scope.test.ts) and feeds it the server's query-matched group
// via a new `processingResults` state. The helper carries the logic; but the LINES that wire it into
// the search surface — hold `j.processing`, clear it with the box, and pass it to the helper — live in
// a Svelte component bun test never imports (Encore has no jsdom; every UI invariant is a source-scan
// guard). Without this guard, deleting any wiring line ships green: the helper keeps its own tests
// while the component silently reverts to the query-blind union. This is the repo's most-repeated
// defect class (a mechanism built, tested, and never called from the path that needs it).
//
// WHY A SOURCE SCAN. The wiring is inside a $derived.by and the runSearch closure, both of which only
// run in a live browser page. The presence of each seam is a decidable property of the component
// source, so this reads the search surface and requires each one.
//
// RE-POINTED for the phone-remote redesign: search moved out of `routes/+page.svelte` (home is
// queue-only now) into its own route, `routes/find/+page.svelte`, carrying `query`, `searchActive`,
// `processingResults`, `runSearch` and `processingRows` over unchanged. The query-scoping seams are
// properties of whichever surface owns the search box, and that is now /find. Same requirements, new
// address.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';

// Blank comments before scanning so a seam cannot be satisfied by text in a comment (or an old
// query-blind snippet quoted in prose) while the live code has lost it. Blanks not deletes so offsets
// line up. Matches the repo convention (failed-process-scar-wiring.test.ts, icon-centring.test.ts).
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// Paths come from `at()`, which resolves against the repo root, so this guard does not encode its own depth.
const PAGE = stripComments(readFileSync(at('src/routes/find/+page.svelte'), 'utf8'));

test('the page imports the query-scope helper it wires', () => {
	expect(PAGE).toMatch(/import\s*\{[^}]*\bprocessingGroupIds\b[^}]*\}\s*from\s*'\$lib\/readiness'/);
});

test('the Processing group is derived through processingGroupIds, scoped by the query', () => {
	// The derivation must delegate to the pure helper and hand it BOTH the query flag and the server's
	// query-matched group. Deleting the delegation or dropping either input reds this.
	expect(PAGE).toMatch(/const\s+processingRows\s*=\s*\$derived\.by\(/);
	expect(PAGE).toMatch(/processingGroupIds\(\s*\{/);
	// searchActive and processingResults must both reach the helper — they are what make the group obey
	// the query. A call missing either is the query-blind form under a new name.
	expect(PAGE).toMatch(/processingGroupIds\(\s*\{[\s\S]{0,220}\bsearchActive\b/);
	expect(PAGE).toMatch(/processingGroupIds\(\s*\{[\s\S]{0,220}\bprocessingResults\b/);
});

test('the query-blind inline union is GONE from the processingRows derivation', () => {
	// The exact reintroduction the bug would take: re-deriving the group by scanning the whole catalog
	// for `readinessFor(m) === 'processing'` (or the whole status map) INSIDE the processingRows derivation,
	// ignoring the query. Capture processingRows' body and forbid that form there.
	const m = PAGE.match(/const\s+processingRows\s*=\s*\$derived\.by\(\(\)\s*=>\s*\{([\s\S]*?)\n\t\}\);/);
	expect(m).not.toBeNull(); // non-vacuous: the derivation must exist to be scanned
	const body = m![1];
	// no whole-catalog processing scan and no whole-status-map scan re-derived inline
	expect(body).not.toMatch(/for\s*\(\s*const\s*\[[^\]]*\]\s*of\s*mediaCatalog\s*\)/);
	expect(body).not.toMatch(/for\s*\(\s*const\s*\[[^\]]*\]\s*of\s*mediaStatus\s*\)/);
});

test('processingResults holds the server query-matched group and is set/cleared on the search path', () => {
	// The state that carries the query-scoping.
	expect(PAGE).toMatch(/let\s+processingResults\s*=\s*\$state<Media\[\]>\(\[\]\)/);
	// runSearch stores the wire's processing group into it (this is "stop discarding it").
	expect(PAGE).toMatch(/processingResults\s*=\s*j\.processing\s*\?\?\s*\[\]/);
	// cleared with the box so a stale query-scoped group cannot linger after the search is dropped.
	// Pin it inside the empty-query teardown next to the other two result resets.
	expect(PAGE).toMatch(/if\s*\(!q\)\s*\{[\s\S]{0,160}processingResults\s*=\s*\[\]/);
});

test('a failed search clears processingResults so no stale query-scoped group lingers', () => {
	// The search catch branch resets readyResults/rawResults; processingResults must reset with them, or a
	// group scoped to a query that then failed would keep rendering under whatever the box shows next.
	// Pin the reset inside the non-abort error branch (showError names it), next to the sibling resets.
	expect(PAGE).toMatch(/rawResults\s*=\s*\[\];\s*processingResults\s*=\s*\[\];[\s\S]{0,120}showError\(/);
});
