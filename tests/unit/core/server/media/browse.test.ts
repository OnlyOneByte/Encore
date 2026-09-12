// Browse by artist. The catalog holds every search result ever materialised (271 rows
// for 7 cooked songs on the live box), so the invariant under test is that browse only ever shows
// songs you can actually SING, and that an uncertain artist never becomes a heading.
import { beforeEach, expect, it } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { MediaRepository } from '$lib/server/media/repository';
import type { Media } from '$lib/contract';
import { EMPTY_SONG_PROFILE } from '$lib/contract';
import { instrumentalKey } from '$lib/server/media/paths';

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'ref-' + id,
	title: 'Title ' + id,
	artist: 'some-uploader',
	durationSec: 200,
	stemStatus: 'none',
	...over
});

const cooked = (id: string, over: Partial<Media> = {}) =>
	media(id, {
		stemStatus: 'ready',
		lyricsStatus: 'ready',
		instrumentalRef: instrumentalKey(id),
		songProfile: EMPTY_SONG_PROFILE,
		...over
	});

let repo: MediaRepository;

beforeEach(() => {
	const db = migratedDb();
	repo = new MediaRepository(db);
});

it('canonical metadata in the index: stores and reads back canonical artist/album/year', () => {
	repo.upsert(cooked('a'));
	repo.setCanonical('a', { artist: 'Daft Punk', album: 'Discovery', year: 2001 });
	expect(repo.artistFacets()).toEqual([{ artist: 'Daft Punk', count: 1 }]);
});

it('canonical metadata in the index: a NULL canonical artist is excluded from the facets, not bucketed as Unknown', () => {
	// This is the low-confidence case: better no heading than a wrong one. An "Unknown" bucket of
	// 40 songs would be the uploader-as-artist bug wearing a different hat.
	repo.upsert(cooked('a'));
	repo.setCanonical('a', { artist: null, album: null, year: null });
	expect(repo.artistFacets()).toEqual([]);
});

it('canonical metadata in the index: a partial patch (album/year OMITTED) leaves a previously-populated album/year intact', async () => {
	// REGRESSION (FIX 2): album/year used to be written unconditionally, so the boot browse-sync —
	// which passes them as null for most songs — re-nulled any populated album/year on EVERY restart.
	// With the undefined-skip guard, omitting them means "do not touch".
	const { media } = await import('$lib/server/db/schema');
	const { eq } = await import('drizzle-orm');
	const db = migratedDb();
	const r = new MediaRepository(db);
	r.upsert(cooked('a'));

	// A prior good write populated album + year.
	r.setCanonical('a', { artist: 'Daft Punk', album: 'Discovery', year: 2001 });
	// A later partial mirror knows only the artist (the boot browse-sync shape): omit album/year.
	r.setCanonical('a', { artist: 'Daft Punk Deluxe' });

	const row = db.select().from(media).where(eq(media.id, 'a')).all()[0]!;
	expect(row.artistCanonical).toBe('Daft Punk Deluxe'); // artist updated
	expect(row.album).toBe('Discovery'); // NOT re-nulled
	expect(row.year).toBe(2001); // NOT re-nulled
});

it('canonical metadata in the index: an EXPLICIT null album/year still clears (a full authoritative mirror can un-set)', async () => {
	const { media } = await import('$lib/server/db/schema');
	const { eq } = await import('drizzle-orm');
	const db = migratedDb();
	const r = new MediaRepository(db);
	r.upsert(cooked('a'));
	r.setCanonical('a', { artist: 'X', album: 'Y', year: 1999 });
	r.setCanonical('a', { artist: 'X', album: null, year: null });
	const row = db.select().from(media).where(eq(media.id, 'a')).all()[0]!;
	expect(row.album).toBeNull();
	expect(row.year).toBeNull();
});

it('media tags (setTags/tagsOf machinery): setTags is idempotent and replaces the whole set for that kind', () => {
	repo.upsert(cooked('a'));
	repo.setTags('a', 'tag', ['pop', 'pop', 'POP ']); // dupes + case + whitespace collapse to one
	expect(repo.tagsOf('a', 'tag')).toEqual(['pop']);

	repo.setTags('a', 'tag', ['soul', 'motown']);
	expect(repo.tagsOf('a', 'tag').sort()).toEqual(['motown', 'soul']); // replaced, not merged
});

it('media tags (setTags/tagsOf machinery): kinds are independent — setting one kind leaves another alone', () => {
	repo.upsert(cooked('a'));
	repo.setTags('a', 'tag', ['pop']);
	repo.setTags('a', 'mood', ['banger']);
	repo.setTags('a', 'tag', ['rock']);
	expect(repo.tagsOf('a', 'tag')).toEqual(['rock']);
	expect(repo.tagsOf('a', 'mood')).toEqual(['banger']);
});

it('media tags (setTags/tagsOf machinery): an empty set clears the tags', () => {
	repo.upsert(cooked('a'));
	repo.setTags('a', 'tag', ['pop']);
	repo.setTags('a', 'tag', []);
	expect(repo.tagsOf('a', 'tag')).toEqual([]);
});

function seedSingableLibrary() {
	// two cooked songs by one artist, one cooked by another, and an UNCOOKED one that must not appear
	repo.upsert(cooked('c1'));
	repo.upsert(cooked('c2'));
	repo.upsert(cooked('c3'));
	repo.upsert(media('raw1')); // a plain search result — cannot be sung without vocals
	repo.setCanonical('c1', { artist: 'Daft Punk', album: null, year: null });
	repo.setCanonical('c2', { artist: 'Daft Punk', album: null, year: null });
	repo.setCanonical('c3', { artist: 'Queen', album: null, year: null });
	repo.setCanonical('raw1', { artist: 'Daft Punk', album: null, year: null });
}

it('browse only shows singable songs: artist facets count only ready songs, most first', () => {
	seedSingableLibrary();
	expect(repo.artistFacets()).toEqual([
		{ artist: 'Daft Punk', count: 2 }, // raw1 is NOT counted despite its canonical artist
		{ artist: 'Queen', count: 1 }
	]);
});

it("browse only shows singable songs: byArtist returns that artist's ready songs only", () => {
	seedSingableLibrary();
	expect(
		repo
			.byArtist('Daft Punk')
			.map((m) => m.id)
			.sort()
	).toEqual(['c1', 'c2']);
	expect(repo.byArtist('Queen').map((m) => m.id)).toEqual(['c3']);
	expect(repo.byArtist('Nobody')).toEqual([]);
});

it('browse only shows singable songs: browsed rows are full Media, so a one-tap re-queue still works', () => {
	seedSingableLibrary();
	const [m] = repo.byArtist('Queen');
	expect(m.instrumentalRef).toBe(instrumentalKey('c3'));
	expect(m.stemStatus).toBe('ready');
});
