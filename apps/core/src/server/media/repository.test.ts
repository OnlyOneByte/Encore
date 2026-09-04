import { instrumentalKey } from './paths';
// The durable media catalog. Search results and cooked songs are persisted so the catalog
// survives a restart — which is what lets the saved-karaoke library exist and what stops
// requestMakeKaraoke from re-cooking an instrumental that's already on disk.
import { test, expect } from 'bun:test';
import { MediaRepository, hydrateMediaCatalog } from './repository';
import { openDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import type { Media } from '@encore/shared';

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: 'Song ' + id,
	durationSec: 200,
	stemStatus: 'none',
	...over
});

const cooked = (id: string, over: Partial<Media> = {}): Media =>
	media(id, { stemStatus: 'ready', lyricsStatus: 'ready', instrumentalRef: instrumentalKey(id), ...over });

function repo(): MediaRepository {
	const { db } = openDb(':memory:');
	runMigrations(db);
	return new MediaRepository(db);
}

test('upsert → byId round-trips every field, optional ones included', () => {
	const r = repo();
	r.upsert(
		cooked('m1', {
			artist: 'A-ha',
			thumbnail: 'https://i.ytimg.com/vi/x/hq.jpg',
			lyricsRef: 'lyrics/m1-aligned.json',
			pitchRef: 'pitch/m1-pitch.json',
			durationSec: 225
		})
	);
	const got = r.byId('m1')!;
	expect(got.id).toBe('m1');
	expect(got.artist).toBe('A-ha');
	expect(got.thumbnail).toBe('https://i.ytimg.com/vi/x/hq.jpg');
	expect(got.stemStatus).toBe('ready');
	expect(got.instrumentalRef).toBe('derived/stems/m1-instrumental.flac');
	expect(got.sourceRef).toBe('vid-m1'); // ORIGIN identity survives the cook (search dedupe key)
	// the derived artifacts must survive too, or a library song replays with no lyrics + no scoring
	expect(got.lyricsRef).toBe('lyrics/m1-aligned.json');
	expect(got.pitchRef).toBe('pitch/m1-pitch.json');
	expect(r.byId('ghost')).toBeUndefined();
});

test('absent optionals come back as undefined, not null (domain shape, not DB shape)', () => {
	const r = repo();
	r.upsert(media('m1'));
	const got = r.byId('m1')!;
	expect(got.artist).toBeUndefined();
	expect(got.thumbnail).toBeUndefined();
	expect(got.instrumentalRef).toBeUndefined();
	expect(got.lyricsRef).toBeUndefined();
	expect(got.pitchRef).toBeUndefined();
});

test('upsert is idempotent on id and updates in place (the cook flip overwrites the iframe row)', () => {
	const r = repo();
	r.upsert(media('m1')); // materialized from search: iframe, no stems
	r.upsert(media('m1')); // seen again in a later search — must not duplicate
	expect(r.all()).toHaveLength(1);

	r.upsert(cooked('m1', { lyricsRef: 'lyrics/m1.json' })); // stems finished
	expect(r.all()).toHaveLength(1);
	const got = r.byId('m1')!;
	expect(got.stemStatus).toBe('ready');
	expect(got.instrumentalRef).toBe('derived/stems/m1-instrumental.flac');
	expect(got.sourceRef).toBe('vid-m1'); // the cook did not fork the song's identity
	expect(got.lyricsRef).toBe('lyrics/m1.json');
});

test('durationSec is rounded — yt-dlp reports fractional seconds, the column is an integer', () => {
	const r = repo();
	r.upsert(media('m1', { durationSec: 225.6 }));
	expect(r.byId('m1')!.durationSec).toBe(226);
});

test('listReady is the library: only stems-ready file media, newest id first', () => {
	const r = repo();
	r.upsert(media('m1')); // plain iframe → not in the library
	r.upsert(media('m2', { stemStatus: 'queued' })); // still cooking → not yet
	r.upsert(cooked('m3'));
	r.upsert(cooked('m5'));
	r.upsert(cooked('m4'));

	const ids = r.listReady().map((m) => m.id);
	expect(ids).toEqual(['m5', 'm4', 'm3']); // ULIDs are monotonic → newest first
});

test('listReady excludes a ready STATUS with no instrumental on disk', () => {
	// The status and the artifact are written by separate steps; the library must mirror isPlayable
	// rather than trusting the status alone, or a browse row resolves to a file that is not there.
	const r = repo();
	r.upsert(media('m1', { stemStatus: 'ready', lyricsStatus: 'ready' }));
	expect(r.listReady()).toHaveLength(0);
});

test('hydrateMediaCatalog seeds the runtime map and reports how many it added', () => {
	const map = new Map<string, Media>();
	expect(hydrateMediaCatalog([cooked('m1'), cooked('m2')], map)).toBe(2);
	expect(map.get('m1')!.stemStatus).toBe('ready');
	expect(map.size).toBe(2);
});

test('hydrateMediaCatalog never clobbers a live runtime object other code holds a reference to', () => {
	const live = media('m1', { title: 'the live one' });
	const map = new Map<string, Media>([['m1', live]]);
	expect(hydrateMediaCatalog([cooked('m1', { title: 'the stale row' }), cooked('m2')], map)).toBe(1);
	expect(map.get('m1')).toBe(live); // same object identity, untouched
	expect(map.get('m1')!.title).toBe('the live one');
	expect(map.has('m2')).toBe(true);
});

test('BOOT ROUND TRIP: a song cooked last night is in the catalog + library after a restart', () => {
	const { db } = openDb(':memory:'); // one DB, two "processes"
	runMigrations(db);

	// last night: searched (iframe), then cooked → both writes land
	const before = new MediaRepository(db);
	before.upsert(media('m1', { title: 'Take On Me' }));
	before.upsert(cooked('m1', { title: 'Take On Me', pitchRef: 'pitch/m1.json' }));

	// tonight: fresh process, empty runtime catalog, hydrate from disk
	const after = new MediaRepository(db);
	const mediaById = new Map<string, Media>();
	hydrateMediaCatalog(after.all(), mediaById);

	expect(mediaById.get('m1')!.title).toBe('Take On Me'); // titles survive (no raw-id rendering)
	expect(after.listReady().map((m) => m.id)).toEqual(['m1']); // one-tap re-queue is offered
	expect(mediaById.get('m1')!.pitchRef).toBe('pitch/m1.json'); // scoring still works
	expect(mediaById.get('m1')!.instrumentalRef).toBe('derived/stems/m1-instrumental.flac');
	expect(mediaById.get('m1')!.sourceRef).toBe('vid-m1'); // and it is still dedupe-able by origin
});

test('a MusicBrainz citation survives the DATABASE round trip', () => {
	// The DB is the index the runtime catalog hydrates from at boot (synchronously, before the async
	// sidecar pass), so a missing column here means the annotation is absent for the whole process
	// lifetime even though the sidecar has it.
	const r = repo();
	r.upsert(
		media('m1', {
			mbid: 'mb-42',
			artistCanonical: 'Tears for Fears',
			annotation: { source: 'musicbrainz', confidence: 'high' }
		})
	);
	const got = r.byId('m1')!;
	expect(got.mbid).toBe('mb-42');
	expect(got.annotation).toEqual({ source: 'musicbrainz', confidence: 'high' });
});

test('a half-written provenance pair is not restored as provenance', () => {
	// source without confidence is not evidence; reading it would let the never-regress check compare
	// against a partially-formed value.
	const r = repo();
	r.upsert(media('m2', { mbid: 'mb-9' }));
	expect(r.byId('m2')!.annotation).toBeUndefined();
	expect(r.byId('m2')!.mbid).toBe('mb-9');
});
