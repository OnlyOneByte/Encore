// guard: the unreachable browse-by-genre feature stays DELETED (owner ruling). The ONLY writer of a song's
// `canonical.genre` was `POST /api/tag`, which had zero non-route callers — no UI, no e2e, no server code,
// no test — so genre was permanently `[]`, the phone's chip row was gated on `facets.genres.length > 1` and
// never appeared, and the whole read chain (`genreFacets()`, `byGenre()`, the `?genre=` branch) was dead in
// production. A SOURCE SCAN because the feature's defining property is the ABSENCE of code; raw source, so a
// re-introduction in a copied comment is caught too.
import { expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { read as readRepoFile, srcDir } from '@encore/test-support';
import { join } from 'node:path';

// Anchored on `srcDir`: a wrong root makes `existsSync` false, which is exactly what this guard wants to see.
const read = (rel: string) => readRepoFile('src', rel);

it('the unreachable browse-by-genre feature stays removed: the uncalled POST /api/tag route is gone', () => {
	// srcDir is derived from the repo-root marker and self-checked on load, so a false here means the route is
	// absent rather than that the path was wrong.
	expect(existsSync(join(srcDir, 'routes/api/tag/+server.ts'))).toBe(false);
});

it('the unreachable browse-by-genre feature stays removed: the dead genre read methods are gone from the media repository', () => {
	const repo = read('lib/server/media/repository.ts');
	expect(repo).not.toMatch(/\bgenreFacets\s*\(/);
	expect(repo).not.toMatch(/\bbyGenre\s*\(/);
});

it('the unreachable browse-by-genre feature stays removed: the library endpoint no longer exposes a genre facet or a ?genre= filter branch', () => {
	const lib = read('routes/api/library/+server.ts');
	expect(lib).not.toMatch(/genreFacets|byGenre/);
	expect(lib).not.toMatch(/searchParams\.get\(\s*['"]genre['"]\s*\)/);
});

it('the unreachable browse-by-genre feature stays removed: the phone has no Browse-by-genre chip row', () => {
	const page = read('routes/+page.svelte');
	expect(page).not.toContain('Browse by genre');
	expect(page).not.toMatch(/facets\.genres/);
});

// The generic tag machinery (setTags/tagsOf, the genre|tag|mood kind enum) is NOT part of the removal: it is
// used elsewhere, so pin that it survived and a future over-eager cleanup cannot take it under this cover.
it('the unreachable browse-by-genre feature stays removed: the generic setTags/tagsOf primitive is retained', () => {
	const repo = read('lib/server/media/repository.ts');
	expect(repo).toMatch(/\bsetTags\s*\(/);
	expect(repo).toMatch(/\btagsOf\s*\(/);
});
