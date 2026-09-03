// Make-karaoke request orchestrator — the entry point for "strip the vocals from this song."
// Marks the media as COOKING (stemStatus:queued) so rotation HOLDS its slot
// (isEntryReady returns false until stems are ready), then enqueues a stems job at the priority of
// the soonest queue entry that needs it. worker-hub flips the media to ready on completion.
// See MASTER-DESIGN §4, §6.

import type { Job, Media, QueueEntry, LyricsCandidate } from '@encore/shared';
import { mergeLyricsCandidate, pickBestLyrics, isQualityUpgrade, isPlayable } from '@encore/shared';
import type { JobRepository } from './repository';
import type { AuthoritativeState } from '../state/store';
import { instrumentalKey as layoutInstrumentalKey, toRelativeKey } from '../media/paths';

export interface MakeKaraokeDeps {
	jobs: JobRepository;
	mediaById: Map<string, Media>;
	state: AuthoritativeState;
	now: () => number;
}

// A media never queued yet still gets cooked, just at the back of the priority order.
const NO_QUEUE_PRIORITY = Number.MAX_SAFE_INTEGER;

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
	| 'cookable'; // nothing separated yet — go

export function cookState(mediaId: string, deps: Pick<MakeKaraokeDeps, 'mediaById' | 'state'>): CookState {
	const media = deps.mediaById.get(mediaId);
	if (!media) return 'unknown';
	const current = deps.state.entries.find((e) => e.id === deps.state.playback.currentEntryId);
	if (current && current.mediaId === mediaId) return 'playing';
	if (isCooked(media)) return 'ready';
	if (media.stemStatus === 'queued') return 'cooking';
	return 'cookable';
}

/**
 * Request stem-separation for a media. Idempotent: a repeat request (or two singers queueing the
 * same song) dedupes to the SAME job, and a song whose stems are ALREADY on disk (persisted across
 * restarts) is never re-cooked. Returns the job, or null when there is no work — unknown media, the
 * currently-playing song, or already cooked. Callers that need to tell those apart ask `cookState`.
 */
export function requestMakeKaraoke(mediaId: string, deps: MakeKaraokeDeps): Job | null {
	const media = deps.mediaById.get(mediaId);
	if (!media) return null;

	const state = cookState(mediaId, deps);
	if (state === 'playing') return null; // would disrupt the live song
	// Stems are already separated (this session or a previous one) — burning 1–2 min of GPU to
	// recompute an identical instrumental is the exact waste the durable catalog exists to prevent.
	if (state === 'ready') return null;

	// Mark it cooking → rotation holds its slot until the instrumental exists.
	media.stemStatus = 'queued';

	const priority = soonestSeqFor(mediaId, deps.state.entries);
	const job = deps.jobs.enqueue(mediaId, 'stems', priority, deps.now());
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
 * Attach the word-timed lyrics artifact (align output) to a media so the TV karaoke overlay can
 * fetch and highlight it. Additive and independent of the stems flip. Returns true if a usable ref
 * was set.
 *
 * The uri is NORMALIZED to a relative key: workers report absolute filesystem paths, and
 * `safeMediaPath` rejects any ref starting with "/", so storing the raw uri meant the overlay could
 * never fetch an artifact that existed on disk. `setMediaPitch` starved mic scoring the same way.
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
 * Attach the reference pitch-track artifact to a media so the server can score the live
 * mic against it. Additive and independent of the stems flip — a `score` job publishes it.
 * Returns true if the media existed and a usable ref was set. (Normalized — see setMediaLyrics.)
 */
export function setMediaPitch(mediaId: string, uri: string | undefined, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	const ref = toRelativeKey(uri);
	if (!media || !ref) return false;
	media.pitchRef = ref;
	return true;
}
