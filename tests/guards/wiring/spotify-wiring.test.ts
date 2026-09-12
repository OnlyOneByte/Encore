// Wiring guard: the Spotify resolver must be REGISTERED, not just built. app.ts constructs
// no seam a unit test can reach (getApp stands up the whole app inside an async .then with DB/env),
// so — like retention-protectedids-wiring.test.ts — this pins the wiring by source scan: the resolver
// is constructed on the app AND the /api/search fan-out actually searches it and merges its hits.
// Comments are blanked so a commented-out wiring cannot satisfy a match.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// Both subjects are named absolutely rather than counted out of this file's own location.
const APP = stripComments(readFileSync(at('apps/core/src/lib/server/app.ts'), 'utf8'));
const SEARCH = stripComments(readFileSync(at('apps/core/src/routes/api/search/+server.ts'), 'utf8'));

test('app.ts constructs and exposes a SpotifyResolver on the app', () => {
	// The type field on EncoreApp.
	expect(APP).toMatch(/\bspotify:\s*SpotifyResolver\b/);
	// The construction — with a backend injected, mirroring YouTubeResolver(ytDlpSearch).
	expect(APP).toMatch(/spotify:\s*new\s+SpotifyResolver\(/);
	expect(APP).toMatch(/spotifySearch/);
});

test('/api/search searches the spotify resolver and merges its hits', () => {
	// safeSearch(app.spotify, q) must appear in the fan-out — reverting the registration reds this.
	expect(SEARCH).toMatch(/safeSearch\(\s*app\.spotify\s*,\s*q\s*\)/);
	// And the spotify results must be spread into the materialized list, or they never reach output.
	expect(SEARCH).toMatch(/\.\.\.\s*spotify\b/);
});
