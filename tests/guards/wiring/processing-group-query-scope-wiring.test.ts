// The query scope for the Processing group is WIRED into whichever page owns the search box. Caught: a
// PROCESSING song appeared under a search it did not match, because the group's id-selection was an
// inline `$derived.by` scanning the whole status map and catalog with no reference to `query` — the
// server already returns a query-scoped `processing` group and the phone threw it away. The pure
// `processingGroupIds` helper keeps its own tests when a wiring line is deleted.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const PAGE = stripComments(readFileSync(at('src/routes/+page.svelte'), 'utf8'));

test('the page imports the query-scope helper it wires', () => {
	expect(PAGE).toMatch(/import\s*\{[^}]*\bprocessingGroupIds\b[^}]*\}\s*from\s*'\$lib\/readiness'/);
});

test('the Processing group is derived through processingGroupIds, scoped by the query', () => {
	expect(PAGE).toMatch(/const\s+processingRows\s*=\s*\$derived\.by\(/);
	expect(PAGE).toMatch(/processingGroupIds\(\s*\{/);
	// `searchActive` and `processingResults` are what make the group obey the query, so a call missing
	// either is the query-blind form under a new name.
	expect(PAGE).toMatch(/processingGroupIds\(\s*\{[\s\S]{0,220}\bsearchActive\b/);
	expect(PAGE).toMatch(/processingGroupIds\(\s*\{[\s\S]{0,220}\bprocessingResults\b/);
});

test('the query-blind inline union is GONE from the processingRows derivation', () => {
	// Scoped to processingRows' own body: a whole-catalog or whole-status-map scan re-derived there is the
	// query-blind form returning, regardless of what the helper is also called with.
	const m = PAGE.match(/const\s+processingRows\s*=\s*\$derived\.by\(\(\)\s*=>\s*\{([\s\S]*?)\n\t\}\);/);
	expect(m).not.toBeNull(); // the derivation must exist to be scanned
	const body = m![1];
	expect(body).not.toMatch(/for\s*\(\s*const\s*\[[^\]]*\]\s*of\s*mediaCatalog\s*\)/);
	expect(body).not.toMatch(/for\s*\(\s*const\s*\[[^\]]*\]\s*of\s*mediaStatus\s*\)/);
});

test('processingResults holds the server query-matched group and is set/cleared on the search path', () => {
	expect(PAGE).toMatch(/let\s+processingResults\s*=\s*\$state<Media\[\]>\(\[\]\)/);
	expect(PAGE).toMatch(/processingResults\s*=\s*j\.processing\s*\?\?\s*\[\]/);
	// Cleared inside the empty-query teardown, or a stale query-scoped group lingers after the box clears.
	expect(PAGE).toMatch(/if\s*\(!q\)\s*\{[\s\S]{0,160}processingResults\s*=\s*\[\]/);
});

test('a failed search clears processingResults so no stale query-scoped group lingers', () => {
	// Pinned in the non-abort error branch beside its sibling resets: a group scoped to a query that then
	// failed would otherwise keep rendering under whatever the box shows next.
	expect(PAGE).toMatch(/rawResults\s*=\s*\[\];\s*processingResults\s*=\s*\[\];[\s\S]{0,120}showError\(/);
});
