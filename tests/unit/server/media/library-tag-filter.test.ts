// guard: the library tag FILTER reads the media_tags byKindValue index, not a client-side pass. `byTag`
// and `tagFacets` are 'tag'-KIND only and READY-only, so a genre value never surfaces through them; both
// sides of the filter narrow in SQL, counted in ROWS rather than asserted in prose; and the two docstrings
// that described the OLD one-sided read stay corrected. Runtime, against a real migrated DB, because the
// query shape is the thing under test.
import { test, expect } from 'bun:test';
import { read } from '$test';
import { flattenDoc } from '$test';
import { MediaRepository } from '$lib/server/media/repository';
import { migratedDb } from '$lib/server/db/test-db';
import { openDb } from '$lib/server/db/index';
import { runMigrations } from '$lib/server/db/migrate';
import { instrumentalKey } from '$lib/server/media/paths';
import type { Media } from '$lib/contract';
import { EMPTY_SONG_PROFILE } from '$lib/contract';

const processed = (id: string): Media => ({
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
// a song still processing — stems not ready. Must never appear in a tag filter or count toward a facet.
const processing = (id: string): Media => ({ ...processed(id), stemStatus: 'queued', instrumentalRef: undefined });

test('byTag returns exactly the ready songs carrying that tag-kind value', () => {
	const repo = new MediaRepository(migratedDb());
	repo.upsert(processed('a'));
	repo.upsert(processed('b'));
	repo.upsert(processed('c'));
	repo.setTags('a', 'tag', ['Duet', '80s']);
	repo.setTags('b', 'tag', ['duet']);
	repo.setTags('c', 'tag', ['acoustic']);
	// duet is on a + b (normalised lower-case at the write boundary), NOT c.
	expect(
		repo
			.byTag('duet')
			.map((m) => m.id)
			.sort()
	).toEqual(['a', 'b']);
	expect(repo.byTag('acoustic').map((m) => m.id)).toEqual(['c']);
	// a tag nobody carries yields nothing — the filter narrows, it does not fall back to the whole list.
	expect(repo.byTag('nonexistent')).toEqual([]);
});

test('byTag excludes non-ready songs even when they carry the tag', () => {
	const repo = new MediaRepository(migratedDb());
	repo.upsert(processed('ready'));
	repo.upsert(processing('processing'));
	repo.setTags('ready', 'tag', ['duet']);
	repo.setTags('processing', 'tag', ['duet']);
	// only the ready song is browsable — a processing song you cannot sing must not show under a tag.
	expect(repo.byTag('duet').map((m) => m.id)).toEqual(['ready']);
});

test('the tag filter reads the tag KIND, not genre — a genre value must not surface', () => {
	const repo = new MediaRepository(migratedDb());
	repo.upsert(processed('g'));
	repo.setTags('g', 'genre', ['rock']); // a GENRE, not a tag
	// byTag/tagFacets are tag-kind only, so a genre value is invisible to them: the genre fence keeps genre
	// browse dead and the tag filter does not reintroduce it.
	expect(repo.byTag('rock')).toEqual([]);
	expect(repo.tagFacets()).toEqual([]);
});

test('tagFacets counts ready songs per tag, most-first', () => {
	const repo = new MediaRepository(migratedDb());
	repo.upsert(processed('a'));
	repo.upsert(processed('b'));
	repo.upsert(processed('c'));
	repo.upsert(processing('d')); // processing — its tag must not count
	repo.setTags('a', 'tag', ['duet', 'acoustic']);
	repo.setTags('b', 'tag', ['duet']);
	repo.setTags('c', 'tag', ['duet']);
	repo.setTags('d', 'tag', ['acoustic']);
	// duet: a+b+c = 3 (most, first). acoustic: a only = 1 (d is processing, excluded).
	expect(repo.tagFacets()).toEqual([
		{ tag: 'duet', count: 3 },
		{ tag: 'acoustic', count: 1 }
	]);
});

// `readyTagged` narrowed only the `media_tags` side and then called `readySongs(db)` with no `extra`, so
// every tag-filter request read the WHOLE ready library and ran the gate over all of it before the join
// threw the non-matching rows away: 900 media rows read to return 1, at 4.42 ms/call, against 1 row at
// 0.39 ms. The pins below are BEHAVIOURAL — they count the rows bun:sqlite hands back for the `media`
// statement, so a revert to `readySongs(db)` reds by row count rather than by shape.

/**
 * A canonical migrated DB whose `media` reads are counted: the row count of every SELECT against `media`
 * that bun:sqlite runs, newest last, plus a `reset` to scope a measurement to one call. Drizzle's
 * bun-sqlite driver reads a select through `Statement.values()`, which is not assignable on the native
 * statement — hence the Proxy.
 */
function countingDb(): { db: ReturnType<typeof migratedDb>; reads: number[]; reset: () => void } {
	const { db, sqlite } = openDb(':memory:');
	runMigrations(db);
	const reads: number[] = [];
	const prepare = sqlite.prepare.bind(sqlite);
	(sqlite as any).prepare = (sql: string, ...rest: any[]) => {
		const stmt: any = prepare(sql as any, ...rest);
		if (!/^select[\s\S]*\bfrom "media"/i.test(sql)) return stmt;
		return new Proxy(stmt, {
			get(target, prop) {
				const value = target[prop];
				if (typeof value !== 'function') return value;
				if (prop !== 'values' && prop !== 'all' && prop !== 'get') return value.bind(target);
				return (...args: any[]) => {
					const rows = value.apply(target, args);
					reads.push(Array.isArray(rows) ? rows.length : 1);
					return rows;
				};
			}
		});
	};
	return { db, reads, reset: () => (reads.length = 0) };
}

/** 30 finished songs, exactly one of them tagged — the shape the issue measured at 900. */
function libraryOf30(repo: MediaRepository): void {
	for (let i = 0; i < 30; i++) repo.upsert(processed('s' + String(i).padStart(2, '0')));
	repo.setTags('s07', 'tag', ['ballad']);
}

test('byTag reads only the tagged media rows, not the whole ready library', () => {
	const { db, reads, reset } = countingDb();
	const repo = new MediaRepository(db);
	libraryOf30(repo);

	// Control FIRST, so a recorder that observed nothing could not pass the pin below by reading 0: the
	// unfiltered library legitimately reads all 30, which is the number a lost push-down would put on the
	// tag filter as well.
	reset();
	expect(repo.listReady()).toHaveLength(30);
	expect(reads).toEqual([30]);

	reset();
	expect(repo.byTag('ballad').map((m) => m.id)).toEqual(['s07']);
	// ONE media statement, returning the one tagged row.
	expect(reads).toEqual([1]);
});

test('tagFacets counts from the tagged rows only', () => {
	const { db, reads, reset } = countingDb();
	const repo = new MediaRepository(db);
	libraryOf30(repo);
	repo.setTags('s21', 'tag', ['duet']);

	reset();
	expect(repo.tagFacets()).toEqual([
		{ tag: 'ballad', count: 1 },
		{ tag: 'duet', count: 1 }
	]);
	// Two songs carry a tag, so two media rows — not the 30 the facet count used to walk.
	expect(reads).toEqual([2]);
});

test('a tag nothing carries reads ZERO media rows — the empty case must not skip the narrowing', () => {
	const { db, reads, reset } = countingDb();
	const repo = new MediaRepository(db);
	libraryOf30(repo);

	reset();
	expect(repo.byTag('nonexistent')).toEqual([]);
	// `inArray(media.id, [])` compiles to `where false` on drizzle-orm 0.45.2 — zero bound params, zero rows —
	// so the empty case needs no branch. "Guarding" it by skipping the `extra` when nothing is tagged restores
	// the whole-library read for the cheapest query there is, and this reads [30] instead of [0].
	expect(reads).toEqual([0]);
});

test('the push-down is pure: identical answers across every readiness state', () => {
	// Parity, hard-coded rather than derived: these expectations hold under BOTH shapes, which is what makes
	// the change a push-down and not a behaviour change.
	const repo = new MediaRepository(migratedDb());
	repo.upsert(processed('s1-finished'));
	repo.upsert({ ...processed('s2-midalign'), lyricsStatus: 'queued' }); // stems done, lyrics gate open
	repo.upsert(processing('s3-unacquired')); // nothing processed at all
	repo.upsert({ ...processed('s4-noartifact'), instrumentalRef: undefined }); // status without artifact
	repo.upsert({ ...processed('s5-lyricsnone'), lyricsStatus: 'none' }); // alignment never ran
	repo.upsert(processed('s6-twotags'));
	for (const id of ['s1-finished', 's2-midalign', 's3-unacquired', 's4-noartifact', 's5-lyricsnone'])
		repo.setTags(id, 'tag', ['ballad']);
	repo.setTags('s6-twotags', 'tag', ['ballad', 'duet']);

	// Only the two FINISHED songs are browsable, newest id first — the four unfinished ones carry the tag and
	// are still absent, so the gate still runs after the narrowing.
	expect(repo.byTag('ballad').map((m) => m.id)).toEqual(['s6-twotags', 's1-finished']);
	expect(repo.byTag('duet').map((m) => m.id)).toEqual(['s6-twotags']);
	expect(repo.byTag('nonexistent')).toEqual([]);
	expect(repo.tagFacets()).toEqual([
		{ tag: 'ballad', count: 2 },
		{ tag: 'duet', count: 1 }
	]);
});

/** The real production file, read once. Comments are stripped per-assertion, not here — the prose guards
 *  below have the comments as their subject. */
const SRC = read('src/lib/server/media/repository.ts');

test('readyTagged hands its media ids down to readySongs, unconditionally', () => {
	// Shape ban beside the row-count pins: the regression has exactly two spellings, and both are cheap to
	// read out of the real source. Comments stripped, so the docstring describing the old shape is not
	// mistaken for the old shape.
	const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
	const body = /\nfunction readyTagged\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(CODE);
	expect(body).not.toBeNull();
	const tagged = body![1];

	// 1. the media side is narrowed to the ids the tag query found …
	expect(tagged).toMatch(/readySongs\(\s*db\s*,\s*inArray\(\s*media\.id\s*,/);
	// … 2. and there is no whole-library call left for any branch to fall back to.
	expect(tagged).not.toMatch(/readySongs\(\s*db\s*\)/);
});

// Prose: the two docstrings that described the OLD read. Both were accurate before the change and false
// after it — a comment contradicting its code. `readySongs`'s doc named `extra` as "the artist filter's
// index push-down", one caller, when `readyTagged` is now a second; and `readyTagged`'s doc said nothing
// about the media side, so a reader who trusted it would not know a push-down is there to preserve. The
// comments ARE the subject, so this asserts the raw prose, anchored on the mechanism each sentence names.

/**
 * The doc comment immediately above a declaration, with its ` * ` markers stripped and whitespace collapsed
 * so each arm below matches the SENTENCE rather than one line-wrapping of it — re-flowing a paragraph
 * otherwise moves a word across a line break and a live claim reads as missing.
 */
function docAbove(name: string): string {
	const m = new RegExp(`/\\*\\*([\\s\\S]*?)\\*/\\s*\\nfunction ${name}\\(`).exec(SRC);
	if (!m) throw new Error(`no doc comment found above ${name} in repository.ts`);
	return flattenDoc(m[1]!).trim();
}

test('prose non-vacuous: the file and both docstrings are really there', () => {
	// Without this sentinel a renamed helper passes every scan below on an empty read.
	expect(SRC.length).toBeGreaterThan(200);
	expect(docAbove('readySongs').length).toBeGreaterThan(200);
	expect(docAbove('readyTagged').length).toBeGreaterThan(200);
});

test("readySongs's docstring no longer attributes `extra` to the artist filter alone", () => {
	const doc = docAbove('readySongs');
	// The base sentence, which became false the moment readyTagged started passing an `extra`.
	expect(SRC).not.toContain("(the artist filter's index push-down)");
	expect(doc).toMatch(/\bextra\b/);
	expect(doc).toMatch(/readyTagged/);
});

test("readyTagged's docstring says BOTH sides narrow, and names the empty-case trap", () => {
	const doc = docAbove('readyTagged');
	// The media half of the claim, which the old doc omitted entirely.
	expect(doc).toMatch(/BOTH sides narrow in SQL/i);
	// The measured evidence the push-down rests on; it wraps mid-line, so match each half.
	expect(doc).toMatch(/900 rows read at/i);
	expect(doc).toMatch(/versus 1 row at 0\.39 ms/i);
	// And the trap, spelled out because "guarding" the empty case is what reintroduces the defect.
	expect(doc).toMatch(/inArray\(media\.id, \[\]\)/);
	expect(doc).toMatch(/SKIPPING the `extra`/i);
});
