// Make-karaoke request orchestrator — the entry point for "strip the vocals from this song."
// Marks the media as COOKING (stemStatus:queued) so rotation HOLDS its slot
// (isEntryReady returns false until stems are ready), then enqueues a stems job at the priority of
// the soonest queue entry that needs it. worker-hub flips the media to ready on completion.
// See MASTER-DESIGN §4, §6.

import type { Job, JobType, Media, QueueEntry, LyricsCandidate, GlobalSettings } from '@encore/shared';
import { mergeLyricsCandidate, pickBestLyrics, isQualityUpgrade, isPlayable, needsFetch, normalizeSongProfile } from '@encore/shared';
import type { JobRepository } from './repository';
import type { AuthoritativeState } from '../state/store';
import { instrumentalKey as layoutInstrumentalKey, toRelativeKey } from '../media/paths';

export interface MakeKaraokeDeps {
	jobs: JobRepository;
	mediaById: Map<string, Media>;
	state: AuthoritativeState;
	now: () => number;
	/** Optional so existing callers and tests keep working; absent means shared defaults. */
	getSettings?: () => GlobalSettings;
}

// A media never queued yet still gets cooked, just at the back of the priority order.
/**
 * Priority for a cook nobody is waiting on: sorts after every queued turn.
 *
 * Exported because two other places reason about it — `backfill.ts` deliberately reuses the value for
 * the lyrics backfill (both mean "nobody is waiting on this"), and the client's cook-and-queue rule
 * exists precisely to avoid a singer's cook being filed here.
 */
export const NO_QUEUE_PRIORITY = Number.MAX_SAFE_INTEGER;

/**
 * How many cooks ONE singer may have in flight at the same time.
 *
 * Not a lifetime quota — a guest whose earlier songs finished cooking can always start more; this
 * bounds only what is cooking RIGHT NOW. WHY it exists: `requestMakeKaraoke` dedups on
 * stems-existence alone, so nothing stopped one phone from tapping Sing down a whole search page and
 * enqueueing a 1–2 minute GPU job per distinct song — a self-inflicted denial of service that needs
 * no malice, just an impatient guest. Three is generous for a real singer (you queue a couple ahead)
 * while capping the fan-out a single guest can impose on a shared box's worker fleet.
 */
export const MAX_CONCURRENT_COOKS_PER_SINGER = 3;

/**
 * How many DISTINCT songs this singer currently has cooking — the bound FIX 2 enforces.
 *
 * A cook is attributed to a singer through the JOB LEDGER — the thing actually being bounded — not
 * through their queue entries. WHY THIS CHANGED: the queue entry (WebSocket) and the cook (HTTP) ride
 * different transports and only the entry is droppable. A phone that taps Sing while its socket is
 * reconnecting buffers the add client-side but the cook POST still lands, so an entry-derived count
 * saw ZERO in-flight cooks and admitted every tap — a guest could bypass the cap entirely by tapping
 * during any reconnect window (first connect, every backoff redial, mobile freeze/resume). The
 * repository attributes each cook to its requester at enqueue and counts distinct cooking media from
 * the ledger, which does not depend on the second transport. `exclude` drops the media being
 * requested so a re-tap of a song already cooking is never counted against its own owner.
 */
export function countInFlightCooks(
	singerId: string,
	deps: Pick<MakeKaraokeDeps, 'jobs' | 'mediaById'>,
	exclude?: string
): number {
	const cooking = new Set<string>();
	for (const mediaId of deps.jobs.liveCookMediaForSinger(singerId)) {
		if (mediaId === exclude) continue;
		const media = deps.mediaById.get(mediaId);
		// A finished cook no longer costs the worker fleet — drop it, mirroring the old !isCooked rule.
		// (In production the stems job reaching `ready` and the media flipping ready coincide, so the
		// ledger filter above usually suffices; this keeps the count honest if they briefly diverge.)
		if (media && isCooked(media)) continue;
		cooking.add(mediaId);
	}
	return cooking.size;
}

/**
 * The deterministic MediaStore key for a media's instrumental stem (stored on Media.instrumentalRef).
 * MUST match the worker's output location (apps/worker/src/processor.py instrumental_path →
 * <media_dir>/derived/stems/<mediaId>-instrumental.wav), since the TV file player resolves
 * `/media/${playbackRef(media)}`. Defined once in ../media/paths.ts; do NOT hand-write this string.
 */
export const instrumentalKey = layoutInstrumentalKey;

/** The soonest (lowest) rotationSeq among queued entries that point at this media; ∞ if none. */
export function soonestSeqFor(mediaId: string, entries: QueueEntry[]): number {
	let min = NO_QUEUE_PRIORITY;
	for (const e of entries) {
		if (e.mediaId === mediaId && e.status === 'queued' && e.rotationSeq < min) min = e.rotationSeq;
	}
	return min;
}

/**
 * Whether a media already has separated stems on disk — the dedupe predicate. A media in this
 * state needs NO worker job: re-queueing it plays the existing instrumental immediately.
 */
export function isCooked(media: Media): boolean {
	return isPlayable(media);
}

/**
 * Why a make-karaoke request can (or can't) proceed. Lets the route answer honestly: an
 * already-cooked song is a SUCCESS ("nothing to do, it's ready"), not an error — which matters once
 * the catalog is durable, since every song cooked on a previous night lands here.
 */
export type CookState =
	| 'unknown' // not in the catalog
	| 'playing' // the live song; cooking it would yank the video out from under the room
	| 'ready' // stems already separated (persisted from an earlier session) — no re-cook
	| 'cooking' // a live job is already working on it; a repeat request dedupes to that job
	| 'over-limit' // this singer already has MAX_CONCURRENT_COOKS_PER_SINGER cooks in flight
	| 'cookable'; // nothing separated yet — go

export function cookState(
	mediaId: string,
	deps: Pick<MakeKaraokeDeps, 'mediaById' | 'state' | 'jobs'>,
	singerId?: string
): CookState {
	const media = deps.mediaById.get(mediaId);
	if (!media) return 'unknown';
	const current = deps.state.entries.find((e) => e.id === deps.state.playback.currentEntryId);
	if (current && current.mediaId === mediaId) return 'playing';
	if (isCooked(media)) return 'ready';
	if (media.stemStatus === 'queued') return 'cooking';
	// A NEW cook (nothing separated, not already cooking) is refused when this singer is already at
	// their in-flight cap. Checked LAST — an already-cooking or ready song is never blocked, since it
	// starts no new work. Only evaluated when a singer is named; the anonymous internal callers
	// (backfill, tests) impose no cap.
	if (singerId && countInFlightCooks(singerId, deps, mediaId) >= MAX_CONCURRENT_COOKS_PER_SINGER) {
		return 'over-limit';
	}
	return 'cookable';
}

/**
 * Request stem-separation for a media. Idempotent: a repeat request (or two singers queueing the
 * same song) dedupes to the SAME job, and a song whose stems are ALREADY on disk (persisted across
 * restarts) is never re-cooked. Returns the job, or null when there is no work — unknown media, the
 * currently-playing song, already cooked, OR the requesting singer is already at their in-flight cook
 * cap. Callers that need to tell those apart ask `cookState` (pass the same `singerId`).
 */
export function requestMakeKaraoke(mediaId: string, deps: MakeKaraokeDeps, singerId?: string): Job | null {
	const media = deps.mediaById.get(mediaId);
	if (!media) return null;

	const state = cookState(mediaId, deps, singerId);
	if (state === 'playing') return null; // would disrupt the live song
	// Stems are already separated (this session or a previous one) — burning 1–2 min of GPU to
	// recompute an identical instrumental is the exact waste the durable catalog exists to prevent.
	if (state === 'ready') return null;
	// This singer already has too many cooks in flight — refuse the new one rather than let one guest
	// flood the worker fleet. An already-cooking song (state === 'cooking') is NOT blocked here: it
	// starts no new work, so it falls through to the dedup below.
	if (state === 'over-limit') return null;

	// Mark it cooking → rotation holds its slot until the instrumental exists.
	media.stemStatus = 'queued';

	const priority = soonestSeqFor(mediaId, deps.state.entries);
	// Start at ACQUISITION when the bytes are not here yet; `fetch` chains to `stems` (see followUps).
	// A local file skips straight to separation — there is nothing to download, and enqueueing a fetch
	// for it would need a worker capability no fetcher advertises.
	const first: JobType = needsFetch(media.source, deps.getSettings?.()?.defaultFetcher) ? 'fetch' : 'stems';
	// Attribute this cook to its requester so the per-singer cap counts it from the ledger even when
	// the singer's queue add was dropped over a reconnecting socket (the bypass this fix closes).
	const job = deps.jobs.enqueue(mediaId, first, priority, deps.now(), undefined, singerId);
	// The dedup index treats a `ready` job as live, so enqueue can hand back a COMPLETED job (the
	// stems exist, but this media object lost its ready flags — e.g. a runtime catalog entry that
	// was rebuilt from a stub). Leaving the media `queued` against a job that will never run again
	// deadlocks rotation: the entry is held forever and the song silently never plays. Reconcile the
	// media to the job instead.
	if (job.status === 'ready') markMediaReady(mediaId, deps.mediaById);
	return job;
}

/**
 * Flip a media to READY after its stems job completes: record the instrumental key and mark stems
 * ready, so rotation's isEntryReady unblocks the held entry and the TV file player serves the backing
 * track. `sourceRef` is deliberately LEFT ALONE — it is the song's origin identity, and overwriting
 * it (as this used to) made the next search fail to recognise the song and mint a second, uncooked
 * row. Returns true if the media existed and was flipped. (worker-hub calls this.)
 */
export function markMediaReady(
	mediaId: string,
	mediaById: Map<string, Media>,
	reportedUri?: string,
	separator?: { engine: string; model: string }
): boolean {
	const media = mediaById.get(mediaId);
	if (!media) return false;

	// An UPGRADE must never publish a worse instrumental than the one already there. A plain cook
	// (no separator reported, or nothing published yet) always applies; a ranked candidate applies
	// only when it beats what is current.
	if (separator && media.instrumentalRef && !isQualityUpgrade(media.separator, separator)) {
		return false;
	}

	// Prefer what the worker ACTUALLY wrote over re-deriving the key. The two must agree, but the
	// worker owns the container format, and trusting its report means a future format change cannot
	// desync the ref from the file and 404 the TV.
	media.instrumentalRef = toRelativeKey(reportedUri) ?? instrumentalKey(mediaId);
	media.stemStatus = 'ready';
	if (separator) media.separator = separator;
	return true;
}

/**
 * Mark the lyrics gate SETTLED for this media — align has run, whatever it found.
 *
 * "Settled", not "succeeded". `ready` here means the step is finished, and a song with no words is a
 * legitimate finished song: requiring a lyrics artifact would leave every genuine instrumental stuck
 * cooking forever on a step that worked correctly. See packages/shared/src/gates.ts.
 */
export function settleLyricsGate(mediaId: string, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	if (!media) return false;
	media.lyricsStatus = 'ready';
	return true;
}

/**
 * Settle the STEMS side after a separation has permanently failed: put the song back to un-cooked.
 *
 * The twin of `settleLyricsGate`, and it was missing. A terminal stems failure left `stemStatus` at
 * whatever it was mid-flight, and `isCooking` reads `stemStatus === 'queued'` — so the song read as
 * cooking FOREVER on every surface, the phone row sat at "Making karaoke… 0%" with no way out, and
 * `cookState` answered 'cooking' and refused to re-cook it. One worker OOM made a song permanently
 * un-singable and un-retryable, which is exactly the trap the align branch above describes.
 *
 * Back to 'none' rather than a 'failed' status because that is the truth: nothing was separated, so
 * the song is a fresh candidate. The guest gets the Sing button back and the failure itself is
 * carried to the phone by the `media:status` event, which is ephemeral by design — the row should
 * say WHY it reverted, not wear a permanent scar.
 */
export function settleStemsGate(mediaId: string, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	if (!media || media.stemStatus === 'ready') return false; // never walk a finished cook backwards
	media.stemStatus = 'none';
	return true;
}

/** Mark the lyrics gate as IN FLIGHT, so the phone can name the step a song is waiting on. */
export function markLyricsQueued(mediaId: string, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	if (!media || media.lyricsStatus === 'ready') return false; // never walk a settled gate backwards
	media.lyricsStatus = 'queued';
	return true;
}

/**
 * Apply a `fetch` job's MusicBrainz annotation, or refuse.
 *
 * NEVER REGRESSES. A `high` annotation carries an MBID and a duration that corroborated it; a `medium`
 * is a plausible identification nothing confirmed. Once a media holds a `high` citation, a later
 * `medium` must not overwrite it — a re-fetch, a re-cook, or a backfill would otherwise be able to
 * downgrade a known-good artist into a guess, and the field that suffers is the one the LRCLIB query
 * matches on.
 *
 * A normalizer-derived value is always overwritable: it is a title parse, not a citation.
 *
 * Writes the canonical fields as well as the MBID, because being able to cite the song is only useful
 * if the names that come with it are the ones downstream reads.
 */
export function applyAnnotation(
	mediaId: string,
	mediaById: Map<string, Media>,
	annotation?: { source?: string; mbid?: string; artist?: string; title?: string; confidence?: string }
): boolean {
	const media = mediaById.get(mediaId);
	if (!media || !annotation?.mbid || !annotation.artist || !annotation.title) return false;
	const confidence = annotation.confidence === 'high' ? 'high' : 'medium';

	// Refuse a downgrade of an existing citation. Same rank comparison in spirit as the separator
	// upgrade gate: a candidate has to be at least as good as what is already published.
	const current = media.annotation;
	if (current?.source === 'musicbrainz' && current.confidence === 'high' && confidence !== 'high') {
		return false;
	}

	media.mbid = annotation.mbid;
	media.artistCanonical = annotation.artist;
	media.titleCanonical = annotation.title;
	media.annotation = { source: 'musicbrainz', confidence };
	return true;
}

/**
 * Attach the word-timed lyrics artifact (align output) to a media so the TV karaoke overlay can
 * fetch and highlight it. Additive and independent of the stems flip. Returns true if a usable ref
 * was set.
 *
 * The uri is NORMALIZED to a relative key: workers report absolute filesystem paths, and
 * `safeMediaPath` rejects any ref starting with "/", so storing the raw uri meant the overlay could
 * never fetch an artifact that existed on disk.
 */
export function setMediaLyrics(
	mediaId: string,
	uri: string | undefined,
	mediaById: Map<string, Media>,
	candidates?: LyricsCandidate[]
): boolean {
	const media = mediaById.get(mediaId);
	if (!media) return false;

	// An align job reports EVERY artifact it produced, one per text source. Merge into the stored set
	// and let pickBestLyrics choose — never "last write wins", which would let a later line-level
	// source silently replace existing word timings.
	if (candidates?.length) {
		let merged = media.lyricsCandidates ?? [];
		for (const c of candidates) {
			const ref = toRelativeKey(c.ref);
			if (!ref) continue; // workers report absolute paths; safeMediaPath rejects those
			merged = mergeLyricsCandidate(merged, { ...c, ref });
		}
		media.lyricsCandidates = merged;
		const best = pickBestLyrics(merged);
		// Only move the pointer if something is actually showable; a set of unusable candidates must not
		// clear a working lyricsRef.
		if (best) {
			media.lyricsRef = best.ref;
			return true;
		}
	}

	// No candidates (an older worker, or a job that only reported `uri`) → the legacy single-ref path.
	const ref = toRelativeKey(uri);
	if (!ref) return false;
	media.lyricsRef = ref;
	return true;
}

/**
 * Attach the isolated VOCALS stem — the guiding track. Additive and independent of the stems flip:
 * a separation reports both stems, and a song is perfectly playable with only the instrumental.
 *
 * Trusts what the worker reported, like markMediaReady does, because the worker owns the container
 * format and re-deriving the key here would desync the ref from the file after any format change. It
 * also owns the CONTENT check: a worker that measured its own vocals stem as silence omits it from
 * the artifact entirely, so an absent ref is a real answer rather than a missing one. The core's own
 * loudness probe (media/loudness.ts) exists for the other direction — already-cooked songs being
 * backfilled, where no worker will run again.
 */
export function setMediaVocals(mediaId: string, uri: string | undefined, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	const ref = toRelativeKey(uri);
	if (!media || !ref) return false;
	media.vocalsRef = ref;
	return true;
}

/**
 * Attach the SONG PROFILE — the key + vocal-range analysis a stems job produces alongside the two
 * stems. Additive and independent of the instrumental flip, like setMediaVocals.
 *
 * TWO things differ from setMediaVocals, and both are load-bearing:
 *
 *  1. It ALWAYS WRITES once the stems job completes, even when the worker reported nothing. A vocals
 *     ref is dropped when absent because a song is fine with no guide; a profile is not, because its
 *     PRESENCE is half the stems cook gate (gates.ts). `undefined`/garbage in normalizes to
 *     EMPTY_SONG_PROFILE (all inner fields null) rather than leaving the field unset — that all-nulls
 *     record is the honest "analysis ran, found nothing" answer that lets a silent-vocal song finish
 *     cooking instead of hanging on "Separating vocals" forever with no way out (the re-cook check
 *     reads hasInstrumental, not the gate, so a data-requiring gate would never re-cook it either).
 *
 *  2. It normalizes at THIS boundary. The value is untrusted wire data off a worker `complete` frame;
 *     normalizeSongProfile validates each field independently and degrades a bad half to null rather
 *     than rejecting the whole record, so a garbage key cannot throw away a good measured range.
 *
 * Always returns true when the media exists — there is no "no usable value" outcome, since an empty
 * profile is itself a valid, gate-satisfying result.
 */
export function setMediaSongProfile(mediaId: string, profile: unknown, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	if (!media) return false;
	media.songProfile = normalizeSongProfile(profile);
	return true;
}
