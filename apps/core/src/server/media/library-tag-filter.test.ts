// guard (#690): the library tag FILTER reads the media_tags byKindValue index, not a client-side pass.
// This pins the repository half:
//   1. byTag(value) returns exactly the READY songs carrying that 'tag'-kind value — and NOTHING else
//      (not other tags, not other kinds, not non-ready songs), so ?tag= narrows correctly.
//   2. tagFacets() counts READY songs per 'tag' value, most-first, so the browse rail lists real tags.
//   3. the 'tag' KIND is load-bearing: a genre-kind value must NOT surface through the tag filter/facet
//      (the same wrong-kind defect #689 guarded on the read side).
// Runtime, against a real migrated DB — the query shape is the thing under test, so exercise it.
import { test, expect } from 'bun:test';
import { MediaRepository } from '$server/media/repository';
import { migratedDb } from '$server/db/test-db';
import { instrumentalKey } from '$server/media/paths';
import type { Media } from '@encore/shared';
import { EMPTY_SONG_PROFILE } from '@encore/shared';

const cooked = (id: string): Media => ({
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
// a song still cooking — stems not ready. Must never appear in a tag filter or count toward a facet.
const cooking = (id: string): Media => ({ ...cooked(id), stemStatus: 'queued', instrumentalRef: undefined });

test('byTag returns exactly the ready songs carrying that tag-kind value (#690)', () => {
	const repo = new MediaRepository(migratedDb());
	repo.upsert(cooked('a'));
	repo.upsert(cooked('b'));
	repo.upsert(cooked('c'));
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

test('byTag excludes non-ready songs even when they carry the tag (#690)', () => {
	const repo = new MediaRepository(migratedDb());
	repo.upsert(cooked('ready'));
	repo.upsert(cooking('cooking'));
	repo.setTags('ready', 'tag', ['duet']);
	repo.setTags('cooking', 'tag', ['duet']);
	// only the ready song is browsable — a cooking song you cannot sing must not show under a tag.
	expect(repo.byTag('duet').map((m) => m.id)).toEqual(['ready']);
});

test('the tag filter reads the tag KIND, not genre — a genre value must not surface (#690)', () => {
	const repo = new MediaRepository(migratedDb());
	repo.upsert(cooked('g'));
	repo.setTags('g', 'genre', ['rock']); // a GENRE, not a tag
	// byTag/tagFacets are tag-kind only; a genre value is invisible to them (the #121 fence keeps
	// genre browse dead, and #690 does not reintroduce it).
	expect(repo.byTag('rock')).toEqual([]);
	expect(repo.tagFacets()).toEqual([]);
});

test('tagFacets counts ready songs per tag, most-first (#690)', () => {
	const repo = new MediaRepository(migratedDb());
	repo.upsert(cooked('a'));
	repo.upsert(cooked('b'));
	repo.upsert(cooked('c'));
	repo.upsert(cooking('d')); // cooking — its tag must not count
	repo.setTags('a', 'tag', ['duet', 'acoustic']);
	repo.setTags('b', 'tag', ['duet']);
	repo.setTags('c', 'tag', ['duet']);
	repo.setTags('d', 'tag', ['acoustic']);
	// duet: a+b+c = 3 (most, first). acoustic: a only = 1 (d is cooking, excluded).
	expect(repo.tagFacets()).toEqual([
		{ tag: 'duet', count: 3 },
		{ tag: 'acoustic', count: 1 }
	]);
});
