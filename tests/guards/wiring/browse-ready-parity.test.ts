// Regression guard — the browse block answered "is this song ready" three different
// ways, so browsing could reveal a song the library hides and a chip's count could open an empty list.
//
// The gap is a single row shape: a song mid-align. `stemStatus: 'ready'` with an instrumental on disk
// but `lyricsStatus: 'queued'` and no lyrics artifact is PAST the stems gate and NOT finished — as
// `gates.ts` says in as many words. `listReady` and `byTag` deferred to `readyToSing` and hid it;
// `byArtist`, `artistFacets` and `tagFacets` asked only the SQL narrowing and showed/counted it.
//
// Two arms, and they answer different questions:
//   BEHAVIOURAL — the five readers agree with `readyToSing` about EIGHT seeded rows covering SEVEN
// distinct gate shapes, against a real migrated DB and the real MediaRepository. Expected
//     ids/counts are HARD-CODED from the seed, never derived by re-running `readyToSing`, so the test
// cannot agree with the code by construction.'s own seed carried only one not-ready shape
//     (mid-align), so every other arm of both gates rested entirely on the source scan.
//   SOURCE SCAN — the five readers all resolve readiness through the ONE shared helper. The
//     behavioural arm proves today's answers agree; this arm is what stops a sixth reader (or a
//     revert of one body) from re-introducing a second definition, which is the actual defect.
//
// Its FLOOR and its CEILING, stated together because measured the gap between them. The
//     floor bans a readiness comparison against `stemStatus` under ANY spelling — drizzle's
//     `eq(media.stemStatus, 'ready')` and a JS `m.stemStatus === 'ready'` re-derivation alike — plus
// any second call of the gate. shipped the comma spelling only, so a sixth reader whose body
//     was `.map(fromRow).filter((m) => m.stemStatus === 'ready' && !!m.instrumentalRef)` left the
//     whole suite green. The floor does NOT reach a re-derivation that never names `stemStatus`:
//     `!!m.instrumentalRef && (m.lyricsStatus === 'ready' || !!m.lyricsRef)` still slips through. That
//     ceiling is ASSERTED below, not merely described, so raising the floor further has to move the
//     assertion on purpose rather than leaving this comment behind.
import { beforeEach, describe, expect, it } from 'bun:test';
import { read } from '@encore/test-support';
import { MediaRepository } from '$lib/server/media/repository';
import { migratedDb } from '$lib/server/db/test-db';
import { instrumentalKey, lyricsKey } from '$lib/server/media/paths';
import type { Media } from '$lib/contract';
import { EMPTY_SONG_PROFILE } from '$lib/contract';

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

// ── the four shapes's seed never held, one per remaining gate arm ──────────────────────
//
// The stems gate is `stemStatus === 'ready' && !!instrumentalRef` and the lyrics gate is
// `lyricsStatus === 'ready' || !!lyricsRef`, so between them there are four ways to be not-ready that
// `midAlign` does not express, plus one way to be ready that it hides. Each gets its own row.

/** Nothing acquired: separation never started, so there is no instrumental either. */
const unacquired = (id: string): Media => ({
	...finished(id),
	stemStatus: 'none',
	instrumentalRef: undefined
});

/** Separation enqueued and not finished — the status arm of the stems gate, mid-flight. */
const stemsQueued = (id: string): Media => ({
	...finished(id),
	stemStatus: 'queued',
	instrumentalRef: undefined
});

/**
 * `stemStatus: 'ready'` with NO instrumental artifact. The ARTIFACT arm of the stems gate on its own:
 * this row satisfies the status column a SQL narrowing would read and is still not singable, which is
 * what `isNotNull(media.instrumentalRef)` carries in `readySongs`.
 */
const stemsReadyNoArtifact = (id: string): Media => ({
	...finished(id),
	instrumentalRef: undefined
});

/** Alignment never ran: `lyricsStatus: 'none'` and no artifact — a browse block listing this is an earlier change. */
const lyricsNeverRan = (id: string): Media => ({
	...finished(id),
	lyricsStatus: 'none',
	lyricsRef: undefined
});

/**
 * A LEGACY row: processed before `lyricsStatus` existed, so it carries no status but does carry a lyrics
 * artifact. `gates.ts` treats that as done deliberately — narrowing the lyrics gate to
 * `lyricsStatus === 'ready'` would make every pre-upgrade song unsingable forever. So this row IS
 * ready, and it is the only row besides `finished` that any reader may return.
 */
const legacyLyricsRef = (id: string): Media => ({
	...finished(id),
	lyricsStatus: 'none',
	lyricsRef: lyricsKey(id)
});

let repo: MediaRepository;

describe('every browse reader answers readiness the same way', () => {
	beforeEach(() => {
		repo = new MediaRepository(migratedDb());
		// 's measured three rows, plus the five added so every gate arm has a seeded row:
		//   a — finished, READY.                       artist 'The Band',       tag 'acoustic'
		//   b — mid-align, not ready.                  artist 'The Band',       tag 'acoustic'  (shares both with a)
		//   c — mid-align, not ready.                  artist 'Other',          tag 'ballad'
		//   d — unacquired, not ready.                 artist 'The Band',       tag 'unacquired'
		//   e — stems queued, not ready.               artist 'The Band',       tag 'stems-queued'
		//   f — stems ready / no artifact, not ready.  artist 'The Band',       tag 'no-instrumental'
		//   g — alignment never ran, not ready.        artist 'The Band',       tag 'lyrics-never-ran'
		//   h — legacy lyricsRef, READY.               artist 'Legacy Library', tag 'legacy'
		//
		// The two groupings are deliberate and catch different leaks. Five not-ready rows share artist
		// 'The Band' with a, so a leak INFLATES that one facet count and lengthens its filter. Each
		// not-ready row also holds its tag ALONE, so the tag readers name WHICH row leaked instead of
		// only reporting a wrong total.
		repo.upsert(finished('a'));
		repo.upsert(midAlign('b'));
		repo.upsert(midAlign('c'));
		repo.upsert(unacquired('d'));
		repo.upsert(stemsQueued('e'));
		repo.upsert(stemsReadyNoArtifact('f'));
		repo.upsert(lyricsNeverRan('g'));
		repo.upsert(legacyLyricsRef('h'));
		repo.setCanonical('a', { artist: 'The Band' });
		repo.setCanonical('b', { artist: 'The Band' });
		repo.setCanonical('c', { artist: 'Other' });
		repo.setCanonical('d', { artist: 'The Band' });
		repo.setCanonical('e', { artist: 'The Band' });
		repo.setCanonical('f', { artist: 'The Band' });
		repo.setCanonical('g', { artist: 'The Band' });
		repo.setCanonical('h', { artist: 'Legacy Library' });
		repo.setTags('a', 'tag', ['acoustic']);
		repo.setTags('b', 'tag', ['acoustic']);
		repo.setTags('c', 'tag', ['ballad']);
		repo.setTags('d', 'tag', ['unacquired']);
		repo.setTags('e', 'tag', ['stems-queued']);
		repo.setTags('f', 'tag', ['no-instrumental']);
		repo.setTags('g', 'tag', ['lyrics-never-ran']);
		repo.setTags('h', 'tag', ['legacy']);
	});

	// Expected values are hard-coded from the seed above: 'a' and 'h' are the only ready songs, so they
	// are the only ids any reader may return and the only songs any facet may count. `readySongs`
	// orders newest-id-first, so the library reads ['h', 'a'].
	it('the library list holds only the ready songs', () => {
		expect(repo.listReady().map((m) => m.id)).toEqual(['h', 'a']);
	});

	it('the artist filter does not reveal the not-ready songs the library hides (F1)', () => {
		// base: ['g', 'f', 'e', 'd', 'b', 'a'] — filtering a list narrowed it INTO rows the unnarrowed
		// list refuses. Five of the six are the shapes's seed never held.
		expect(repo.byArtist('The Band').map((m) => m.id)).toEqual(['a']);
		// 'Other' has one song and it is not ready, so its filter is empty…
		expect(repo.byArtist('Other')).toEqual([]);
		expect(repo.byArtist('Legacy Library').map((m) => m.id)).toEqual(['h']);
	});

	it('the artist rail counts only ready songs, and never offers a heading that opens empty (F2)', () => {
		// base: [{ 'The Band', 6 }, { 'Other', 1 }, { 'Legacy Library', 1 }] — 6 under a chip whose list
		// holds 1, and a chip for 'Other' whose list is empty. Facet order is count desc, then value asc.
		expect(repo.artistFacets()).toEqual([
			{ artist: 'Legacy Library', count: 1 },
			{ artist: 'The Band', count: 1 }
		]);
	});

	it('the tag rail counts only ready songs, and never offers a heading that opens empty (F2)', () => {
		// base: acoustic 2, ballad 1, unacquired 1, stems-queued 1, no-instrumental 1,
		// lyrics-never-ran 1, legacy 1 — five of those seven chips opened a measured EMPTY list.
		expect(repo.tagFacets()).toEqual([
			{ tag: 'acoustic', count: 1 },
			{ tag: 'legacy', count: 1 }
		]);
	});

	it('the tag filter holds only the ready songs', () => {
		expect(repo.byTag('acoustic').map((m) => m.id)).toEqual(['a']);
		expect(repo.byTag('ballad')).toEqual([]);
		expect(repo.byTag('legacy').map((m) => m.id)).toEqual(['h']);
	});

	// One row per not-ready gate shape, checked against all five readers. `it.each` names the shape in
	// the failure line, so a leak points at the gate arm that let it through rather than at a total.
	// Each row's tag is held by that row alone (b is the exception — it shares 'acoustic' with a, which
	// is what the count assertions above cover), so `byTag` and `tagFacets` discriminate per row.
	it.each([
		['b', 'mid-align, sharing both groupings with a', 'The Band', 'acoustic'],
		['c', 'mid-align, sole holder of its groupings', 'Other', 'ballad'],
		['d', 'unacquired — separation never started', 'The Band', 'unacquired'],
		['e', 'separation still enqueued', 'The Band', 'stems-queued'],
		['f', "stemStatus 'ready' with no instrumental artifact", 'The Band', 'no-instrumental'],
		['g', 'alignment never ran', 'The Band', 'lyrics-never-ran']
	])('%s (%s) is hidden by every one of the five readers', (id, _shape, artist, tag) => {
		expect(repo.listReady().map((m) => m.id)).not.toContain(id);
		expect(repo.byArtist(artist).map((m) => m.id)).not.toContain(id);
		expect(repo.byTag(tag).map((m) => m.id)).not.toContain(id);
		// A leak in either rail shows up as an extra heading, or as an inflated count on 'The Band' /
		// 'acoustic'. Both totals are hard-coded from the seed, never read back from a reader.
		expect(repo.artistFacets()).toEqual([
			{ artist: 'Legacy Library', count: 1 },
			{ artist: 'The Band', count: 1 }
		]);
		expect(repo.tagFacets()).toEqual([
			{ tag: 'acoustic', count: 1 },
			{ tag: 'legacy', count: 1 }
		]);
	});

	it('the legacy lyrics-artifact row IS ready, and every one of the five readers shows it', () => {
		// The other direction: a gate narrowed to `lyricsStatus === 'ready'` — dropping the legacy arm
		// in `gates.ts` — would HIDE this song from all five readers. 'a' alone cannot detect that,
		// because it carries `lyricsStatus: 'ready'` and satisfies either spelling.
		expect(repo.listReady().map((m) => m.id)).toContain('h');
		expect(repo.byArtist('Legacy Library').map((m) => m.id)).toEqual(['h']);
		expect(repo.byTag('legacy').map((m) => m.id)).toEqual(['h']);
		expect(repo.artistFacets()).toContainEqual({ artist: 'Legacy Library', count: 1 });
		expect(repo.tagFacets()).toContainEqual({ tag: 'legacy', count: 1 });
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

// Non-vacuity sentinel: with every not-ready row absent, all the assertions above must PASS on base too
// — so the redness above comes from the not-ready windows, not from the invariants being unsatisfiable.
describe('the same invariants hold for a library of finished songs alone', () => {
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
// it can only observe that today's answers happen to agree, which is exactly what was true of
// `listReady` and `byTag` while three other readers disagreed. This arm bans the second definition
// by SHAPE (a readiness comparison against `stemStatus`, and the gate call), not by name, so a renamed
// copy of the old per-reader spelling trips it too — and, since, so does a JS re-derivation that
// never touches drizzle. What it still cannot see is a re-derivation that never mentions `stemStatus`
// at all; that ceiling is asserted at the bottom of this block so it cannot silently drift.
//
// Named from the repo root. This anchor sat 250 lines BELOW the imports as `join(HERE, 'repository.ts')`,
// which is why the sweeps that re-anchored this suite walked past it: a self-derived path is not
// necessarily near the import block. `read()` throws with the guard's name attached when the subject
// moves, where `readFileSync` on a wrong join reported nothing but an ENOENT.
const SRC = read('src/lib/server/media/repository.ts');

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

/**
 * A readiness comparison against `stemStatus`, under ANY name and in EITHER language: drizzle's
 * `eq(media.stemStatus, 'ready')` (the comma form) and a JS `m.stemStatus === 'ready'` re-derivation.
 *
 * shipped the comma form alone, which caught the shape that actually occurred in — a renamed
 * copy of a per-reader query — and missed the one measured: a sixth reader spelling the same
 * predicate in JS after `.map(fromRow)`, which is neither this pattern nor a gate call. Widening to the
 * comparison operators keeps the file's count at exactly 1 (the `eq(…)` in `readySongs`), so this costs
 * no false positive today. `stemStatus: r.stemStatus,` in the row mappers is not a comparison and does
 * not match.
 */
const NARROWING = /stemStatus\s*(?:,|===|==)\s*'ready'/g;
/** The authoritative gate call, under any receiver. */
const GATE = /\breadyToSing\b/g;
const count = (re: RegExp, s: string) => s.match(re)?.length ?? 0;

describe('readiness is defined once for the whole browse block', () => {
	it('the shared helper exists and is where BOTH halves of the predicate live', () => {
		const shared = body('readySongs');
		expect(count(NARROWING, shared)).toBe(1);
		expect(count(GATE, shared)).toBe(1);
	});

	it('the readiness comparison appears exactly once in the file, and the gate call exactly once', () => {
		// This is the drift ban. A second spelling anywhere in this file — a new reader, or a revert of
		// one body to its own query, in SQL or in JS — makes one of these two counts 2.
		expect(count(NARROWING, CODE)).toBe(1);
		expect(count(GATE, CODE.replace(/^import.*$/gm, ''))).toBe(1);
	});

	// The floor and the ceiling of that ban, asserted against fixture strings rather than production —
	// the point is what the PATTERN can see, and production holds exactly one match by the test above.
	// Fixtures, not the real file, is also what lets the JS shape be checked at all: it does not exist
	// in `repository.ts` and must not be added there to test for it.
	describe('what the drift ban catches, and what it admits it does not', () => {
		/** The pattern an earlier change shipped: the drizzle comma form only. Kept so the widening is pinned, not assumed. */
		const PRE_799 = /stemStatus\s*,\s*'ready'/g;

		/** The drizzle spelling the real `readySongs` uses. */
		const SQL_FORM = "const narrowing = and(eq(media.stemStatus, 'ready'), isNotNull(media.instrumentalRef));";

		/**
		 * The sixth reader measured. Its body re-derives readiness in JS after `.map(fromRow)` — it
		 * calls no gate and writes no drizzle predicate, so's ban saw nothing and the whole suite
		 * stayed green with it in the file.
		 */
		const JS_REDERIVATION = ".map(fromRow).filter((m) => m.stemStatus === 'ready' && !!m.instrumentalRef)";

		/**
		 * The CEILING, stated as code. A re-derivation that never names `stemStatus` — reading the
		 * artifact columns the two gates happen to imply — is invisible to a `stemStatus`-anchored ban
		 * and to a `readyToSing` grep alike. Nothing here claims otherwise.
		 */
		const NEVER_NAMES_STEMSTATUS =
			".map(fromRow).filter((m) => !!m.instrumentalRef && (m.lyricsStatus === 'ready' || !!m.lyricsRef))";

		it('catches the drizzle spelling, as it did before', () => {
			expect(count(NARROWING, SQL_FORM)).toBe(1);
		});

		it('now catches a JS re-derivation, which the pre- pattern did not', () => {
			expect(count(PRE_799, JS_REDERIVATION)).toBe(0); // the measured hole
			expect(count(NARROWING, JS_REDERIVATION)).toBe(1); // reverting NARROWING to PRE_799 reds here
			expect(count(GATE, JS_REDERIVATION)).toBe(0); // and the gate grep never saw it either
		});

		it('does NOT catch a re-derivation that never names stemStatus — the stated ceiling', () => {
			// Deliberate, and documented in this file's header. If a later change raises the floor past
			// this shape, this assertion must be moved on purpose and the header updated with it —
			// which is the point of asserting a limitation instead of only writing it in prose.
			expect(count(NARROWING, NEVER_NAMES_STEMSTATUS)).toBe(0);
			expect(count(GATE, NEVER_NAMES_STEMSTATUS)).toBe(0);
		});

		it('does not fire on the row mappers, which name stemStatus without comparing it', () => {
			// Why widening to `,|===|==` costs no false positive: a property copy is not a comparison.
			expect(count(NARROWING, 'stemStatus: r.stemStatus,\n\tlyricsStatus: r.lyricsStatus,')).toBe(0);
		});
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
		// DESC, value ASC`. A count taken in SQL cannot consult the gate table, which is the
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
		// the exact defect class's own report names in `tagFacets`.
		expect(SRC).not.toContain('The SQL narrows to separated songs');
		expect(docAbove('listReady')).toMatch(/readySongs/);
	});
});
