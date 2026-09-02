// B-7-C4 — browse by artist/genre. The catalog holds every search result ever materialised (271 rows
// for 7 cooked songs on the live box), so the invariant under test is that browse only ever shows
// songs you can actually SING, and that an uncertain artist never becomes a heading.
import { beforeEach, describe, expect, it } from 'bun:test';
import { openDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { MediaRepository } from './repository';
import type { Media } from '@encore/shared';
import { instrumentalKey } from './paths';

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'ref-' + id,
	title: 'Title ' + id,
	artist: 'some-uploader',
	durationSec: 200,
	stemStatus: 'none',
	playMode: 'iframe',
	...over
});

const cooked = (id: string, over: Partial<Media> = {}) =>
	media(id, { playMode: 'file', stemStatus: 'ready', instrumentalRef: instrumentalKey(id), ...over });

let repo: MediaRepository;

beforeEach(() => {
	const { db } = openDb(':memory:');
	runMigrations(db, './drizzle');
	repo = new MediaRepository(db);
});

describe('canonical metadata in the index', () => {
	it('stores and reads back canonical artist/album/year', () => {
		repo.upsert(cooked('a'));
		repo.setCanonical('a', { artist: 'Daft Punk', album: 'Discovery', year: 2001 });
		expect(repo.artistFacets()).toEqual([{ artist: 'Daft Punk', count: 1 }]);
	});

	it('a NULL canonical artist is excluded from the facets, not bucketed as Unknown', () => {
		// This is the low-confidence case: better no heading than a wrong one. An "Unknown" bucket of
		// 40 songs would be the uploader-as-artist bug wearing a different hat.
		repo.upsert(cooked('a'));
		repo.setCanonical('a', { artist: null, album: null, year: null });
		expect(repo.artistFacets()).toEqual([]);
	});
});

describe('genre tags', () => {
	it('setTags is idempotent and replaces the whole set for that kind', () => {
		repo.upsert(cooked('a'));
		repo.setTags('a', 'genre', ['pop', 'pop', 'POP ']); // dupes + case + whitespace collapse to one
		expect(repo.tagsOf('a', 'genre')).toEqual(['pop']);

		repo.setTags('a', 'genre', ['soul', 'motown']);
		expect(repo.tagsOf('a', 'genre').sort()).toEqual(['motown', 'soul']); // replaced, not merged
	});

	it('kinds are independent — setting genres leaves free tags alone', () => {
		repo.upsert(cooked('a'));
		repo.setTags('a', 'genre', ['pop']);
		repo.setTags('a', 'tag', ['banger']);
		repo.setTags('a', 'genre', ['rock']);
		expect(repo.tagsOf('a', 'genre')).toEqual(['rock']);
		expect(repo.tagsOf('a', 'tag')).toEqual(['banger']);
	});

	it('an empty set clears the tags', () => {
		repo.upsert(cooked('a'));
		repo.setTags('a', 'genre', ['pop']);
		repo.setTags('a', 'genre', []);
		expect(repo.tagsOf('a', 'genre')).toEqual([]);
	});
});

describe('browse only shows singable songs', () => {
	beforeEach(() => {
		// two cooked songs by one artist, one cooked by another, and an UNCOOKED one that must not appear
		repo.upsert(cooked('c1'));
		repo.upsert(cooked('c2'));
		repo.upsert(cooked('c3'));
		repo.upsert(media('raw1')); // a plain search result — cannot be sung without vocals
		repo.setCanonical('c1', { artist: 'Daft Punk', album: null, year: null });
		repo.setCanonical('c2', { artist: 'Daft Punk', album: null, year: null });
		repo.setCanonical('c3', { artist: 'Queen', album: null, year: null });
		repo.setCanonical('raw1', { artist: 'Daft Punk', album: null, year: null });
		repo.setTags('c1', 'genre', ['electronic']);
		repo.setTags('c2', 'genre', ['electronic', 'house']);
		repo.setTags('c3', 'genre', ['rock']);
		repo.setTags('raw1', 'genre', ['electronic']);
	});

	it('artist facets count only ready songs, most first', () => {
		expect(repo.artistFacets()).toEqual([
			{ artist: 'Daft Punk', count: 2 }, // raw1 is NOT counted despite its canonical artist
			{ artist: 'Queen', count: 1 }
		]);
	});

	it('genre facets count only ready songs', () => {
		expect(repo.genreFacets()).toEqual([
			{ genre: 'electronic', count: 2 }, // raw1 excluded
			{ genre: 'house', count: 1 },
			{ genre: 'rock', count: 1 }
		]);
	});

	it('byArtist returns that artist\'s ready songs only', () => {
		expect(repo.byArtist('Daft Punk').map((m) => m.id).sort()).toEqual(['c1', 'c2']);
		expect(repo.byArtist('Queen').map((m) => m.id)).toEqual(['c3']);
		expect(repo.byArtist('Nobody')).toEqual([]);
	});

	it('byGenre returns ready songs carrying it, and is case-insensitive on input', () => {
		expect(repo.byGenre('electronic').map((m) => m.id).sort()).toEqual(['c1', 'c2']);
		expect(repo.byGenre('Electronic').map((m) => m.id).sort()).toEqual(['c1', 'c2']);
		expect(repo.byGenre('house').map((m) => m.id)).toEqual(['c2']);
	});

	it('a song in two genres appears under both, exactly once each', () => {
		const el = repo.byGenre('electronic').filter((m) => m.id === 'c2');
		const ho = repo.byGenre('house').filter((m) => m.id === 'c2');
		expect(el).toHaveLength(1);
		expect(ho).toHaveLength(1);
	});

	it('browsed rows are full Media, so a one-tap re-queue still works', () => {
		const [m] = repo.byArtist('Queen');
        expect(m.instrumentalRef).toBe(instrumentalKey('c3'));
		expect(m.stemStatus).toBe('ready');
		expect(m.playMode).toBe('file');
	});
});
