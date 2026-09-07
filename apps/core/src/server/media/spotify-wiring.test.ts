// Wiring guard (#427): the Spotify resolver must be REGISTERED, not just built. app.ts constructs
// no seam a unit test can reach (getApp stands up the whole app inside an async .then with DB/env),
// so — like retention-protectedids-wiring.test.ts — this pins the wiring by source scan: the resolver
// is constructed on the app AND the /api/search fan-out actually searches it and merges its hits.
// Comments are blanked so a commented-out wiring cannot satisfy a match.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server/media
const APP = stripComments(readFileSync(join(import.meta.dir, '..', 'app.ts'), 'utf8'));
const SEARCH = stripComments(
	readFileSync(join(import.meta.dir, '..', '..', 'routes', 'api', 'search', '+server.ts'), 'utf8')
);

test('app.ts constructs and exposes a SpotifyResolver on the app (#427)', () => {
	// The type field on EncoreApp.
	expect(APP).toMatch(/\bspotify:\s*SpotifyResolver\b/);
	// The construction — with a backend injected, mirroring YouTubeResolver(ytDlpSearch).
	expect(APP).toMatch(/spotify:\s*new\s+SpotifyResolver\(/);
	expect(APP).toMatch(/spotifySearch/);
});

test('/api/search searches the spotify resolver and merges its hits (#427)', () => {
	// safeSearch(app.spotify, q) must appear in the fan-out — reverting the registration reds this.
	expect(SEARCH).toMatch(/safeSearch\(\s*app\.spotify\s*,\s*q\s*\)/);
	// And the spotify results must be spread into the materialized list, or they never reach output.
	expect(SEARCH).toMatch(/\.\.\.\s*spotify\b/);
});
