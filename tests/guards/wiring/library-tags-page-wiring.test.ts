// The tag map from /api/library is WIRED from the room link onto the library row. Three seams: the page
// holds the map, `refreshLibrary` stores `j.tags` instead of discarding it, and `rowMeta` threads it
// through the ONE shared row shape every SongRow call site spreads. Delete any and the tag chips silently
// never appear while the server test and the SongRow test both stay green.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

/** Blank comments, so a commented-out wiring line cannot satisfy a match. */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// `read()` throws on a miss, so a moved subject reds loudly instead of stripping an empty string and
// reporting three green arms over nothing.
const PAGE = stripComments(read('src/routes/+page.svelte'));
const ROOM = stripComments(read('src/lib/stores/room.ts'));

test('the page holds a libraryTags map keyed by mediaId', () => {
	expect(PAGE).toMatch(/let\s+libraryTags\s*=\s*\$state<Record<string,\s*string\[\]>>\(\{\}\)/);
});

test('refreshLibrary stores the wire tags map (stops discarding j.tags)', () => {
	// Pinned INSIDE refreshLibrary's own body, so an assignment stranded in another method cannot satisfy it.
	const m = ROOM.match(/async\s+refreshLibrary\s*\([^)]*\)\s*:\s*Promise<void>\s*\{([\s\S]*?)\n\t\}/);
	expect(m).not.toBeNull(); // refreshLibrary must exist to be scanned
	expect(m![1]).toMatch(/this\.libraryTags\s*=\s*j\.tags\s*\?\?\s*\{\}/);
});

test('rowMeta threads the song tags through the shared row shape', () => {
	// Read by the song's id in the ONE place row props are assembled, so every call site gets it; SongRow
	// itself only paints the chips on a ready row.
	const m = PAGE.match(/const\s+rowMeta\s*=\s*\(m:\s*Media\)\s*=>\s*\(\{([\s\S]*?)\}\);/);
	expect(m).not.toBeNull(); // rowMeta must exist to be scanned
	expect(m![1]).toMatch(/tags\s*:\s*libraryTags\[\s*m\.id\s*\]/);
});
