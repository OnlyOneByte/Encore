// Sidecar records. `meta/<id>.json` is authoritative; the DB is a rebuildable index.
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
	clearArtifacts,
	SIDECAR_SCHEMA,
	type MediaSidecar
} from './sidecar';

const NOW = 1_788_400_000_000;

// A real-shaped row: the uploader in `artist`, the artist buried in `title` (the title-normalizer problem).
const media = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'djV11Xbc914',
	title: 'Britney Spears - Baby One More Time (Lyrics)',
	artist: '7clouds',
	durationSec: 210,
	thumbnail: 'https://i.ytimg.com/vi/x/hq.jpg',
	stemStatus: 'none',
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
			media({ instrumentalRef: 'derived/stems/m1-instrumental.m4a', lyricsRef: 'derived/lyrics/m1.json' }),
			NOW
		);
		expect(s.artifacts.instrumental).toBe('derived/stems/m1-instrumental.m4a');
		expect(s.artifacts.lyrics).toBe('derived/lyrics/m1.json');
	});

	it('a MANUAL edit survives a rewrite — curation must not be erased by a re-parse', () => {
		// The DB has no idea a human set these, so a naive rebuild would stomp them.
		const curated: MediaSidecar = {
			...sidecarFromMedia(media(), NOW),
			canonical: {
				...sidecarFromMedia(media(), NOW).canonical,
				artist: 'Britney Spears',
				genre: ['pop', '90s'],
				year: 1998,
				album: 'Baby One More Time'
			},
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
		const withHistory: MediaSidecar = {
			...first,
			library: { tags: ['banger'], addedAt: NOW - 99, playCount: 7, lastPlayedAt: NOW - 5 }
		};
		const again = sidecarFromMedia(media(), NOW + 1000, withHistory);
		expect(again.library).toEqual({ tags: ['banger'], addedAt: NOW - 99, playCount: 7, lastPlayedAt: NOW - 5 });
	});

	it('keeps the ORIGIN sourceRef even if the live media somehow drifted', () => {
		const first = sidecarFromMedia(media(), NOW);
		const again = sidecarFromMedia(media({ sourceRef: 'derived/stems/oops.m4a' }), NOW, first);
		expect(again.origin.sourceRef).toBe('djV11Xbc914'); // immutable identity — never the cooked stem key
	});
});

describe('mediaFromSidecar (the index projection)', () => {
	it('round-trips a plain song', () => {
		const m = media();
		const back = mediaFromSidecar(sidecarFromMedia(m, NOW));
		expect(back).toMatchObject({
			id: 'm1',
			source: 'youtube',
			sourceRef: 'djV11Xbc914',
			durationSec: 210,
			stemStatus: 'none'
		});
	});

	it('a cooked song comes back as READY and playable, so it is not re-cooked', () => {
		const s = sidecarFromMedia(media({ instrumentalRef: 'derived/stems/m1-instrumental.m4a' }), NOW);
		const back = mediaFromSidecar(s);
		expect(back.stemStatus).toBe('ready');
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
		const s = sidecarFromMedia(
			media({ title: 'Daft Punk - One More Time (Official Video)', artist: 'Daft Punk' }),
			NOW
		);
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

	it('a corrupt-but-PRESENT sidecar logs a distinct warning; a missing one is silent', async () => {
		const warnings: string[] = [];
		const orig = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(' '));
		};
		try {
			// Missing: normal, must NOT warn.
			expect(await readSidecar('never-existed')).toBeNull();
			expect(warnings).toHaveLength(0);

			// Present but unparseable: corruption of the authoritative record — must warn, must not throw.
			await writeSidecar(sidecarFromMedia(media(), NOW));
			await Bun.write(join(root, 'meta', 'm1.json'), '{ half a fi');
			expect(await readSidecar('m1')).toBeNull();
			expect(warnings.length).toBe(1);
			expect(warnings[0]).toContain('m1.json');

			// Present, valid JSON, but wrong shape: still corruption, still warns.
			warnings.length = 0;
			await Bun.write(join(root, 'meta', 'm1.json'), '{"not":"a sidecar"}');
			expect(await readSidecar('m1')).toBeNull();
			expect(warnings.length).toBe(1);
			expect(warnings[0]).toContain('shape check');
		} finally {
			console.warn = orig;
		}
	});

	it('a PARTIAL sidecar (only `id`) fails the shape check — a hand edit must not throw a boot pass (#446 defect 2)', async () => {
		// Hand-editing meta/<id>.json is the design (writeSidecar is pretty-printed on purpose). A hand
		// edit that keeps only the id — the shape `{"id":"m1"}` — used to PASS readSidecar's id-only check,
		// then throw deep inside a boot maintenance pass (mediaFromSidecar reads s.origin/raw/canonical,
		// the browse-sync pass reads s.canonical.genre, retention reads s.library) — and with no per-pass
		// isolation that one throw aborted backfill, lyrics AND retention behind one silent warn. Require
		// the sections its consumers dereference, down the existing warn-and-return-null path.
		const warnings: string[] = [];
		const orig = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(' '));
		};
		try {
			await writeSidecar(sidecarFromMedia(media(), NOW));
			await Bun.write(join(root, 'meta', 'm1.json'), JSON.stringify({ id: 'm1' }));
			const got = await readSidecar('m1');
			expect(got).toBeNull(); // NOT the partial object
			expect(warnings.length).toBe(1);
			expect(warnings[0]).toContain('shape check');
		} finally {
			console.warn = orig;
		}
	});

	it('mediaFromSidecar throws on the partial shape readSidecar now rejects — proving the rejection matters (#446 defect 2)', () => {
		// This is what USED to run when readSidecar returned the partial: a dereference of a missing
		// section. It documents why widening the predicate is the fix — the partial is genuinely unusable.
		expect(() => mediaFromSidecar({ id: 'm1' } as unknown as MediaSidecar)).toThrow();
	});

	it('writeSidecar is atomic: it leaves no temp file behind and readback is complete', async () => {
		const { readdirSync } = await import('node:fs');
		const s = sidecarFromMedia(media(), NOW);
		await writeSidecar(s);
		const metaFiles = readdirSync(join(root, 'meta'));
		// Exactly the target — no leftover .tmp sibling from the write-then-rename.
		expect(metaFiles).toEqual(['m1.json']);
		expect(await readSidecar('m1')).toEqual(s); // fully written, parseable
	});

	it('overwriting an existing sidecar never exposes a partial file', async () => {
		// Two writes to the same id land via distinct temps + rename, so a reader always sees one whole
		// file — either the old complete one or the new complete one.
		await writeSidecar(sidecarFromMedia(media({ id: 'x' }), NOW));
		const updated = sidecarFromMedia(
			media({ id: 'x', instrumentalRef: 'derived/stems/x-instrumental.m4a' }),
			NOW + 1000
		);
		await writeSidecar(updated);
		const back = await readSidecar('x');
		expect(back).toEqual(updated);
		expect(back!.artifacts.instrumental).toBe('derived/stems/x-instrumental.m4a');
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
		expect(index.get('b')!.stemStatus).toBe('none');
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
		// Without the backfill, only songs added after the sidecar became authoritative would survive
		// losing the SQLite file — every song already in the catalog would still be permanently lost.
		const curated = sidecarFromMedia(media({ id: 'curated' }), NOW);
		curated.canonical.genre = ['soul'];
		curated.provenance.artist = { by: 'manual', confidence: 'high' };
		await writeSidecar(curated);

		const written = await backfillSidecars(
			[media({ id: 'old1' }), media({ id: 'old2' }), media({ id: 'curated' })],
			NOW
		);
		expect(written).toBe(2); // the curated one is skipped, not rewritten
		expect(await readSidecar('old1')).not.toBeNull();
		expect((await readSidecar('curated'))!.canonical.genre).toEqual(['soul']); // curation intact
	});

	it('backfill is idempotent — a second run writes nothing', async () => {
		await backfillSidecars([media({ id: 'a' })], NOW);
		expect(await backfillSidecars([media({ id: 'a' })], NOW)).toBe(0);
	});
});

describe('annotation persistence', () => {
	it('the artist CREDIT survives a sidecar round trip', () => {
		// The sidecar is authoritative — the DB is rebuilt from it. A credit that lived only in a column
		// would be lost on a rebuild, and the align job would silently go back to being unable to tell
		// two recordings of a song apart.
		const m = media({ title: 'Lady Gaga ft. Beyoncé - Telephone (Lyrics)', artist: 'Lady Gaga' });
		const side = sidecarFromMedia(m, NOW);
		expect(side.canonical.artistCredit).toBe('Lady Gaga ft. Beyoncé');
		expect(mediaFromSidecar(side).artistCredit).toBe('Lady Gaga ft. Beyoncé');
	});

	it('#672 — a LOW-confidence credit is not projected into the Media (LRCLIB tiebreak poison)', () => {
		// A no-separator title with a plausible uploader parses `uploader-fallback` at LOW confidence:
		// artist is the uploader channel, which is a guess. The credit is still STORED verbatim (it is
		// the raw billing and must survive re-annotation), but it must NOT reach the projected Media,
		// where `LrclibSource.fetch` would score the near-tie tiebreak against the channel name via
		// `credit = req.artist_credit or req.artist`. browseArtist already gates the artist to null; the
		// credit now gates the same way.
		const m = media({ title: 'Baby One More Time', artist: 'SomeChannel' });
		const side = sidecarFromMedia(m, NOW);
		expect(side.provenance.artist?.confidence).toBe('low');
		expect(side.canonical.artistCredit).toBe('SomeChannel'); // stored...
		const back = mediaFromSidecar(side);
		expect(back.artistCanonical).toBeUndefined(); // ...gated out of the artist...
		expect(back.artistCredit).toBeUndefined(); // ...and out of the credit too (the fix)
	});

	it('a MusicBrainz citation does not overwrite the credit with a narrower one', () => {
		// The annotator returns a PRIMARY artist, so letting a citation write here would replace a real
		// two-artist billing with one name — losing exactly the signal that distinguishes the versions.
		const m = media({
			title: 'Lady Gaga ft. Beyoncé - Telephone (Lyrics)',
			artist: 'Lady Gaga',
			mbid: 'mb-9',
			artistCanonical: 'Lady Gaga',
			annotation: { source: 'musicbrainz', confidence: 'high' }
		});
		const side = sidecarFromMedia(m, NOW);
		expect(side.canonical.artist).toBe('Lady Gaga'); // the citation owns this
		expect(side.canonical.artistCredit).toBe('Lady Gaga ft. Beyoncé'); // ...but not this
	});

	it('#672 — a YouTube citation round-trips as source "youtube" and is not re-parsed away', () => {
		// YouTube's OWN declared metadata is a citation (no MBID). It must persist with provenance
		// by=youtube, project back with annotation.source=youtube, and survive a later re-parse of the
		// raw title — the same never-regress the MusicBrainz path gets, via keepCited.
		const m = media({
			title: 'some noisy upload title',
			artist: 'SomeChannel',
			artistCanonical: 'a-ha',
			titleCanonical: 'Take On Me',
			annotation: { source: 'youtube', confidence: 'high' }
		});
		const side = sidecarFromMedia(m, NOW);
		expect(side.canonical.artist).toBe('a-ha');
		expect(side.canonical.title).toBe('Take On Me');
		expect(side.provenance.artist).toEqual({ by: 'youtube', confidence: 'high' });
		const back = mediaFromSidecar(side);
		expect(back.artistCanonical).toBe('a-ha');
		expect(back.annotation).toEqual({ source: 'youtube', confidence: 'high' });

		// A later write whose Media lost the runtime annotation (an index-only hydrate) must keep the
		// stored citation rather than re-parse the raw title into the artist slot.
		const reparsed = media({ title: 'some noisy upload title', artist: 'SomeChannel' });
		const side2 = sidecarFromMedia(reparsed, NOW, side);
		expect(side2.canonical.artist).toBe('a-ha'); // keepCited protected it
		expect(side2.provenance.artist).toEqual({ by: 'youtube', confidence: 'high' });
	});

	it('a MusicBrainz citation survives a sidecar round trip', () => {
		// REGRESSION: mbid and annotation were runtime-only — no columns, not in the sidecar — so a
		// restart forgot that an artist had been CITED, and the never-regress rule then had nothing to
		// compare against: the next `medium` annotation would overwrite a `high` freely.
		const cited = media({
			mbid: 'mb-42',
			artistCanonical: 'Tears for Fears',
			titleCanonical: 'Everybody Wants to Rule the World',
			annotation: { source: 'musicbrainz', confidence: 'high' }
		});
		const back = mediaFromSidecar(sidecarFromMedia(cited, NOW));
		expect(back.mbid).toBe('mb-42');
		expect(back.annotation).toEqual({ source: 'musicbrainz', confidence: 'high' });
		expect(back.artistCanonical).toBe('Tears for Fears');
	});

	it('a later write does NOT downgrade a citation back to a title parse', () => {
		// Every sidecar write re-parses the raw title. Without the cited guard that parse would
		// overwrite the citation — reintroducing through persistence the exact regression
		// applyAnnotation refuses at runtime.
		const cited = media({
			mbid: 'mb-42',
			artistCanonical: 'Tears for Fears',
			annotation: { source: 'musicbrainz', confidence: 'high' }
		});
		const first = sidecarFromMedia(cited, NOW);
		// a second write from a media that has LOST its runtime annotation (e.g. rebuilt from an index)
		const stripped = { ...cited, mbid: undefined, annotation: undefined };
		const second = sidecarFromMedia(stripped, NOW, first);
		expect(second.canonical.mbid).toBe('mb-42');
		expect(second.provenance.artist?.by).toBe('musicbrainz');
		expect(second.canonical.artist).toBe('Tears for Fears');
	});

	it('an unannotated song round-trips with normalizer provenance, not a citation', () => {
		const back = mediaFromSidecar(sidecarFromMedia(media(), NOW));
		expect(back.mbid).toBeUndefined();
		expect(back.annotation?.source).not.toBe('musicbrainz');
	});
});

describe('clearArtifacts (eviction must stick) (#442 §1)', () => {
	it('nulls all four derived-artifact fields on the authoritative record', async () => {
		const s0 = sidecarFromMedia(
			media({
				instrumentalRef: 'derived/stems/m1-instrumental.flac',
				vocalsRef: 'derived/stems/m1-vocals.flac',
				lyricsRef: 'derived/lyrics/m1.json',
				lyricsCandidates: [
					{ ref: 'derived/lyrics/m1.json', textSource: 'lrclib', timing: 'word', textConfidence: 'high', createdAt: 1 }
				]
			}),
			NOW
		);
		await writeSidecar(s0);

		await clearArtifacts('m1');

		const after = await readSidecar('m1');
		expect(after?.artifacts.instrumental).toBeNull();
		expect(after?.artifacts.vocals).toBeNull();
		expect(after?.artifacts.lyrics).toBeNull();
		expect(after?.artifacts.lyricsCandidates).toEqual([]);
	});

	it('makes an eviction STICK: a re-derive does not resurrect the song as cooked', async () => {
		// The bug: app.ts eviction sets instrumentalRef = undefined and upserts, but sidecarFromMedia
		// does `m.instrumentalRef ?? prev?.artifacts.instrumental`, so undefined ?? prev RESTORES the
		// just-deleted ref; mediaFromSidecar then re-derives stemStatus 'ready', resurrecting an evicted
		// song as cooked with a ref to a deleted file. clearArtifacts nulls the fields directly so the
		// eviction sticks. This test reproduces BOTH halves.
		const cooked = media({
			instrumentalRef: 'derived/stems/m1-instrumental.flac',
			vocalsRef: 'derived/stems/m1-vocals.flac',
			lyricsRef: 'derived/lyrics/m1.json',
			stemStatus: 'ready'
		});
		await writeSidecar(sidecarFromMedia(cooked, NOW));

		// Eviction as app.ts performs it: the runtime Media loses its refs (undefined) and is upserted,
		// which fires sidecarFromMedia with the PRIOR sidecar as `previous`.
		const prev = await readSidecar('m1');
		const evicted: Media = {
			...cooked,
			instrumentalRef: undefined,
			vocalsRef: undefined,
			lyricsRef: undefined,
			lyricsCandidates: [],
			stemStatus: 'none'
		};
		const restored = sidecarFromMedia(evicted, NOW, prev);
		// Without clearArtifacts, the ?? prev restores the ref — proving the defect is real:
		expect(restored.artifacts.instrumental).toBe('derived/stems/m1-instrumental.flac');
		expect(mediaFromSidecar(restored).stemStatus).toBe('ready'); // resurrected — the bug

		// clearArtifacts on the authoritative record is what makes the eviction stick:
		await writeSidecar(restored); // simulate the upsert sink having written the restored sidecar
		await clearArtifacts('m1');
		const final = await readSidecar('m1');
		expect(final?.artifacts.instrumental).toBeNull();
		expect(mediaFromSidecar(final!).stemStatus).toBe('none'); // stays evicted
	});

	it('is a no-op when the song has no sidecar yet', async () => {
		await clearArtifacts('ghost'); // must not throw
		expect(await readSidecar('ghost')).toBeNull();
	});
});
