// Regression guard for issue #763 — the browse block answered "is this song ready" three different
// ways, so browsing could reveal a song the library hides and a chip's count could open an empty list.
//
// The gap is a single row shape: a song mid-align. `stemStatus: 'ready'` with an instrumental on disk
// but `lyricsStatus: 'queued'` and no lyrics artifact is PAST the stems gate and NOT finished — as
// `gates.ts` says in as many words. `listReady` and `byTag` deferred to `readyToSing` and hid it;
// `byArtist`, `artistFacets` and `tagFacets` asked only the SQL narrowing and showed/counted it.
//
// Two arms, and they answer different questions:
//   BEHAVIOURAL — the five readers agree about one seeded mid-align song, against a real migrated DB
//     and the real MediaRepository. Expected ids/counts are HARD-CODED from the seed, never derived by
//     re-running `readyToSing`, so the test cannot agree with the code by construction.
//   SOURCE SCAN — the five readers all resolve readiness through the ONE shared helper. The
//     behavioural arm proves today's answers agree; this arm is what stops a sixth reader (or a
//     revert of one body) from re-introducing a second definition, which is the actual defect.
import { beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MediaRepository } from './repository';
import { migratedDb } from '../db/test-db';
import { instrumentalKey } from './paths';
import type { Media } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';

/** A finished song: both gates satisfied. */
const finished = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: 'Song ' + id,
	durationSec: 200,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	instrumentalRef: instrumentalKey(id),
	songProfile: { ...EMPTY_SONG_PROFILE }
});

/**
 * A song MID-ALIGN — the whole defect window. Separation is done (status + artifact), alignment is
 * still enqueued and there is no lyrics artifact, so the lyrics gate is open and the song is not
 * finished. Only valid `StepStatus` values are used ('none' | 'queued' | 'ready').
 */
const midAlign = (id: string): Media => ({
	...finished(id),
	lyricsStatus: 'queued',
	lyricsRef: undefined
});

let repo: MediaRepository;

describe('#763 — every browse reader answers readiness the same way', () => {
	beforeEach(() => {
		repo = new MediaRepository(migratedDb());
		// The issue's measured seed:
		//   a — finished.                     artist 'The Band', tag 'acoustic'
		//   b — mid-align, NOT finished.      artist 'The Band', tag 'acoustic'  (shares both with a)
		//   c — mid-align, NOT finished.      artist 'Other',    tag 'ballad'    (sole holder of both)
		repo.upsert(finished('a'));
		repo.upsert(midAlign('b'));
		repo.upsert(midAlign('c'));
		repo.setCanonical('a', { artist: 'The Band' });
		repo.setCanonical('b', { artist: 'The Band' });
		repo.setCanonical('c', { artist: 'Other' });
		repo.setTags('a', 'tag', ['acoustic']);
		repo.setTags('b', 'tag', ['acoustic']);
		repo.setTags('c', 'tag', ['ballad']);
	});

	// Expected values are hard-coded from the seed above: 'a' is the only finished song, so it is the
	// only id any reader may return and the only song any facet may count.
	it('the library list holds only the finished song', () => {
		expect(repo.listReady().map((m) => m.id)).toEqual(['a']);
	});

	it('the artist filter does not reveal the mid-align song the library hides (F1)', () => {
		// base: ['b', 'a'] — filtering a list narrowed it INTO a row the unnarrowed list refuses.
		expect(repo.byArtist('The Band').map((m) => m.id)).toEqual(['a']);
		// 'Other' has one song and it is not finished, so its filter is empty…
		expect(repo.byArtist('Other')).toEqual([]);
	});

	it('the artist rail counts only finished songs, and never offers a heading that opens empty (F2)', () => {
		// base: [{ 'The Band', 2 }, { 'Other', 1 }] — 2 under a chip whose list holds 1, and a chip
		// for 'Other' whose list is empty.
		expect(repo.artistFacets()).toEqual([{ artist: 'The Band', count: 1 }]);
	});

	it('the tag rail counts only finished songs, and never offers a heading that opens empty (F2)', () => {
		// base: [{ 'acoustic', 2 }, { 'ballad', 1 }] — 'ballad' opened a measured EMPTY list.
		expect(repo.tagFacets()).toEqual([{ tag: 'acoustic', count: 1 }]);
	});

	it('the tag filter holds only the finished song', () => {
		expect(repo.byTag('acoustic').map((m) => m.id)).toEqual(['a']);
		expect(repo.byTag('ballad')).toEqual([]);
	});

	// The invariants, stated over whatever the readers return rather than over the seed. These are the
	// two the issue names, and they are what a sixth reader would break.
	it('every artist facet count equals the length of the filter it opens, whose rows are all in the library', () => {
		const libraryIds = new Set(repo.listReady().map((m) => m.id));
		const facets = repo.artistFacets();
		expect(facets.length).toBeGreaterThan(0); // not vacuous: there IS a facet to check
		for (const f of facets) {
			const opened = repo.byArtist(f.artist);
			expect(opened.length).toBe(f.count);
			expect(opened.length).toBeGreaterThan(0); // a chip never lands on an empty list
			for (const m of opened) expect(libraryIds.has(m.id)).toBe(true);
		}
	});

	it('every tag facet count equals the length of the filter it opens, whose rows are all in the library', () => {
		const libraryIds = new Set(repo.listReady().map((m) => m.id));
		const facets = repo.tagFacets();
		expect(facets.length).toBeGreaterThan(0);
		for (const f of facets) {
			const opened = repo.byTag(f.tag);
			expect(opened.length).toBe(f.count);
			expect(opened.length).toBeGreaterThan(0);
			for (const m of opened) expect(libraryIds.has(m.id)).toBe(true);
		}
	});
});

// Non-vacuity sentinel: with the mid-align rows absent, every assertion above must PASS on base too —
// so the redness above comes from the mid-align window, not from the invariants being unsatisfiable.
describe('#763 — the same invariants hold for a library of finished songs alone', () => {
	it('a finished-only library agrees across all five readers', () => {
		const r = new MediaRepository(migratedDb());
		r.upsert(finished('a'));
		r.setCanonical('a', { artist: 'The Band' });
		r.setTags('a', 'tag', ['acoustic']);

		expect(r.listReady().map((m) => m.id)).toEqual(['a']);
		expect(r.byArtist('The Band').map((m) => m.id)).toEqual(['a']);
		expect(r.artistFacets()).toEqual([{ artist: 'The Band', count: 1 }]);
		expect(r.byTag('acoustic').map((m) => m.id)).toEqual(['a']);
		expect(r.tagFacets()).toEqual([{ tag: 'acoustic', count: 1 }]);
	});
});

// ── source scan: one definition, and it stays one ──────────────────────────────────────────────────
//
// Reads the REAL production file. The behavioural arm cannot express "there is only one predicate" —
// it can only observe that today's five answers happen to agree, which is exactly what was true of
// `listReady` and `byTag` while three other readers disagreed. This arm bans the second definition
// by SHAPE (the narrowing expression and the gate call), not by name, so a renamed copy of the old
// per-reader spelling trips it too.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'repository.ts'), 'utf8');

/** Strip comments, so a docstring quoting the narrowing is never mistaken for a second one. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** One function or method body, by name, from the real source. Throws if it is gone (renamed ≠ absent). */
function body(name: string): string {
	const m = new RegExp(`\\n(\\t?)(?:function )?${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\1\\}`).exec(CODE);
	if (!m) throw new Error(`${name} not found in repository.ts — the guard needs updating deliberately`);
	return m[2];
}

/** The doc comment immediately above a declaration, from the RAW source (comments are the subject). */
function docAbove(name: string): string {
	const m = new RegExp(`/\\*\\*([\\s\\S]*?)\\*/\\s*\\n\\t?(?:function )?${name}\\(`).exec(SRC);
	if (!m) throw new Error(`no doc comment found above ${name}`);
	return m[1];
}

/** The SQL narrowing, under ANY name: a where-clause comparing stemStatus to 'ready'. */
const NARROWING = /stemStatus\s*,\s*'ready'/g;
/** The authoritative gate call, under any receiver. */
const GATE = /\breadyToSing\b/g;
const count = (re: RegExp, s: string) => s.match(re)?.length ?? 0;

describe('#763 — readiness is defined once for the whole browse block', () => {
	it('the shared helper exists and is where BOTH halves of the predicate live', () => {
		const shared = body('readySongs');
		expect(count(NARROWING, shared)).toBe(1);
		expect(count(GATE, shared)).toBe(1);
	});

	it('the SQL narrowing appears exactly once in the file, and the gate call exactly once', () => {
		// This is the drift ban. A second spelling anywhere in this repository — a new reader, or a
		// revert of one body to its own query — makes one of these two counts 2.
		expect(count(NARROWING, CODE)).toBe(1);
		expect(count(GATE, CODE.replace(/^import .*$/gm, ''))).toBe(1);
	});

	it.each([
		['listReady', /readySongs\(/],
		['byArtist', /readySongs\(/],
		['artistFacets', /readySongs\(/],
		['byTag', /readyTagged\(/],
		['tagFacets', /readyTagged\(/]
	])('%s resolves readiness through the shared helper rather than restating it', (name, expected) => {
		const b = body(name);
		expect(b).toMatch(expected);
		expect(count(NARROWING, b)).toBe(0);
		expect(count(GATE, b)).toBe(0);
	});

	it('the tag helper inherits readiness from the shared set instead of re-asking it', () => {
		// `readyTagged` must not carry its own readiness clause; membership of readySongs() IS the
		// gate. Without this, the tag pair of readers could drift from the other three again.
		const tagged = body('readyTagged');
		expect(tagged).toMatch(/readySongs\(/);
		expect(count(NARROWING, tagged)).toBe(0);
		expect(count(GATE, tagged)).toBe(0);
	});

	it('the SQL aggregation machinery is gone from this file, so a facet count cannot go back into SQL', () => {
		// `sql` and `asc` were imported for ONE purpose: the facets' `count(*)` / `ORDER BY count(*)
		// DESC, value ASC`. A count taken in SQL cannot consult the gate table, which is the #763
		// defect, so re-importing either is the shape of a relapse — deliberate re-use would have to
		// update this assertion on purpose.
		const importLine = /^import \{[^}]*\} from 'drizzle-orm';$/m.exec(SRC)?.[0] ?? '';
		expect(importLine).not.toBe('');
		expect(importLine).not.toMatch(/\bsql\b/);
		expect(importLine).not.toMatch(/\basc\b/);
		expect(importLine).toMatch(/\btype SQL\b/); // the narrowing parameter's type
		expect(CODE).not.toMatch(/count\(\*\)/);
	});

	it("listReady's own docstring no longer claims to narrow in SQL itself", () => {
		// RAW text, because a comment is the subject. `listReady` is now a one-liner containing no SQL
		// at all, so the old sentence describing its query became a comment contradicting its code —
		// the exact defect class #763's own report names in `tagFacets`.
		expect(SRC).not.toContain('The SQL narrows to separated songs');
		expect(docAbove('listReady')).toMatch(/readySongs/);
	});
});
