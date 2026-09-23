// GET /api/library supports a `?tag=` filter and exposes a tag facet, both reading the media_tags
// byKindValue index through the repository rather than filtering the payload client-side. The handler
// calls `getApp()`, so exercising the real GET would boot the whole server; a repository runtime test
// proves `byTag`/`tagFacets` really read the tag-kind index.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

/** Blank comments, so a seam cannot be satisfied by prose describing it. */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const SRC = stripComments(read('src/routes/api/library/+server.ts'));

test('the route reads a ?tag= param and selects the library via byTag', () => {
	expect(SRC).toMatch(/searchParams\.get\(\s*['"'"'"'"]tag["'"'"'"']\s*\)/);
	// Through the INDEXED repository method, never a `.filter()` over listReady.
	expect(SRC).toMatch(/\.byTag\(\s*tag\s*\)/);
});

test('the route exposes a tag facet built from tagFacets()', () => {
	const m = SRC.match(/facets\s*:\s*\{([^}]*)\}/);
	expect(m).not.toBeNull();
	expect(m![1]).toMatch(/tags\s*:\s*app\.media\.tagFacets\(\)/);
});

test('the filter object reports the active tag', () => {
	// The client needs it to render the active-filter label and a clear affordance.
	expect(SRC).toMatch(/tag\s*\?\s*\{\s*tag\s*\}/);
});
