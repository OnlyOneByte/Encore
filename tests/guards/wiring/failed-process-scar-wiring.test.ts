// The failed-process scar is WIRED into the room link on all three seams: record on failure, clear on
// success, re-surface on mount. A failed process is live-only — the catalog Media records no failure
// (a dead process settles back to un-processed) and the in-memory `mediaStatus` map is lost on reload —
// so a guest who reloads sees the song as plain un-processed with no trace it broke. The scar store is
// unit-tested; deleting a WIRING line leaves those tests green while the feature is dead.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

/** Blank comments in place, so a seam cannot be satisfied by prose while the live code has lost it. */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const LINK = stripComments(read('src/lib/stores/room.ts'));
// The page must not carry a copy: two owners of one scar list is the drift this guards, and a stale
// duplicate would keep every assertion below green.
const PAGE = stripComments(read('src/routes/+page.svelte'));

test('the link imports the scar helpers it wires, and the page no longer does', () => {
	// Pinned here so the guard reds naming the feature, rather than as an opaque undefined-symbol build error.
	expect(LINK).toMatch(/import\s*\{[^}]*\bactiveScars\b[^}]*\}\s*from\s*'\$lib\/stores\/process-scars'/);
	expect(LINK).toMatch(/import\s*\{[^}]*\brecordScar\b[^}]*\}\s*from\s*'\$lib\/stores\/process-scars'/);
	expect(LINK).toMatch(/import\s*\{[^}]*\bclearScar\b[^}]*\}\s*from\s*'\$lib\/stores\/process-scars'/);
	// One owner: the page renders the room's state, it does not maintain the scar list.
	expect(PAGE).not.toContain('process-scars');
});

test('a failed media:status records a scar', () => {
	expect(LINK).toMatch(/status === 'failed'/);
	expect(LINK).toMatch(/recordScar\(\s*failedMedia\s*\)/);
});

test('a successful re-process clears the scar', () => {
	expect(LINK).toMatch(/clearScar\(\s*mediaId\s*\)/);
	// It must be in the `ready` branch: a row cannot read `failed` while the song is sitting there ready.
	expect(LINK).toMatch(/status === 'ready'\)\s*\{[\s\S]{0,120}clearScar\(/);
});

test('mount re-surfaces active scars into the live status map', () => {
	// Seeding the scar's snapshot into the catalog is required because GET /api/library omits a failed
	// song, so the row would otherwise not render at all.
	expect(LINK).toMatch(/activeScars\(\)/);
	// The holder must be a FIELD, outliving connect(), so the queue:sync branch can re-apply it long
	// afterwards; a local inside connect() would be out of scope there.
	expect(LINK).toMatch(/#scarred\s*:\s*Media\[\]\s*=\s*\[\]/);
	expect(LINK).toMatch(/this\.#scarred\s*=\s*activeScars\(\)/);
	expect(LINK).toMatch(/mergeMissingMedia\(\s*this\.#scarred\s*\)/);
	// The synthetic failed status is written only where absent, so a fresher live broadcast wins.
	expect(LINK).toMatch(/if\s*\(!withScars\.has\(m\.id\)\)\s*withScars\.set\(\s*m\.id\s*,\s*\{\s*status:\s*'failed'/);
});

test('the held scar list tracks failures that happen AFTER connect, not just the ones on disk', () => {
	// The link lives for the document and never remounts, so a mount-time snapshot goes stale: a failure
	// arriving later must join the held list or the NEXT queue:sync wipes that row for good.
	expect(LINK).toMatch(/this\.#scarred\s*=\s*\[\s*\.\.\.this\.#scarred\s*,\s*failedMedia\s*\]/);
	// …and a successful re-process must drop it, or the row is re-surfaced as failed on every sync.
	expect(LINK).toMatch(/this\.#scarred\s*=\s*this\.#scarred\.filter\(/);
});

test('a queue:sync re-applies the scars it would otherwise wipe', () => {
	// ORDERING: queue:sync REPLACES mediaCatalog wholesale and a failed song is absent server-side, so
	// the first sync wipes the scarred row on the very reload the scar exists to survive. Scars must be
	// re-applied AFTER the catalog is rebuilt.
	expect(LINK).toMatch(/queue:sync/);
	expect(LINK).toMatch(/if\s*\(this\.#scarred\.length\)\s*this\.mergeMissingMedia\(\s*this\.#scarred\s*\)/);
	// Gap-fill only: mergeMissingMedia must never overwrite a fresher server copy of an id.
	expect(LINK).toMatch(/mergeMissingMedia\(list: Media\[\]\)[\s\S]{0,260}if\s*\(!next\.has\(m\.id\)\)/);
});
