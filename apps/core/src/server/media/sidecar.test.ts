// B-7-C3 — sidecar records. `meta/<id>.json` is authoritative; the DB is a rebuildable index.
// The headline property under test: delete the index and the library comes back from the volume alone.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Media } from '@encore/shared';
import {
	backfillSidecars,
	sidecarFromMedia,
	mediaFromSidecar,
	browseArtist,
	writeSidecar,
	readSidecar,
	readAllSidecars,
	rebuildIndexFromMeta,
	SIDECAR_SCHEMA,
	type MediaSidecar
} from './sidecar';

const NOW = 1_788_400_000_000;

// A real-shaped row: the uploader in `artist`, the artist buried in `title` (the B-7-C1 problem).
const media = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'djV11Xbc914',
	title: 'Britney Spears - Baby One More Time (Lyrics)',
	artist: '7clouds',
	durationSec: 210,
	thumbnail: 'https://i.ytimg.com/vi/x/hq.jpg',
	stemStatus: 'none',
	playMode: 'iframe',
	...over
});

let root: string;
let savedMeta: string | undefined;
let savedRoot: string | undefined;

beforeEach(() => {
	savedMeta = process.env.ENCORE_META_DIR;
	savedRoot = process.env.MEDIA_DIR;
	root = mkdtempSync(join(tmpdir(), 'encore-meta-'));
	process.env.MEDIA_DIR = root;
	delete process.env.ENCORE_META_DIR;
});
afterEach(() => {
	if (savedMeta === undefined) delete process.env.ENCORE_META_DIR;
	else process.env.ENCORE_META_DIR = savedMeta;
	if (savedRoot === undefined) delete process.env.MEDIA_DIR;
	else process.env.MEDIA_DIR = savedRoot;
	rmSync(root, { recursive: true, force: true });
});

describe('sidecarFromMedia', () => {
	it('derives canonical artist/title with the normalizer and records provenance', () => {
		const s = sidecarFromMedia(media(), NOW);
		expect(s.canonical.artist).toBe('Britney Spears'); // NOT the "7clouds" uploader
		expect(s.canonical.title).toBe('Baby One More Time');
		expect(s.provenance.artist?.by).toBe('title-split');
		expect(s.provenance.artist?.confidence).toBe('medium');
		expect(s.schema).toBe(SIDECAR_SCHEMA);
	});

	it('NEVER discards the raw uploader/title, so a better normalizer can re-derive later', () => {
		const s = sidecarFromMedia(media(), NOW);
		expect(s.raw.uploader).toBe('7clouds');
		expect(s.raw.rawTitle).toBe('Britney Spears - Baby One More Time (Lyrics)');
	});

	it('carries the artifact refs that make a cooked song restorable', () => {
		const s = sidecarFromMedia(
			media({ instrumentalRef: 'derived/stems/m1-instrumental.m4a', lyricsRef: 'derived/lyrics/m1.json', pitchRef: 'derived/pitch/m1-pitch.json' }),
			NOW
		);
		expect(s.artifacts.instrumental).toBe('derived/stems/m1-instrumental.m4a');
		expect(s.artifacts.lyrics).toBe('derived/lyrics/m1.json');
		expect(s.artifacts.pitch).toBe('derived/pitch/m1-pitch.json');
	});

	it('a MANUAL edit survives a rewrite — curation must not be erased by a re-parse', () => {
		// The DB has no idea a human set these, so a naive rebuild would stomp them.
		const curated: MediaSidecar = {
			...sidecarFromMedia(media(), NOW),
			canonical: { ...sidecarFromMedia(media(), NOW).canonical, artist: 'Britney Spears', genre: ['pop', '90s'], year: 1998, album: 'Baby One More Time' },
			provenance: { artist: { by: 'manual', confidence: 'high' } }
		};
		const again = sidecarFromMedia(media({ title: 'Some Totally Different Title - X' }), NOW + 5000, curated);
		expect(again.canonical.artist).toBe('Britney Spears'); // manual wins over the re-parse
		expect(again.provenance.artist?.by).toBe('manual');
		expect(again.canonical.genre).toEqual(['pop', '90s']); // hand-set genre survives
		expect(again.canonical.year).toBe(1998);
	});

	it('preserves addedAt, play counts and tags across rewrites', () => {
		const first = sidecarFromMedia(media(), NOW);
		const withHistory: MediaSidecar = { ...first, library: { tags: ['banger'], addedAt: NOW - 99, playCount: 7, lastPlayedAt: NOW - 5 } };
		const again = sidecarFromMedia(media(), NOW + 1000, withHistory);
		expect(again.library).toEqual({ tags: ['banger'], addedAt: NOW - 99, playCount: 7, lastPlayedAt: NOW - 5 });
	});

	it('keeps the ORIGIN sourceRef even if the live media somehow drifted', () => {
		const first = sidecarFromMedia(media(), NOW);
		const again = sidecarFromMedia(media({ sourceRef: 'derived/stems/oops.m4a' }), NOW, first);
		expect(again.origin.sourceRef).toBe('djV11Xbc914'); // immutable identity (the B-5 lesson)
	});
});

describe('mediaFromSidecar (the index projection)', () => {
	it('round-trips a plain song', () => {
		const m = media();
		const back = mediaFromSidecar(sidecarFromMedia(m, NOW));
		expect(back).toMatchObject({ id: 'm1', source: 'youtube', sourceRef: 'djV11Xbc914', durationSec: 210, stemStatus: 'none', playMode: 'iframe' });
	});

	it('a cooked song comes back as READY and file-backed, so it is not re-cooked', () => {
		const s = sidecarFromMedia(media({ instrumentalRef: 'derived/stems/m1-instrumental.m4a' }), NOW);
		const back = mediaFromSidecar(s);
		expect(back.stemStatus).toBe('ready');
		expect(back.playMode).toBe('file');
		expect(back.instrumentalRef).toBe('derived/stems/m1-instrumental.m4a');
	});

	it('title stays the RAW title — that is what search matches and singers recognise', () => {
		const back = mediaFromSidecar(sidecarFromMedia(media(), NOW));
		expect(back.title).toBe('Britney Spears - Baby One More Time (Lyrics)');
		expect(back.artist).toBe('7clouds'); // canonical artist is for browse/lookup, not for display here
	});
});

describe('browseArtist', () => {
	it('returns the canonical artist when the parse was confident', () => {
		const s = sidecarFromMedia(media({ title: 'Daft Punk - One More Time (Official Video)', artist: 'Daft Punk' }), NOW);
		expect(s.provenance.artist?.confidence).toBe('high');
		expect(browseArtist(s)).toBe('Daft Punk');
	});

	it('returns null for a low-confidence guess — a guess must not become a library heading', () => {
		const s = sidecarFromMedia(media({ title: 'Baby One More Time', artist: '7clouds' }), NOW);
		expect(s.provenance.artist?.confidence).toBe('low');
		expect(browseArtist(s)).toBeNull();
	});
});

describe('sidecar I/O and index rebuild', () => {
	it('writes a hand-editable file and reads it back', async () => {
		const s = sidecarFromMedia(media(), NOW);
		await writeSidecar(s);
		const path = join(root, 'meta', 'm1.json');
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, 'utf8')).toContain('\n  '); // pretty-printed: meant to be edited by hand
		expect(await readSidecar('m1')).toEqual(s);
	});

	it('a corrupt sidecar returns null instead of throwing (must not brick boot)', async () => {
		await writeSidecar(sidecarFromMedia(media(), NOW));
		await Bun.write(join(root, 'meta', 'm1.json'), '{ this is not json');
		expect(await readSidecar('m1')).toBeNull();
		expect(await readAllSidecars()).toEqual([]); // skipped, not fatal
	});

	it('a missing sidecar is null, not an error', async () => {
		expect(await readSidecar('nope')).toBeNull();
		expect(await readAllSidecars()).toEqual([]);
	});

	it('THE POINT: an empty index is rebuilt entirely from the volume', async () => {
		// Simulates losing the SQLite file: all the bytes are on disk, and the sidecars are what let
		// the catalog come back rather than being permanently lost with the DB.
		await writeSidecar(sidecarFromMedia(media({ id: 'a', instrumentalRef: 'derived/stems/a-instrumental.m4a' }), NOW));
		await writeSidecar(sidecarFromMedia(media({ id: 'b' }), NOW));

		const index = new Map<string, Media>();
		const restored = await rebuildIndexFromMeta({
			hasMedia: (id) => index.has(id),
			upsert: (m) => index.set(m.id, m)
		});

		expect(restored).toBe(2);
		expect(index.get('a')!.stemStatus).toBe('ready'); // cooked song recognised as cooked
		expect(index.get('a')!.instrumentalRef).toBe('derived/stems/a-instrumental.m4a');
		expect(index.get('b')!.playMode).toBe('iframe');
	});

	it('leaves rows the index already has ALONE (a live object may be referenced elsewhere)', async () => {
		await writeSidecar(sidecarFromMedia(media({ id: 'a' }), NOW));
		const live: Media = media({ id: 'a', title: 'LIVE OBJECT' });
		const index = new Map<string, Media>([['a', live]]);

		const restored = await rebuildIndexFromMeta({ hasMedia: (id) => index.has(id), upsert: (m) => index.set(m.id, m) });
		expect(restored).toBe(0);
		expect(index.get('a')).toBe(live); // same reference, untouched
	});

	it('backfill describes songs that predate sidecars, and never clobbers a curated one', async () => {
		// Without the backfill, only songs added after B-7-C3 would survive losing the SQLite file —
		// every song already in the catalog would still be permanently lost with it.
		const curated = sidecarFromMedia(media({ id: 'curated' }), NOW);
		curated.canonical.genre = ['soul'];
		curated.provenance.artist = { by: 'manual', confidence: 'high' };
		await writeSidecar(curated);

		const written = await backfillSidecars([media({ id: 'old1' }), media({ id: 'old2' }), media({ id: 'curated' })], NOW);
		expect(written).toBe(2); // the curated one is skipped, not rewritten
		expect(await readSidecar('old1')).not.toBeNull();
		expect((await readSidecar('curated'))!.canonical.genre).toEqual(['soul']); // curation intact
	});

	it('backfill is idempotent — a second run writes nothing', async () => {
		await backfillSidecars([media({ id: 'a' })], NOW);
		expect(await backfillSidecars([media({ id: 'a' })], NOW)).toBe(0);
	});
});
