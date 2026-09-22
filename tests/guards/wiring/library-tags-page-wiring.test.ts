// guard: the tag map from /api/library is WIRED through the phone's find surface onto the library row.
//
// THE DEFECT CLASS this guards is Encore's most-repeated one: a mechanism (the server's tags map, the
// SongRow tags prop) built and unit-tested, but never CALLED from the render path that needs it. The
// lines that thread it — hold `j.tags` in state, and pass `tags: libraryTags[m.id]` through the ONE
// shared rowMeta shape every SongRow call site spreads — live in a Svelte component bun test never
// imports (no jsdom). Delete any of them and the tag chips silently never appear while the server
// test and the SongRow test both stay green. This scan requires each seam.
//
// TWO SUBJECTS, and only one of them has moved around. The `/api/library` FETCH was hoisted off the page
// onto the room link (`RoomLink.refreshLibrary`), which is where the payload is STORED, and that has been
// true since the phone-remote redesign. Where the tag map is READ and rendered has moved twice: off
// `routes/+page.svelte` onto `routes/find/+page.svelte` when search became its own route, and back again
// when that route was merged into home (2026-09-22). Two seams are asserted against the page that owns the
// song rows, one against the store. Same requirements, current addresses.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}
// Both subjects are named from the REPO ROOT rather than from wherever this test happens to sit
//. `read()` throws on a miss, so a wrong path reds loudly instead of stripping an empty
// string and reporting three green arms over nothing.
const PAGE = stripComments(read('src/routes/+page.svelte'));
const ROOM = stripComments(read('src/lib/stores/room.ts'));

test('the page holds a libraryTags map keyed by mediaId', () => {
	expect(PAGE).toMatch(/let\s+libraryTags\s*=\s*\$state<Record<string,\s*string\[\]>>\(\{\}\)/);
});

test('refreshLibrary stores the wire tags map (stops discarding j.tags)', () => {
	// RE-POINTED: the page-local `loadLibrary()` is GONE — the `/api/library` fetch now lives on the room
	// link as `refreshLibrary()`, because it feeds two readers (the /find rows AND home's queue titles
	// and progress bars). The claim is unweakened and still the whole point of the arm: the wire's tags
	// map must be STORED rather than discarded. Pinned INSIDE refreshLibrary's own body so an assignment
	// stranded in some other method cannot satisfy it.
	const m = ROOM.match(/async\s+refreshLibrary\s*\([^)]*\)\s*:\s*Promise<void>\s*\{([\s\S]*?)\n\t\}/);
	expect(m).not.toBeNull(); // non-vacuous: refreshLibrary must exist to be scanned
	expect(m![1]).toMatch(/this\.libraryTags\s*=\s*j\.tags\s*\?\?\s*\{\}/);
});

test('rowMeta threads the song tags through the shared row shape', () => {
	// The single place SongRow props are assembled. tags must be read by the song's id so every call
	// site (ready/processing/raw/popular/recent) gets it — SongRow itself only paints them on a ready row.
	const m = PAGE.match(/const\s+rowMeta\s*=\s*\(m:\s*Media\)\s*=>\s*\(\{([\s\S]*?)\}\);/);
	expect(m).not.toBeNull(); // non-vacuous: rowMeta must exist to be scanned
	expect(m![1]).toMatch(/tags\s*:\s*libraryTags\[\s*m\.id\s*\]/);
});
