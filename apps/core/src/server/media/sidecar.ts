// Sidecar records — the AUTHORITATIVE per-song library entry (B-7-C3).
//
// `meta/<mediaId>.json` is the truth; the SQLite `media` table is a rebuildable INDEX over it
// (docs/ARCHITECTURE.md). Three things follow from that, and they are the reason for the
// inversion rather than incidental benefits:
//
//   1. The volume becomes SELF-DESCRIBING. Today, losing the SQLite file loses every title, artist and
//      artifact link while all ~1.4 GB of bytes survive uselessly on disk. With sidecars, a rescan
//      rebuilds the catalog from the volume alone — move it to a new box and it still knows itself.
//   2. Genre and tags become HAND-EDITABLE. A self-hosted library gets curated with a text editor;
//      that is impossible if the only copy lives in a DB row.
//   3. The DB stops being a single point of permanent loss.
//
// Cost is one small JSON write per change, which is nothing beside a 5 MB audio file.
//
// The pure half (build a sidecar from a Media, project one back) is separated from the I/O half so it
// unit-tests without a filesystem — the same split as ytdlp.ts parseSearchJson.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Media, LyricsCandidate } from '@encore/shared';
import { pickBestLyrics } from '@encore/shared';
import { metaDir } from './paths';
import { parseTrackTitle, type TrackParseRule } from './track-title';

/** Bump when the on-disk shape changes incompatibly. Readers tolerate older schemas. */
// 2 (B-3-C5): `artifacts.lyricsCandidates` added. `artifacts.lyrics` keeps its meaning — the CHOSEN
// ref — so a schema-1 record still reads correctly; it simply has no provenance, which we report as
// unknown rather than inventing.
export const SIDECAR_SCHEMA = 2;

/** How a derived field was obtained. Mirrors the lyrics chain's provenance idea (B-3) on purpose. */
export interface FieldProvenance {
	by: TrackParseRule | 'manual' | 'musicbrainz' | 'lrclib' | 'youtube';
	confidence: 'high' | 'medium' | 'low';
}

export interface MediaSidecar {
	id: string;
	schema: number;
	origin: {
		source: Media['source'];
		/** Immutable ORIGIN identity — never the cooked stem key. See Media.sourceRef. */
		sourceRef: string;
		fetchedAt: number;
	};
	canonical: {
		artist: string | null;
		title: string;
		album: string | null;
		year: number | null;
		genre: string[];
		language: string | null;
		durationSec: number;
	};
	/** Per-field provenance. A machine-parsed artist and a hand-corrected one are not equal evidence. */
	provenance: Partial<Record<'artist' | 'title' | 'album' | 'year' | 'genre', FieldProvenance>>;
	artifacts: {
		audio: string | null;
		instrumental: string | null;
		vocals: string | null;
		pitch: string | null;
		/** The CHOSEN lyrics ref (whichever candidate pickBestLyrics selected). */
		lyrics: string | null;
		/**
		 * Every lyrics artifact this song has, one per text source (B-3-C5). Authoritative here rather
		 * than in the DB, per B-7's rule that the sidecar is the record and the index is rebuildable —
		 * and this is what makes re-alignment possible later without re-fetching audio. Absent on
		 * schema-1 records.
		 */
		lyricsCandidates?: LyricsCandidate[];
	};
	library: {
		tags: string[];
		addedAt: number;
		playCount: number;
		lastPlayedAt: number | null;
	};
	/**
	 * The UNTOUCHED source metadata. Never discarded: keeping the raw uploader and title means a
	 * better normalizer (or a MusicBrainz lookup) can re-derive canonical fields later without
	 * re-downloading a single byte.
	 */
	raw: {
		uploader: string | null;
		rawTitle: string;
		thumbnail: string | null;
	};
}

/**
 * Build a sidecar from a runtime Media, deriving canonical artist/title with the B-7-C1 normalizer.
 * PURE. `previous` (an existing sidecar) is merged so hand-edited fields and play counts SURVIVE a
 * rewrite — the DB has no idea a human set a genre, so a naive rebuild would erase curation.
 */
export function sidecarFromMedia(m: Media, now: number, previous?: MediaSidecar | null): MediaSidecar {
	const parsed = parseTrackTitle(m.title, m.artist ?? null);
	const prev = previous ?? null;

	// A manually-set field always wins over a re-parse. This is the whole point of provenance.
	const keepManual = (field: 'artist' | 'title') => prev?.provenance?.[field]?.by === 'manual';

	return {
		id: m.id,
		schema: SIDECAR_SCHEMA,
		origin: {
			source: m.source,
			sourceRef: prev?.origin.sourceRef ?? m.sourceRef,
			fetchedAt: prev?.origin.fetchedAt ?? now
		},
		canonical: {
			artist: keepManual('artist') ? prev!.canonical.artist : parsed.artist,
			title: keepManual('title') ? prev!.canonical.title : parsed.title,
			album: prev?.canonical.album ?? null,
			year: prev?.canonical.year ?? null,
			genre: prev?.canonical.genre ?? [],
			language: prev?.canonical.language ?? null,
			durationSec: m.durationSec
		},
		provenance: {
			...(prev?.provenance ?? {}),
			...(keepManual('artist') ? {} : { artist: { by: parsed.by, confidence: parsed.confidence } }),
			...(keepManual('title') ? {} : { title: { by: parsed.by, confidence: parsed.confidence } })
		},
		artifacts: {
			// audio has no field on Media (the worker owns it); preserve whatever a prior write knew.
			audio: prev?.artifacts.audio ?? null,
			instrumental: m.instrumentalRef ?? prev?.artifacts.instrumental ?? null,
			vocals: prev?.artifacts.vocals ?? null,
			pitch: m.pitchRef ?? prev?.artifacts.pitch ?? null,
			lyrics: m.lyricsRef ?? prev?.artifacts.lyrics ?? null,
			// Keep whatever the runtime knows, else whatever a prior write knew — an index-only hydrate
			// (no sidecar read) leaves lyricsCandidates undefined, and losing the set on that write would
			// silently destroy the upgrade path B-3-C5 exists for.
			lyricsCandidates: m.lyricsCandidates ?? prev?.artifacts.lyricsCandidates
		},
		library: {
			tags: prev?.library.tags ?? [],
			addedAt: prev?.library.addedAt ?? now,
			playCount: prev?.library.playCount ?? 0,
			lastPlayedAt: prev?.library.lastPlayedAt ?? null
		},
		raw: {
			uploader: prev?.raw.uploader ?? m.artist ?? null,
			rawTitle: prev?.raw.rawTitle ?? m.title,
			thumbnail: m.thumbnail ?? prev?.raw.thumbnail ?? null
		}
	};
}

/**
 * Project a sidecar back into the runtime/DB `Media` shape — the INDEX direction. PURE.
 *
 * `title` keeps the RAW title, not the canonical one, because the raw string is what search matches
 * and what a singer recognises in a result list ("Britney Spears - Baby One More Time (Lyrics)").
 * Canonical artist/title exist for BROWSE and for lyrics lookup, not to rewrite what the room sees.
 */
export function mediaFromSidecar(s: MediaSidecar): Media {
	const cooked = !!s.artifacts.instrumental;
	return {
		id: s.id,
		source: s.origin.source,
		sourceRef: s.origin.sourceRef,
		title: s.raw.rawTitle,
		artist: s.raw.uploader ?? undefined,
		durationSec: s.canonical.durationSec,
		thumbnail: s.raw.thumbnail ?? undefined,
		stemStatus: cooked ? 'ready' : 'none',
		playMode: cooked ? 'file' : 'iframe',
		instrumentalRef: s.artifacts.instrumental ?? undefined,
		lyricsRef: chosenLyricsRef(s),
		lyricsCandidates: s.artifacts.lyricsCandidates,
		pitchRef: s.artifacts.pitch ?? undefined,
		// Carry the confidence-gated canonicals so a RESTORED media is immediately complete. The boot
		// sync pass mirrors these into the index too, but an align job dispatched before that pass ran
		// would otherwise look up the raw title and miss.
		artistCanonical: browseArtist(s) ?? undefined,
		titleCanonical: lookupTitle(s) ?? undefined
	};
}

/**
 * Which lyrics artifact a restored song should show (B-3-C5).
 *
 * RE-PICKS from the candidate set rather than trusting the stored `lyrics` pointer, so a ranking change
 * (or a candidate written by an older worker that mis-chose) is corrected on the next restore instead
 * of being frozen into the record. Falls back to the stored pointer for schema-1 records, which have no
 * candidates — those still work, they just carry no provenance.
 */
export function chosenLyricsRef(s: MediaSidecar): string | undefined {
	const best = pickBestLyrics(s.artifacts.lyricsCandidates ?? []);
	return best?.ref ?? s.artifacts.lyrics ?? undefined;
}

/** The browse-safe canonical artist: null when we only guessed (see track-title.ts). */
export function browseArtist(s: MediaSidecar): string | null {
	const p = s.provenance.artist;
	if (!p || p.confidence === 'low') return null;
	return s.canonical.artist;
}

/**
 * The lookup-safe canonical title: null when we only guessed (B-3-C1). Same confidence gate as
 * `browseArtist`, for the same reason — a lyrics lookup on a guessed title returns either nothing or,
 * worse, ANOTHER SONG'S words, and confidently wrong lyrics are the one outcome worse than none.
 * Callers fall back to the raw title, which is a miss but never a lie.
 */
export function lookupTitle(s: MediaSidecar): string | null {
	const p = s.provenance.title;
	if (!p || p.confidence === 'low') return null;
	return s.canonical.title;
}

// ── I/O ─────────────────────────────────────────────────────────────────────────────

function sidecarPath(mediaId: string): string {
	return join(metaDir(), `${mediaId}.json`);
}

/** Read one sidecar, or null if absent/unparseable. Never throws — a corrupt file must not brick boot. */
export async function readSidecar(mediaId: string): Promise<MediaSidecar | null> {
	try {
		const file = Bun.file(sidecarPath(mediaId));
		if (!(await file.exists())) return null;
		const parsed = JSON.parse(await file.text()) as MediaSidecar;
		return parsed && typeof parsed.id === 'string' ? parsed : null;
	} catch {
		return null;
	}
}

/** Write one sidecar. Pretty-printed on purpose: this file is meant to be hand-edited. */
export async function writeSidecar(s: MediaSidecar): Promise<void> {
	mkdirSync(metaDir(), { recursive: true });
	await Bun.write(sidecarPath(s.id), JSON.stringify(s, null, 2) + '\n');
}

/** Every media id that has a sidecar on disk. */
export async function listSidecarIds(): Promise<string[]> {
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

/**
 * Rebuild the DB index (and the runtime catalog) from the sidecars on disk — the property that makes
 * the volume portable. Sidecars are authoritative, so anything present in `meta/` but missing from the
 * index is restored. Rows the index already has are LEFT ALONE: a live runtime object may already be
 * referenced elsewhere, and re-projecting it could stomp state the DB knows and the sidecar does not
 * yet (e.g. a cook that finished microseconds ago).
 *
 * @returns how many records were restored.
 */
export async function rebuildIndexFromMeta(deps: {
	hasMedia: (id: string) => boolean;
	upsert: (m: Media) => void;
}): Promise<number> {
	let restored = 0;
	for (const s of await readAllSidecars()) {
		if (deps.hasMedia(s.id)) continue;
		deps.upsert(mediaFromSidecar(s));
		restored++;
	}
	return restored;
}

/**
 * The other direction: write a sidecar for every indexed media that does not have one yet.
 *
 * Needed because sidecars only start being written when a media is next upserted, so without this the
 * self-describing-volume property would apply ONLY to songs added after B-7-C3 — every song already in
 * the catalog would still be lost with the SQLite file, which is exactly the failure this is meant to
 * remove. One-shot, idempotent, and cheap (a few KB per song).
 *
 * @returns how many sidecars were created.
 */
export async function backfillSidecars(all: Media[], now: number): Promise<number> {
	let written = 0;
	for (const m of all) {
		if (await readSidecar(m.id)) continue; // already described — never clobber a curated file
		await writeSidecar(sidecarFromMedia(m, now));
		written++;
	}
	return written;
}
