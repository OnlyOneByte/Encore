// Make-karaoke request orchestrator — the entry point for "strip the vocals from this song."
// Marks the media as COOKING (stemStatus:queued) so rotation HOLDS its slot
// (isEntryReady returns false until stems are ready), then enqueues a stems job at the priority of
// the soonest queue entry that needs it. worker-hub flips the media to ready on completion.
// See ARCHITECTURE §6, §7.

import type { Job, JobType, Media, QueueEntry, LyricsCandidate, GlobalSettings } from '$lib/contract';
import {
	mergeLyricsCandidate,
	resolveLyricsRef,
	isTerminalJob,
	isQualityUpgrade,
	isPlayable,
	isCookableSource,
	needsFetch,
	normalizeSongProfile
} from '$lib/contract';
import type { JobRepository } from './repository';
import type { AuthoritativeState } from '../state/store';
import { instrumentalKey as layoutInstrumentalKey, toRelativeKey } from '../media/paths';
import { mediaStatusFor, shouldBroadcastCook } from './media-status';
import { cleanJobWork } from '../media/migrate-layout';
import type { ServerEvent } from '$lib/contract';

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
 * MUST match the worker's output location (worker/src/processor.py instrumental_path →
 * <media_dir>/derived/stems/<mediaId>-instrumental.flac), since the TV file player resolves
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
	| 'not-cookable' // metadata-only source (Spotify): no fetcher can pull its bytes, so it never can be
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
	// FIRST, and before any room state: this is a property of the SONG, not of the moment. A
	// metadata-only source (Spotify) has no fetcher that can pull its bytes, so no sequence of events
	// can ever make it cookable — answering anything else here is what let the phone offer Sing and
	// book a turn that could never play. Checked ahead of `playing`/`ready`/`over-limit`
	// deliberately: those are all states a song passes through, and this one it can never leave.
	if (!isCookableSource(media.source)) return 'not-cookable';
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
 * restarts) is never re-cooked. Returns the job, or null when there is no work — unknown media, a
 * metadata-only source that can never be cooked, the currently-playing song, already cooked, OR the
 * requesting singer is already at their in-flight cook cap. Callers that need to tell those apart ask
 * `cookState` (pass the same `singerId`) — and that promise is now true of EVERY refusal here, which
 * is the fix for the metadata-only case, which used to be refused by a standalone check inside this
 * function, so `cookState` answered `'cookable'` for a song this function would always reject and the
 * phone booked the singer a turn that could never play.
 */
export function requestMakeKaraoke(mediaId: string, deps: MakeKaraokeDeps, singerId?: string): Job | null {
	const media = deps.mediaById.get(mediaId);
	if (!media) return null;

	const state = cookState(mediaId, deps, singerId);
	// Spotify is a SEARCH / metadata source only (docs/DECISIONS.md, the annotator pattern): its
	// sourceRef is a Spotify track id, NOT anything a fetcher can pull, so cooking one would enqueue a
	// fetch that forms `youtube.com/watch?v=<spotify-track-id>` and dies at ffmpeg — the exact
	// shape-inference bug the fetcher registry exists to kill. A Spotify hit sharpens the query; the
	// singer queues the YouTube result. Refused off the STATE now, not off `media.source` directly, so
	// the refusal is visible to every caller that asks `cookState` before acting.
	if (state === 'not-cookable') return null;
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

/** Why a lyrics re-select could not start — the honest refusal the endpoint maps to a status code. */
export type ReselectRefusal =
	| 'unknown-media'
	| 'not-cooked' // the vocals stem does not exist yet, so there is nothing to re-time against
	| 'unknown-candidate' // a pick that names a ref not in the stored set
	| 'no-text'; // a paste with no usable words

export interface ReselectResult {
	job: Job;
	/** The candidate ref now pinned — an existing candidate's ref, or the minted manual ref. */
	ref: string;
}

/**
 * The MediaStore key a pasted manual candidate is written under. Deterministic so a repeated
 * paste OVERWRITES the same artifact rather than stacking duplicates — the worker computes the same
 * key from `pinnedRef` and `mergeLyricsCandidate` dedupes on it. Mirrors the worker's `candidate_key`
 * for the (manual, word) tier; a re-time always lands word timings, so the tier is fixed.
 */
export function manualLyricsRef(mediaId: string): string {
	return `derived/lyrics/${mediaId}-manual-word.json`;
}

/**
 * A HUMAN RE-PICK of the lyrics set, then a re-time. Two shapes: pick an already-stored
 * candidate by `ref`, or paste new `text` (a `manual`-source candidate the worker will time). Either
 * way the choice is pinned on the media (`lyricsOverrideRef`) so it OUTRANKS `pickBestLyrics`
 * everywhere the chosen candidate is resolved, and an `align` job is made to actually RUN.
 *
 * The re-run is the load-bearing part. A finished `align` sits `ready`, and `ready` does not free the
 * dedup slot (`SLOT_FREEING_STATUSES`), so a bare `enqueue(id,'align',...)` would hand back the OLD
 * job and nothing would run — silently. So we CANCEL the live align first (cancel frees the slot),
 * then enqueue a fresh one, and reopen the lyrics gate. The owner rejected special-casing `align`
 * inside `findLive` (it would let a chained align race a manual one); cancel-then-enqueue is the
 * durable seam. `dispatch.ts` then reads `media.lyricsOverrideRef` and sends the worker `pinnedRef`.
 *
 * Q1=A: no capability gate here — any joined singer may re-pick, like every other room control. The
 * endpoint enforces "joined"; this function does not re-check identity.
 */
export function requestLyricsReselect(
	mediaId: string,
	choice: { ref?: string; text?: string },
	deps: Pick<MakeKaraokeDeps, 'jobs' | 'mediaById' | 'state' | 'now'>,
	singerId?: string
): ReselectResult | ReselectRefusal {
	const media = deps.mediaById.get(mediaId);
	if (!media) return 'unknown-media';
	// Re-timing runs the aligner over the retained VOCALS stem, so the song must be cooked. Without a
	// vocals ref there is nothing to align against — refuse rather than enqueue a job that cannot work.
	if (!media.vocalsRef) return 'not-cooked';

	const pasted = typeof choice.text === 'string' ? choice.text.trim() : '';
	let ref: string;
	if (pasted) {
		ref = manualLyricsRef(mediaId);
	} else {
		const picked = typeof choice.ref === 'string' ? choice.ref : '';
		// A pick must name a candidate actually on disk — a ref not in the set would pin the media to a
		// pointer nothing resolves, blanking the overlay. The paste path is the way to introduce a NEW ref.
		if (!picked || !(media.lyricsCandidates ?? []).some((c) => c.ref === picked)) return 'unknown-candidate';
		ref = picked;
	}

	// Pin the human choice BEFORE enqueue so `dispatch.assignParams` reads it onto the align's params.
	media.lyricsOverrideRef = ref;

	const priority = soonestSeqFor(mediaId, deps.state.entries);
	const now = deps.now();
	// Make the re-run reachable. A finished `align` sits `ready`, which occupies the dedup slot AND is
	// terminal, so it can be neither reused nor cancelled — a bare enqueue would hand it straight back
	// and nothing would run (the silent no-op this whole feature exists to defeat). Two shapes:
	//   • a still-live align (queued/assigned/running) — CANCEL it; cancel frees the slot.
	//   • a terminal align (ready/failed) — SUPERSEDE it; deleting the terminal row frees the slot.
	// A song that never aligned has neither and both are no-ops — the enqueue then starts the first one.
	const live = deps.jobs.findLive(mediaId, 'align');
	if (live && !isTerminalJob(live.status)) deps.jobs.cancel(live.id, now);
	else deps.jobs.supersedeForRerun(mediaId, 'align');
	const job = deps.jobs.enqueue(mediaId, 'align', priority, now, undefined, singerId);
	// Reopen the lyrics gate so the room sees the re-time in progress. NOT via markLyricsQueued: that
	// helper deliberately refuses to walk a SETTLED ('ready') gate backwards, and a re-timed song's gate
	// is exactly settled — a re-pick is the one case where re-opening a finished lyrics gate is correct,
	// because a NEW align really is about to run. Rotation does not gate on lyrics (it gates on stems),
	// so this cannot un-play a live song; it only drives the phone's cooking indicator.
	media.lyricsStatus = 'queued';
	return { job, ref };
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
 * cooking forever on a step that worked correctly. See src/lib/contract/queue/gates.ts.
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

/**
 * Settle the right gate for a job that has reached terminal `failed`, by job type. THE single rule
 * for what a dead cook does to its song's readiness, so every terminal-fail path settles the same
 * way and a fourth one cannot silently reopen the hole.
 *
 * A cook can die on three paths — the worker reports `job:failed` (#onFailed), it sits unservable
 * past the TTL (dispatch), or the reaper exhausts its attempts because the worker box died — and
 * ALL of them must settle, not just the reported one. Otherwise a TTL- or reaper-killed cook leaves
 * `lyricsStatus`/`stemStatus` mid-flight forever: `readyToSing` never flips, rotation holds the
 * queue entry on every pass, and the song never plays even with its instrumental on disk.
 *
 * The per-type rule (unchanged from where it used to live inline in #onFailed):
 *   • `align`        → settle the LYRICS gate. The song already plays; a dead align must not keep it
 *                      from ever being sung — let the party continue with no words on screen.
 *   • `fetch`/`stems`→ settle the STEMS gate back to un-cooked. A dead download or separation used
 *                      to leave the song reading "Making karaoke…" forever, un-retryable. `fetch`
 *                      counts because requestMakeKaraoke marks the media cooking BEFORE the download.
 *   • `stems-upgrade`→ NEITHER. The song still has its working instrumental; settleStemsGate refuses
 *                      to walk a finished cook backwards anyway.
 *
 * Returns whether it changed anything (a gate was settled), for the caller's logging.
 */
export function settleGatesForFailedJob(job: Job, mediaById: Map<string, Media>): boolean {
	if (job.jobType === 'align') return settleLyricsGate(job.mediaId, mediaById);
	if (job.jobType === 'fetch' || job.jobType === 'stems') return settleStemsGate(job.mediaId, mediaById);
	return false; // stems-upgrade: keep the working instrumental
}

/**
 * Why a job reached terminal `failed`. Three code paths can end a cook permanently and the operator
 * needs to tell them apart from one grep, so the cause travels with the log line rather than being
 * inferred from the (now uniform) format: `worker` — the worker reported job:failed and retries are
 * exhausted (worker-hub #onFailed); `unservable` — no connected worker ever advertised the required
 * capability within the TTL (worker-hub dispatch loop); `reaper` — a lease expired and the JobReaper
 * exhausted attempts with no worker in the loop at all (app.ts).
 */
export type TerminalFailureCause = 'worker' | 'unservable' | 'reaper';

export interface TerminalFailureDeps {
	/** The room sink. Injected because make-karaoke cannot reach worker-hub's private #emitStatus,
	 *  and app.ts's reaper hook had to hand-reimplement it. */
	broadcast: (event: ServerEvent) => void;
	mediaById: Map<string, Media>;
	/**
	 * Flush the song's row after a gate settles. Optional, matching `WorkerHubDeps.persistMedia`, so the
	 * hub still unit-tests with no DB.
	 *
	 * WHY THIS EXISTS. `settleGatesForFailedJob` mutates the in-memory `Media` and nothing else, but
	 * `stem_status` and `lyrics_status` are STORED columns and the *queued* flip IS persisted — the
	 * make-karaoke route upserts immediately after enqueue, precisely so a restart mid-cook still knows
	 * the song is pending. `hydrateMediaCatalog` then wins at boot over the sidecar path, which never
	 * stores `'queued'`, and no boot pass reconciled the column against the job ledger.
	 *
	 * So a terminal failure settled the gate in memory, the process restarted, and the song came back
	 * reading as cooking with a terminal job row behind it and no Sing button — resurrecting the exact
	 * stranding `settleStemsGate` was written to end. It is the one failure in this subsystem a guest
	 * cannot work around: no user action clears it, and the cook will never run again to clear it either.
	 */
	persist?: (mediaId: string) => void;
}

/**
 * The terminal-failure EPILOGUE — the four things every permanently-failed cook must do, in one
 * place. Before this, three sites open-coded the identical four steps
 * (worker-hub #onFailed, worker-hub's unservable-TTL branch, and app.ts's reaper onFailed hook) and a
 * fourth copy was reconstructed inside reaper-broadcast-on-failure.test.ts. Only the inner gate rule
 * (settleGatesForFailedJob) had been extracted, so the epilogue AROUND it kept drifting: the TTL
 * branch omitted cleanJobWork, app.ts hand-reimplemented the private #emitStatus, and all three log
 * lines diverged (different tag, some missing media/attempts) so no single grep found every terminal
 * failure — the shape that let the reaper path ship silent.
 *
 * The four steps, in order:
 *   1. Settle the readiness gate for this job type so `readyToSing` can flip and rotation stops
 *      holding the queue entry (settleGatesForFailedJob).
 *   2. Broadcast `media:status` so a watching phone leaves 'cooking' → 'failed' and the Sing button
 *      returns — gated on shouldBroadcastCook exactly as #emitStatus is, so a dead `stems-upgrade` on
 *      an already-singable song does not flip every ready row back to "Making karaoke".
 *   3. One operator log line, now in a UNIFORM key=value format (`job= media= attempts= reason=`, with
 *      a `cause=` discriminator) so `grep 'reaper failure'` or `grep 'job=<id>'` finds it on every
 *      path — the divergent formats used to drop the reaper case and never carry a media id on the
 *      unservable case.
 *   4. Reclaim the job's scratch (cleanJobWork) — its work/<jobId>/ holds a decoded source plus both
 *      stems and nothing resumes from a terminal job. A no-op when the dir is absent (a remote
 *      worker's scratch the core never had).
 *
 * `job` is the ALREADY-terminal job (post JobRepository.fail), so it carries the final attempts count
 * and error. Returns whether the gate settle changed anything, for a caller that wants it.
 */
export function reportTerminalFailure(job: Job, cause: TerminalFailureCause, deps: TerminalFailureDeps): boolean {
	// 1. Settle the gate for this job type (the half already extracted).
	const settled = settleGatesForFailedJob(job, deps.mediaById);
	// 1b. …and make that settlement DURABLE. Gated on `settled` deliberately: a stems-upgrade failure
	//     keeps its working instrumental and settles nothing, so writing there would flush a row per
	//     failure for no change. Ordered before the broadcast so the room is never told a song is failed
	//     while the row that outlives the process still says it is cooking.
	if (settled) deps.persist?.(job.mediaId);
	// 2. Tell the room — same shouldBroadcastCook guard #emitStatus applies.
	const media = deps.mediaById.get(job.mediaId);
	if (shouldBroadcastCook(job, media)) {
		deps.broadcast({
			type: 'media:status',
			mediaId: job.mediaId,
			status: mediaStatusFor(job),
			pct: job.progressPct,
			etaSec: job.etaSec ?? undefined
		});
	}
	// 3. One uniform operator line. Job id is the only field common to all callers, so it leads; the
	//    cause discriminator lets a grep separate a terminal failure from the merely-informational
	//    stall warn that shares the `warn` level.
	console.warn(
		`[core] terminal job failure cause=${cause} job=${job.id} media=${job.mediaId} ` +
			`type=${job.jobType} attempts=${job.attempts} reason=${job.error ?? 'unknown'}`
	);
	// 4. Reclaim scratch — nothing resumes from a terminal job.
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
 * Apply a `fetch` job's annotation, or refuse.
 *
 * TWO citation SOURCES arrive here, and both are stronger than the title parse they replace:
 *   • `musicbrainz` — a search that AGREED on artist and title with a corroborating duration; carries
 *     an MBID.
 *   • `youtube` — YouTube's OWN extracted `track`/`artist` metadata, captured for free at download time
 *. The uploader DECLARED the credit rather than us reverse-engineering it from the title, so
 *     it is a citation, not a guess — `high`, and with NO MBID (YouTube does not mint one). An MBID is
 *     therefore required only for the `musicbrainz` source.
 *
 * NEVER REGRESSES. Once a media holds a `high` citation from EITHER source, a later `medium` (or a
 * later citation that is not itself `high`) must not overwrite it — a re-fetch, a re-cook, or a
 * backfill would otherwise downgrade a known-good artist into a lesser value, and the field that
 * suffers is the one the LRCLIB query matches on. A normalizer-derived value is always overwritable:
 * it is a title parse, not a citation.
 *
 * Writes the canonical fields as well as any MBID, because being able to cite the song is only useful
 * if the names that come with it are the ones downstream reads.
 */
export function applyAnnotation(
	mediaId: string,
	mediaById: Map<string, Media>,
	annotation?: { source?: string; mbid?: string; artist?: string; title?: string; confidence?: string }
): boolean {
	const media = mediaById.get(mediaId);
	if (!media || !annotation?.artist || !annotation.title) return false;
	// Only the two citation sources are accepted here; anything else (a normalizer echo, a typo) is not
	// an identification and writes nothing.
	const source =
		annotation.source === 'musicbrainz' ? 'musicbrainz' : annotation.source === 'youtube' ? 'youtube' : null;
	if (!source) return false;
	// A MusicBrainz citation is defined by its MBID; a YouTube one has none by construction.
	if (source === 'musicbrainz' && !annotation.mbid) return false;
	const confidence = annotation.confidence === 'high' ? 'high' : 'medium';

	// Refuse a downgrade of an existing citation — from EITHER citation source. Same rank comparison in
	// spirit as the separator upgrade gate: a candidate has to be at least as good as what is published.
	const current = media.annotation;
	const currentIsCitation = current?.source === 'musicbrainz' || current?.source === 'youtube';
	if (currentIsCitation && current!.confidence === 'high' && confidence !== 'high') {
		return false;
	}

	// Only a MusicBrainz citation carries an MBID; a YouTube one leaves whatever was there untouched.
	if (annotation.mbid) media.mbid = annotation.mbid;
	media.artistCanonical = annotation.artist;
	media.titleCanonical = annotation.title;
	media.annotation = { source, confidence };
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
	// and let the resolver choose — never "last write wins", which would let a later line-level
	// source silently replace existing word timings.
	if (candidates?.length) {
		let merged = media.lyricsCandidates ?? [];
		for (const c of candidates) {
			const ref = toRelativeKey(c.ref);
			if (!ref) continue; // workers report absolute paths; safeMediaPath rejects those
			merged = mergeLyricsCandidate(merged, { ...c, ref });
		}
		media.lyricsCandidates = merged;
		// Resolve through the SHARED resolver so a human override wins over the ranking here just
		// as it does on a sidecar restore — the SAME function, so a live align completion and a restore
		// can never disagree. With no override this is exactly pickBestLyrics as before.
		const chosen = resolveLyricsRef(merged, media.lyricsOverrideRef);
		// Only move the pointer if something is actually showable; a set of unusable candidates must not
		// clear a working lyricsRef.
		if (chosen) {
			media.lyricsRef = chosen;
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
 * Attach the MEASURED guide offset — how far the vocals stem sits from the instrumental, in signed
 * milliseconds, so guide/instrumental alignment is observable instead of assumed.
 *
 * Additive and independent of the instrumental flip, like setMediaVocals — and like it, a VALUE-OR-NOTHING
 * field, not an always-write one. The worker measures the offset best-effort and only reports it when it
 * has a trustworthy number (see measure_guide_offset_ms's tri-state); an absent value on the wire means
 * "not measured", which must leave the field as it is. So a non-number is a no-op here: it never overwrites
 * an existing measurement with null, which matters on a stems-UPGRADE re-cook where a declined re-measure
 * would otherwise wipe a good offset a prior cook recorded. A measured 0 IS a number and is stored — that
 * is the honest "measured, and it was aligned" answer, distinct from the never-measured null.
 *
 * The untrusted wire value is coerced at this boundary: anything that is not a finite number is dropped
 * rather than written, so a garbage frame cannot poison the alignment the client trusts.
 */
export function setMediaGuideOffset(mediaId: string, offsetMs: unknown, mediaById: Map<string, Media>): boolean {
	const media = mediaById.get(mediaId);
	if (!media) return false;
	if (typeof offsetMs !== 'number' || !Number.isFinite(offsetMs)) return false;
	media.guideOffsetMs = Math.round(offsetMs);
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
