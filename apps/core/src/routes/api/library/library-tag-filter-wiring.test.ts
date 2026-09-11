// guard: GET /api/library must support a `?tag=` filter that narrows the library to songs
// carrying a descriptive tag, AND expose a tag facet — both reading the media_tags byKindValue index
// via the repository (byTag / tagFacets), not a client-side filter over the payload.
//
// WHY A SOURCE SCAN. The handler calls getApp() — the live app singleton with a DB, job ledger and
// boot maintenance — so exercising the real GET here would boot the whole server (same reason as the
// wiring guard). The behaviour the feature turns on is a decidable property of the route source:
//   (a) it reads the `tag` query param and selects the library via byTag(tag),
//   (b) it returns a tag facet built from tagFacets() in the payload,
//   (c) the filter object reports the active tag.
// The repository RUNTIME test (media/library-tag-filter.test.ts) proves byTag/tagFacets actually read
// the tag-kind index, so this scan is not the only thing standing between the fix and green.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Blank comments (not delete — keep offsets) so a seam cannot be satisfied by prose describing it.
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}
const SRC = stripComments(readFileSync(join(import.meta.dir, '+server.ts'), 'utf8'));

test('the route reads a ?tag= param and selects the library via byTag', () => {
	// reads the tag query param
	expect(SRC).toMatch(/searchParams\.get\(\s*['"'"'"'"]tag["'"'"'"']\s*\)/);
	// and narrows the library through the indexed repository method, NOT a .filter() over listReady
	expect(SRC).toMatch(/\.byTag\(\s*tag\s*\)/);
});

test('the route exposes a tag facet built from tagFacets()', () => {
	// the facets object must carry a tags facet from the repository
	const m = SRC.match(/facets\s*:\s*\{([^}]*)\}/);
	expect(m).not.toBeNull(); // non-vacuous
	expect(m![1]).toMatch(/tags\s*:\s*app\.media\.tagFacets\(\)/);
});

test('the filter object reports the active tag', () => {
	// so the client can render "duet · N songs" and a clear affordance for a tag filter too.
	expect(SRC).toMatch(/tag\s*\?\s*\{\s*tag\s*\}/);
});
