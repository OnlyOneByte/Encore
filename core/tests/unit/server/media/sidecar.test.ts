// Sidecar records. `meta/<id>.json` is authoritative; the DB is a rebuildable index.
// The headline property under test: delete the index and the library comes back from the volume alone.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_SONG_PROFILE, type Media } from '$lib/contract';
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
	updateSidecar,
	queueSidecarTask,
	sweepSidecarTemps,
	SIDECAR_SCHEMA,
	type MediaSidecar
} from '$lib/server/media/sidecar';
import { finishDelete, requestDelete, setKeep } from '$lib/server/media/library-manage';
import { evictUnlessKept } from '$lib/server/media/retention';
import { metaDir } from '$lib/server/media/paths';
import { assignParams } from '$lib/server/jobs/dispatch';

const NOW = 1_788_400_000_000;

// A real-shaped row: the uploader in `artist`, the real artist buried in `title`.
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

	it('carries the artifact refs that make a processed song restorable', () => {
		const s = sidecarFromMedia(
			media({ instrumentalRef: 'derived/stems/m1-instrumental.m4a', lyricsRef: 'derived/lyrics/m1.json' }),
			NOW
		);
		expect(s.artifacts.instrumental).toBe('derived/stems/m1-instrumental.m4a');
		expect(s.artifacts.lyrics).toBe('derived/lyrics/m1.json');
	});

	it('a MANUAL edit survives a rewrite — curation must not be erased by a re-parse', () => {
		// The DB has no idea a human set these, so a naive re-parse would stomp them.
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
		expect(again.origin.sourceRef).toBe('djV11Xbc914'); // immutable identity — never the processed stem key
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

	it('a processed song comes back as READY and playable, so it is not re-processed', () => {
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
			expect(await readSidecar('never-existed')).toBeNull(); // missing is normal: must NOT warn
			expect(warnings).toHaveLength(0);

			// Corruption of the authoritative record must warn and must not throw: unparseable, then valid
			// JSON of the wrong shape.
			await writeSidecar(sidecarFromMedia(media(), NOW));
			await Bun.write(join(root, 'meta', 'm1.json'), '{ half a fi');
			expect(await readSidecar('m1')).toBeNull();
			expect(warnings.length).toBe(1);
			expect(warnings[0]).toContain('m1.json');

			warnings.length = 0;
			await Bun.write(join(root, 'meta', 'm1.json'), '{"not":"a sidecar"}');
			expect(await readSidecar('m1')).toBeNull();
			expect(warnings.length).toBe(1);
			expect(warnings[0]).toContain('shape check');
		} finally {
			console.warn = orig;
		}
	});

	it('a PARTIAL sidecar (only `id`) fails the shape check — a hand edit must not throw a boot pass (defect 2)', async () => {
		// Hand-editing meta/<id>.json is the design, and `{"id":"m1"}` passed an id-only check then threw deep
		// inside a boot maintenance pass — with no per-pass isolation that one throw aborted backfill, lyrics AND
		// retention behind a single silent warn. The check requires every section a consumer dereferences.
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

	it('mediaFromSidecar throws on the partial shape readSidecar now rejects — proving the rejection matters (defect 2)', () => {
		// The partial is genuinely unusable, which is why widening readSidecar's predicate is the fix.
		expect(() => mediaFromSidecar({ id: 'm1' } as unknown as MediaSidecar)).toThrow();
	});

	it('writeSidecar is atomic: it leaves no temp file behind and readback is complete', async () => {
		const { readdirSync } = await import('node:fs');
		const s = sidecarFromMedia(media(), NOW);
		await writeSidecar(s);
		const metaFiles = readdirSync(join(root, 'meta'));
		expect(metaFiles).toEqual(['m1.json']); // no leftover .tmp sibling from the write-then-rename
		expect(await readSidecar('m1')).toEqual(s); // fully written, parseable
	});

	it('overwriting an existing sidecar never exposes a partial file', async () => {
		// Distinct temps + rename, so a reader always sees one whole file: the old one or the new one.
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
		// Losing the SQLite file: the bytes are on disk, and the sidecars are what bring the catalog back.
		await writeSidecar(sidecarFromMedia(media({ id: 'a', instrumentalRef: 'derived/stems/a-instrumental.m4a' }), NOW));
		await writeSidecar(sidecarFromMedia(media({ id: 'b' }), NOW));

		const index = new Map<string, Media>();
		const restored = await rebuildIndexFromMeta({
			hasMedia: (id) => index.has(id),
			upsert: (m) => index.set(m.id, m)
		});

		expect(restored).toBe(2);
		expect(index.get('a')!.stemStatus).toBe('ready'); // processed song recognised as processed
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
		// Without the backfill, every song predating the sidecar is still lost permanently with the DB.
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
		// A credit living only in a column is lost on a rebuild, and align can no longer tell two recordings apart.
		const m = media({ title: 'Lady Gaga ft. Beyoncé - Telephone (Lyrics)', artist: 'Lady Gaga' });
		const side = sidecarFromMedia(m, NOW);
		expect(side.canonical.artistCredit).toBe('Lady Gaga ft. Beyoncé');
		expect(mediaFromSidecar(side).artistCredit).toBe('Lady Gaga ft. Beyoncé');
	});

	it('a LOW-confidence credit is not projected into the Media (LRCLIB tiebreak poison)', () => {
		// A no-separator title parses `uploader-fallback` at LOW confidence, so the artist is a guess. The credit
		// is still STORED verbatim (the raw billing must survive re-annotation) but must NOT reach the projected
		// Media, where `LrclibSource.fetch` would score its near-tie tiebreak against the channel name.
		const m = media({ title: 'Baby One More Time', artist: 'SomeChannel' });
		const side = sidecarFromMedia(m, NOW);
		expect(side.provenance.artist?.confidence).toBe('low');
		expect(side.canonical.artistCredit).toBe('SomeChannel'); // stored...
		const back = mediaFromSidecar(side);
		expect(back.artistCanonical).toBeUndefined(); // ...gated out of the artist...
		expect(back.artistCredit).toBeUndefined(); // ...and out of the credit too (the fix)
	});

	it('a MusicBrainz citation does not overwrite the credit with a narrower one', () => {
		// The annotator returns a PRIMARY artist, so a citation writing here would replace a two-artist
		// billing with one name — losing the signal that distinguishes the versions.
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

	it('a YouTube citation round-trips as source "youtube" and is not re-parsed away', () => {
		// YouTube's OWN metadata is a citation (no MBID), so keepCited gives it the MusicBrainz never-regress.
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

		// A write whose Media lost the runtime annotation keeps the stored citation rather than re-parsing.
		const reparsed = media({ title: 'some noisy upload title', artist: 'SomeChannel' });
		const side2 = sidecarFromMedia(reparsed, NOW, side);
		expect(side2.canonical.artist).toBe('a-ha'); // keepCited protected it
		expect(side2.provenance.artist).toEqual({ by: 'youtube', confidence: 'high' });
	});

	it('a MusicBrainz citation survives a sidecar round trip', () => {
		// mbid and annotation were runtime-only, so a restart forgot an artist had been CITED and the
		// never-regress rule had nothing to compare against: a `medium` could overwrite a `high` freely.
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
		// Every sidecar write re-parses the raw title, so without the cited guard persistence reintroduces
		// the exact regression applyAnnotation refuses at runtime.
		const cited = media({
			mbid: 'mb-42',
			artistCanonical: 'Tears for Fears',
			annotation: { source: 'musicbrainz', confidence: 'high' }
		});
		const first = sidecarFromMedia(cited, NOW);
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

describe('clearArtifacts (eviction must stick) (§1)', () => {
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

	it('makes an eviction STICK: a re-derive does not resurrect the song as processed', async () => {
		// Eviction upserts a Media with instrumentalRef undefined, but sidecarFromMedia does `m.instrumentalRef
		// ?? prev?.artifacts.instrumental`, so undefined ?? prev RESTORES the just-deleted ref and
		// mediaFromSidecar re-derives 'ready'. clearArtifacts nulls the fields so the eviction sticks.
		const processed = media({
			instrumentalRef: 'derived/stems/m1-instrumental.flac',
			vocalsRef: 'derived/stems/m1-vocals.flac',
			lyricsRef: 'derived/lyrics/m1.json',
			stemStatus: 'ready'
		});
		await writeSidecar(sidecarFromMedia(processed, NOW));

		// As app.ts performs it: the upsert fires sidecarFromMedia with the PRIOR sidecar as `previous`.
		const prev = await readSidecar('m1');
		const evicted: Media = {
			...processed,
			instrumentalRef: undefined,
			vocalsRef: undefined,
			lyricsRef: undefined,
			lyricsCandidates: [],
			stemStatus: 'none'
		};
		const restored = sidecarFromMedia(evicted, NOW, prev);
		expect(restored.artifacts.instrumental).toBe('derived/stems/m1-instrumental.flac');
		expect(mediaFromSidecar(restored).stemStatus).toBe('ready'); // resurrected — the bug

		await writeSidecar(restored); // simulate the upsert sink having written the restored sidecar
		await clearArtifacts('m1');
		const final = await readSidecar('m1');
		expect(final?.artifacts.instrumental).toBeNull();
		expect(mediaFromSidecar(final!).stemStatus).toBe('none'); // stays evicted
	});

	it("clears a fetched song's kept original, so the next process reads the watch URL", async () => {
		await writeSidecar(sidecarFromMedia(media({ originalRef: 'audio/m1.webm', originalBytes: 4_050_000 }), NOW));
		expect(mediaFromSidecar((await readSidecar('m1'))!).originalRef).toBe('audio/m1.webm');

		await clearArtifacts('m1');
		const after = mediaFromSidecar((await readSidecar('m1'))!);
		expect(after.originalRef).toBeUndefined();
		expect(after.originalBytes).toBeUndefined();
		expect(assignParams('align', after).fetcher).not.toBe('local');
		expect(assignParams('align', after).remoteUri).toBeUndefined();
	});

	it('is a no-op when the song has no sidecar yet', async () => {
		await clearArtifacts('ghost'); // must not throw
		expect(await readSidecar('ghost')).toBeNull();
	});
});

describe('concurrent writers of one record (#1188, #1185)', () => {
	it('a Keep and a library save at the same moment keep the Keep', async () => {
		const m = media();
		await writeSidecar(sidecarFromMedia(m, NOW));
		for (let round = 0; round < 20; round++) {
			const save = () => updateSidecar(m.id, (prev) => sidecarFromMedia(m, NOW, prev));
			// Both orders: a save that read before the Keep wrote must not put the old library back.
			await Promise.all(round % 2 ? [save(), setKeep(m.id, true)] : [setKeep(m.id, true), save()]);
			expect((await readSidecar(m.id))?.library.keep).toBe(true);
			await setKeep(m.id, false);
		}
	});

	it('a reader never sees a half-written record while it is being replaced', async () => {
		const m = media();
		await writeSidecar(sidecarFromMedia(m, NOW));
		let writing = true;
		// Each write is longer than the last, the case a read cut at the old length breaks.
		const writer = (async () => {
			for (let i = 1; i <= 150; i++) {
				await updateSidecar(m.id, (s) =>
					s ? { ...s, library: { ...s.library, tags: [...s.library.tags, `t${i}`] } } : null
				);
			}
			writing = false;
		})();
		let reads = 0;
		while (writing) {
			expect(await readSidecar(m.id)).not.toBeNull();
			reads++;
		}
		await writer;
		expect(reads).toBeGreaterThan(0);
		expect((await readSidecar(m.id))?.library.tags).toHaveLength(150);
	});

	it('a record renamed over between the existence check and the read is still read whole', async () => {
		// Guards against a return to reading the sidecar with `Bun.file` (#1185). The sequence, forced: any Bun.file
		// handle on the record sees it replaced by a longer one right after `exists()`. Red every run on such a reader.
		const m = media();
		await writeSidecar(sidecarFromMedia(m, NOW));
		const path = join(metaDir(), `${m.id}.json`);
		const staged = join(metaDir(), 'staged.tmp');
		const base = sidecarFromMedia(m, NOW);
		const tags = Array.from({ length: 50 }, (_, i) => `tag-${i}`);
		writeFileSync(staged, JSON.stringify({ ...base, library: { ...base.library, tags } }));
		const bun = Bun as unknown as { file: typeof Bun.file };
		const realFile = bun.file;
		bun.file = ((p: string, opts?: BlobPropertyBag) => {
			const f = realFile(p, opts);
			if (p !== path) return f;
			const exists = f.exists.bind(f);
			f.exists = async () => {
				const found = await exists();
				renameSync(staged, path);
				return found;
			};
			return f;
		}) as typeof Bun.file;
		try {
			expect(await readSidecar(m.id)).not.toBeNull();
		} finally {
			bun.file = realFile;
		}
	});

	it('delete sees a Keep that is still queued behind another write', async () => {
		const m = media({
			stemStatus: 'ready',
			instrumentalRef: 'derived/stems/m1-instrumental.flac',
			lyricsStatus: 'ready',
			songProfile: EMPTY_SONG_PROFILE
		});
		await writeSidecar(sidecarFromMedia(m, NOW));
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		// A slow write holds the queue, so the Keep is queued but not yet on disk.
		void queueSidecarTask(m.id, () => gate);
		const keep = setKeep(m.id, true);
		const app = {
			mediaById: new Map([[m.id, m]]),
			pendingDeletes: { has: () => false, schedule: () => {} },
			state: { entries: [] }
		};
		const verdict = requestDelete(app as never, m.id);
		release();
		await keep;
		expect(await verdict).toEqual({ refused: 'kept' });
	});

	// #1241: removal decides from a Keep read taken earlier, so each re-reads Keep behind queued writes as it acts.
	const holdQueue = (mediaId: string) => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		void queueSidecarTask(mediaId, () => gate);
		return release;
	};

	it('the end of a delete Undo window spares a song kept during the window', async () => {
		const m = media();
		await writeSidecar(sidecarFromMedia(m, NOW));
		const release = holdQueue(m.id); // a slow write still ahead of the Keep
		const keep = setKeep(m.id, true);
		const acted: string[] = [];
		const done = finishDelete(m.id, {
			remove: (id) => acted.push(`removed ${id}`),
			restore: (id) => acted.push(`restored ${id}`)
		});
		release();
		await Promise.all([keep, done]);
		expect(acted).toEqual([`restored ${m.id}`]);
	});

	it('eviction spares a song kept after the pass planned it', async () => {
		const m = media();
		await writeSidecar(sidecarFromMedia(m, NOW));
		const release = holdQueue(m.id);
		const keep = setKeep(m.id, true);
		const upserts: string[] = [];
		const evicting = evictUnlessKept(m, {
			jobs: { supersedeForRerun: () => false },
			upsert: (row) => upserts.push(row.id)
		});
		release();
		await keep;
		expect(await evicting).toBeNull();
		expect(upserts).toEqual([]);
		expect((await readSidecar(m.id))?.library.keep).toBe(true);
	});
});

describe('sweepSidecarTemps', () => {
	it('removes a crash-left temp over a minute old, and nothing else', async () => {
		await writeSidecar(sidecarFromMedia(media(), NOW));
		const old = join(metaDir(), '.m1.1.1.a.tmp');
		const fresh = join(metaDir(), '.m1.2.2.b.tmp');
		writeFileSync(old, '{');
		writeFileSync(fresh, '{');
		const now = Date.now();
		utimesSync(old, (now - 120_000) / 1000, (now - 120_000) / 1000);
		expect(await sweepSidecarTemps(now)).toBe(1);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		expect(await readSidecar('m1')).not.toBeNull();
	});
});

describe('the kept original read back from a sidecar', () => {
	const side = (audio: string | null, audioBytes: unknown, source: Media['source'] = 'youtube') => {
		const s = sidecarFromMedia(media({ source }), NOW);
		return { ...s, artifacts: { ...s.artifacts, audio, audioBytes: audioBytes as number } };
	};

	it('takes only an audio/<id>.<known ext> ref with a positive size, as setMediaOriginal does', () => {
		expect(mediaFromSidecar(side('audio/m1.webm', 4_050_000))).toMatchObject({
			originalRef: 'audio/m1.webm',
			originalBytes: 4_050_000
		});
		for (const [audio, bytes] of [
			['../../outside.webm', 10],
			['audio/m2.webm', 10],
			['audio/m1.flac', 10],
			['audio/m1.webm', 0],
			['audio/m1.webm', null]
		] as const) {
			expect(mediaFromSidecar(side(audio, bytes)).originalRef).toBeUndefined();
		}
	});

	it("never reads an upload's original as a kept, evictable one", () => {
		expect(mediaFromSidecar(side('audio/m1.webm', 4_050_000, 'local')).originalRef).toBeUndefined();
	});
});
