// Job ledger — the durable state-of-record for make-karaoke processing (Demucs stems, WhisperX
// align, scoring). SQLite is authority here (NOT the transport): workers dial home over WS and the
// ledger tracks ownership/lifecycle. This is the I/O layer; the legal-transition rules live in the
// pure transitions.ts (mirrors store.ts ↔ shared/applyAndReseq). See
// docs/job-lifecycle-and-worker-protocol.md §1, §6, §10.

import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { DB } from '../db/index';
import { jobs } from '../db/schema';
import { ulid, type Job, type JobStatus, type JobType } from '@encore/shared';
import { assertTransition } from './transitions';

// Dedup slot occupancy: a (mediaId, jobType) is "taken" by any job that is NOT failed/canceled —
// the SAME set the partial unique index `jobs_live_media_type_idx` enforces (schema.ts). A `ready`
// job still occupies the slot (stems already exist → reuse the result, skip the worker), only a
// failed/canceled job frees it so the song can be re-processed.
const SLOT_FREEING_STATUSES: JobStatus[] = ['failed', 'canceled'];

/** Optional fields a transition can patch alongside the status change. */
export interface JobPatch {
	workerId?: string | null;
	stage?: string | null;
	progressPct?: number;
	etaSec?: number | null;
	error?: string | null;
	leaseExpiresAt?: number | null;
	priority?: number;
	attempts?: number;
}

export class JobRepository {
	#db: DB;
	constructor(db: DB) {
		this.#db = db;
	}

	/**
	 * Enqueue a job for (mediaId, jobType), or REUSE the existing live one (idempotent — §6 dedup).
	 * Two singers queueing the same song get one job; the second add just subscribes to it. A new
	 * job is only created when no slot-occupying job exists (i.e. the previous one failed/canceled,
	 * or there never was one).
	 */
	enqueue(mediaId: string, jobType: JobType, priority: number, now: number): Job {
		const existing = this.findLive(mediaId, jobType);
		if (existing) return existing;

		const job: Job = {
			id: ulid(now),
			mediaId,
			jobType,
			status: 'queued',
			priority,
			attempts: 0,
			maxAttempts: 3,
			workerId: null,
			stage: null,
			progressPct: 0,
			etaSec: null,
			leaseExpiresAt: null,
			createdAt: now,
			updatedAt: now
		};
		this.#db.insert(jobs).values({ ...job, error: null }).run();
		return job;
	}

	byId(id: string): Job | null {
		return this.#toJob(this.#db.select().from(jobs).where(eq(jobs.id, id)).all()[0]);
	}

	/** The live (slot-occupying) job for a key, if any — the dedup lookup. */
	findLive(mediaId: string, jobType: JobType): Job | null {
		const row = this.#db
			.select()
			.from(jobs)
			.where(
				and(
					eq(jobs.mediaId, mediaId),
					eq(jobs.jobType, jobType),
					notInArray(jobs.status, SLOT_FREEING_STATUSES)
				)
			)
			.all()[0];
		return this.#toJob(row);
	}

	/** All jobs in any of the given statuses — feeds dispatch (queued) and the reaper (M7-C2). */
	listByStatus(...statuses: JobStatus[]): Job[] {
		if (statuses.length === 0) return [];
		return this.#db.select().from(jobs).where(inArray(jobs.status, statuses)).all().map((r) => this.#toJob(r)!);
	}

	/**
	 * Apply a status change through the pure state machine, patching any provided fields and always
	 * bumping `updatedAt`. Throws on an unknown id or an illegal transition (the machine is the
	 * authority). Returns the updated job.
	 */
	transition(id: string, to: JobStatus, patch: JobPatch, now: number): Job {
		const current = this.byId(id);
		if (!current) throw new Error(`unknown job: ${id}`);
		assertTransition(current.status, to);

		const next = { ...patch, status: to, updatedAt: now };
		this.#db.update(jobs).set(next).where(eq(jobs.id, id)).run();
		return this.byId(id)!;
	}

	// — semantic lifecycle helpers (thin wrappers over transition, named for the wire protocol §5) —

	/** Dispatch: offer the job to a worker; the caller sets the ack-lease deadline (M7-C2). */
	assign(id: string, workerId: string, leaseExpiresAt: number | null, now: number): Job {
		return this.transition(id, 'assigned', { workerId, leaseExpiresAt }, now);
	}

	/** Worker accepted (`job:accept`): begin processing. */
	accept(id: string, now: number): Job {
		return this.transition(id, 'running', {}, now);
	}

	/** Worker progress (`job:progress`): self-loop in `running`, refresh stage/pct/lease. */
	progress(id: string, patch: JobPatch, now: number): Job {
		return this.transition(id, 'running', patch, now);
	}

	/** Worker finished (`job:complete`): terminal `ready`. */
	complete(id: string, now: number): Job {
		return this.transition(id, 'ready', { progressPct: 100, leaseExpiresAt: null, workerId: null }, now);
	}

	/** Terminal failure (retries exhausted or non-retryable). */
	fail(id: string, error: string, now: number): Job {
		return this.transition(id, 'failed', { error, leaseExpiresAt: null, workerId: null }, now);
	}

	/** Song removed before finish (`job:cancel`): terminal `canceled`, frees the dedup slot. */
	cancel(id: string, now: number): Job {
		return this.transition(id, 'canceled', { leaseExpiresAt: null, workerId: null }, now);
	}

	/**
	 * Return a non-terminal job to the queue (worker reject, lease expiry, or boot recovery). The
	 * caller decides whether to increment `attempts` — an ack-timeout doesn't (work never started),
	 * a progress-lease expiry does (M7-C2). Clears the owner + lease.
	 */
	requeue(id: string, attempts: number, now: number): Job {
		return this.transition(id, 'queued', { workerId: null, leaseExpiresAt: null, attempts }, now);
	}

	/** Map a DB row to the shared Job (drops the internal `error` column, which isn't on the type). */
	#toJob(row: typeof jobs.$inferSelect | undefined): Job | null {
		if (!row) return null;
		const { error: _error, ...job } = row;
		return job;
	}
}
