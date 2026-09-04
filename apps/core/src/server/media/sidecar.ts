// Sidecar records — the AUTHORITATIVE per-song library entry.
//
// `meta/<mediaId>.json` is the truth; the SQLite `media` table is a rebuildable INDEX over it
// (docs/ARCHITECTURE.md). Why the inversion, not incidental benefits:
//   1. SELF-DESCRIBING volume: losing the SQLite file today loses every title/artist/artifact link
//      while ~1.4 GB of bytes survive uselessly; sidecars let a rescan rebuild the catalog from the
//      volume alone, so it still knows itself on a new box.
//   2. Genre/tags become HAND-EDITABLE — impossible if the only copy lives in a DB row.
//   3. The DB stops being a single point of permanent loss.
// Cost is one small JSON write per change, nothing beside a 5 MB audio file.
//
// Pure half (build a sidecar, project one back) is split from the I/O half to unit-test without a
// filesystem — same split as ytdlp.ts parseSearchJson.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Media, LyricsCandidate } from '@encore/shared';
import { pickBestLyrics } from '@encore/shared';
import { metaDir } from './paths';
import { parseTrackTitle, type TrackParseRule } from './track-title';

/** Bump when the on-disk shape changes incompatibly. Readers tolerate older schemas. */
// 2: `artifacts.lyricsCandidates` added. `artifacts.lyrics` keeps its meaning (the CHOSEN ref), so a
// schema-1 record still reads correctly — it just has no provenance, reported as unknown not invented.
export const SIDECAR_SCHEMA = 2;

/** How a derived field was obtained. Mirrors the lyrics chain's provenance idea on purpose. */
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
		/** MusicBrainz recording id, when an annotation cited this song. Null when only parsed. */
		mbid?: string | null;
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
		/** The CHOSEN lyrics ref (whichever candidate pickBestLyrics selected). */
		lyrics: string | null;
		/**
		 * Every lyrics artifact this song has, one per text source. Authoritative here (not the DB),
		 * which is what makes re-alignment possible later without re-fetching audio. Absent on schema-1.
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
	 * The UNTOUCHED source metadata. Never discarded: keeping the raw uploader and title lets a better
	 * normalizer (or a MusicBrainz lookup) re-derive canonical fields later without re-downloading.
	 */
	raw: {
		uploader: string | null;
		rawTitle: string;
		thumbnail: string | null;
	};
}

/**
 * Build a sidecar from a runtime Media, deriving canonical artist/title with the track-title normalizer.
 * PURE. `previous` (an existing sidecar) is merged so hand-edited fields and play counts SURVIVE a
 * rewrite — the DB has no idea a human set a genre, so a naive rebuild would erase curation.
 */
export function sidecarFromMedia(m: Media, now: number, previous?: MediaSidecar | null): MediaSidecar {
	const parsed = parseTrackTitle(m.title, m.artist ?? null);
	const prev = previous ?? null;

	// A manually-set field always wins over a re-parse. This is the whole point of provenance.
	// A hand correction and a MusicBrainz citation are both stronger evidence than re-parsing the raw
	// title, so neither may be clobbered by a later write. Without this, every sidecar write would
	// silently downgrade a cited artist back to a title parse — the exact regression applyAnnotation
	// refuses at runtime, reintroduced through persistence.
	const CITED = ['manual', 'musicbrainz'];
	const keepCited = (field: 'artist' | 'title') => CITED.includes(prev?.provenance?.[field]?.by ?? '');
	// Runtime annotation wins over a stored one: it is the fresher citation.
	const cited = m.annotation?.source === 'musicbrainz' ? m.annotation : undefined;

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
			artist: cited ? (m.artistCanonical ?? parsed.artist) : keepCited('artist') ? prev!.canonical.artist : parsed.artist,
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
				? { artist: { by: 'musicbrainz' as const, confidence: cited.confidence }, title: { by: 'musicbrainz' as const, confidence: cited.confidence } }
				: {
						...(keepCited('artist') ? {} : { artist: { by: parsed.by, confidence: parsed.confidence } }),
						...(keepCited('title') ? {} : { title: { by: parsed.by, confidence: parsed.confidence } })
					})
		},
		artifacts: {
			// audio has no field on Media (the worker owns it); preserve whatever a prior write knew.
			audio: prev?.artifacts.audio ?? null,
			instrumental: m.instrumentalRef ?? prev?.artifacts.instrumental ?? null,
			vocals: m.vocalsRef ?? prev?.artifacts.vocals ?? null,
			lyrics: m.lyricsRef ?? prev?.artifacts.lyrics ?? null,
			// Runtime first, else a prior write: an index-only hydrate leaves lyricsCandidates undefined,
			// and losing the set here would silently destroy the upgrade path the set exists for.
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
		// The lyrics gate is DERIVED from the artifact rather than stored, so the sidecar keeps its
		// meaning: artifacts are the truth and status is a projection of them.
		//
		// The one case this cannot recover is "align ran and correctly found no words" — a genuine
		// instrumental has no artifact to infer from, so after a DB wipe it comes back unsettled and is
		// not singable until align runs again. That self-heals: the boot lyrics backfill enqueues it and
		// the step costs ~18s. Storing a bit here instead would mean the sidecar asserting something no
		// file on disk can corroborate, which is the property that made these records trustworthy.
		lyricsStatus: s.artifacts.lyrics ? 'ready' : undefined,
		mbid: s.canonical.mbid ?? undefined,
		// Provenance is per-field in the sidecar; Media carries one summary. Artist is the field that
		// matters (it is what browse groups by and what the never-regress rule protects), so it decides.
		annotation:
			s.provenance.artist && (s.provenance.artist.by === 'musicbrainz' || s.provenance.artist.confidence !== 'low')
				? {
						source: s.provenance.artist.by === 'musicbrainz' ? 'musicbrainz' : 'normalizer',
						confidence: s.provenance.artist.confidence === 'low' ? 'medium' : s.provenance.artist.confidence
					}
				: undefined,
		instrumentalRef: s.artifacts.instrumental ?? undefined,
		// The sidecar is authoritative, so a song whose vocals artifact was recorded before the DB was
		// wiped gets its guiding track back here without a re-cook.
		vocalsRef: s.artifacts.vocals ?? undefined,
		lyricsRef: chosenLyricsRef(s),
		lyricsCandidates: s.artifacts.lyricsCandidates,
		// Carry the confidence-gated canonicals so a RESTORED media is immediately complete. The boot
		// sync pass mirrors these into the index too, but an align job dispatched before it ran would
		// otherwise look up the raw title and miss.
		artistCanonical: browseArtist(s) ?? undefined,
		titleCanonical: lookupTitle(s) ?? undefined
	};
}

/**
 * Which lyrics artifact a restored song should show.
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
 * The lookup-safe canonical title: null when we only guessed. Same confidence gate as
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

/**
 * Read one sidecar, or null if absent/unparseable. Never throws — a corrupt file must not brick boot.
 *
 * Absent and corrupt both return null (a bad file cannot stop the process from booting), but they are
 * NOT the same event: a MISSING sidecar is normal (an index-only song, a never-described id), while a
 * sidecar that EXISTS and then fails to parse or fails the shape check is corruption of the record this
 * design calls authoritative — the source of truth for that song is gone. That must not be silent, so
 * the existing-but-unreadable case logs a distinct warning; the missing case says nothing.
 */
export async function readSidecar(mediaId: string): Promise<MediaSidecar | null> {
	const path = sidecarPath(mediaId);
	let existed = false;
	try {
		const file = Bun.file(path);
		if (!(await file.exists())) return null;
		existed = true;
		const parsed = JSON.parse(await file.text()) as MediaSidecar;
		if (parsed && typeof parsed.id === 'string') return parsed;
		// The file is there and is valid JSON, but not a sidecar (wrong/empty shape). Still corruption of
		// the authoritative record — treat it like a parse failure, not like an absent file.
		console.warn(`[sidecar] authoritative record ${path} exists but failed the shape check (no string id); returning null`);
		return null;
	} catch (err) {
		if (existed) {
			// EXISTED but could not be read/parsed: partial JSON from an interrupted write, a truncated
			// file, garbage. The one case that means silent loss of a song's source of truth.
			console.warn(`[sidecar] authoritative record ${path} exists but could not be parsed; returning null:`, err);
		}
		return null;
	}
}

/**
 * Write one sidecar ATOMICALLY. Pretty-printed on purpose: this file is meant to be hand-edited.
 *
 * The naive `Bun.write(target, ...)` truncates the target in place, so a crash, kill, or ENOSPC
 * mid-write leaves partial JSON on the record this design calls authoritative — readSidecar then
 * returns null and the song's source of truth is simply gone. Instead write to a sibling temp file in
 * the SAME directory (rename is only atomic within a filesystem) and rename it over the target: rename
 * is atomic on POSIX, so a reader sees either the old complete file or the new complete file, never a
 * half-written one. The temp file is unique per write so two concurrent writes to the same id cannot
 * corrupt each other's temp.
 */
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
		// Best-effort cleanup so a failed write does not leave an orphan temp behind.
		try {
			unlinkSync(tmp);
		} catch {
			/* temp may not exist */
		}
		throw err;
	}
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
 * Sidecars only start being written when a media is next upserted, so without this the
 * self-describing-volume property would apply ONLY to songs added after sidecars became authoritative
 * — every pre-existing song would still be lost with the SQLite file. One-shot, idempotent, cheap.
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
