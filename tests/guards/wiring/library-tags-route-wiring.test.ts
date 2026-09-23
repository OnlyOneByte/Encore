// GET /api/library must surface each song's descriptive tags, so the library row shows them without a
// second round-trip. Three seams, and deleting any ships an empty tag surface with the phone none the
// wiser: read tags with the 'tag' KIND, build a mediaId→string[] map over the LIBRARY list, and RETURN it.
// The handler calls `getApp()`, so exercising the real GET would boot the whole server; a companion
// runtime test proves `tagsOf(id,'tag')` returns what `setTags(id,'tag',…)` wrote.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';

/** Blank comments, so a seam cannot be satisfied by prose describing it. */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const SRC = stripComments(readFileSync(at('src/routes/api/library/+server.ts'), 'utf8'));

test('the route reads tags with the tag KIND, not the genre default', () => {
	// `tagsOf(id)` defaults to 'genre' while the sidecar writes kind 'tag', so a read omitting the kind
	// returns genres and the chips stay empty forever.
	expect(SRC).toMatch(/\.tagsOf\(\s*[^,]+,\s*'tag'\s*\)/);
});

test('the route builds a mediaId→tags map over the LIBRARY list', () => {
	// Over the library, not the processing list and not the whole catalog.
	expect(SRC).toMatch(/const\s+tags\s*:\s*Record<string,\s*string\[\]>\s*=\s*\{\}/);
	expect(SRC).toMatch(/for\s*\(\s*const\s+\w+\s+of\s+library\s*\)/);
});

test('the tags map is RETURNED in the /api/library payload', () => {
	// A built-but-unreturned map is the wired-to-nothing form, so the shorthand must be in the response.
	const m = SRC.match(/return\s+json\(\{([\s\S]*?)\}\);/);
	expect(m).not.toBeNull(); // the response must exist to be scanned
	const body = m![1];
	expect(body).toMatch(/\btags\b\s*,/);
});
