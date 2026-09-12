// runtime companion to library-tags-wiring.test.ts. The library route reads a song's tags via
// `app.media.tagsOf(id, 'tag')`. This pins the property that read DEPENDS on and that the wiring scan
// cannot see: the 'tag' KIND matters. tagsOf defaults to 'genre', and the sidecar write path stores
// under 'tag' — so a read with the wrong (or defaulted) kind returns NOTHING even though tags exist.
// This test proves reading with 'tag' returns exactly what setTags wrote, and that the default 'genre'
// read does NOT see it — which is why the route must pass the kind explicitly.
import { test, expect } from 'bun:test';
import { MediaRepository } from '$lib/server/media/repository';
import { migratedDb } from '$lib/server/db/test-db';
import { instrumentalKey } from '$lib/server/media/paths';
import type { Media } from '$lib/contract';
import { EMPTY_SONG_PROFILE } from '$lib/contract';

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

test("tagsOf(id, 'tag') returns exactly the tag-kind values setTags wrote", () => {
	const repo = new MediaRepository(migratedDb());
	repo.upsert(cooked('m1'));
	repo.setTags('m1', 'tag', ['Acoustic', '80s', 'duet']);
	// normalised at the write boundary: trimmed + lower-cased + de-duped, order preserved on read.
	expect(repo.tagsOf('m1', 'tag').sort()).toEqual(['80s', 'acoustic', 'duet']);
});

test("the default 'genre' read does NOT see tag-kind values — the kind argument is load-bearing", () => {
	const repo = new MediaRepository(migratedDb());
	repo.upsert(cooked('m1'));
	repo.setTags('m1', 'tag', ['acoustic']);
	// A route that called tagsOf(id) without the kind would land here: empty, tag chips gone.
	expect(repo.tagsOf('m1')).toEqual([]);
	expect(repo.tagsOf('m1', 'tag')).toEqual(['acoustic']);
});

test('a song with no tags yields an empty array, so its row omits the chips', () => {
	const repo = new MediaRepository(migratedDb());
	repo.upsert(cooked('m2'));
	expect(repo.tagsOf('m2', 'tag')).toEqual([]);
});
