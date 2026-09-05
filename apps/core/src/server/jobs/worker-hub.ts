// Worker hub — the I/O brain of the dial-home protocol (§5). Bridges the in-memory WorkerRegistry,
// the pure dispatcher (dispatch.ts), the durable JobRepository, and lease policy.
// Decoupled from Bun.serve like realtime/hub.ts: it takes a `toWorker` sink (send a WorkerCommand
// to one worker) + a `broadcast` sink (media:status to phones/TV), so it unit-tests with no socket.
//
// Flow: worker:hello → welcome + dispatch; job:accept/progress/complete/failed drive the ledger;
// each lifecycle change rebroadcasts media:status so phones show the live "Separating… 68%" bar.

import type {
	WorkerMessage,
	WorkerCommand,
	ServerEvent,
	MediaStatus,
	Media,
	Job,
	JobType,
	MediaStoreConfig,
	GlobalSettings
} from '@encore/shared';
import { sourceUriFor } from '@encore/shared';
import type { JobRepository } from './repository';
import type { AttemptLedger } from './attempts';
import { WorkerRegistry } from './registry';
import { planAssignments, assignParams, followUps, requiredCapability, separatorFor, publishesInstrumental, inheritsCook, hasCapableWorker } from './dispatch';
import {
	markMediaReady,
	setMediaLyrics,
	setMediaVocals,
	setMediaSongProfile,
	applyAnnotation,
	settleLyricsGate,
	settleStemsGate,
	markLyricsQueued
} from './make-karaoke';
import { cleanJobWork } from '../media/migrate-layout';
import { ackDeadline, progressDeadline, DEFAULT_LEASE_CONFIG, type LeaseConfig } from './leases';
import { mediaStatusFor } from './media-status';

export type ToWorker = (workerId: string, cmd: WorkerCommand) => void;
export type Broadcast = (event: ServerEvent) => void;

/**
 * How long a job may sit continuously unservable (no connected worker advertises its capability)
 * before it is moved to a terminal `failed` state. Without a ceiling such a job parks `queued`
 * forever: it never reaches a terminal state, so the TV and phone wait indefinitely on a song that
 * can never cook. Two minutes is long enough to ride out a worker restart or a fleet that is still
 * coming up, short enough that a genuinely unservable job surfaces as failed rather than hanging.
 */
const UNSERVABLE_TTL_MS = 120_000;

export interface WorkerHubDeps {
	jobs: JobRepository;
	/** Per-attempt history. Optional so the hub still unit-tests bare; app.ts wires it. */
	attempts?: AttemptLedger;
	registry: WorkerRegistry;
	/** Resolve a media's source URI (youtube id / file key) so the worker can pull it. */
	mediaById: Map<string, Media>;
	toWorker: ToWorker; // send a WorkerCommand to ONE worker session
	broadcast: Broadcast; // media:status to the whole room
	/** Fired AFTER a media flips to ready (stems done): lets the core reconcile playback so a held
	 *  song plays at its fair slot if the room idled while it cooked. Optional. */
	onMediaReady?: (mediaId: string) => void;
	/** Persist a media after its artifacts change (durable catalog). Optional so the hub still
	 *  unit-tests with no DB; app.ts wires it to MediaRepository.upsert. */
	persistMedia?: (mediaId: string) => void;
	/** Room-level separator settings: supplies the engine+model a stems/upgrade job carries.
	 *  Optional so the hub still unit-tests without settings (assignParams falls back to defaults). */
	getSettings?: () => GlobalSettings;
	now: () => number;
	config?: LeaseConfig;
	mediaStore?: MediaStoreConfig;
}

export class WorkerHub {
	#d: WorkerHubDeps;
	#config: LeaseConfig;
	/** Job ids already reported as unservable, mapped to the time they FIRST became unservable, so a
	 *  dispatch loop that runs on every event does not reprint the same warning forever AND can fail a
	 *  job that has been unservable past UNSERVABLE_TTL_MS. Pruned on every terminal path (find-a-worker,
	 *  complete, fail, TTL-fail) so ids for jobs that die while still queued cannot leak. */
	#unservableSince = new Map<string, number>();
	constructor(deps: WorkerHubDeps) {
		this.#d = deps;
		this.#config = deps.config ?? DEFAULT_LEASE_CONFIG;
	}

	/** Handle one inbound worker message. Returns nothing — effects go through the injected sinks. */
	handle(msg: WorkerMessage): void {
		switch (msg.type) {
			case 'worker:hello':
				return this.#onHello(msg);
			case 'worker:heartbeat':
				return this.#onHeartbeat(msg);
			case 'job:accept':
				return this.#onAccept(msg);
			case 'job:reject':
				return this.#onReject(msg);
			case 'job:progress':
				return this.#onProgress(msg);
			case 'job:complete':
				return this.#onComplete(msg);
			case 'job:failed':
				return this.#onFailed(msg);
		}
	}

	/** Worker (re)connected: register, send welcome handshake, then dispatch any waiting work. */
	#onHello(msg: Extract<WorkerMessage, { type: 'worker:hello' }>): void {
		this.#d.registry.hello(msg.workerId, msg.capabilities, msg.concurrency, msg.version, this.#d.now(), msg.host);
		// Log what joined, hardware included. On a heterogeneous fleet this is how "why was that cook
		// slow" gets answered from the core's log without shelling into the worker. `cpuCount` is the
		// worker's EFFECTIVE count, so `(contained)` marks a box that was given a slice of a bigger one.
		const hw = msg.host
			? `${msg.host.accelerator ?? (msg.host.cuda ? 'cuda' : 'cpu')}/${msg.host.cpuCount ?? '?'}cpu${msg.host.contained ? ' (contained)' : ''}`
			: 'hardware unreported';
		console.log(
			`[hub] worker ${msg.workerId} joined: ${hw}, caps=[${msg.capabilities.join(',')}], slots=${msg.concurrency}`
		);
		this.#d.toWorker(msg.workerId, {
			type: 'worker:welcome',
			heartbeatIntervalSec: Math.floor(this.#config.progressLeaseMs / 1000),
			ackTimeoutSec: Math.floor(this.#config.ackTimeoutMs / 1000),
			mediaStore: this.#d.mediaStore ?? { kind: 'local' }
		});
		this.dispatch();
	}

	#onHeartbeat(msg: Extract<WorkerMessage, { type: 'worker:heartbeat' }>): void {
		this.#d.registry.heartbeat(msg.workerId, msg.slotsFree, this.#d.now());
	}

	/** assigned → running, stamp a fresh progress lease. */
	#onAccept(msg: Extract<WorkerMessage, { type: 'job:accept' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'assigned' || job.workerId !== msg.workerId) return; // stale
		const updated = this.#d.jobs.accept(msg.jobId, progressDeadline(this.#d.now(), this.#config), this.#d.now());
		this.#emitStatus(updated);
	}

	/** Worker declined (capability/transient) → back to queued, free the slot, try another worker. */
	#onReject(msg: Extract<WorkerMessage, { type: 'job:reject' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'assigned' || job.workerId !== msg.workerId) return;
		this.#d.jobs.requeue(msg.jobId, job.attempts, this.#d.now()); // no attempt burned (never ran)
		this.#d.registry.releaseSlot(msg.workerId);
		this.dispatch();
	}

	/** running self-loop: refresh lease + rebroadcast the live progress bar. */
	#onProgress(msg: Extract<WorkerMessage, { type: 'job:progress' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return;
		const updated = this.#d.jobs.progress(
			msg.jobId,
			{ stage: msg.stage, progressPct: msg.pct, etaSec: msg.etaSec ?? null, leaseExpiresAt: progressDeadline(this.#d.now(), this.#config) },
			this.#d.now()
		);
		this.#emitStatus(updated, msg.stage);
	}

	/** running → ready (terminal): flip media to the playable instrumental, free the slot, broadcast
	 *  ready, then let the core reconcile playback (a held song slots back at its fair position). */
	#onComplete(msg: Extract<WorkerMessage, { type: 'job:complete' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return; // stale
		this.#unservableSince.delete(msg.jobId); // terminal — prune any stale unservable tracking
		// Record what the worker ACTUALLY ran, and its per-stage split, BEFORE completing: `complete`
		// seals the attempt row, and a sealed row is never written again. Ordering matters here.
		this.#d.attempts?.reportFacts(msg.jobId, {
			...(msg.facts ?? {}),
			stages: msg.stages?.length ? JSON.stringify(msg.stages) : undefined
		});
		const updated = this.#d.jobs.complete(msg.jobId, this.#d.now());
		const settings = this.#d.getSettings?.();
		// Flip the media to ready (instrumentalRef→what the worker wrote, stemStatus→
		// ready) so rotation's isEntryReady returns true and the held entry becomes playable.
		// Separation jobs report WHICH engine+model produced the artifact, so an upgrade can be refused
		// when it would not actually improve on what is published.
		const separator = separatorFor(job.jobType, settings);
		// ONLY separation publishes an instrumental. A `fetch` has produced nothing singable, and
		// markMediaReady derives the key when the worker reports none — so calling it here marked the
		// media ready with a key for a file that does not exist.
		if (publishesInstrumental(job.jobType)) {
			markMediaReady(job.mediaId, this.#d.mediaById, msg.artifacts?.stems?.instrumental, separator);
			// The same separation also isolated the vocals — the guiding track. This artifact was
			// arriving on the wire and being dropped, which is why a cooked song had no guide even
			// though the file was sitting on disk next to the instrumental. Additive and independent:
			// a worker that could not encode vocals, or measured them as silence, reports none and the
			// song simply offers no guide.
			setMediaVocals(job.mediaId, msg.artifacts?.stems?.vocals, this.#d.mediaById);
			// The SAME separation also analysed the two stems for key + range and reported it as a third
			// artifact, a SIBLING of `stems` rather than a member of it (a profile is not a file). Persisted
			// here, at the boundary, because its PRESENCE completes the stems cook gate (gates.ts) — so
			// unlike the vocals ref this is written even when the worker found nothing, and
			// setMediaSongProfile normalizes the untrusted frame to a valid profile.
			//
			// Read through the DECLARED wire field, not structurally. This line previously reached into
			// `artifacts.stems.songProfile` while the worker published `artifacts.songProfile`, so the
			// value was always undefined — and with the gate requiring it, every separated song stalled at
			// "Separating vocals" permanently. Unit tests on both sides passed throughout, because each
			// mocked its own shape.
			setMediaSongProfile(job.mediaId, msg.artifacts?.songProfile, this.#d.mediaById);
		}
		// A fetch may have identified the song. Applied under a never-regress rule so a later `medium`
		// cannot downgrade an existing `high` citation. Declined annotation leaves the normalizer's
		// values untouched, which is the honest outcome rather than a guess written as fact.
		applyAnnotation(job.mediaId, this.#d.mediaById, msg.artifacts?.annotation);
		// Attach word-timed lyrics if the job carried an align artifact (the TV overlay). Additive:
		// a stems-only complete leaves lyrics absent; an align complete populates lyricsRef.
		setMediaLyrics(job.mediaId, msg.artifacts?.lyrics?.uri, this.#d.mediaById, msg.artifacts?.lyrics?.candidates);
		// The lyrics GATE is satisfied by align having RUN, not by it having found words: a genuine
		// instrumental completes with no artifact and is still a finished song. Set after setMediaLyrics
		// so the artifact (when there is one) is already attached.
		if (job.jobType === 'align') settleLyricsGate(job.mediaId, this.#d.mediaById);
		// Persist the cooked media NOW (stems key + lyrics) so a restart finds the separated
		// song in the library instead of re-cooking it.
		this.#d.persistMedia?.(job.mediaId);
		this.#d.registry.releaseSlot(msg.workerId);
		// Job scratch is transient by contract — the intermediate WAVs in work/<jobId> are large
		// (a decoded source plus both separated stems) and nothing reads them after this point. Leaving
		// them is how 432MB accumulated under the old layout.
		cleanJobWork(msg.jobId);
		// Enqueue whatever this job unblocks (stems → align + score, and optionally a quality upgrade),
		// AFTER cleanJobWork so the follow-up gets its own scratch dir. Dedup on (mediaId, jobType) means
		// a re-cooked song cannot stack duplicate align jobs; it inherits the completed job's priority so
		// it stays as urgent as the song that needed it.
		for (const next of followUps(job.jobType, settings)) {
			// A chained step continues THIS cook so the song's end-to-end duration spans the whole run;
			// `stems-upgrade` deliberately starts its own (see inheritsCook).
			this.#d.jobs.enqueue(job.mediaId, next, job.priority, this.#d.now(), inheritsCook(next) ? job.cookId : undefined);
			// Name the step the song is now waiting on, so the phone's cooking line can say "Timing
			// lyrics" instead of leaving a finished separation looking idle.
			if (next === 'align') markLyricsQueued(job.mediaId, this.#d.mediaById);
		}
		this.#emitStatus(updated);
		this.#d.onMediaReady?.(job.mediaId); // core reconciles playback (start if idle / preload)
		this.dispatch(); // picks up the follow-up too
	}

	/** running → requeue (retryable, attempts left) or failed (terminal). Frees the slot either way. */
	#onFailed(msg: Extract<WorkerMessage, { type: 'job:failed' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return;
		this.#unservableSince.delete(msg.jobId); // terminal or requeue — prune stale unservable tracking
		this.#d.registry.releaseSlot(msg.workerId);
		const attempts = job.attempts + 1;
		if (msg.retryable && attempts < job.maxAttempts) {
			this.#d.jobs.requeue(msg.jobId, attempts, this.#d.now());
			this.dispatch();
		} else {
			const updated = this.#d.jobs.fail(msg.jobId, msg.error, this.#d.now(), attempts);
			cleanJobWork(msg.jobId); // terminal: nothing will resume from this scratch
			// A PERMANENTLY failed align must not hold the song hostage. Now that singing waits for the
			// lyrics gate, leaving it unsettled would mean one broken metadata step — a worker OOM, a
			// model that will not load — makes the song unsingable forever, with no way out but a manual
			// DB edit. We tried, we are done waiting: settle the gate and let the party continue with no
			// words on screen. The line logged just below is the record of why.
			if (job.jobType === 'align') settleLyricsGate(job.mediaId, this.#d.mediaById);
			// The same argument for the OTHER gate. A dead separation used to leave stemStatus mid-flight,
			// so isCooking stayed true and the song read as "Making karaoke…" forever while cookState
			// answered 'cooking' and refused a retry. Settle it back to un-cooked so the guest can try
			// again; the failure reaches them via #emitStatus below.
			//
			// 'fetch' counts, and that is the common case rather than an edge one: requestMakeKaraoke
			// marks the media cooking BEFORE the download, so a dead fetch (bad URL, no deno, yt-dlp
			// broken) strands it exactly like a dead separation. 'align' is excluded because that song
			// already plays — settleLyricsGate above is its remedy — and 'stems-upgrade' because the
			// song still has its working instrumental, which settleStemsGate refuses to walk back.
			if (job.jobType === 'fetch' || job.jobType === 'stems') {
				settleStemsGate(job.mediaId, this.#d.mediaById);
			}
			// LOG a terminal failure. A dead `align` job is otherwise completely silent — the song still
			// plays, it just never gets lyrics and nothing anywhere says why. The operator needs one line
			// naming the media and the reason, since the jobs table is the only other record.
			console.warn(
				`[core] job ${msg.jobId} (${job.jobType}) FAILED permanently after ${attempts} attempt(s) ` +
					`for media ${job.mediaId}: ${msg.error}`
			);
			this.#emitStatus(updated);
		}
	}

	/**
	 * Dispatch loop (§4): plan assignments for all queued jobs against live worker capacity, then
	 * for each: mark the job assigned (ack lease) + claim the worker's slot + send job:assign.
	 * Idempotent to call after any event that frees capacity or enqueues work.
	 */
	dispatch(): void {
		const queued = this.#d.jobs.listByStatus('queued');
		if (queued.length === 0) return;
		const workers = this.#d.registry.list();
		const now = this.#d.now();

		// A job's required capability is engine-derived (a roformer cook needs stems:roformer),
		// so route by the SETTINGS-resolved capability, not the bare job type.
		const settings = this.#d.getSettings?.();
		const capabilityFor = (j: { jobType: JobType }) => requiredCapability(j.jobType, settings);

		// Separate "waiting for a free slot" from "no connected worker can EVER run this". Both leave
		// the job queued, and conflating them is how a song sits at 0% forever looking like a hung
		// worker: the real cause is that nothing in the fleet advertises the capability, which no
		// amount of waiting fixes. Reported once per job so the log names the missing capability
		// instead of the operator having to infer it.
		for (const job of queued) {
			if (hasCapableWorker(job, workers, capabilityFor)) continue;
			// First time we've seen this job unservable: stamp when, warn once. On a later pass, if it has
			// been continuously unservable past the TTL, move it to terminal `failed` so #emitStatus
			// broadcasts `failed` and the TV/phone can stop waiting on a song that can never cook.
			const since = this.#unservableSince.get(job.id);
			if (since !== undefined) {
				if (now - since >= UNSERVABLE_TTL_MS) {
					const cap = capabilityFor(job);
					const updated = this.#d.jobs.fail(
						job.id,
						`no connected worker advertised capability '${cap}' within ${Math.round(UNSERVABLE_TTL_MS / 1000)}s`,
						now
					);
					this.#unservableSince.delete(job.id); // terminal now — prune so the id cannot leak
					console.warn(
						`[hub] job ${job.id} (${job.jobType}) FAILED: unservable for ${Math.round((now - since) / 1000)}s ` +
							`(needs capability '${cap}', no connected worker ever advertised it)`
					);
					this.#emitStatus(updated);
				}
				continue; // already warned this stall; nothing else to do until the TTL fires
			}
			this.#unservableSince.set(job.id, now);
			const cap = capabilityFor(job);
			console.warn(
				`[hub] job ${job.id} (${job.jobType}) needs capability '${cap}' and NO connected worker ` +
					`advertises it — it will stay queued until one does or ${Math.round(UNSERVABLE_TTL_MS / 1000)}s elapse. ` +
					`Connected: ${workers.length === 0 ? 'none' : workers.map((w) => `${w.workerId}[${w.capabilities.join(',')}]`).join(' ')}`
			);
			// Only tell the ROOM when the stalled job is one that blocks singing. An `align` follow-up
			// on an already-published song is genuinely unservable, but the song is playable and
			// broadcasting a 'queued' status for it would regress a ready song to cooking on every
			// phone — a worse bug than the one being reported. Missing lyrics is not missing audio.
			const media = this.#d.mediaById.get(job.mediaId);
			if (media?.instrumentalRef) continue;
			this.#d.broadcast({
				type: 'media:status',
				mediaId: job.mediaId,
				status: mediaStatusFor(job),
				pct: job.progressPct,
				unservable: true
			});
		}

		for (const { jobId, workerId } of planAssignments(queued, workers, capabilityFor)) {
			this.#unservableSince.delete(jobId); // it found a worker; a later stall is a fresh event
			const pending = this.#d.jobs.byId(jobId);
			if (!pending) continue; // vanished between planning and dispatch
			const media = this.#d.mediaById.get(pending.mediaId);
			const params = assignParams(pending.jobType, media, this.#d.getSettings?.());
			// Record WHAT WAS DISPATCHED onto the attempt, alongside the song's length so the cost can be
			// reported as a rate rather than raw seconds. These are the request, not yet the truth: a
			// worker that reports its own resolved model overwrites them (AttemptLedger.reportFacts).
			const job = this.#d.jobs.assign(jobId, workerId, ackDeadline(now, this.#config), now, {
				engine: params.engine ?? null,
				model: params.model ?? null,
				asrModel: params.asrModel ?? null,
				syncMode: params.syncMode ?? null,
				audioSec: media?.durationSec ?? null
			});
			this.#d.registry.claimSlot(workerId);
			this.#d.toWorker(workerId, {
				type: 'job:assign',
				jobId: job.id,
				mediaId: job.mediaId,
				jobType: job.jobType,
				sourceUri: media ? sourceUriFor(media, this.#d.getSettings?.()?.defaultFetcher) : '',
				params
			});
		}
	}

	#emitStatus(job: Job, stage?: MediaStatus): void {
		this.#d.broadcast({
			type: 'media:status',
			mediaId: job.mediaId,
			status: mediaStatusFor(job, stage),
			pct: job.progressPct,
			etaSec: job.etaSec ?? undefined
		});
	}
}

/** The URI a worker uses to pull the source (youtube → watch URL; local → file key). */
