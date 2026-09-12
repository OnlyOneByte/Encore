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
import type { Media, LyricsCandidate } from '$shared';
import { resolveLyricsRef } from '$shared';
import type { SongProfile } from '$shared';
import { normalizeSongProfile } from '$shared';
import { metaDir } from './paths';
import { parseTrackTitle, type TrackParseRule } from './track-title';

/** Bump when the on-disk shape changes incompatibly. Readers tolerate older schemas. */
// 2: `artifacts.lyricsCandidates` added. `artifacts.lyrics` keeps its meaning (the CHOSEN ref), so a
// schema-1 record still reads correctly — it just has no provenance, reported as unknown not invented.
// 3: `artifacts.songProfile` added (key + vocal range). Purely additive: a schema-2 record simply has
// no profile, which mediaFromSidecar restores as absent — the stems gate then reads that song as
// still-cooking and the boot pipeline re-analyses it, exactly as an old song with no vocals ref did.
// 4: `artifacts.guideOffsetMs` added (the measured guide/instrumental offset). Purely additive: a
// schema-3 record has no offset, restored as absent, which the client's guideOffsetSec maps to 0 — so an
// un-upgraded song is held exactly as today until a re-cook measures one.
// 5: `artifacts.lyricsOverrideRef` added (a human's explicit lyrics pick). Purely additive: a
// schema-4 record has no override, so chosenLyricsRef falls through to the ranking exactly as before.
export const SIDECAR_SCHEMA = 5;

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
		/**
		 * The full artist billing as written ("Lady Gaga feat. Beyoncé"), where `artist` is the primary
		 * alone. Distinguishes two RECORDINGS of one song, which is why it is kept: a lyrics provider
		 * holds a record per version and the primary artist matches all of them equally.
		 *
		 * Always from the upload's own parse, never from a MusicBrainz citation — the annotator returns
		 * a primary artist, so letting a citation write here would replace a real credit with a
		 * narrower one.
		 */
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
		/**
		 * A human's explicit lyrics pick, by candidate `ref`. Authoritative here so the choice
		 * survives a DB wipe like every other derived fact. Optional/absent on schema-4 and earlier;
		 * absent means "no override" and `chosenLyricsRef` falls through to the ranking. A stored ref that
		 * no longer names a candidate is ignored on read, not honoured blindly.
		 */
		lyricsOverrideRef?: string;
		/**
		 * The key + vocal-range analysis (see SongProfile). Authoritative here so a DB wipe restores it
		 * without re-cooking — the durability claim the media layer makes for every derived artifact.
		 * Optional/absent on schema-2 records; an all-nulls profile is a real, gate-satisfying value and
		 * is NOT the same as absent (which means the analysis never ran).
		 */
		songProfile?: SongProfile;
		/**
		 * The MEASURED guide/instrumental offset in signed ms. Authoritative here so a DB wipe
		 * restores it without re-cooking, like every derived artifact. Optional/absent on schema-3 and
		 * earlier; absent means "never measured" (the client holds the guide as today), which is distinct
		 * from a stored 0 ("measured, aligned").
		 */
		guideOffsetMs?: number;
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
	// A YouTube citation counts the same as a MusicBrainz one: YouTube's OWN extracted metadata
	// is a declared credit, not a re-parse, so a later title parse must not clobber it either.
	const CITED = ['manual', 'musicbrainz', 'youtube'];
	const keepCited = (field: 'artist' | 'title') => CITED.includes(prev?.provenance?.[field]?.by ?? '');
	// Runtime annotation wins over a stored one: it is the fresher citation. Either citation source.
	const cited =
		m.annotation?.source === 'musicbrainz' || m.annotation?.source === 'youtube' ? m.annotation : undefined;
	// The provenance `by` records WHICH authority cited it, so a YouTube citation is not mislabelled as
	// MusicBrainz (they are not equal evidence, and `by` is what a later reader trusts).
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
			// Not subject to `cited`/`keepCited`: the credit describes the UPLOAD's billing, which a
			// recording-level citation has no better answer for. Preserved across writes so a
			// re-annotated song does not lose it.
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
		artifacts: {
			// audio has no field on Media (the worker owns it); preserve whatever a prior write knew.
			audio: prev?.artifacts.audio ?? null,
			instrumental: m.instrumentalRef ?? prev?.artifacts.instrumental ?? null,
			vocals: m.vocalsRef ?? prev?.artifacts.vocals ?? null,
			lyrics: m.lyricsRef ?? prev?.artifacts.lyrics ?? null,
			// Runtime first, else a prior write: an index-only hydrate leaves lyricsCandidates undefined,
			// and losing the set here would silently destroy the upgrade path the set exists for.
			lyricsCandidates: m.lyricsCandidates ?? prev?.artifacts.lyricsCandidates,
			// Same runtime-first / preserve-prior rule as lyricsCandidates: a human's pick must not be
			// erased by an index-only hydrate that carries no override on the Media.
			lyricsOverrideRef: m.lyricsOverrideRef ?? prev?.artifacts.lyricsOverrideRef,
			// Same runtime-first / preserve-prior rule as lyricsCandidates: an index-only hydrate that has
			// not read the sidecar yet carries no profile on the Media, so falling back to the prior
			// write is what stops a sidecar rewrite from erasing an already-recorded key/range.
			songProfile: m.songProfile ?? prev?.artifacts.songProfile,
			// Same runtime-first / preserve-prior rule, with `??` (never `||`) because a MEASURED 0 is a
			// real offset — an aligned stem — that `||` would discard as falsy and re-read from the prior
			// write. An index-only hydrate carries no offset on the Media, so falling back to prior is what
			// stops a sidecar rewrite from erasing an already-measured value.
			guideOffsetMs: m.guideOffsetMs ?? prev?.artifacts.guideOffsetMs
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
		// The sidecar is authoritative, so a song whose vocals artifact was recorded before the DB was
		// wiped gets its guiding track back here without a re-cook.
		vocalsRef: s.artifacts.vocals ?? undefined,
		lyricsRef: chosenLyricsRef(s),
		lyricsCandidates: s.artifacts.lyricsCandidates,
		// Carry the human override onto the runtime Media so the phone can show which pick is pinned and
		// whether a newer candidate now out-ranks it, and so a re-persist does not lose it.
		lyricsOverrideRef: s.artifacts.lyricsOverrideRef,
		// Restore the key/range so a wiped DB comes back with the analysis intact — no re-cook. The
		// stored value is authoritative but still untrusted (an older writer, a hand edit), so it is
		// re-normalized on the way out; a schema-2 sidecar has none and this stays undefined, which the
		// gate reads as still-cooking so the boot pipeline re-analyses it.
		songProfile: s.artifacts.songProfile ? normalizeSongProfile(s.artifacts.songProfile) : undefined,
		// A measured offset (including 0) round-trips; absent stays undefined → the client holds the guide
		// as today. `typeof … number` rather than truthiness so a stored 0 is not read back as absent.
		guideOffsetMs: typeof s.artifacts.guideOffsetMs === 'number' ? s.artifacts.guideOffsetMs : undefined,
		// Carry the confidence-gated canonicals so a RESTORED media is immediately complete. The boot
		// sync pass mirrors these into the index too, but an align job dispatched before it ran would
		// otherwise look up the raw title and miss.
		artistCanonical: browseArtist(s) ?? undefined,
		artistCredit: credit(s) ?? undefined,
		titleCanonical: lookupTitle(s) ?? undefined
	};
}

/**
 * Which lyrics artifact a restored song should show.
 *
 * A HUMAN OVERRIDE wins first: if `lyricsOverrideRef` names a candidate still in the set, it is
 * honoured over the ranking — the one thing that may show a lower-ranked candidate, because a person
 * outranks the heuristic. Otherwise RE-PICKS from the candidate set rather than trusting the stored
 * `lyrics` pointer, so a ranking change (or a candidate written by an older worker that mis-chose) is
 * corrected on the next restore instead of being frozen into the record. Falls back to the stored
 * pointer for schema-1 records, which have no candidates — those still work, they just carry no
 * provenance.
 *
 * Override-then-rank lives in the shared `resolveLyricsRef`, the SAME resolver `setMediaLyrics` uses, so
 * a restore and a live align completion can never disagree about which candidate a human's pick selects.
 */
export function chosenLyricsRef(s: MediaSidecar): string | undefined {
	return resolveLyricsRef(s.artifacts.lyricsCandidates, s.artifacts.lyricsOverrideRef) ?? s.artifacts.lyrics ?? undefined;
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

/**
 * The lookup-safe FULL artist billing ("Lady Gaga feat. Beyoncé"): null when the artist parse was
 * only a guess. Same confidence gate as `browseArtist`/`lookupTitle`, and here for a sharper reason
 *.
 *
 * `artistCredit` is stored UNGATED — it is the upload's raw billing and is preserved verbatim across
 * writes so a re-annotated song does not lose it. But its downstream consumer is the LRCLIB ranking:
 * `LrclibSource.fetch` scores a record with `credit = req.artist_credit or req.artist`, PREFERRING the
 * credit over the artist. For an `uploader-fallback` song `artistCanonical` is null (correctly gated)
 * so no artist key is sent, yet the ungated credit still rode along as `artistCredit` — the uploader
 * channel name — and the near-tie tiebreak scored against it. So the confidence gate was everywhere
 * the artist was read EXCEPT the one place a low-confidence value could still poison selection. This
 * closes it: a low-confidence artist contributes no credit either, matching the gate on the primary.
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
 * Is `parsed` structurally a sidecar we can safely project into `Media`? A string `id` alone is not
 * enough: `mediaFromSidecar` (via `rebuildIndexFromMeta`), the browse-sync pass (`s.canonical.genre`)
 * and the retention pass (`s.library.lastPlayedAt`) all dereference the SECTION objects directly, so a
 * partial record — the exact shape a hand edit produces, and hand-editing is the design — throws deep
 * inside a boot maintenance pass rather than here. Require every section `readSidecar`'s consumers
 * dereference to be a present object; anything short of that is corruption of the authoritative record
 * and must go down the warn-and-return-null path with the other malformed cases, not throw later.
 */
function isWellFormedSidecar(parsed: unknown): parsed is MediaSidecar {
	if (!parsed || typeof parsed !== 'object') return false;
	const s = parsed as Record<string, unknown>;
	if (typeof s.id !== 'string') return false;
	const isObject = (v: unknown) => !!v && typeof v === 'object';
	// The five sections mediaFromSidecar reads, plus `library` which the retention pass reads. `raw`
	// carries rawTitle (the title projected into Media); `provenance` is dereferenced for the artist
	// annotation. All are non-optional in MediaSidecar, so a real record always has them.
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
		const parsed = JSON.parse(await file.text()) as unknown;
		if (isWellFormedSidecar(parsed)) return parsed;
		// The file is there and is valid JSON, but not a WHOLE sidecar (wrong/empty/partial shape — e.g.
		// a hand edit that kept only `id`). Still corruption of the authoritative record: returning it
		// would let a boot maintenance pass throw on a missing section and, with no per-pass isolation,
		// abort every later pass. Treat it like a parse failure, not like an absent file.
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

/**
 * Null out a song's four derived-artifact fields on its authoritative record and rewrite it, so an
 * eviction actually STICKS.
 *
 * sidecarFromMedia intentionally does instrumental: m.instrumentalRef ?? prev?.artifacts.instrumental
 * (load-bearing for an index-only hydrate that carries no refs on the Media). But that same ?? prev
 * means an eviction upsert, which passes instrumentalRef = undefined, has its just-deleted refs
 * RESTORED from the prior sidecar, and mediaFromSidecar then re-derives stemStatus: ready,
 * resurrecting an evicted song as cooked with refs to files no longer on disk (violates ARCHITECTURE
 * section 6: a browse row must never resolve to a file that is not on disk).
 *
 * Rather than weaken ?? prev, the eviction path calls this to null the fields directly on the
 * authoritative record. A no-op if there is no sidecar yet.
 */
export async function clearArtifacts(mediaId: string): Promise<void> {
	const side = await readSidecar(mediaId);
	if (!side) return;
	side.artifacts = {
		...side.artifacts,
		instrumental: null,
		vocals: null,
		lyrics: null,
		lyricsCandidates: [],
		// The offset was measured FROM the stems being evicted, so it goes with them — a re-cook measures a
		// fresh one. Set undefined (not 0), the honest "no longer measured".
		guideOffsetMs: undefined
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
