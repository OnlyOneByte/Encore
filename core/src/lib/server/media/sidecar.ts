// `meta/<mediaId>.json` is AUTHORITATIVE; the SQLite `media` table only INDEXES it. See
// docs/ARCHITECTURE.md §6. The pure half is split from the I/O half to unit-test without a filesystem.

import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Media, LyricsCandidate } from '../../contract';
import { resolveLyricsRef } from '../../contract';
import type { SongProfile } from '../../contract';
import { normalizeSongProfile, clampLyricsOffsetMs } from '../../contract';
import { metaDir, keptOriginalRef } from './paths';
import { parseTrackTitle, type TrackParseRule } from './track-title';
import type { LyricsEditSnapshot } from '../jobs/lyrics-edit';
import { slicer } from '../slice';

/** Keep every new field OPTIONAL and additive: there is no migration step, so an older record's absent
 *  field must read as "never ran" rather than an error. */
export const SIDECAR_SCHEMA = 7;

/** How a derived field was obtained. */
export interface FieldProvenance {
	by: TrackParseRule | 'manual' | 'musicbrainz' | 'lrclib' | 'youtube';
	confidence: 'high' | 'medium' | 'low';
}

export interface MediaSidecar {
	id: string;
	schema: number;
	origin: {
		source: Media['source'];
		/** Immutable ORIGIN identity — never the processed stem key. See Media.sourceRef. */
		sourceRef: string;
		fetchedAt: number;
	};
	canonical: {
		/** MusicBrainz recording id, when an annotation cited this song. Null when only parsed. */
		mbid?: string | null;
		artist: string | null;
		/** `artist` is the primary alone. Always from the upload's own parse, since a MusicBrainz citation
		 *  would narrow it to the primary. */
		artistCredit?: string | null;
		title: string;
		album: string | null;
		year: number | null;
		genre: string[];
		language: string | null;
		durationSec: number;
	};
	/** A machine-parsed artist and a hand-corrected one are not equal evidence. */
	provenance: Partial<Record<'artist' | 'title' | 'album' | 'year' | 'genre', FieldProvenance>>;
	// Every field below is authoritative here — a DB wipe restores it without re-processing.
	artifacts: {
		audio: string | null;
		/** `audio`'s size when a fetch job kept it; a kept original is used only with one. */
		audioBytes?: number | null;
		instrumental: string | null;
		vocals: string | null;
		/** Both stems in ONE 4-channel file. Absent → the TV takes the legacy two-element path. */
		guideMix?: string | null;
		/** The CHOSEN lyrics ref. */
		lyrics: string | null;
		/** One per text source — what makes re-alignment possible without re-fetching audio. */
		lyricsCandidates?: LyricsCandidate[];
		/** A human's pick, by candidate `ref`. A stored ref naming no candidate is ignored on read. */
		lyricsOverrideRef?: string;
		/** The pasted WORDS, for a pin naming a candidate nothing has written yet. */
		lyricsOverrideText?: string;
		/** The host's lyrics-fix state. See docs/SERVER.md#lyrics-fixes. */
		lyricsEditRev?: number;
		/** Earlier states, oldest first, for Undo. Kept here only: it never rides the wire or the index. */
		lyricsEditHistory?: LyricsEditSnapshot[];
		/** The host's whole-song nudge, in ms (`Media.lyricsOffsetMs`). */
		lyricsOffsetMs?: number;
		/** An ALL-NULLS profile is a real, gate-satisfying result and is NOT the same as absent. */
		songProfile?: SongProfile;
	};
	library: {
		tags: string[];
		addedAt: number;
		playCount: number;
		lastPlayedAt: number | null;
		/** The host's Keep: retention never evicts this song. */
		keep?: boolean;
	};
	/** UNTOUCHED source metadata, so a better normalizer can re-derive canonical fields later. */
	raw: {
		uploader: string | null;
		rawTitle: string;
		thumbnail: string | null;
	};
}

/** PURE. `previous` is merged so hand-edited fields and play counts SURVIVE a rewrite: the DB has no idea
 *  a human set a genre, so a naive rebuild erases curation. */
export function sidecarFromMedia(m: Media, now: number, previous?: MediaSidecar | null): MediaSidecar {
	const parsed = parseTrackTitle(m.title, m.artist ?? null);
	const prev = previous ?? null;

	// Never-regress: a manual or cited field beats a re-parse, and a runtime annotation beats a stored one.
	const CITED = ['manual', 'musicbrainz', 'youtube'];
	const keepCited = (field: 'artist' | 'title') => CITED.includes(prev?.provenance?.[field]?.by ?? '');
	// The host's rename beats a citation too, so a later worker annotation never undoes it.
	const named = prev?.provenance?.artist?.by === 'manual';
	const cited =
		!named && (m.annotation?.source === 'musicbrainz' || m.annotation?.source === 'youtube') ? m.annotation : undefined;
	const citedBy = cited?.source === 'youtube' ? ('youtube' as const) : ('musicbrainz' as const);

	return {
		id: m.id,
		schema: SIDECAR_SCHEMA,
		origin: {
			source: m.source,
			sourceRef: prev?.origin.sourceRef ?? m.sourceRef,
			fetchedAt: prev?.origin.fetchedAt ?? now
		},
		canonical: {
			mbid: m.mbid ?? prev?.canonical.mbid ?? null,
			artist: cited
				? (m.artistCanonical ?? parsed.artist)
				: keepCited('artist')
					? prev!.canonical.artist
					: parsed.artist,
			// Outside `cited`/`keepCited`: a recording-level citation cannot better the UPLOAD's own billing.
			artistCredit: named
				? (prev!.canonical.artistCredit ?? null)
				: (parsed.artistFull ?? prev?.canonical.artistCredit ?? null),
			title: cited ? (m.titleCanonical ?? parsed.title) : keepCited('title') ? prev!.canonical.title : parsed.title,
			album: prev?.canonical.album ?? null,
			year: prev?.canonical.year ?? null,
			genre: prev?.canonical.genre ?? [],
			language: prev?.canonical.language ?? null,
			durationSec: m.durationSec
		},
		provenance: {
			...(prev?.provenance ?? {}),
			...(cited
				? {
						artist: { by: citedBy, confidence: cited.confidence },
						title: { by: citedBy, confidence: cited.confidence }
					}
				: {
						...(keepCited('artist') ? {} : { artist: { by: parsed.by, confidence: parsed.confidence } }),
						...(keepCited('title') ? {} : { title: { by: parsed.by, confidence: parsed.confidence } })
					})
		},
		// Runtime wins, else the prior write: an index-only hydrate carries none of these refs, so without
		// the fallback a rewrite erases an artifact already recorded.
		artifacts: {
			audio: m.originalRef ?? prev?.artifacts.audio ?? null, // the download a fetch job kept
			audioBytes: m.originalBytes ?? prev?.artifacts.audioBytes ?? null,
			instrumental: m.instrumentalRef ?? prev?.artifacts.instrumental ?? null,
			vocals: m.vocalsRef ?? prev?.artifacts.vocals ?? null,
			guideMix: m.guideMixRef ?? prev?.artifacts.guideMix ?? null, // the mix IS the two stems, one file
			lyrics: m.lyricsRef ?? prev?.artifacts.lyrics ?? null,
			lyricsCandidates: m.lyricsCandidates ?? prev?.artifacts.lyricsCandidates,
			// Once the host has changed the lyrics, the runtime holds the whole state, so "back to automatic" clears.
			...(m.lyricsEditRev !== undefined
				? {
						lyricsOverrideRef: m.lyricsOverrideRef,
						lyricsOverrideText: m.lyricsOverrideText,
						lyricsEditRev: m.lyricsEditRev
					}
				: {
						lyricsOverrideRef: m.lyricsOverrideRef ?? prev?.artifacts.lyricsOverrideRef,
						// EXCEPTION to the fallback above: the paste moves WITH its ref, so falling back would re-time a
						// stale paste over a newly picked candidate.
						lyricsOverrideText: m.lyricsOverrideRef ? m.lyricsOverrideText : prev?.artifacts.lyricsOverrideText,
						lyricsEditRev: prev?.artifacts.lyricsEditRev
					}),
			lyricsEditHistory: prev?.artifacts.lyricsEditHistory,
			lyricsOffsetMs: m.lyricsOffsetMs ?? prev?.artifacts.lyricsOffsetMs,
			songProfile: m.songProfile ?? prev?.artifacts.songProfile
		},
		library: {
			tags: prev?.library.tags ?? [],
			addedAt: prev?.library.addedAt ?? now,
			playCount: prev?.library.playCount ?? 0,
			lastPlayedAt: prev?.library.lastPlayedAt ?? null,
			...(prev?.library.keep ? { keep: true } : {})
		},
		raw: {
			uploader: prev?.raw.uploader ?? m.artist ?? null,
			rawTitle: prev?.raw.rawTitle ?? m.title,
			thumbnail: m.thumbnail ?? prev?.raw.thumbnail ?? null
		}
	};
}

/** A fetched song's kept original, with its size, or nothing. An upload's `audio` is its only copy, never one. */
function keptOriginalOf(s: MediaSidecar): Pick<Media, 'originalRef' | 'originalBytes'> {
	const ref = s.origin.source === 'local' ? null : keptOriginalRef(s.id, s.artifacts.audio);
	const bytes = s.artifacts.audioBytes;
	return ref && Number.isSafeInteger(bytes) && (bytes as number) > 0
		? { originalRef: ref, originalBytes: bytes as number }
		: {};
}

/** The INDEX direction. PURE. `title` keeps the RAW title, which is what search matches and what a singer
 *  recognises; canonical artist/title are for BROWSE and lyrics lookup only. */
export function mediaFromSidecar(s: MediaSidecar): Media {
	const processed = !!s.artifacts.instrumental;
	return {
		id: s.id,
		source: s.origin.source,
		sourceRef: s.origin.sourceRef,
		title: s.provenance.title?.by === 'manual' ? s.canonical.title : s.raw.rawTitle,
		artist: s.raw.uploader ?? undefined,
		durationSec: s.canonical.durationSec,
		thumbnail: s.raw.thumbnail ?? undefined,
		stemStatus: processed ? 'ready' : 'none',
		// DERIVED from the artifact, never stored: "align ran and found no words" self-heals via the boot
		// backfill rather than storing a bit no file on disk could corroborate.
		lyricsStatus: s.artifacts.lyrics ? 'ready' : undefined,
		mbid: s.canonical.mbid ?? undefined,
		// Provenance is per-field; Media carries one summary, decided by artist.
		annotation:
			s.provenance.artist && (s.provenance.artist.by === 'musicbrainz' || s.provenance.artist.confidence !== 'low')
				? {
						source:
							s.provenance.artist.by === 'musicbrainz'
								? 'musicbrainz'
								: s.provenance.artist.by === 'youtube' || s.provenance.artist.by === 'manual'
									? s.provenance.artist.by
									: 'normalizer',
						confidence: s.provenance.artist.confidence === 'low' ? 'medium' : s.provenance.artist.confidence
					}
				: undefined,
		// Only what `setMediaOriginal` would accept, so a hand-edited ref cannot point outside `audio/<id>.*`.
		...keptOriginalOf(s),
		instrumentalRef: s.artifacts.instrumental ?? undefined,
		vocalsRef: s.artifacts.vocals ?? undefined,
		guideMixRef: s.artifacts.guideMix ?? undefined,
		lyricsRef: chosenLyricsRef(s),
		lyricsCandidates: s.artifacts.lyricsCandidates,
		lyricsOverrideRef: s.artifacts.lyricsOverrideRef,
		lyricsOverrideText: s.artifacts.lyricsOverrideText,
		lyricsEditRev: s.artifacts.lyricsEditRev,
		// Read, not trusted: a hand edit could hold anything.
		...(s.artifacts.lyricsOffsetMs !== undefined
			? { lyricsOffsetMs: clampLyricsOffsetMs(s.artifacts.lyricsOffsetMs) }
			: {}),
		// Re-normalized on the way out even though authoritative: a hand edit may not match today's shape.
		songProfile: s.artifacts.songProfile ? normalizeSongProfile(s.artifacts.songProfile) : undefined,
		// Carried so a RESTORED media is complete ahead of the boot sync pass that mirrors these too.
		artistCanonical: browseArtist(s) ?? undefined,
		artistCredit: credit(s) ?? undefined,
		titleCanonical: lookupTitle(s) ?? undefined
	};
}

/** RE-PICKS from the candidate set rather than trusting the stored `lyrics` pointer, so a ranking change is
 *  corrected on restore. Shares `resolveLyricsRef` with `setMediaLyrics`, so the two cannot disagree. */
export function chosenLyricsRef(s: MediaSidecar): string | undefined {
	return (
		resolveLyricsRef(s.artifacts.lyricsCandidates, s.artifacts.lyricsOverrideRef) ?? s.artifacts.lyrics ?? undefined
	);
}

/** Null when we only guessed. */
export function browseArtist(s: MediaSidecar): string | null {
	const p = s.provenance.artist;
	if (!p || p.confidence === 'low') return null;
	return s.canonical.artist;
}

/** Null when we only guessed: a lookup on a guessed title returns nothing or, worse, ANOTHER SONG'S words.
 *  Callers fall back to the raw title — a miss, never a lie. */
export function lookupTitle(s: MediaSidecar): string | null {
	const p = s.provenance.title;
	if (!p || p.confidence === 'low') return null;
	return s.canonical.title;
}

/** Gated like `browseArtist`, because `LrclibSource.fetch` PREFERS credit over artist when scoring:
 *  ungated, a guessed credit wins a near-tie on a song whose artist is correctly null. */
export function credit(s: MediaSidecar): string | null {
	const p = s.provenance.artist;
	if (!p || p.confidence === 'low') return null;
	return s.canonical.artistCredit ?? null;
}

/** The browse index's view of one sidecar, named ONCE so the live-persist callback and the boot sync pass
 *  cannot drift. browseArtist/lookupTitle return null on a low-confidence parse, so a guess never becomes a
 *  library heading. */
export function canonicalsOf(s: MediaSidecar): {
	artist: string | null;
	title: string | null;
	album: string | null;
	year: number | null;
} {
	return { artist: browseArtist(s), title: lookupTitle(s), album: s.canonical.album, year: s.canonical.year };
}

function sidecarPath(mediaId: string): string {
	return join(metaDir(), `${mediaId}.json`);
}

/** A partial record must be caught HERE: `mediaFromSidecar` and the retention/browse-sync passes
 *  dereference the section objects directly, so a missing one throws deep inside a boot pass. */
function isWellFormedSidecar(parsed: unknown): parsed is MediaSidecar {
	if (!parsed || typeof parsed !== 'object') return false;
	const s = parsed as Record<string, unknown>;
	if (typeof s.id !== 'string') return false;
	const isObject = (v: unknown) => !!v && typeof v === 'object';
	return (
		isObject(s.origin) &&
		isObject(s.canonical) &&
		isObject(s.provenance) &&
		isObject(s.artifacts) &&
		isObject(s.library) &&
		isObject(s.raw)
	);
}

/** Never throws: a corrupt file must not brick boot. Only the EXISTING-but-unreadable case warns, since a
 *  missing sidecar is normal for an index-only song. */
export async function readSidecar(mediaId: string): Promise<MediaSidecar | null> {
	const path = sidecarPath(mediaId);
	let text: string;
	try {
		// One open + read, never `Bun.file`: it caches the size at `exists()`, so a write renamed in between
		// is read cut short at the OLD length and fails to parse (#1185).
		text = await readFile(path, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			console.warn(`[sidecar] authoritative record ${path} exists but could not be read; returning null:`, err);
		}
		return null;
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		if (isWellFormedSidecar(parsed)) return parsed;
		console.warn(
			`[sidecar] authoritative record ${path} exists but failed the shape check (not a complete sidecar); returning null`
		);
		return null;
	} catch (err) {
		console.warn(`[sidecar] authoritative record ${path} exists but could not be parsed; returning null:`, err);
		return null;
	}
}

/** ATOMIC via temp-file + rename, because `Bun.write(target,…)` truncates in place and a crash mid-write
 *  leaves partial JSON on the authoritative record. Pretty-printed: this file is hand-edited. */
export async function writeSidecar(s: MediaSidecar): Promise<void> {
	const dir = metaDir();
	mkdirSync(dir, { recursive: true });
	const target = sidecarPath(s.id);
	const tmp = join(dir, `.${s.id}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
	const { renameSync, unlinkSync } = await import('node:fs');
	try {
		await Bun.write(tmp, JSON.stringify(s, null, 2) + '\n');
		renameSync(tmp, target);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			/* temp may not exist */
		}
		throw err;
	}
}

// On globalThis because server.ts and the SvelteKit bundle each load their own copy of this module.
const QUEUE_KEY = Symbol.for('encore.sidecar-updates');
const pendingUpdates: Map<string, Promise<unknown>> = ((globalThis as Record<symbol, unknown>)[QUEUE_KEY] ??= new Map<
	string,
	Promise<unknown>
>()) as Map<string, Promise<unknown>>;

/** Runs `task` after every earlier queued task for this id has settled. Every write to a record goes through
 *  here, or a writer that read before another's write lands puts the old fields back. */
export function queueSidecarTask<T>(mediaId: string, task: () => Promise<T>): Promise<T> {
	const run = (pendingUpdates.get(mediaId) ?? Promise.resolve()).catch(() => undefined).then(task);
	pendingUpdates.set(mediaId, run);
	const settle = () => {
		if (pendingUpdates.get(mediaId) === run) pendingUpdates.delete(mediaId);
	};
	run.then(settle, settle);
	return run;
}

/** A read-modify-write of one record, run one at a time per id: two writers that read the same record lose
 *  one's change, and an Undo entry is not a field the runtime can restore. `change` returning null writes nothing. */
export function updateSidecar(
	mediaId: string,
	change: (prev: MediaSidecar | null) => MediaSidecar | null
): Promise<MediaSidecar | null> {
	return queueSidecarTask(mediaId, async () => {
		const next = change(await readSidecar(mediaId));
		if (next) await writeSidecar(next);
		return next;
	});
}

/** A read behind every queued write for this id, for a decision such as "is it kept?" that a write in flight
 *  could change. Never call it from inside a queued task for the same id: it would wait on itself. */
export function readSidecarInOrder(mediaId: string): Promise<MediaSidecar | null> {
	return queueSidecarTask(mediaId, () => readSidecar(mediaId));
}

/** A crash between `writeSidecar`'s write and rename leaves its temp behind; boot removes any over a minute
 *  old, so a write in flight right now is never touched. @returns how many were removed. */
export async function sweepSidecarTemps(now: number, maxAgeMs = 60_000): Promise<number> {
	const { readdirSync, statSync, unlinkSync } = await import('node:fs');
	let removed = 0;
	let names: string[];
	try {
		names = readdirSync(metaDir());
	} catch {
		return 0;
	}
	for (const name of names) {
		if (!name.startsWith('.') || !name.endsWith('.tmp')) continue;
		const path = join(metaDir(), name);
		try {
			if (now - statSync(path).mtimeMs < maxAgeMs) continue;
			unlinkSync(path);
			removed++;
		} catch {
			/* gone already, or not ours to remove */
		}
	}
	return removed;
}

/**
 * Eviction must call THIS, never a bare upsert: `sidecarFromMedia`'s `?? prev` merge would restore the
 * just-deleted refs, resurrecting the song as processed with refs to files that are gone. Weakening the
 * merge is not an option — an index-only hydrate depends on it.
 */
export async function clearArtifacts(mediaId: string): Promise<void> {
	await updateSidecar(mediaId, (side) => {
		if (!side) return null;
		side.artifacts = {
			...side.artifacts,
			// A fetched original is re-acquirable, so eviction takes it too; an upload's never is.
			...(side.origin.source === 'local' ? {} : { audio: null, audioBytes: null }),
			instrumental: null,
			vocals: null,
			guideMix: null, // the mix IS the two evicted stems, in one file
			lyrics: null,
			lyricsCandidates: []
		};
		return side;
	});
}

/** Every media id that has a sidecar on disk. */
async function listSidecarIds(): Promise<string[]> {
	const { readdirSync } = await import('node:fs');
	try {
		return readdirSync(metaDir())
			.filter((n) => n.endsWith('.json'))
			.map((n) => n.slice(0, -'.json'.length));
	} catch {
		return [];
	}
}

/** Read every sidecar on disk, skipping unreadable ones. */
export async function readAllSidecars(): Promise<MediaSidecar[]> {
	const out: MediaSidecar[] = [];
	for (const id of await listSidecarIds()) {
		const s = await readSidecar(id);
		if (s) out.push(s);
	}
	return out;
}

/** What makes the volume portable. A row the index ALREADY has is left alone: re-projecting could stomp
 *  state the DB knows and the sidecar does not.
 *  @returns how many records were restored. */
export async function rebuildIndexFromMeta(deps: {
	hasMedia: (id: string) => boolean;
	upsert: (m: Media) => void;
}): Promise<number> {
	let restored = 0;
	// One SQLite write per song, so a large library is restored in slices (#1297).
	const letIn = slicer();
	for (const s of await readAllSidecars()) {
		await letIn();
		if (deps.hasMedia(s.id)) continue;
		deps.upsert(mediaFromSidecar(s));
		restored++;
	}
	return restored;
}

/** The other direction, so a self-describing volume covers pre-existing songs too. Idempotent.
 *  @returns how many sidecars were created. */
export async function backfillSidecars(all: Media[], now: number): Promise<number> {
	let written = 0;
	for (const m of all) {
		// An existing file is already described: never clobber a curated one.
		if (await updateSidecar(m.id, (prev) => (prev ? null : sidecarFromMedia(m, now)))) written++;
	}
	return written;
}
