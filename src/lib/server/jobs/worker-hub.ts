// The I/O side of the dial-home protocol: WorkerRegistry + dispatch.ts + JobRepository + lease policy.
// Decoupled from Bun.serve via the `toWorker`/`broadcast` sinks, so it unit-tests with no socket.
// See docs/ARCHITECTURE.md §7.

import type {
	WorkerMessage,
	WorkerCommand,
	ServerEvent,
	MediaStatus,
	Media,
	Job,
	JobType,
	MediaStoreConfig,
	GlobalSettings,
	EffectiveSettings
} from '../../contract';
import { sourceUriFor, resolveProcessSeparator } from '../../contract';
import type { JobRepository } from './repository';
import type { AttemptLedger } from './attempts';
import { WorkerRegistry } from './registry';
import {
	planAssignments,
	assignParams,
	followUps,
	requiredCapability,
	separatorFor,
	publishesInstrumental,
	inheritsProcess,
	hasCapableWorker
} from './dispatch';
import {
	markMediaReady,
	setMediaLyrics,
	setMediaVocals,
	setMediaGuideMix,
	setMediaSongProfile,
	applyAnnotation,
	settleLyricsGate,
	reportTerminalFailure,
	markLyricsQueued,
	type TerminalFailureDeps
} from './process';
import { cleanJobWork } from '../media/migrate-layout';
import { ackDeadline, progressDeadline, attemptsExhausted, DEFAULT_LEASE_CONFIG, type LeaseConfig } from './leases';
import { completedStatusFor, mediaStatusFor, shouldBroadcastProcess } from './media-status';

export type ToWorker = (workerId: string, cmd: WorkerCommand) => void;
export type Broadcast = (event: ServerEvent) => void;

/** Ceiling on continuous unservability before terminal `failed`; without it the job parks `queued`
 *  forever. Two minutes rides out a worker restart or a fleet coming up, without hanging a job that is
 *  genuinely unservable. */
const UNSERVABLE_TTL_MS = 120_000;

export interface WorkerHubDeps {
	jobs: JobRepository;
	/** Per-attempt history. Optional so the hub still unit-tests bare; app.ts wires it. */
	attempts?: AttemptLedger;
	registry: WorkerRegistry;
	mediaById: Map<string, Media>;
	/** Deletes the guide-mix FILE when a completion carries no mix. Without it the stale-but-valid mix
	 *  survives and the next boot's backfill re-adopts it, pinning the room to superseded stems. */
	discardGuideMix?: (mediaId: string) => void | Promise<void>;
	/** `'silent'` REFUSES the completion; `'unknown'` still PUBLISHES — an unmeasurable file (no ffmpeg
	 *  on the host) is not silence, and refusing on it would be a self-inflicted outage. */
	verifyInstrumental?: (ref: string) => Promise<'audible' | 'silent' | 'unknown'>;
	toWorker: ToWorker; // send a WorkerCommand to ONE worker session
	broadcast: Broadcast; // media:status to the whole room
	/** Fired AFTER a media flips ready, so a held song plays at its fair slot if the room idled. */
	onMediaReady?: (mediaId: string) => void;
	/** Optional so the hub unit-tests with no DB; app.ts wires it to MediaRepository.upsert. */
	persistMedia?: (mediaId: string) => void;
	/** EFFECTIVE, not just global: the room's downward-only quality ceiling must reach both the engine a
	 *  stems job is dispatched with AND the capability it is routed by. */
	getSettings?: () => EffectiveSettings;
	now: () => number;
	config?: LeaseConfig;
	mediaStore?: MediaStoreConfig;
}

/** Validates an inbound frame BEFORE anything reads a field off it. This family carries DISPATCH
 *  AUTHORITY and is reachable UNAUTHENTICATED whenever `ENCORE_WORKER_TOKEN` is unset, so a malformed
 *  frame must never throw out of the socket handler. Returns an error string, or null when shape-safe. */
export function validateWorkerMessage(msg: unknown): string | null {
	if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return 'malformed worker frame';
	const m = msg as Record<string, unknown>;
	if (typeof m.type !== 'string') return 'missing worker frame type';
	if (typeof m.workerId !== 'string' || m.workerId.length === 0) return 'missing workerId';
	switch (m.type) {
		case 'worker:hello':
			if (!Array.isArray(m.capabilities) || !m.capabilities.every((c) => typeof c === 'string'))
				return 'malformed capabilities';
			if (typeof m.concurrency !== 'number' || !Number.isFinite(m.concurrency)) return 'malformed concurrency';
			if (typeof m.version !== 'string') return 'malformed version';
			return null;
		case 'worker:heartbeat':
			if (typeof m.slotsFree !== 'number' || !Number.isFinite(m.slotsFree)) return 'malformed slotsFree';
			if (!Array.isArray(m.runningJobIds) || !m.runningJobIds.every((j) => typeof j === 'string'))
				return 'malformed runningJobIds';
			return null;
		case 'job:accept':
			if (typeof m.jobId !== 'string' || m.jobId.length === 0) return 'missing jobId';
			return null;
		case 'job:reject':
			if (typeof m.jobId !== 'string' || m.jobId.length === 0) return 'missing jobId';
			if (typeof m.reason !== 'string') return 'malformed reason';
			return null;
		case 'job:progress':
			if (typeof m.jobId !== 'string' || m.jobId.length === 0) return 'missing jobId';
			if (typeof m.stage !== 'string') return 'malformed stage';
			if (typeof m.pct !== 'number' || !Number.isFinite(m.pct)) return 'malformed pct';
			return null;
		case 'job:complete':
			if (typeof m.jobId !== 'string' || m.jobId.length === 0) return 'missing jobId';
			if (typeof m.mediaUri !== 'string') return 'malformed mediaUri';
			return null;
		case 'job:failed':
			if (typeof m.jobId !== 'string' || m.jobId.length === 0) return 'missing jobId';
			if (typeof m.error !== 'string') return 'malformed error';
			if (typeof m.retryable !== 'boolean') return 'malformed retryable';
			return null;
		default:
			return 'unknown worker frame type';
	}
}

export class WorkerHub {
	#d: WorkerHubDeps;
	#config: LeaseConfig;
	/** First-unservable stamps, so the loop neither reprints its warning every pass nor loses the clock
	 *  UNSERVABLE_TTL_MS measures. Pruned on every terminal path or an id for a job that died while
	 *  queued leaks. */
	#unservableSince = new Map<string, number>();
	constructor(deps: WorkerHubDeps) {
		this.#d = deps;
		this.#config = deps.config ?? DEFAULT_LEASE_CONFIG;
		// Slot release is EVENT-keyed and covers REJECT/COMPLETE only; FAIL releases explicitly at its
		// own call site (#onFailed). See docs/SERVER.md#idempotency-and-the-process-cap.
		this.#d.jobs.setSlotReleaseHook((workerId) => this.#d.registry.releaseSlot(workerId));
	}

	/** The room's downward-only quality ceiling resolved INTO `defaultEngine`/`defaultModel`, because
	 *  dispatch.ts reads those fields for both the dispatched params and the routing capability — a
	 *  demucs-capped process must not be sent to a roformer worker. Only the stems pairing is rewritten. */
	#processSettings(): GlobalSettings | undefined {
		const effective = this.#d.getSettings?.();
		if (!effective) return undefined;
		const { engine, model } = resolveProcessSeparator(effective);
		return { ...effective.global, defaultEngine: engine, defaultModel: model };
	}

	/** The sink bag every terminal path here hands `reportTerminalFailure` — named ONCE so a worker
	 *  failure, a refused silent instrumental and the unservable TTL cannot settle through different
	 *  sinks (in particular so none of the three loses the durable `persist` half). */
	#failureSinks(): TerminalFailureDeps {
		return {
			broadcast: (e) => this.#d.broadcast(e),
			mediaById: this.#d.mediaById,
			persist: (mediaId) => this.#d.persistMedia?.(mediaId)
		};
	}

	/** Effects go through the injected sinks. */
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
		// `cpuCount` is the worker's EFFECTIVE count; `(contained)` marks a slice of a bigger box.
		const hw = msg.host
			? `${msg.host.accelerator ?? (msg.host.cuda ? 'cuda' : 'cpu')}/${msg.host.cpuCount ?? '?'}cpu${msg.host.contained ? ' (contained)' : ''}`
			: 'hardware unreported';
		console.log(
			`[hub] worker ${msg.workerId} joined: ${hw}, caps=[${msg.capabilities.join(',')}], slots=${msg.concurrency}`
		);
		this.#d.toWorker(msg.workerId, {
			type: 'worker:welcome',
			// HALF the progress lease: at the full value one dropped tick breaches the lease and the
			// reaper requeues a healthy process as `progress-lease-expired`.
			heartbeatIntervalSec: Math.floor(this.#config.progressLeaseMs / 1000 / 2),
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
		// REJECT frees the slot via the machine's slot-release hook (reads the owner pre-write).
		this.#d.jobs.requeue(msg.jobId, job.attempts, this.#d.now(), 'REJECT');
		this.dispatch();
	}

	/** running self-loop: refresh lease + rebroadcast the live progress bar. */
	#onProgress(msg: Extract<WorkerMessage, { type: 'job:progress' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return;
		const updated = this.#d.jobs.progress(
			msg.jobId,
			{
				stage: msg.stage,
				progressPct: msg.pct,
				etaSec: msg.etaSec ?? null,
				leaseExpiresAt: progressDeadline(this.#d.now(), this.#config)
			},
			this.#d.now()
		);
		this.#emitStatus(updated, msg.stage);
	}

	/** running → ready (terminal): publish the instrumental, free the slot, reconcile playback. */
	#onComplete(msg: Extract<WorkerMessage, { type: 'job:complete' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return; // stale

		// Verifying spawns ffmpeg and decodes the whole file, so it gates completion ASYNCHRONOUSLY and
		// re-checks staleness on entry — the reaper can fail this job while the probe is still decoding.
		const reported = msg.artifacts?.stems?.instrumental;
		if (this.#d.verifyInstrumental && publishesInstrumental(job.jobType) && reported) {
			void this.#d.verifyInstrumental(reported).then(
				(verdict) => {
					if (verdict === 'silent') this.#refuseSilentInstrumental(msg, reported);
					else this.#completeVerified(msg);
				},
				() => this.#completeVerified(msg) // probe threw — unmeasurable, not silent
			);
			return;
		}
		this.#completeVerified(msg);
	}

	/** Terminal and non-retryable: the same separator over the same source reproduces the same silence,
	 *  so a requeue would only burn every remaining attempt to arrive back here. */
	#refuseSilentInstrumental(msg: Extract<WorkerMessage, { type: 'job:complete' }>, ref: string): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return; // stale
		this.#unservableSince.delete(msg.jobId);
		this.#d.registry.releaseSlot(msg.workerId);
		const updated = this.#d.jobs.fail(
			msg.jobId,
			`instrumental measures as digital silence (${ref}) — refused rather than published as ready`,
			this.#d.now(),
			job.attempts + 1
		);
		console.warn(
			`[core] refused a silent instrumental for media ${job.mediaId}: the worker reported ${ref}, ` +
				'which measures at or below the silence floor. The song stays un-processed.'
		);
		reportTerminalFailure(updated, 'worker', this.#failureSinks());
	}

	/** The completion body proper, reached once the reported instrumental is not measurably silent. */
	#completeVerified(msg: Extract<WorkerMessage, { type: 'job:complete' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return; // stale
		this.#unservableSince.delete(msg.jobId); // terminal — prune any stale unservable tracking
		// MUST precede `complete`, which seals the attempt row; a sealed row is never written again.
		this.#d.attempts?.reportFacts(msg.jobId, {
			...(msg.facts ?? {}),
			stages: msg.stages?.length ? JSON.stringify(msg.stages) : undefined,
			selection: msg.selection ? JSON.stringify(msg.selection) : undefined
		});
		const updated = this.#d.jobs.complete(msg.jobId, this.#d.now());
		const settings = this.#processSettings();
		const separator = separatorFor(job.jobType, settings);
		if (publishesInstrumental(job.jobType)) {
			// Every setter below is guarded on `accepted`: markMediaReady returns false for a stems-upgrade
			// that does not outrank the published separator, and a refusal must change NOTHING — an
			// unguarded setMediaSongProfile would wipe the song's existing key and vocal range.
			const accepted = markMediaReady(job.mediaId, this.#d.mediaById, msg.artifacts?.stems?.instrumental, separator);
			if (accepted) {
				setMediaVocals(job.mediaId, msg.artifacts?.stems?.vocals, this.#d.mediaById);
				// Read through its DECLARED wire field. An absent mix clears the ref AND deletes the file,
				// or the next boot's backfill re-adopts a mix built from the stems this frame replaced.
				if (!setMediaGuideMix(job.mediaId, msg.artifacts?.stems?.guideMix, this.#d.mediaById)) {
					void this.#d.discardGuideMix?.(job.mediaId);
				}
				// A SIBLING of `stems`, not a member, and written even on an empty report: its PRESENCE
				// alone completes the stems gate (gates.ts).
				setMediaSongProfile(job.mediaId, msg.artifacts?.songProfile, this.#d.mediaById);
			}
		}
		applyAnnotation(job.mediaId, this.#d.mediaById, msg.artifacts?.annotation);
		setMediaLyrics(job.mediaId, msg.artifacts?.lyrics?.uri, this.#d.mediaById, msg.artifacts?.lyrics?.candidates);
		// The gate is satisfied by align having RUN, not by it having found words. After setMediaLyrics,
		// so the artifact is already attached when there is one.
		if (job.jobType === 'align') settleLyricsGate(job.mediaId, this.#d.mediaById);
		this.#d.persistMedia?.(job.mediaId);
		cleanJobWork(msg.jobId);
		// Follow-ups enqueue AFTER cleanJobWork, so each gets its own scratch dir.
		for (const next of followUps(job.jobType, settings)) {
			// `inheritsProcess` carries the process id AND the singer attribution together; see
			// docs/SERVER.md#idempotency-and-the-process-cap.
			this.#d.jobs.enqueue(
				job.mediaId,
				next,
				job.priority,
				this.#d.now(),
				inheritsProcess(next) ? job.processingId : undefined,
				inheritsProcess(next) ? (job.singerId ?? undefined) : undefined
			);
			if (next === 'align') markLyricsQueued(job.mediaId, this.#d.mediaById);
		}
		this.#emitStatus(updated);
		this.#d.onMediaReady?.(job.mediaId);
		this.dispatch();
	}

	/** running → requeue (retryable, attempts left) or failed (terminal). Frees the slot either way. */
	#onFailed(msg: Extract<WorkerMessage, { type: 'job:failed' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return;
		this.#unservableSince.delete(msg.jobId); // terminal or requeue — prune stale unservable tracking
		const attempts = job.attempts + 1;
		if (msg.retryable && !attemptsExhausted(attempts, job.maxAttempts)) {
			// Released EXPLICITLY, not via the slot-release hook, which never fires for FAIL or
			// LEASE_EXPIRED — the reaper's dead-worker paths share those events and must not double-free a
			// slot the registry reclaims itself. The `workerId` guard above proves this worker is alive.
			this.#d.registry.releaseSlot(msg.workerId);
			this.#d.jobs.requeue(msg.jobId, attempts, this.#d.now());
			this.dispatch();
		} else {
			this.#d.registry.releaseSlot(msg.workerId); // same explicit release, same reason as above
			const updated = this.#d.jobs.fail(msg.jobId, msg.error, this.#d.now(), attempts);
			// An unsettled gate makes the song unsingable forever, so all three fail paths route through
			// this one epilogue (see reportTerminalFailure).
			reportTerminalFailure(updated, 'worker', this.#failureSinks());
		}
	}

	/** Plans assignments against live capacity, then per job: assign (ack lease) + claim slot + send
	 *  job:assign. Idempotent — safe after any event that frees capacity or enqueues work. */
	dispatch(): void {
		const queued = this.#d.jobs.listByStatus('queued');
		if (queued.length === 0) return;
		const workers = this.#d.registry.list();
		const now = this.#d.now();

		// Routed by the SETTINGS-resolved capability (e.g. stems:roformer), not the bare job type, so a
		// room-lowered process quality reaches a matching worker.
		const settings = this.#processSettings();
		const capabilityFor = (j: { jobType: JobType }) => requiredCapability(j.jobType, settings);

		// "Waiting for a slot" and "no worker can EVER run this" must stay distinguishable: conflated,
		// a missing capability reads as a hung worker with the song at 0% forever.
		for (const job of queued) {
			if (hasCapableWorker(job, workers, capabilityFor)) continue;
			const since = this.#unservableSince.get(job.id);
			if (since !== undefined) {
				if (now - since >= UNSERVABLE_TTL_MS) {
					const cap = capabilityFor(job);
					const updated = this.#d.jobs.fail(
						job.id,
						`no connected worker advertised capability '${cap}' within ${Math.round(UNSERVABLE_TTL_MS / 1000)}s`,
						now
					);
					this.#unservableSince.delete(job.id);
					reportTerminalFailure(updated, 'unservable', this.#failureSinks());
				}
				continue;
			}
			this.#unservableSince.set(job.id, now);
			const cap = capabilityFor(job);
			console.warn(
				`[hub] job ${job.id} (${job.jobType}) needs capability '${cap}' and NO connected worker ` +
					`advertises it — it will stay queued until one does or ${Math.round(UNSERVABLE_TTL_MS / 1000)}s elapse. ` +
					`Connected: ${workers.length === 0 ? 'none' : workers.map((w) => `${w.workerId}[${w.capabilities.join(',')}]`).join(' ')}`
			);
			// Only tell the ROOM when the stall blocks singing: broadcasting 'queued' for an unservable
			// `align` on a playable song would regress a ready row to processing on every phone.
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
			const params = assignParams(pending.jobType, media, settings);
			// The REQUEST, not the truth: a worker's own resolved model overwrites these via reportFacts.
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
				jobId: job.id, // the span id
				processingId: job.processingId, // the trace id across a chained fetch→stems→align run
				mediaId: job.mediaId,
				jobType: job.jobType,
				sourceUri: media ? sourceUriFor(media, this.#d.getSettings?.()?.global.defaultFetcher) : '',
				params
			});
		}
	}

	/** Broadcasts where the SONG is, never the job's own status — media-status.ts owns that translation,
	 *  and a terminal completion asks the MEDIA's gates via `completedStatusFor`. */
	#emitStatus(job: Job, stage?: MediaStatus): void {
		const media = this.#d.mediaById.get(job.mediaId);
		if (!shouldBroadcastProcess(job, media)) return;
		this.#d.broadcast({
			type: 'media:status',
			mediaId: job.mediaId,
			status: job.status === 'ready' ? completedStatusFor(job, media) : mediaStatusFor(job, stage),
			pct: job.progressPct,
			etaSec: job.etaSec ?? undefined
		});
	}
}
