// Marks a media PROCESSING so rotation HOLDS its slot until stems exist. See docs/ARCHITECTURE.md §6, §7.

import type { Job, JobType, Media, QueueEntry, GlobalSettings } from '../../contract';
import {
	mergeLyricsCandidate,
	parseLyricsCandidates,
	resolveLyricsRef,
	isTerminalJob,
	isQualityUpgrade,
	isPlayable,
	isProcessableSource,
	needsFetch,
	normalizeSongProfile,
	DEFAULT_GLOBAL_SETTINGS,
	PROCESSES_UNCAPPED
} from '../../contract';
import type { JobRepository } from './repository';
import type { AuthoritativeState } from '../state/store';
import { instrumentalKey as layoutInstrumentalKey, toRelativeKey, keptOriginalRef } from '../media/paths';
import { mediaStatusFor, shouldBroadcastProcess } from './media-status';
import { cleanJobWork } from '../media/migrate-layout';
import type { ServerEvent } from '../../contract';

export interface ProcessDeps {
	jobs: JobRepository;
	mediaById: Map<string, Media>;
	state: AuthoritativeState;
	now: () => number;
	/** Must be threaded to BOTH `processState` and `requestProcess` — see docs/SERVER.md#idempotency-and-the-process-cap. */
	getSettings?: () => GlobalSettings;
	/** Whether the instrumental is in the media store. Omitted means "trust the status". */
	stemsOnDisk?: (ref: string) => boolean;
}

/** Sorts after every queued turn; `backfill.ts` reuses this exact value as BACKFILL_PRIORITY. */
export const NO_QUEUE_PRIORITY = Number.MAX_SAFE_INTEGER;

/** A missing `getSettings` resolves to the shipped DEFAULT, never "uncapped": omitting the dependency must not bypass the bound. */
export function maxProcessesPerSinger(deps: Pick<ProcessDeps, 'getSettings'>): number {
	const configured = deps.getSettings?.().maxProcessesPerSinger;
	return typeof configured === 'number' ? configured : DEFAULT_GLOBAL_SETTINGS.maxProcessesPerSinger;
}

/** Counted from the JOB LEDGER, never from queue entries — see docs/SERVER.md#idempotency-and-the-process-cap.
 *  `exclude` drops the media being requested, so a re-tap is not counted against itself. */
export function countInFlightProcesses(
	singerId: string,
	deps: Pick<ProcessDeps, 'jobs' | 'mediaById'>,
	exclude?: string
): number {
	const processing = new Set<string>();
	for (const mediaId of deps.jobs.liveProcessMediaForSinger(singerId)) {
		if (mediaId === exclude) continue;
		const media = deps.mediaById.get(mediaId);
		// Keeps the count honest if the ledger filter and the media's ready flip briefly diverge.
		if (media && isProcessed(media)) continue;
		processing.add(mediaId);
	}
	return processing.size;
}

/** MUST match the worker's published instrumental key (worker/encore_worker/artifacts/keys.py) or the TV 404s. Never hand-write this string. */
export const instrumentalKey = layoutInstrumentalKey;

/** The soonest (lowest) rotationSeq among queued entries that point at this media; ∞ if none. */
export function soonestSeqFor(mediaId: string, entries: QueueEntry[]): number {
	let min = NO_QUEUE_PRIORITY;
	for (const e of entries) {
		if (e.mediaId === mediaId && e.status === 'queued' && e.rotationSeq < min) min = e.rotationSeq;
	}
	return min;
}

/** Whether a media already has separated stems on disk — the dedupe predicate; needs NO worker job. */
export function isProcessed(media: Media): boolean {
	return isPlayable(media);
}

/** A ready status or a finished stems job: the song says its stems exist. */
export function claimsStems(media: Media, jobs: Pick<JobRepository, 'findLive'>): boolean {
	return isProcessed(media) || jobs.findLive(media.id, 'stems')?.status === 'ready';
}

/** The stems ref a claiming song names: the stored ref, else the default key. */
export function claimedStemsRef(media: Media): string {
	return media.instrumentalRef ?? instrumentalKey(media.id);
}

/** A ready status, or a finished stems job, whose instrumental file is gone (evicted, deleted by hand). */
export function stemsMissing(media: Media, deps: Pick<ProcessDeps, 'jobs' | 'stemsOnDisk'>): boolean {
	if (!deps.stemsOnDisk) return false;
	return claimsStems(media, deps.jobs) && !deps.stemsOnDisk(claimedStemsRef(media));
}

/** Resets a song to not-made. The finished jobs must go too: they hold the dedup slot, so the next pick
 *  would get the old `ready` stems job back and mark the deleted stems ready again. */
export function forgetProcess(media: Media, jobs: Pick<JobRepository, 'supersedeForRerun'>): void {
	media.instrumentalRef = undefined;
	media.vocalsRef = undefined;
	media.guideMixRef = undefined;
	media.lyricsRef = undefined;
	media.lyricsCandidates = [];
	media.lyricsStatus = undefined;
	media.stemStatus = 'none';
	for (const t of ['stems', 'stems-upgrade', 'align'] as const) jobs.supersedeForRerun(media.id, t);
}

/** Lets the route answer honestly: an already-processed song is a SUCCESS, not an error. */
export type ProcessState =
	| 'unknown' // not in the catalog
	| 'not-processable' // metadata-only source: no fetcher can pull its bytes, so it never can be
	| 'playing' // processing the live song would yank the video out from under the room
	| 'ready' // stems already separated — no re-process
	| 'processing' // a live job has it; a repeat request dedupes to that job
	| 'over-limit' // at `GlobalSettings.maxProcessesPerSinger`
	| 'processable';

export function processState(
	mediaId: string,
	deps: Pick<ProcessDeps, 'mediaById' | 'state' | 'jobs' | 'getSettings' | 'stemsOnDisk'>,
	singerId?: string
): ProcessState {
	const media = deps.mediaById.get(mediaId);
	if (!media) return 'unknown';
	// The arm ORDER is load-bearing (docs/SERVER.md#idempotency-and-the-process-cap): a metadata-only
	// source can never LEAVE this state, so it is decided ahead of the transient ones.
	if (!isProcessableSource(media.source)) return 'not-processable';
	const current = deps.state.entries.find((e) => e.id === deps.state.playback.currentEntryId);
	if (current && current.mediaId === mediaId) return 'playing';
	if (isProcessed(media) && !stemsMissing(media, deps)) return 'ready';
	if (media.stemStatus === 'queued') return 'processing';
	// `cap !== PROCESSES_UNCAPPED` MUST be tested before `count >= cap`: `0` means uncapped, and a bare
	// `count >= 0` is true for everyone, so turning the cap off would instead refuse every first request.
	const cap = maxProcessesPerSinger(deps);
	if (singerId && cap !== PROCESSES_UNCAPPED && countInFlightProcesses(singerId, deps, mediaId) >= cap) {
		return 'over-limit';
	}
	return 'processable';
}

/**
 * Idempotent: a repeat request, or two singers queueing one song, dedupes to the SAME job. Returns the job,
 * or null when there is no work — unknown media, a metadata-only source, the currently-playing song, already
 * processed, or the singer's in-flight cap. `processState` with the same `singerId` tells those apart.
 */
export function requestProcess(mediaId: string, deps: ProcessDeps, singerId?: string): Job | null {
	const media = deps.mediaById.get(mediaId);
	if (!media) return null;

	// Refused off the STATE, never off `media.source`, so every refusal is visible to `processState` too.
	// `processing` deliberately falls through to the dedup below.
	const state = processState(mediaId, deps, singerId);
	if (state === 'not-processable') return null;
	if (state === 'playing') return null;
	if (state === 'ready') return null;
	if (state === 'over-limit') return null;

	if (stemsMissing(media, deps)) forgetProcess(media, deps.jobs);
	media.stemStatus = 'queued'; // rotation holds this slot until the instrumental exists
	const priority = soonestSeqFor(mediaId, deps.state.entries);
	// The fetch step already ran, so the next step is stems: Try again after a failed separation starts there. (Stems
	// reads the fetch's kept file, or the watch URL once that was evicted.) Enqueueing `fetch` again handed back
	// that finished job: no stems job was made, and the line below marked the song ready.
	const fetched = deps.jobs.findLive(mediaId, 'fetch')?.status === 'ready';
	const first: JobType = needsFetch(media.source, deps.getSettings?.()?.defaultFetcher) && !fetched ? 'fetch' : 'stems';
	const job = deps.jobs.enqueue(mediaId, first, priority, deps.now(), undefined, singerId);
	// A `ready` job still occupies the dedup slot, so enqueue can hand one back for a media whose ready flags
	// were lost — and leaving that `queued` against a job that will never run again deadlocks rotation.
	if (job.status === 'ready') markMediaReady(mediaId, deps.mediaById);
	return job;
}

/** Why a lyrics re-select could not start — the honest refusal the endpoint maps to a status code. */
export type ReselectRefusal =
	| 'unknown-media'
	| 'not-processed' // the vocals stem does not exist yet, so there is nothing to re-time against
	| 'unknown-candidate' // a pick that names a ref not in the stored set
	| 'no-text'; // a paste with no usable words

export interface ReselectResult {
	job: Job;
	/** An existing candidate's ref, or the minted manual ref. */
	ref: string;
}

/** The idempotency key for a pasted candidate: a repeat paste OVERWRITES rather than stacking, and the
 *  worker derives this same key from `pinnedRef`. */
export function manualLyricsRef(mediaId: string): string {
	return `derived/lyrics/${mediaId}-manual-word.json`;
}

/**
 * A HUMAN RE-PICK, then a re-time. The pinned `lyricsOverrideRef` OUTRANKS `pickBestLyrics` everywhere.
 *
 * ORDER IS LOAD-BEARING: a finished `align` is terminal `ready` and still holds the dedup slot, so the slot
 * must be freed BEFORE the enqueue, or the caller gets the OLD job back and nothing re-runs.
 */
export function requestLyricsReselect(
	mediaId: string,
	choice: { ref?: string; text?: string },
	deps: Pick<ProcessDeps, 'jobs' | 'mediaById' | 'state' | 'now'>,
	singerId?: string
): ReselectResult | ReselectRefusal {
	const media = deps.mediaById.get(mediaId);
	if (!media) return 'unknown-media';
	// The aligner runs over the retained VOCALS stem; without one there is nothing to align against.
	if (!media.vocalsRef) return 'not-processed';

	const pasted = typeof choice.text === 'string' ? choice.text.trim() : '';
	let ref: string;
	if (pasted) {
		ref = manualLyricsRef(mediaId);
	} else {
		const picked = typeof choice.ref === 'string' ? choice.ref : '';
		// Whitespace-only paste is `no-text`, not `unknown-candidate` — the caller named the paste shape.
		if (!picked && typeof choice.text === 'string') return 'no-text';
		// Pasting is the only way to introduce a NEW ref; an unresolvable pick blanks the overlay.
		if (!picked || !(media.lyricsCandidates ?? []).some((c) => c.ref === picked)) return 'unknown-candidate';
		ref = picked;
	}

	media.lyricsOverrideRef = ref; // pinned BEFORE enqueue so dispatch.assignParams reads it onto align
	// On the media, not the job, so it survives a restart's requeue. MUST be cleared on a ref pick: a
	// leftover paste outranks `pinnedRef` in the worker and re-times over the human's choice.
	media.lyricsOverrideText = pasted || undefined;

	const priority = soonestSeqFor(mediaId, deps.state.entries);
	const now = deps.now();
	const live = deps.jobs.findLive(mediaId, 'align');
	if (live && !isTerminalJob(live.status)) deps.jobs.cancel(live.id, now);
	else deps.jobs.supersedeForRerun(mediaId, 'align');
	const job = deps.jobs.enqueue(mediaId, 'align', priority, now, undefined, singerId);
	// Direct, NOT markLyricsQueued, which refuses to walk a settled gate backwards: a re-pick is the one
	// case where reopening a finished lyrics gate is correct.
	media.lyricsStatus = 'queued';
	return { job, ref };
}

/** `sourceRef` is deliberately LEFT ALONE: it is the song's origin identity, and overwriting it makes the
 *  next search miss the song and mint a second, unprocessed row. */
export function markMediaReady(
	mediaId: string,
	mediaById: Map<string, Media>,
	reportedUri?: string,
	separator?: { engine: string; model: string }
): boolean {
	const media = mediaById.get(mediaId);
	if (!media) return false;

	// An UPGRADE must never publish a worse instrumental than the one already there.
	if (separator && media.instrumentalRef && !isQualityUpgrade(media.separator, separator)) {
		return false;
	}

	// What the worker ACTUALLY wrote beats re-deriving: a container change would desync ref from file.
	media.instrumentalRef = toRelativeKey(reportedUri) ?? instrumentalKey(mediaId);
	media.stemStatus = 'ready';
	if (separator) media.separator = separator;
	return true;
}

/** SETTLED, not "succeeded": requiring a lyrics artifact would leave every genuine instrumental stuck
 *  processing on a step that worked correctly. */
export function settleLyricsGate(mediaId: string, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	if (!media) return false;
	media.lyricsStatus = 'ready';
	return true;
}

/** Without this `stemStatus` stays mid-flight and `processState` reads the song as processing FOREVER,
 *  refusing a re-process. 'none' not 'failed': nothing was separated, so it is a fresh candidate. */
export function settleStemsGate(mediaId: string, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	if (!media || media.stemStatus === 'ready') return false; // never walk a finished process backwards
	media.stemStatus = 'none';
	return true;
}

/** A TABLE, not if/else, because two callers read it from opposite directions and must not drift (see
 *  docs/SERVER.md#idempotency-and-the-process-cap). `stems-upgrade` is in no `settledBy` list. */
export interface GateSettlement {
	/** Matches `ProcessGate.id` in `GATES`, so a log line reads the same on both sides. */
	readonly id: 'stems' | 'lyrics';
	/** Job types whose completion or failure is what moves this gate. */
	readonly settledBy: readonly JobType[];
	/** Only the explicit `'queued'` marker counts: a NULL status means "predates the gate" or "never
	 *  started", and settling either forges a step that never ran. */
	readonly inFlight: (m: Media) => boolean;
	/** How the gate settles when nothing will ever finish it. */
	readonly settle: (mediaId: string, mediaById: Map<string, Media>) => boolean;
}

export const GATE_SETTLEMENT: readonly GateSettlement[] = [
	{
		id: 'stems',
		// `fetch` counts: the media is marked processing BEFORE the download, so a song mid-fetch has a
		// legitimately in-flight stems gate and no stems job yet.
		settledBy: ['fetch', 'stems'],
		inFlight: (m) => m.stemStatus === 'queued',
		settle: settleStemsGate
	},
	{
		id: 'lyrics',
		settledBy: ['align'],
		inFlight: (m) => m.lyricsStatus === 'queued',
		settle: settleLyricsGate
	}
] as const;

/** Narrower than `Job`, so boot reconciliation can ask about a gate stranded by a row that is GONE. */
export type SettleableJob = Pick<Job, 'mediaId' | 'jobType'>;

/** All three death paths (`job:failed`, the unservable TTL, the reaper) MUST route through here, or a
 *  killed process leaves its gate mid-flight forever and `readyToSing` never flips. */
export function settleGatesForFailedJob(job: SettleableJob, mediaById: Map<string, Media>): boolean {
	const gate = GATE_SETTLEMENT.find((g) => g.settledBy.includes(job.jobType));
	return gate ? gate.settle(job.mediaId, mediaById) : false; // no gate: stems-upgrade keeps its instrumental
}

/** `worker` = job:failed with retries exhausted; `unservable` = no worker advertised the capability in
 *  the TTL; `reaper` = a lease expired with attempts exhausted and no worker involved. */
export type TerminalFailureCause = 'worker' | 'unservable' | 'reaper';

export interface TerminalFailureDeps {
	/** The room sink. Injected because process cannot reach worker-hub's private #emitStatus. */
	broadcast: (event: ServerEvent) => void;
	mediaById: Map<string, Media>;
	/** Optional in the type, REQUIRED for durability: the settle only mutates in-memory `Media`, while
	 *  `hydrateMediaCatalog` wins at boot off the stored columns — skip it and a restart resurrects the
	 *  stranding, with nothing a user can do to clear it. */
	persist?: (mediaId: string) => void;
}

/** One place, so all three death paths settle identically: settle the gate, broadcast `media:status`, log
 *  one uniform line, reclaim the scratch. `job` is already terminal. */
export function reportTerminalFailure(job: Job, cause: TerminalFailureCause, deps: TerminalFailureDeps): boolean {
	const settled = settleGatesForFailedJob(job, deps.mediaById);
	// BEFORE the broadcast, so the room is never told 'failed' while the durable row says 'processing'.
	// Gated on `settled`, because a stems-upgrade failure settles nothing to flush.
	if (settled) deps.persist?.(job.mediaId);
	const media = deps.mediaById.get(job.mediaId);
	// Gated: a dead `stems-upgrade` must not flip an already-singable row back to "Making karaoke".
	if (shouldBroadcastProcess(job, media)) {
		deps.broadcast({
			type: 'media:status',
			mediaId: job.mediaId,
			status: mediaStatusFor(job),
			// The row rides the failure, because a sync carries only queued songs: a phone that never fetched this
			// one would otherwise name it by its id in "Couldn't make karaoke for …". Unconditional, because this
			// path only ever sees a terminal job, which `mediaStatusFor` reports as `failed`.
			media,
			pct: job.progressPct,
			etaSec: job.etaSec ?? undefined,
			// WHO TO TELL "try again". The job has carried this since it was enqueued — /api/process and
			// /api/lyrics-reselect are the only callers and both pass the session's singer — and a chained
			// follow-up inherits it (see `inheritsProcess` at the requeue in worker-hub). `null` means nobody
			// asked, which the client reads as "tell the room".
			requestedBy: job.singerId ?? undefined,
			// WHY it died, when the reason is that no worker can make it: there is still no maker, so the room
			// keeps "Can't make new karaoke right now" rather than being sent to pick another song that dies too.
			unservable: cause === 'unservable' || undefined
		});
	}
	console.warn(
		`[core] terminal job failure cause=${cause} job=${job.id} media=${job.mediaId} ` +
			`type=${job.jobType} attempts=${job.attempts} reason=${job.error ?? 'unknown'}`
	);
	cleanJobWork(job.id);
	return settled;
}

/** Mark the lyrics gate as IN FLIGHT, so the phone can name the step a song is waiting on. */
export function markLyricsQueued(mediaId: string, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	if (!media || media.lyricsStatus === 'ready') return false; // never walk a settled gate backwards
	media.lyricsStatus = 'queued';
	return true;
}

/**
 * Only two sources count as CITATIONS: `musicbrainz`, which carries an MBID, and `youtube`, the uploader's
 * own declared credit. NEVER REGRESSES — a later `medium` must not overwrite a stored `high`, because the
 * field that suffers is the one the LRCLIB query matches on. A normalizer title parse is overwritable.
 */
export function applyAnnotation(
	mediaId: string,
	mediaById: Map<string, Media>,
	annotation?: { source?: string; mbid?: string; artist?: string; title?: string; confidence?: string }
): boolean {
	const media = mediaById.get(mediaId);
	if (!media || !annotation?.artist || !annotation.title) return false;
	const source =
		annotation.source === 'musicbrainz' ? 'musicbrainz' : annotation.source === 'youtube' ? 'youtube' : null;
	if (!source) return false;
	if (source === 'musicbrainz' && !annotation.mbid) return false; // defined by its MBID
	const confidence = annotation.confidence === 'high' ? 'high' : 'medium';

	const current = media.annotation;
	const currentIsCitation = current?.source === 'musicbrainz' || current?.source === 'youtube';
	if (currentIsCitation && current!.confidence === 'high' && confidence !== 'high') {
		return false;
	}

	if (annotation.mbid) media.mbid = annotation.mbid; // only MusicBrainz carries one
	media.artistCanonical = annotation.artist;
	media.titleCanonical = annotation.title;
	media.annotation = { source, confidence };
	return true;
}

/** The uri MUST be normalized to a relative key: workers report ABSOLUTE paths and `safeMediaPath` rejects
 *  any ref starting with "/", so a raw uri cannot fetch an artifact that is on disk. `candidates` is the
 *  worker's UNTRUSTED report, read through `parseLyricsCandidates` rather than cast. */
export function setMediaLyrics(
	mediaId: string,
	uri: string | undefined,
	mediaById: Map<string, Media>,
	candidates?: unknown
): boolean {
	const media = mediaById.get(mediaId);
	if (!media) return false;

	// MERGE, never "last write wins", which would let a later line-level source replace word timings.
	const reported = parseLyricsCandidates(candidates);
	if (reported.length) {
		let merged = media.lyricsCandidates ?? [];
		for (const c of reported) {
			const ref = toRelativeKey(c.ref);
			if (!ref) continue;
			merged = mergeLyricsCandidate(merged, { ...c, ref });
		}
		media.lyricsCandidates = merged;
		// The SHARED resolver, so a live completion and a sidecar restore can never disagree.
		const chosen = resolveLyricsRef(merged, media.lyricsOverrideRef);
		if (chosen) {
			media.lyricsRef = chosen; // only move the pointer if something is actually showable
			return true;
		}
		// Nothing showable, and the pointer names a file this report WITHDREW: a re-run rewrote it with an
		// attempt its ladder rejected (`selectable: false`), so what the pointer would show is no longer the
		// document it chose. Clear it rather than show a reject; a pointer to anything else is left alone.
		if (media.lyricsRef && merged.some((c) => c.ref === media.lyricsRef && c.selectable === false)) {
			media.lyricsRef = undefined;
			return true;
		}
	}

	// No candidates (an older worker, or a `uri`-only report) → the legacy single-ref path.
	const ref = toRelativeKey(uri);
	if (!ref) return false;
	media.lyricsRef = ref;
	return true;
}

/** Additive: a song is playable with only the instrumental. An ABSENT ref is a real answer, not a missing
 *  one — a worker that measures its own vocals as silence omits the artifact entirely. */
export function setMediaVocals(mediaId: string, uri: string | undefined, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	const ref = toRelativeKey(uri);
	if (!media || !ref) return false;
	media.vocalsRef = ref;
	return true;
}

/** The download a fetch job kept, with its size. Only an `audio/<id>.<known ext>` ref (an older worker reports a
 *  scratch path, which `cleanJobWork` deletes) and a positive whole size (an older worker sends none). */
export function setMediaOriginal(
	mediaId: string,
	uri: string | undefined,
	bytes: unknown,
	mediaById: Map<string, Media>
): boolean {
	const media = mediaById.get(mediaId);
	const ref = keptOriginalRef(mediaId, uri);
	if (!media || !ref || !Number.isSafeInteger(bytes) || (bytes as number) <= 0) return false;
	media.originalRef = ref;
	media.originalBytes = bytes as number;
	return true;
}

/**
 * Both stems in ONE 4-channel file, so the TV plays the guide from a single playhead. An absent key CLEARS
 * the ref rather than preserving the old one, because the mix is a DERIVATIVE tied to the stem generation
 * that produced it (docs/SERVER.md#idempotency-and-the-process-cap). The caller deletes the stale FILE.
 */
export function setMediaGuideMix(mediaId: string, uri: string | undefined, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	if (!media) return false;
	const ref = toRelativeKey(uri);
	if (!ref) {
		const had = media.guideMixRef !== undefined;
		media.guideMixRef = undefined;
		return had;
	}
	media.guideMixRef = ref;
	return true;
}

/**
 * ALWAYS WRITES once stems completes, even on an empty report: a profile's PRESENCE is half the stems gate,
 * so garbage normalizes to EMPTY_SONG_PROFILE rather than leaving the field unset — otherwise a
 * silent-vocal song hangs on "Separating vocals" forever. Normalized HERE because the value is untrusted.
 */
export function setMediaSongProfile(mediaId: string, profile: unknown, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	if (!media) return false;
	media.songProfile = normalizeSongProfile(profile);
	return true;
}
