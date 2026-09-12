// guard: the tag map from /api/library is WIRED through the phone page onto the library row.
//
// THE DEFECT CLASS this guards is Encore's most-repeated one: a mechanism (the server's tags map, the
// SongRow tags prop) built and unit-tested, but never CALLED from the render path that needs it. The
// lines that thread it — hold `j.tags` in state, and pass `tags: libraryTags[m.id]` through the ONE
// shared rowMeta shape every SongRow call site spreads — live in a Svelte component bun test never
// imports (no jsdom). Delete any of them and the tag chips silently never appear while the server
// test and the SongRow test both stay green. This scan requires each seam.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}
// The subject is named from the REPO ROOT rather than from wherever this test happens to sit
// (XR-VER-05). `read()` throws on a miss, so a wrong path reds loudly instead of stripping an empty
// string and reporting three green arms over nothing.
const PAGE = stripComments(read('src/routes/+page.svelte'));

test('the page holds a libraryTags map keyed by mediaId', () => {
	expect(PAGE).toMatch(/let\s+libraryTags\s*=\s*\$state<Record<string,\s*string\[\]>>\(\{\}\)/);
});

test('loadLibrary stores the wire tags map (stops discarding j.tags)', () => {
	expect(PAGE).toMatch(/libraryTags\s*=\s*j\.tags\s*\?\?\s*\{\}/);
});

test('rowMeta threads the song tags through the shared row shape', () => {
	// The single place SongRow props are assembled. tags must be read by the song's id so every call
	// site (ready/cooking/raw/popular/recent) gets it — SongRow itself only paints them on a ready row.
	const m = PAGE.match(/const\s+rowMeta\s*=\s*\(m:\s*Media\)\s*=>\s*\(\{([\s\S]*?)\}\);/);
	expect(m).not.toBeNull(); // non-vacuous: rowMeta must exist to be scanned
	expect(m![1]).toMatch(/tags\s*:\s*libraryTags\[\s*m\.id\s*\]/);
});
