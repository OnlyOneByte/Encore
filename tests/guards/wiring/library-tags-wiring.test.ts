// guard: GET /api/library must surface each library song's descriptive tags, so the phone
// library row can show them WITHOUT a second round-trip. This is the READ/display half of the tags feature; the
// WRITE half (kind:'tag' rows from the sidecar) already lands via setTags in app.ts.
//
// WHY A SOURCE SCAN. The handler calls getApp() — the live app singleton with a DB, job ledger and
// boot maintenance — so exercising the real GET here would boot the whole server. The behaviour the
// bug turns on is instead a decidable property of the route source: it must (a) read tags with the
// 'tag' KIND (tagsOf defaults to 'genre', which is NOT what the sidecar writes, so a bare tagsOf(id)
// would silently return nothing), (b) build a mediaId→string[] map over the LIBRARY list, and (c)
// return it in the payload. Deleting any of the three ships an empty tag surface with the phone none
// the wiser — the repo's most-repeated defect class (a read wired to the wrong kind, or not returned).
//
// A companion RUNTIME test (library-tags.test.ts) proves tagsOf(id,'tag') actually returns what
// setTags(id,'tag',…) wrote, so this scan is not the only thing standing between the fix and green.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

// Blank comments (not delete — keep offsets) so a seam cannot be satisfied by prose describing it.
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// Was a sibling read of the route handler this guard sat beside in src/routes/api/library —
// the GET /api/library handler, named from the repo root now that the guard no longer sits next to it.
const SRC = stripComments(read('src/routes/api/library/+server.ts'));

test('the route reads tags with the tag KIND, not the genre default', () => {
	// tagsOf(id) defaults to 'genre'; the sidecar write path is setTags(id, "tag", …). A read that
	// omits the kind returns genres and the tag chips stay empty forever — this reds that form.
	expect(SRC).toMatch(/\.tagsOf\(\s*[^,]+,\s*'tag'\s*\)/);
});

test('the route builds a mediaId→tags map over the LIBRARY list', () => {
	// A `tags` record, populated by iterating the library (not the cooking list, not the whole catalog).
	expect(SRC).toMatch(/const\s+tags\s*:\s*Record<string,\s*string\[\]>\s*=\s*\{\}/);
	expect(SRC).toMatch(/for\s*\(\s*const\s+\w+\s+of\s+library\s*\)/);
});

test('the tags map is RETURNED in the /api/library payload', () => {
	// The map must reach the wire. Pin `tags,` (shorthand) inside the json({...}) response next to
	// `library` — a built-but-unreturned map is the wired-to-nothing form.
	const m = SRC.match(/return\s+json\(\{([\s\S]*?)\}\);/);
	expect(m).not.toBeNull(); // non-vacuous: the response must exist to be scanned
	const body = m![1];
	expect(body).toMatch(/\btags\b\s*,/);
});
