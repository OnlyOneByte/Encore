// The Spotify resolver must be REGISTERED, not just built: constructed on the app AND searched by the
// /api/search fan-out, whose hits must be merged. `getApp()` stands the whole app up inside an async
// `.then` with a DB and env, so there is no seam a unit test can reach.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';

/** Blank comments, so a commented-out wiring line cannot satisfy a match. */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const APP = stripComments(readFileSync(at('src/lib/server/app.ts'), 'utf8'));
const SEARCH = stripComments(readFileSync(at('src/routes/api/search/+server.ts'), 'utf8'));

test('app.ts constructs and exposes a SpotifyResolver on the app', () => {
	expect(APP).toMatch(/\bspotify:\s*SpotifyResolver\b/); // the EncoreApp field
	// Constructed with a backend injected, mirroring YouTubeResolver(ytDlpSearch).
	expect(APP).toMatch(/spotify:\s*new\s+SpotifyResolver\(/);
	expect(APP).toMatch(/spotifySearch/);
});

test('/api/search searches the spotify resolver and merges its hits', () => {
	expect(SEARCH).toMatch(/safeSearch\(\s*app\.spotify\s*,\s*q\s*\)/);
	// Spread into the materialized list, or the hits never reach the output.
	expect(SEARCH).toMatch(/\.\.\.\s*spotify\b/);
});
