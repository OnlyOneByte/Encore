// Sidecar records — the AUTHORITATIVE per-song library entry. `meta/<mediaId>.json` is the truth;
// the SQLite `media` table is a rebuildable INDEX over it. See docs/ARCHITECTURE.md
// #media-storage-and-paths for why. Pure half (build a sidecar, project one back) is split from the
// I/O half to unit-test without a filesystem — same split as ytdlp.ts parseSearchJson.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Media, LyricsCandidate } from '../../contract';
import { resolveLyricsRef } from '../../contract';
import type { SongProfile } from '../../contract';
import { normalizeSongProfile } from '../../contract';
import { metaDir } from './paths';
import { parseTrackTitle, type TrackParseRule } from './track-title';

/** Bump when the on-disk shape changes incompatibly. Every bump so far has been strictly ADDITIVE —
 *  a new optional field whose absence on an older record reads as "never ran"/"not set", never an
 *  error — so readers tolerate every older schema with no migration step. Keep new fields optional
 *  and additive, or records already on disk stop reading correctly. */
export const SIDECAR_SCHEMA = 7;

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
		/** Immutable ORIGIN identity — never the processed stem key. See Media.sourceRef. */
		sourceRef: string;
		fetchedAt: number;
	};
	canonical: {
		/** MusicBrainz recording id, when an annotation cited this song. Null when only parsed. */
		mbid?: string | null;
		artist: string | null;
		/** The full artist billing as written ("Lady Gaga feat. Beyoncé"); `artist` is the primary
		 *  alone. Distinguishes two RECORDINGS of one song. Always from the upload's own parse, never
		 *  a MusicBrainz citation, which would replace a real credit with a narrower primary-only one. */
		artistCredit?: string | null;
		title: string;
		album: string | null;
		year: number | null;
		genre: string[];
		language: string | null;
		durationSec: number;
	};
	/** Per-field provenance. A machine-parsed artist and a hand-corrected one are not equal evidence. */
	provenance: Partial<Record<'artist' | 'title' | 'album' | 'year' | 'genre', FieldProvenance>>;
	// Every field below is authoritative here — a DB wipe restores it without re-processing.
	artifacts: {
		audio: string | null;
		instrumental: string | null;
		vocals: string | null;
		/** GUIDE MIX: both stems in ONE 4-channel file (ch 0/1 instrumental, 2/3 vocals). Absent
		 *  (schema-6 and earlier) means the TV takes the legacy two-element path. */
		guideMix?: string | null;
		/** The CHOSEN lyrics ref (whichever candidate pickBestLyrics selected). */
		lyrics: string | null;
		/** Every lyrics artifact this song has, one per text source — what makes re-alignment possible
		 *  later without re-fetching audio. Absent on schema-1. */
		lyricsCandidates?: LyricsCandidate[];
		/** A human's explicit lyrics pick, by candidate `ref`. Absent means "no override" and
		 *  `chosenLyricsRef` falls through to the ranking. A stored ref that no longer names a
		 *  candidate is ignored on read, not honoured blindly. */
		lyricsOverrideRef?: string;
		/** The WORDS a human pasted, for a pin naming a candidate NOTHING has written yet — closes the
		 *  window between paste and re-time. Absent when the pin names a candidate already on disk. */
		lyricsOverrideText?: string;
		/** Key + vocal-range analysis (SongProfile). Absent (schema-2) means the analysis never ran;
		 *  an ALL-NULLS profile is a real, gate-satisfying result and is NOT the same as absent. */
		songProfile?: SongProfile;
	};
	library: {
		tags: string[];
		addedAt: number;
		playCount: number;
		lastPlayedAt: number | null;
	};
	/** The UNTOUCHED source metadata — kept so a better normalizer or MusicBrainz lookup can
	 *  re-derive canonical fields later without re-downloading. */
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

	// A manually-set or cited field always wins over a re-parse (never-regress, same rule
	// applyAnnotation enforces at runtime). A YouTube citation counts the same as MusicBrainz.
	const CITED = ['manual', 'musicbrainz', 'youtube'];
	const keepCited = (field: 'artist' | 'title') => CITED.includes(prev?.provenance?.[field]?.by ?? '');
	// Runtime annotation wins over a stored one: it is the fresher citation. Either citation source.
	const cited = m.annotation?.source === 'musicbrainz' || m.annotation?.source === 'youtube' ? m.annotation : undefined;
	// `by` records WHICH authority cited it, so a YouTube citation is never mislabelled as MusicBrainz.
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
			// Not subject to `cited`/`keepCited`: describes the UPLOAD's billing, which a recording-level
			// citation has no better answer for — preserved across writes so re-annotating doesn't lose it.
			artistCredit: parsed.artistFull ?? prev?.canonical.artistCredit ?? null,
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
		// Runtime value wins, else fall back to the prior write — an index-only hydrate carries none of
		// these refs, so falling back stops a rewrite from erasing an artifact already recorded.
		artifacts: {
			audio: prev?.artifacts.audio ?? null, // no field on Media at all — the worker owns it
			instrumental: m.instrumentalRef ?? prev?.artifacts.instrumental ?? null,
			vocals: m.vocalsRef ?? prev?.artifacts.vocals ?? null,
			guideMix: m.guideMixRef ?? prev?.artifacts.guideMix ?? null, // the mix IS the two stems, one file
			lyrics: m.lyricsRef ?? prev?.artifacts.lyrics ?? null,
			lyricsCandidates: m.lyricsCandidates ?? prev?.artifacts.lyricsCandidates,
			lyricsOverrideRef: m.lyricsOverrideRef ?? prev?.artifacts.lyricsOverrideRef,
			// Exception: the pasted text moves WITH the ref it belongs to — a ref pick clears the paste,
			// so falling back to the prior write here (unlike the rule above) would re-time a stale
			// paste over the newly picked candidate. Only a media with NO pin at all falls back.
			lyricsOverrideText: m.lyricsOverrideRef ? m.lyricsOverrideText : prev?.artifacts.lyricsOverrideText,
			songProfile: m.songProfile ?? prev?.artifacts.songProfile
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
	const processed = !!s.artifacts.instrumental;
	return {
		id: s.id,
		source: s.origin.source,
		sourceRef: s.origin.sourceRef,
		title: s.raw.rawTitle,
		artist: s.raw.uploader ?? undefined,
		durationSec: s.canonical.durationSec,
		thumbnail: s.raw.thumbnail ?? undefined,
		stemStatus: processed ? 'ready' : 'none',
		// DERIVED from the artifact, not stored — artifacts are the truth, status is a projection. The
		// one unrecoverable case, "align ran and found no words", self-heals via the boot lyrics
		// backfill (~18s) rather than storing a bit no file on disk could corroborate.
		lyricsStatus: s.artifacts.lyrics ? 'ready' : undefined,
		mbid: s.canonical.mbid ?? undefined,
		// Provenance is per-field; Media carries one summary, decided by artist (what browse groups by
		// and what the never-regress rule protects).
		annotation:
			s.provenance.artist && (s.provenance.artist.by === 'musicbrainz' || s.provenance.artist.confidence !== 'low')
				? {
						source:
							s.provenance.artist.by === 'musicbrainz'
								? 'musicbrainz'
								: s.provenance.artist.by === 'youtube'
									? 'youtube'
									: 'normalizer',
						confidence: s.provenance.artist.confidence === 'low' ? 'medium' : s.provenance.artist.confidence
					}
				: undefined,
		instrumentalRef: s.artifacts.instrumental ?? undefined,
		vocalsRef: s.artifacts.vocals ?? undefined,
		// A schema-6 sidecar has no mix, stays undefined → guidePath() returns the two-element path.
		guideMixRef: s.artifacts.guideMix ?? undefined,
		lyricsRef: chosenLyricsRef(s),
		lyricsCandidates: s.artifacts.lyricsCandidates,
		lyricsOverrideRef: s.artifacts.lyricsOverrideRef,
		lyricsOverrideText: s.artifacts.lyricsOverrideText,
		// Re-normalized on the way out even though authoritative, since an older writer or hand edit
		// may not match today's shape; a schema-2 sidecar has none, read as still-processing.
		songProfile: s.artifacts.songProfile ? normalizeSongProfile(s.artifacts.songProfile) : undefined,
		// Carried so a RESTORED media is immediately complete, ahead of the boot sync pass that mirrors these too.
		artistCanonical: browseArtist(s) ?? undefined,
		artistCredit: credit(s) ?? undefined,
		titleCanonical: lookupTitle(s) ?? undefined
	};
}

/**
 * Which lyrics artifact a restored song should show. A HUMAN OVERRIDE wins first; otherwise
 * RE-PICKS from the candidate set rather than trusting the stored `lyrics` pointer, so a ranking
 * change is corrected on restore instead of frozen in. Falls back to the stored pointer for
 * schema-1 records (no candidates). Shares `resolveLyricsRef` with `setMediaLyrics`, so a restore
 * and a live align completion can never disagree on which candidate a human's pick selects.
 */
export function chosenLyricsRef(s: MediaSidecar): string | undefined {
	return (
		resolveLyricsRef(s.artifacts.lyricsCandidates, s.artifacts.lyricsOverrideRef) ?? s.artifacts.lyrics ?? undefined
	);
}

/** The browse-safe canonical artist: null when we only guessed (see track-title.ts). */
export function browseArtist(s: MediaSidecar): string | null {
	const p = s.provenance.artist;
	if (!p || p.confidence === 'low') return null;
	return s.canonical.artist;
}

/**
 * The lookup-safe canonical title: null when we only guessed. Same gate as `browseArtist` — a
 * lyrics lookup on a guessed title returns nothing or, worse, ANOTHER SONG'S words, and confidently
 * wrong lyrics are worse than none. Callers fall back to the raw title: a miss, never a lie.
 */
export function lookupTitle(s: MediaSidecar): string | null {
	const p = s.provenance.title;
	if (!p || p.confidence === 'low') return null;
	return s.canonical.title;
}

/**
 * The lookup-safe FULL artist billing: null when the artist parse was only a guess. `artistCredit`
 * is otherwise stored UNGATED, but its consumer `LrclibSource.fetch` PREFERS credit over artist when
 * scoring a match — so an `uploader-fallback` song (artistCanonical correctly null) could still let
 * its ungated credit win a near-tie tiebreak on a guess. Gating credit the same way closes that.
 */
export function credit(s: MediaSidecar): string | null {
	const p = s.provenance.artist;
	if (!p || p.confidence === 'low') return null;
	return s.canonical.artistCredit ?? null;
}

// ── I/O ─────────────────────────────────────────────────────────────────────────────

function sidecarPath(mediaId: string): string {
	return join(metaDir(), `${mediaId}.json`);
}

/**
 * Is `parsed` structurally a sidecar we can safely project into `Media`? A partial record (the
 * shape a hand edit produces) must be caught HERE: `mediaFromSidecar` and the retention/browse-sync
 * passes dereference the section objects directly, so a missing section would otherwise throw deep
 * inside a boot maintenance pass. Anything short of every section present is corruption and takes
 * the warn-and-return-null path below, not a later throw.
 */
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

/**
 * Read one sidecar, or null if absent/unparseable. Never throws — a corrupt file must not brick
 * boot. Absent and corrupt both return null, but a MISSING sidecar is normal (an index-only song)
 * while one that EXISTS and fails to parse or fails the shape check means that song's source of
 * truth is gone — so only the existing-but-unreadable case logs a warning.
 */
export async function readSidecar(mediaId: string): Promise<MediaSidecar | null> {
	const path = sidecarPath(mediaId);
	let existed = false;
	try {
		const file = Bun.file(path);
		if (!(await file.exists())) return null;
		existed = true;
		const parsed = JSON.parse(await file.text()) as unknown;
		if (isWellFormedSidecar(parsed)) return parsed;
		// Valid JSON but not a WHOLE sidecar (e.g. a hand edit that kept only `id`) — still corruption
		// of the authoritative record, so treat it like a parse failure, not an absent file.
		console.warn(
			`[sidecar] authoritative record ${path} exists but failed the shape check (not a complete sidecar); returning null`
		);
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
 * `Bun.write(target,...)` truncates in place, so a crash/kill/ENOSPC mid-write would leave partial
 * JSON on the authoritative record — instead write a unique sibling temp file and rename it over the
 * target (atomic on POSIX), so a reader always sees either the old complete file or the new one.
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

/**
 * Null out a song's four derived-artifact fields on its authoritative record and rewrite it, so an
 * eviction actually STICKS. `sidecarFromMedia`'s `?? prev` merge is load-bearing for an index-only
 * hydrate, but that same fallback would let an eviction upsert (`instrumentalRef: undefined`) have
 * its just-deleted refs RESTORED from the prior sidecar — resurrecting an evicted song as processed
 * with refs to files no longer on disk. Rather than weaken the merge, eviction calls this instead.
 */
export async function clearArtifacts(mediaId: string): Promise<void> {
	const side = await readSidecar(mediaId);
	if (!side) return;
	side.artifacts = {
		...side.artifacts,
		instrumental: null,
		vocals: null,
		guideMix: null, // the mix IS the two stems being evicted, in one file — it goes with them
		lyrics: null,
		lyricsCandidates: []
	};
	await writeSidecar(side);
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
 * Rebuild the DB index (and runtime catalog) from the sidecars on disk — what makes the volume
 * portable. Anything in `meta/` but missing from the index is restored; rows the index already has
 * are LEFT ALONE, since a live runtime object may be referenced elsewhere and re-projecting it could
 * stomp state the DB knows and the sidecar does not (e.g. a process that finished microseconds ago).
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
 * The other direction: write a sidecar for every indexed media that lacks one, so self-describing
 * volume applies to pre-existing songs too, not just ones added after. One-shot, idempotent, cheap.
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
