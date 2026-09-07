// Regression guard for issue #121 (owner ruling: DELETE the unreachable browse-by-genre feature).
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
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_SRC = join(HERE, '..', '..'); // apps/core/src
const read = (rel: string) => readFileSync(join(CORE_SRC, rel), 'utf8');

describe('#121 — the unreachable browse-by-genre feature stays removed', () => {
	it('the uncalled POST /api/tag route is gone', () => {
		expect(existsSync(join(CORE_SRC, 'routes/api/tag/+server.ts'))).toBe(false);
	});

	it('the dead genre read methods are gone from the media repository', () => {
		const repo = read('server/media/repository.ts');
		expect(repo).not.toMatch(/\bgenreFacets\s*\(/);
		expect(repo).not.toMatch(/\bbyGenre\s*\(/);
	});

	it('the library endpoint no longer exposes a genre facet or a ?genre= filter branch', () => {
		const lib = read('routes/api/library/+server.ts');
		expect(lib).not.toMatch(/genreFacets|byGenre/);
		expect(lib).not.toMatch(/searchParams\.get\(\s*['"]genre['"]\s*\)/);
	});

	it('the phone has no Browse-by-genre chip row', () => {
		const page = read('routes/+page.svelte');
		expect(page).not.toContain('Browse by genre');
		expect(page).not.toMatch(/facets\.genres/);
	});

	// The generic tag machinery (setTags/tagsOf and the genre|tag|mood kind enum) is NOT part of the
	// removal — it is used elsewhere and the owner did not name it. Assert it survived, so a future
	// over-eager cleanup cannot delete the reusable primitive under cover of this guard.
	it('the generic setTags/tagsOf primitive is retained', () => {
		const repo = read('server/media/repository.ts');
		expect(repo).toMatch(/\bsetTags\s*\(/);
		expect(repo).toMatch(/\btagsOf\s*\(/);
	});
});
