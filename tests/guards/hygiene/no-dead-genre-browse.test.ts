// Regression guard for the browse-by-genre removal (owner ruling: DELETE the unreachable browse-by-genre feature).
//
// Browse-by-genre could never render: the ONLY writer of a song's `canonical.genre` was
// `POST /api/tag`, which had zero non-route callers — no UI, no e2e, no server code, no test. Genre
// was therefore permanently `[]`, the phone's genre chip row was gated on `facets.genres.length > 1`
// and never appeared, and the whole read chain (`genreFacets()`, `byGenre()`, the `?genre=` branch)
// was dead in production. The owner ruled remove-it, so this guard pins the dead surface as GONE.
//
// It is a SOURCE SCAN on purpose: the feature's defining property is the ABSENCE of code, which no
// behavioural test can express (there is nothing left to exercise). Reads raw source so a stray
// re-introduction in either code or a copied comment is caught. Mutation-proven on base: every
// assertion below reds when the deleted code is restored.
import { expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { read as readRepoFile, srcDir } from '@encore/test-support';
import { join } from 'node:path';

// Anchored on `srcDir` rather than on this file's own location. The previous form was
// `dirname(fileURLToPath(import.meta.url))` then `join(HERE, '..', '..')` to mean src — a
// statement about where the TEST lived, embedded in a statement about where the SOURCE lived. Moving the
// file broke it, and the four assertions that read a file broke LOUDLY while the one asserting a file is
// ABSENT would have started passing for the wrong reason: a wrong root makes `existsSync` false, which is
// exactly what this guard wants to see.
const read = (rel: string) => readRepoFile('src', rel);

it('the unreachable browse-by-genre feature stays removed: the uncalled POST /api/tag route is gone', () => {
	// Deliberately still an existsSync, but on an anchor that cannot silently be wrong: `srcDir` is
	// derived from the repo root marker and self-checked on load, so a false here means the route is
	// absent rather than that the path was.
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

// The generic tag machinery (setTags/tagsOf and the genre|tag|mood kind enum) is NOT part of the
// removal — it is used elsewhere and the owner did not name it. Assert it survived, so a future
// over-eager cleanup cannot delete the reusable primitive under cover of this guard.
it('the unreachable browse-by-genre feature stays removed: the generic setTags/tagsOf primitive is retained', () => {
	const repo = read('lib/server/media/repository.ts');
	expect(repo).toMatch(/\bsetTags\s*\(/);
	expect(repo).toMatch(/\btagsOf\s*\(/);
});
