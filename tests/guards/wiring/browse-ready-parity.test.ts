// guard: the browse block answered "is this song ready" three different ways, so browsing could reveal a
// song the library hides and a chip's count could open an empty list. The gap is one row shape, a song
// mid-align, which `listReady` and `byTag` hid while `byArtist`, `artistFacets` and `tagFacets` counted it.
// A behavioural arm with ids hard-coded from the seed, plus a source scan banning a second definition by
// SHAPE. See docs/GUARDS.md#wiring-single-source for the ban's ceiling.
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

/** MID-ALIGN, the defect window: separation done, alignment still enqueued, no lyrics artifact. */
const midAlign = (id: string): Media => ({
	...finished(id),
	lyricsStatus: 'queued',
	lyricsRef: undefined
});

// The stems gate is `stemStatus === 'ready' && !!instrumentalRef` and the lyrics gate
// `lyricsStatus === 'ready' || !!lyricsRef`, so there are four not-ready shapes `midAlign` does not
// express plus one ready shape it hides. One seeded row each.

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

/** The ARTIFACT arm alone: satisfies the status column a SQL narrowing reads and is still not singable. */
const stemsReadyNoArtifact = (id: string): Media => ({
	...finished(id),
	instrumentalRef: undefined
});

/** Alignment never ran: `lyricsStatus: 'none'` and no artifact. */
const lyricsNeverRan = (id: string): Media => ({
	...finished(id),
	lyricsStatus: 'none',
	lyricsRef: undefined
});

/**
 * A LEGACY row: no `lyricsStatus`, but a lyrics artifact. `gates.ts` treats that as done deliberately —
 * narrowing the gate to `lyricsStatus === 'ready'` makes every pre-upgrade song unsingable forever. It is
 * the only row besides `finished` that any reader may return.
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
		// Ready rows are 'a' (finished) and 'h' (legacy lyricsRef). Five not-ready rows share artist 'The Band'
		// with a, so a leak INFLATES that facet count and lengthens its filter; each not-ready row also holds
		// its tag ALONE, so the tag readers name WHICH row leaked rather than only reporting a wrong total.
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

	// Expected values are hard-coded from the seed, never derived by re-running `readyToSing`. `readySongs`
	// orders newest-id-first, so the library reads ['h', 'a'].
	it('the library list holds only the ready songs', () => {
		expect(repo.listReady().map((m) => m.id)).toEqual(['h', 'a']);
	});

	it('the artist filter does not reveal the not-ready songs the library hides (F1)', () => {
		// Before the fix this returned six ids: filtering narrowed INTO rows the unnarrowed list refuses.
		expect(repo.byArtist('The Band').map((m) => m.id)).toEqual(['a']);
		// 'Other' has one song and it is not ready, so its filter is empty…
		expect(repo.byArtist('Other')).toEqual([]);
		expect(repo.byArtist('Legacy Library').map((m) => m.id)).toEqual(['h']);
	});

	it('the artist rail counts only ready songs, and never offers a heading that opens empty (F2)', () => {
		// Before the fix: 6 under a chip whose list holds 1, and an 'Other' chip opening empty. Facet order is
		// count desc, then value asc.
		expect(repo.artistFacets()).toEqual([
			{ artist: 'Legacy Library', count: 1 },
			{ artist: 'The Band', count: 1 }
		]);
	});

	it('the tag rail counts only ready songs, and never offers a heading that opens empty (F2)', () => {
		// Before the fix five of these seven chips opened an empty list.
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

	// One row per not-ready gate shape against all five readers; `it.each` names the shape in the failure
	// line, so a leak points at the gate arm that let it through. Each row holds its tag alone except b,
	// which shares 'acoustic' with a.
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
		// A leak shows as an extra heading or an inflated count; both totals are hard-coded from the seed.
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
		// The other direction: dropping the legacy arm in `gates.ts` HIDES this song from all five readers, and
		// 'a' alone cannot detect that because it satisfies either spelling.
		expect(repo.listReady().map((m) => m.id)).toContain('h');
		expect(repo.byArtist('Legacy Library').map((m) => m.id)).toEqual(['h']);
		expect(repo.byTag('legacy').map((m) => m.id)).toEqual(['h']);
		expect(repo.artistFacets()).toContainEqual({ artist: 'Legacy Library', count: 1 });
		expect(repo.tagFacets()).toContainEqual({ tag: 'legacy', count: 1 });
	});

	// The invariants, stated over whatever the readers return rather than over the seed.
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

// Sentinel: with every not-ready row absent the invariants must still hold, or they are unsatisfiable
// and the redness above says nothing about the not-ready windows.
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

// Source scan over the real production file. The behavioural arm can only observe that today's answers
// agree, which was already true of `listReady` and `byTag` while three other readers disagreed. The
// second definition is banned by SHAPE rather than by name, and the ban's ceiling is asserted below so
// it cannot silently drift.
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
 * A readiness comparison against `stemStatus` in EITHER language: drizzle's `eq(media.stemStatus, 'ready')`
 * comma form and a JS `m.stemStatus === 'ready'` re-derivation. The comparison operators keep the file's
 * count at exactly 1, and `stemStatus: r.stemStatus,` in the row mappers is a copy, not a comparison.
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
		// The drift ban: a second spelling anywhere in this file, in SQL or in JS, makes one count 2.
		expect(count(NARROWING, CODE)).toBe(1);
		expect(count(GATE, CODE.replace(/^import.*$/gm, ''))).toBe(1);
	});

	// Floor and ceiling asserted against FIXTURES, not production: the subject is what the PATTERN can see,
	// and the JS shape must not be added to `repository.ts` merely to be testable.
	describe('what the drift ban catches, and what it admits it does not', () => {
		/** The narrower earlier pattern: the drizzle comma form only. Kept so the widening is pinned. */
		const PRE_799 = /stemStatus\s*,\s*'ready'/g;

		/** The drizzle spelling the real `readySongs` uses. */
		const SQL_FORM = "const narrowing = and(eq(media.stemStatus, 'ready'), isNotNull(media.instrumentalRef));";

		/** A sixth reader re-deriving in JS: no gate call and no drizzle predicate, so the narrow ban saw nothing. */
		const JS_REDERIVATION = ".map(fromRow).filter((m) => m.stemStatus === 'ready' && !!m.instrumentalRef)";

		/** The CEILING as code: a re-derivation naming only artifact columns is invisible to both patterns. */
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
			// Deliberate: raising the floor past this shape has to move this assertion on purpose.
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
		// Membership of readySongs() IS the gate, so `readyTagged` carries no readiness clause of its own.
		const tagged = body('readyTagged');
		expect(tagged).toMatch(/readySongs\(/);
		expect(count(NARROWING, tagged)).toBe(0);
		expect(count(GATE, tagged)).toBe(0);
	});

	it('the SQL aggregation machinery is gone from this file, so a facet count cannot go back into SQL', () => {
		// `sql` and `asc` existed for the facets' `count(*)` / `ORDER BY count(*) DESC, value ASC`. A count
		// taken in SQL cannot consult the gate, so re-importing either is the shape of a relapse.
		const importLine = /^import \{[^}]*\} from 'drizzle-orm';$/m.exec(SRC)?.[0] ?? '';
		expect(importLine).not.toBe('');
		expect(importLine).not.toMatch(/\bsql\b/);
		expect(importLine).not.toMatch(/\basc\b/);
		expect(importLine).toMatch(/\btype SQL\b/); // the narrowing parameter's type
		expect(CODE).not.toMatch(/count\(\*\)/);
	});

	it("listReady's own docstring no longer claims to narrow in SQL itself", () => {
		// RAW text, because a comment is the subject: `listReady` holds no SQL at all now, so the old sentence
		// describing its query became a comment contradicting its code.
		expect(SRC).not.toContain('The SQL narrows to separated songs');
		expect(docAbove('listReady')).toMatch(/readySongs/);
	});
});
