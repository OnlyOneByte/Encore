// Worker hub — the I/O brain of the dial-home protocol (§5). Bridges the in-memory WorkerRegistry,
// the pure dispatcher (dispatch.ts), the durable JobRepository (M7-C1), and lease policy (M7-C2).
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
	JobStatus,
	MediaStoreConfig
} from '@encore/shared';
import type { JobRepository } from './repository';
import { WorkerRegistry } from './registry';
import { planAssignments } from './dispatch';
import { markMediaReady } from './make-karaoke';
import { ackDeadline, progressDeadline, DEFAULT_LEASE_CONFIG, type LeaseConfig } from './leases';

export type ToWorker = (workerId: string, cmd: WorkerCommand) => void;
export type Broadcast = (event: ServerEvent) => void;

export interface WorkerHubDeps {
	jobs: JobRepository;
	registry: WorkerRegistry;
	/** Resolve a media's source URI (youtube id / file key) so the worker can pull it. */
	mediaById: Map<string, Media>;
	toWorker: ToWorker; // send a WorkerCommand to ONE worker session
	broadcast: Broadcast; // media:status to the whole room
	/** Fired AFTER a media flips to ready (stems done): lets the core reconcile playback so a held
	 *  song plays at its fair slot if the room idled while it cooked (M7-C6). Optional. */
	onMediaReady?: (mediaId: string) => void;
	now: () => number;
	config?: LeaseConfig;
	mediaStore?: MediaStoreConfig;
}

/** Map a worker stage / job status to the phone-facing media:status (§5: stage maps 1:1). */
function mediaStatusFor(job: Job, stage?: MediaStatus): MediaStatus {
	if (stage) return stage;
	const map: Record<JobStatus, MediaStatus> = {
		queued: 'queued',
		assigned: 'queued',
		running: 'separating', // generic "working"; refined by the worker's reported stage
		ready: 'ready',
		failed: 'failed',
		canceled: 'failed'
	};
	return map[job.status];
}

export class WorkerHub {
	#d: WorkerHubDeps;
	#config: LeaseConfig;
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
		this.#d.registry.hello(msg.workerId, msg.capabilities, msg.concurrency, msg.version, this.#d.now());
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
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return;
		const updated = this.#d.jobs.complete(msg.jobId, this.#d.now());
		// Flip the media to ready: playMode→file, sourceRef→the instrumental key, stemStatus→ready.
		// rotation's isEntryReady now returns true, so the held entry becomes playable at its slot.
		markMediaReady(job.mediaId, this.#d.mediaById);
		this.#d.registry.releaseSlot(msg.workerId);
		this.#emitStatus(updated);
		this.#d.onMediaReady?.(job.mediaId); // core reconciles playback (start if idle / preload)
		this.dispatch();
	}

	/** running → requeue (retryable, attempts left) or failed (terminal). Frees the slot either way. */
	#onFailed(msg: Extract<WorkerMessage, { type: 'job:failed' }>): void {
		const job = this.#d.jobs.byId(msg.jobId);
		if (!job || job.status !== 'running' || job.workerId !== msg.workerId) return;
		this.#d.registry.releaseSlot(msg.workerId);
		const attempts = job.attempts + 1;
		if (msg.retryable && attempts < job.maxAttempts) {
			this.#d.jobs.requeue(msg.jobId, attempts, this.#d.now());
			this.dispatch();
		} else {
			const updated = this.#d.jobs.fail(msg.jobId, msg.error, this.#d.now(), attempts);
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

		for (const { jobId, workerId } of planAssignments(queued, workers)) {
			const job = this.#d.jobs.assign(jobId, workerId, ackDeadline(now, this.#config), now);
			this.#d.registry.claimSlot(workerId);
			const media = this.#d.mediaById.get(job.mediaId);
			this.#d.toWorker(workerId, {
				type: 'job:assign',
				jobId: job.id,
				mediaId: job.mediaId,
				jobType: job.jobType,
				sourceUri: media ? sourceUri(media) : '',
				params: { model: job.jobType === 'stems' ? 'htdemucs' : undefined }
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
function sourceUri(media: Media): string {
	return media.source === 'youtube' ? `https://www.youtube.com/watch?v=${media.sourceRef}` : media.sourceRef;
}
