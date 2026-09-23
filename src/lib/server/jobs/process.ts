// The entry point for "strip the vocals from this song." Marks the media as PROCESSING
// (stemStatus:queued) so rotation HOLDS its slot until stems are ready, then enqueues a stems job at
// the priority of the soonest queue entry that needs it. worker-hub flips the media to ready on
// completion. See docs/ARCHITECTURE.md §6, §7.

import type { Job, JobType, Media, QueueEntry, LyricsCandidate, GlobalSettings } from '../../contract';
import {
	mergeLyricsCandidate,
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
import { instrumentalKey as layoutInstrumentalKey, toRelativeKey } from '../media/paths';
import { mediaStatusFor, shouldBroadcastProcess } from './media-status';
import { cleanJobWork } from '../media/migrate-layout';
import type { ServerEvent } from '../../contract';

export interface ProcessDeps {
	jobs: JobRepository;
	mediaById: Map<string, Media>;
	state: AuthoritativeState;
	now: () => number;
	/** Optional so existing callers and tests keep working; absent means shared defaults. */
	getSettings?: () => GlobalSettings;
}

/** Priority for a process nobody is waiting on: sorts after every queued turn, so it still gets
 *  processed, just at the back. `backfill.ts` reuses this exact value (both mean "nobody is waiting
 *  on this") — see BACKFILL_PRIORITY. */
export const NO_QUEUE_PRIORITY = Number.MAX_SAFE_INTEGER;

/** How many processes ONE singer may have in flight — a SETTING (`GlobalSettings.maxProcessesPerSinger`),
 *  not a constant, because the right cap is a function of how many workers a deployment has.
 *  `requestProcess` dedups on stems-existence alone, so nothing else stops one phone from tapping Sing
 *  down a whole results page and enqueueing a GPU job per distinct song. Callers with no `getSettings`
 *  (backfill, most unit tests) get the shipped DEFAULT, never "uncapped" — omitting the dependency must
 *  not be a way to bypass the bound. */
export function maxProcessesPerSinger(deps: Pick<ProcessDeps, 'getSettings'>): number {
	const configured = deps.getSettings?.().maxProcessesPerSinger;
	return typeof configured === 'number' ? configured : DEFAULT_GLOBAL_SETTINGS.maxProcessesPerSinger;
}

/** How many DISTINCT songs this singer currently has processing — the bound `over-limit` enforces.
 *  Attributed through the JOB LEDGER, not queue entries: the entry (WebSocket) and the process (HTTP)
 *  ride different transports and only the entry is droppable, so a phone tapping Sing during a
 *  reconnect window would file a process with no entry and an entry-derived count would see zero and
 *  admit every such tap. The ledger attributes each process to its requester at enqueue instead, so the
 *  count doesn't depend on the second transport. `exclude` drops the media being requested, so a re-tap
 *  of a song already processing is never counted against its own owner. */
export function countInFlightProcesses(
	singerId: string,
	deps: Pick<ProcessDeps, 'jobs' | 'mediaById'>,
	exclude?: string
): number {
	const processing = new Set<string>();
	for (const mediaId of deps.jobs.liveProcessMediaForSinger(singerId)) {
		if (mediaId === exclude) continue;
		const media = deps.mediaById.get(mediaId);
		// A finished process no longer costs the fleet. The ledger filter above usually suffices (ready
		// and the media flipping ready coincide); this keeps the count honest if they briefly diverge.
		if (media && isProcessed(media)) continue;
		processing.add(mediaId);
	}
	return processing.size;
}

/** The deterministic MediaStore key for a media's instrumental stem. MUST match the worker's output
 *  location (worker/src/processor.py `instrumental_path`), since the TV file player resolves
 *  `/media/${playbackRef(media)}` from it. Defined once in ../media/paths.ts; never hand-write this string. */
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

/** Why a process request can (or can't) proceed. Lets the route answer honestly: an already-processed
 *  song is a SUCCESS ("nothing to do, it's ready"), not an error. */
export type ProcessState =
	| 'unknown' // not in the catalog
	| 'not-processable' // metadata-only source (Spotify): no fetcher can pull its bytes, so it never can be
	| 'playing' // the live song; processing it would yank the video out from under the room
	| 'ready' // stems already separated (persisted from an earlier session) — no re-process
	| 'processing' // a live job is already working on it; a repeat request dedupes to that job
	| 'over-limit' // this singer is at the configured in-flight cap (GlobalSettings.maxProcessesPerSinger)
	| 'processable'; // nothing separated yet — go

export function processState(
	mediaId: string,
	deps: Pick<ProcessDeps, 'mediaById' | 'state' | 'jobs' | 'getSettings'>,
	singerId?: string
): ProcessState {
	const media = deps.mediaById.get(mediaId);
	if (!media) return 'unknown';
	// Checked FIRST, ahead of `playing`/`ready`/`over-limit`, because this is a property of the SONG,
	// not of the moment: those other states are ones a song passes through, but a metadata-only source
	// can never leave this one, and answering anything else here is what let the phone book a turn that
	// could never play.
	if (!isProcessableSource(media.source)) return 'not-processable';
	const current = deps.state.entries.find((e) => e.id === deps.state.playback.currentEntryId);
	if (current && current.mediaId === mediaId) return 'playing';
	if (isProcessed(media)) return 'ready';
	if (media.stemStatus === 'queued') return 'processing';
	// Checked LAST — an already-processing/ready song starts no new work, so the cap never blocks it.
	// Only evaluated when a singer is named; anonymous internal callers (backfill) are bounded by the
	// work they enqueue, not a per-singer count.
	//
	// `cap !== PROCESSES_UNCAPPED` MUST be tested before `count >= cap`: `0` means uncapped, and with a
	// bare `0` the comparison `count >= 0` is true for every singer, so turning the cap off would instead
	// refuse everyone. Named as a sentinel for exactly this reason — never compare against a bare 0.
	const cap = maxProcessesPerSinger(deps);
	if (singerId && cap !== PROCESSES_UNCAPPED && countInFlightProcesses(singerId, deps, mediaId) >= cap) {
		return 'over-limit';
	}
	return 'processable';
}

/**
 * Requests stem-separation for a media. Idempotent: a repeat request, or two singers queueing the
 * same song, dedupes to the SAME job, and stems already on disk are never re-processed.
 * Returns the job, or null when there is no work — unknown media, a metadata-only source, the
 * currently-playing song, already processed, or the singer's in-flight cap. Callers that need to tell
 * those apart ask `processState` with the same `singerId`; every refusal here is visible there too.
 */
export function requestProcess(mediaId: string, deps: ProcessDeps, singerId?: string): Job | null {
	const media = deps.mediaById.get(mediaId);
	if (!media) return null;

	const state = processState(mediaId, deps, singerId);
	// Refused off the STATE, not off `media.source` directly, so the refusal is visible to every caller
	// that asks `processState` first — a metadata-only source (e.g. Spotify) has no fetcher that can
	// pull its bytes; enqueueing one anyway would only die downstream at the worker.
	if (state === 'not-processable') return null;
	if (state === 'playing') return null; // would disrupt the live song
	if (state === 'ready') return null; // already separated — recomputing is the exact waste avoided
	// An already-processing song (`processing`) is NOT blocked here — it starts no new work, so it
	// falls through to the dedup below. Only a brand-new process can be `over-limit`.
	if (state === 'over-limit') return null;

	media.stemStatus = 'queued'; // rotation holds this slot until the instrumental exists
	const priority = soonestSeqFor(mediaId, deps.state.entries);
	// A local file skips straight to `stems` — nothing to download, and enqueueing a fetch for it would
	// need a worker capability no fetcher advertises.
	const first: JobType = needsFetch(media.source, deps.getSettings?.()?.defaultFetcher) ? 'fetch' : 'stems';
	const job = deps.jobs.enqueue(mediaId, first, priority, deps.now(), undefined, singerId);
	// The dedup index treats a `ready` job as live, so this can hand back a COMPLETED job whose media
	// object lost its ready flags (e.g. a runtime catalog entry rebuilt from a stub). Leaving the media
	// `queued` against a job that will never run again would deadlock rotation forever, so reconcile it.
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
	/** The candidate ref now pinned — an existing candidate's ref, or the minted manual ref. */
	ref: string;
}

/** Deterministic MediaStore key for a pasted manual candidate, so a repeated paste OVERWRITES the same
 *  artifact rather than stacking duplicates — the worker derives the same key from `pinnedRef`, and
 *  `mergeLyricsCandidate` dedupes on it. A re-time always lands word timings, so the tier is fixed. */
export function manualLyricsRef(mediaId: string): string {
	return `derived/lyrics/${mediaId}-manual-word.json`;
}

/**
 * A HUMAN RE-PICK of the lyrics set, then a re-time. Two shapes: pick an already-stored candidate by
 * `ref`, or paste new `text`. Either way the choice is pinned (`lyricsOverrideRef`) so it OUTRANKS
 * `pickBestLyrics` everywhere the candidate is resolved, and an `align` job is made to actually RUN.
 *
 * The re-run is the load-bearing part: a finished `align` sits terminal `ready`, which does NOT free
 * the dedup slot, so a bare `enqueue` would hand back the OLD job and silently run nothing. This
 * CANCELs a live align (or SUPERSEDEs a terminal one) first, to free the slot, then enqueues a fresh
 * one. `dispatch.ts` reads `media.lyricsOverrideRef`/`lyricsOverrideText` onto that job's params.
 *
 * No capability gate here — any joined singer may re-pick, like every other room control; the endpoint
 * enforces "joined" and this function does not re-check identity.
 */
export function requestLyricsReselect(
	mediaId: string,
	choice: { ref?: string; text?: string },
	deps: Pick<ProcessDeps, 'jobs' | 'mediaById' | 'state' | 'now'>,
	singerId?: string
): ReselectResult | ReselectRefusal {
	const media = deps.mediaById.get(mediaId);
	if (!media) return 'unknown-media';
	// Re-timing runs the aligner over the retained VOCALS stem, so without one there's nothing to align
	// against — refuse rather than enqueue a job that cannot work.
	if (!media.vocalsRef) return 'not-processed';

	const pasted = typeof choice.text === 'string' ? choice.text.trim() : '';
	let ref: string;
	if (pasted) {
		ref = manualLyricsRef(mediaId);
	} else {
		const picked = typeof choice.ref === 'string' ? choice.ref : '';
		// A paste of nothing but whitespace is `no-text`, not a fall-through to the ref branch — the
		// caller named the paste shape, so `unknown-candidate` would blame a ref they never sent.
		if (!picked && typeof choice.text === 'string') return 'no-text';
		// A pick must name a candidate actually on disk, or it would pin the media to a pointer nothing
		// resolves, blanking the overlay. Pasting is the only way to introduce a NEW ref.
		if (!picked || !(media.lyricsCandidates ?? []).some((c) => c.ref === picked)) return 'unknown-candidate';
		ref = picked;
	}

	media.lyricsOverrideRef = ref; // pinned BEFORE enqueue so dispatch.assignParams reads it onto align
	// The PASTED WORDS themselves: a manual ref names a candidate no provider has written, so without
	// the text the worker gets a pointer to a file that doesn't exist. Stored on the media, not the job,
	// so it survives a restart's requeue too. CLEARED on a ref pick — a leftover paste would outrank
	// `pinnedRef` in the worker and re-time over the candidate the human just chose.
	media.lyricsOverrideText = pasted || undefined;

	const priority = soonestSeqFor(mediaId, deps.state.entries);
	const now = deps.now();
	// A finished align occupies the dedup slot AND is terminal (neither reusable nor cancellable), so:
	// still-live → CANCEL it (frees the slot); terminal → SUPERSEDE it (deletes the row, frees the
	// slot). A song that never aligned has neither, and the enqueue below starts the first one.
	const live = deps.jobs.findLive(mediaId, 'align');
	if (live && !isTerminalJob(live.status)) deps.jobs.cancel(live.id, now);
	else deps.jobs.supersedeForRerun(mediaId, 'align');
	const job = deps.jobs.enqueue(mediaId, 'align', priority, now, undefined, singerId);
	// NOT via markLyricsQueued, which refuses to walk a SETTLED gate backwards — a re-pick is the one
	// case where reopening a finished lyrics gate is correct, since a NEW align really is about to run.
	// Rotation gates on stems, not lyrics, so this can't un-play a live song.
	media.lyricsStatus = 'queued';
	return { job, ref };
}

/** Flips a media to READY after its stems job completes, so rotation's isEntryReady unblocks the held
 *  entry. `sourceRef` is deliberately LEFT ALONE: it's the song's origin identity, and overwriting it
 *  would make the next search fail to recognise the song and mint a second, unprocessed row. */
export function markMediaReady(
	mediaId: string,
	mediaById: Map<string, Media>,
	reportedUri?: string,
	separator?: { engine: string; model: string }
): boolean {
	const media = mediaById.get(mediaId);
	if (!media) return false;

	// An UPGRADE must never publish a worse instrumental than the one already there; a plain process
	// (no separator reported, or nothing published yet) always applies.
	if (separator && media.instrumentalRef && !isQualityUpgrade(media.separator, separator)) {
		return false;
	}

	// Prefers what the worker ACTUALLY wrote over re-deriving the key, so a future container format
	// change can't desync the ref from the file and 404 the TV.
	media.instrumentalRef = toRelativeKey(reportedUri) ?? instrumentalKey(mediaId);
	media.stemStatus = 'ready';
	if (separator) media.separator = separator;
	return true;
}

/** Marks the lyrics gate SETTLED — align has run, whatever it found. "Settled", not "succeeded": a
 *  song with no words is a legitimate finished song, and requiring a lyrics artifact would leave every
 *  genuine instrumental stuck processing forever on a step that worked correctly. */
export function settleLyricsGate(mediaId: string, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	if (!media) return false;
	media.lyricsStatus = 'ready';
	return true;
}

/** Settles the STEMS side after a separation permanently fails: back to un-processed. Without this a
 *  terminal stems failure leaves `stemStatus` mid-flight, so the song reads as processing FOREVER —
 *  `processState` refuses to ever let it re-process. Reverts to 'none', not 'failed', because that's
 *  the truth (nothing was separated, so it's a fresh candidate); the failure itself reaches the phone
 *  only through the ephemeral `media:status` broadcast, not a permanent scar on the record. */
export function settleStemsGate(mediaId: string, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	if (!media || media.stemStatus === 'ready') return false; // never walk a finished process backwards
	media.stemStatus = 'none';
	return true;
}

/**
 * THE per-gate settlement rule, as a TABLE rather than if/else, because it now has TWO readers that
 * must never drift apart: `settleGatesForFailedJob` (below) asks "one job just died, which gate does it
 * settle?"; `reconcileStrandedGates` (gate-reconcile.ts) asks the same question from the boot direction
 * ("no job is alive for this gate and none ever will be — which job types should I have expected?").
 * Mirrors `GATES` in `$lib/contract/queue/gates.ts` under the same gate ids and pipeline order — that
 * table says whether a step is DONE, this one says what happens when it can never finish. `stems-upgrade`
 * appears in no `settledBy` list: the song still has its working instrumental, so a dead upgrade settles
 * nothing.
 */
export interface GateSettlement {
	/** Matches the `ProcessGate.id` in the contract's `GATES`, so a log line reads the same on both sides. */
	readonly id: 'stems' | 'lyrics';
	/** Job types whose completion or failure is what moves this gate. */
	readonly settledBy: readonly JobType[];
	/** Is this gate MID-FLIGHT — a step actively claimed as running, not done or never started? Narrow
	 *  on purpose: only the explicit `'queued'` marker counts. A NULL/absent status means "predates the
	 *  gate" or "nothing ever started", not "in progress" — settling either would forge a step that
	 *  never ran and mark an unprocessed song finished. */
	readonly inFlight: (m: Media) => boolean;
	/** How the gate settles when nothing will ever finish it. */
	readonly settle: (mediaId: string, mediaById: Map<string, Media>) => boolean;
}

export const GATE_SETTLEMENT: readonly GateSettlement[] = [
	{
		id: 'stems',
		// `fetch` counts because requestProcess marks the media processing BEFORE the download starts,
		// so a song mid-fetch has a legitimately in-flight stems gate and no stems job yet.
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

/** Widened from `Job` so the boot reconciliation can ask this same question about a job that no longer
 *  EXISTS — a gate stranded by a cancelled row with its dedup slot freed has no `Job` to pass, and
 *  fabricating a fake one would be worse than just naming the two fields the rule needs. */
export type SettleableJob = Pick<Job, 'mediaId' | 'jobType'>;

/** THE single rule for what a dead process does to its song's readiness, so every terminal-fail path
 *  settles the same way and a fourth path can't reopen the hole. A process can die on three paths — the
 *  worker's own `job:failed` report, the unservable TTL, or the reaper's exhausted-attempts sweep — and
 *  ALL must settle, or a TTL-/reaper-killed process leaves its gate mid-flight forever, holding the
 *  queue entry with `readyToSing` never flipping even though the instrumental is on disk. The per-type
 *  mapping lives in `GATE_SETTLEMENT` above, not restated here, so the boot reconciliation can't drift
 *  from it. Returns whether it changed anything, for the caller's logging. */
export function settleGatesForFailedJob(job: SettleableJob, mediaById: Map<string, Media>): boolean {
	const gate = GATE_SETTLEMENT.find((g) => g.settledBy.includes(job.jobType));
	return gate ? gate.settle(job.mediaId, mediaById) : false; // no gate: stems-upgrade keeps its instrumental
}

/** Why a job reached terminal `failed`, so the operator can tell the three death paths apart from one
 *  grep: `worker` (job:failed, retries exhausted), `unservable` (no worker ever advertised the required
 *  capability within the TTL), `reaper` (a lease expired and attempts exhausted with no worker involved). */
export type TerminalFailureCause = 'worker' | 'unservable' | 'reaper';

export interface TerminalFailureDeps {
	/** The room sink. Injected because process cannot reach worker-hub's private #emitStatus. */
	broadcast: (event: ServerEvent) => void;
	mediaById: Map<string, Media>;
	/** Flushes the song's row after a gate settles. Optional, matching `WorkerHubDeps.persistMedia`.
	 *  REQUIRED for durability, though: `settleGatesForFailedJob` only mutates the in-memory `Media`, but
	 *  `stemStatus`/`lyricsStatus` are STORED columns and `hydrateMediaCatalog` wins at boot over the
	 *  sidecar path — skip this and a restart resurrects the exact stranding `settleStemsGate` exists to
	 *  end, this time unrecoverable (no user action clears it, and the process never runs again to). */
	persist?: (mediaId: string) => void;
}

/** The terminal-failure EPILOGUE every permanently-failed process must run, in one place so all death
 *  paths settle identically:
 *    1. Settle the readiness gate for this job type, so `readyToSing` can flip and rotation lets go.
 *    2. Broadcast `media:status`, gated on `shouldBroadcastProcess` (a dead `stems-upgrade` on an
 *       already-singable song must not flip a ready row back to "Making karaoke").
 *    3. One uniform operator log line, so `grep 'job=<id>'` finds it on every path.
 *    4. Reclaim the job's scratch — nothing resumes from a terminal job.
 *  `job` is the ALREADY-terminal job. Returns whether the gate settle changed anything. */
export function reportTerminalFailure(job: Job, cause: TerminalFailureCause, deps: TerminalFailureDeps): boolean {
	const settled = settleGatesForFailedJob(job, deps.mediaById);
	// Gated on `settled`: a stems-upgrade failure settles nothing, so persisting there would flush a row
	// for no change. Ordered before the broadcast so the room is never told 'failed' while the row that
	// outlives the process still says 'processing'.
	if (settled) deps.persist?.(job.mediaId);
	const media = deps.mediaById.get(job.mediaId);
	if (shouldBroadcastProcess(job, media)) {
		deps.broadcast({
			type: 'media:status',
			mediaId: job.mediaId,
			status: mediaStatusFor(job),
			pct: job.progressPct,
			etaSec: job.etaSec ?? undefined
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
 * Applies a `fetch` job's annotation, or refuses. Two citation sources, both stronger than the title
 * parse they replace: `musicbrainz` (a search that AGREED on artist and title with a corroborating
 * duration, carries an MBID) and `youtube` (YouTube's own extracted `track`/`artist`, a citation
 * because the uploader DECLARED it rather than us reverse-engineering it — `high` confidence, never an
 * MBID). NEVER REGRESSES: once a media holds a `high` citation from either source, a later `medium`
 * must not overwrite it, since the field that suffers is the one the LRCLIB query matches on. A
 * normalizer-derived value is always overwritable — it's a title parse, not a citation.
 */
export function applyAnnotation(
	mediaId: string,
	mediaById: Map<string, Media>,
	annotation?: { source?: string; mbid?: string; artist?: string; title?: string; confidence?: string }
): boolean {
	const media = mediaById.get(mediaId);
	if (!media || !annotation?.artist || !annotation.title) return false;
	// Anything but these two sources (a normalizer echo, a typo) is not an identification.
	const source =
		annotation.source === 'musicbrainz' ? 'musicbrainz' : annotation.source === 'youtube' ? 'youtube' : null;
	if (!source) return false;
	if (source === 'musicbrainz' && !annotation.mbid) return false; // defined by its MBID
	const confidence = annotation.confidence === 'high' ? 'high' : 'medium';

	// Same rank comparison in spirit as the separator upgrade gate: at least as good as what's published.
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

/** Attaches the word-timed lyrics artifact (align output), additive and independent of the stems flip.
 *  The uri is NORMALIZED to a relative key, since workers report absolute filesystem paths and
 *  `safeMediaPath` rejects any ref starting with "/" — storing the raw uri would make the overlay
 *  unable to fetch an artifact that exists on disk. Returns true if a usable ref was set. */
export function setMediaLyrics(
	mediaId: string,
	uri: string | undefined,
	mediaById: Map<string, Media>,
	candidates?: LyricsCandidate[]
): boolean {
	const media = mediaById.get(mediaId);
	if (!media) return false;

	// Merge into the stored set and let the resolver choose — never "last write wins", which would let a
	// later line-level source silently replace existing word timings.
	if (candidates?.length) {
		let merged = media.lyricsCandidates ?? [];
		for (const c of candidates) {
			const ref = toRelativeKey(c.ref);
			if (!ref) continue;
			merged = mergeLyricsCandidate(merged, { ...c, ref });
		}
		media.lyricsCandidates = merged;
		// The SHARED resolver, so a human override wins here exactly as it does on a sidecar restore —
		// a live completion and a restore can never disagree.
		const chosen = resolveLyricsRef(merged, media.lyricsOverrideRef);
		if (chosen) {
			media.lyricsRef = chosen; // only move the pointer if something is actually showable
			return true;
		}
	}

	// No candidates (an older worker, or a job that only reported `uri`) → the legacy single-ref path.
	const ref = toRelativeKey(uri);
	if (!ref) return false;
	media.lyricsRef = ref;
	return true;
}

/** Attaches the isolated VOCALS stem (the guiding track), additive and independent of the stems flip —
 *  a song is perfectly playable with only the instrumental. Trusts the worker's report, like
 *  markMediaReady, for both the container format AND the content check: a worker that measures its own
 *  vocals as silence omits the artifact entirely, so an absent ref is a real answer, not a missing one
 *  (media/loudness.ts covers the other direction — already-processed songs being backfilled). */
export function setMediaVocals(mediaId: string, uri: string | undefined, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	const ref = toRelativeKey(uri);
	if (!media || !ref) return false;
	media.vocalsRef = ref;
	return true;
}

/**
 * Attaches the GUIDE MIX — both stems in ONE 4-channel file, so the TV plays the guiding track from a
 * single playhead instead of holding two elements in time against each other.
 *
 * ALWAYS WRITES, unlike `setMediaVocals` — the asymmetry is the whole point. The mix is not an
 * independent artifact but a DERIVATIVE of the two stems at a fixed path every process overwrites, so
 * its validity is tied to the stem generation that produced it. If a `stems-upgrade`'s mix encode fails
 * and the OLD ref were preserved, the room would keep playing a mix built from SUPERSEDED stems while
 * `instrumentalRef`/`Media.separator` advertise the better ones — and unrecoverably so, since the
 * backfill classifies a song with a ref as `settled` and never rebuilds it. So an absent key instead
 * CLEARS the ref: the song falls back to the two-element guide path, `guideMixEligibility` reports it
 * eligible again, and the next boot's backfill rebuilds the mix from the NEW stems. The caller deletes
 * the stale FILE (worker-hub.ts); this owns the ref only.
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
 * Attaches the SONG PROFILE (key + vocal-range analysis), additive and independent of the instrumental
 * flip like setMediaVocals — but TWO things differ, both load-bearing. First, it ALWAYS WRITES once
 * stems completes, even when the worker reported nothing: a profile's PRESENCE is half the stems
 * process gate (gates.ts), so `undefined`/garbage normalizes to EMPTY_SONG_PROFILE (all-null) rather
 * than leaving the field unset — the honest "analysis ran, found nothing" answer that lets a
 * silent-vocal song finish processing instead of hanging on "Separating vocals" forever. Second, it
 * normalizes at THIS boundary: the value is untrusted wire data, and `normalizeSongProfile` degrades a
 * bad half to null independently rather than rejecting the whole record. Always returns true when the
 * media exists — an empty profile is itself a valid, gate-satisfying result.
 */
export function setMediaSongProfile(mediaId: string, profile: unknown, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	if (!media) return false;
	media.songProfile = normalizeSongProfile(profile);
	return true;
}
