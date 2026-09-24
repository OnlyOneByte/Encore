// The durable state-of-record for job processing. I/O layer only — legal-transition rules live in the
// pure transitions.ts. See docs/ARCHITECTURE.md §7 and docs/SERVER.md#the-attempt-ledger.

import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { DB } from '../db/index';
import { jobs } from '../db/schema';
import {
	ulid,
	isTerminalJob,
	type Job,
	type JobStatus,
	type JobType,
	type JobEvent,
	type AttemptOutcome
} from '../../contract';
import { assertEvent } from './transitions';
import type { AttemptLedger, AttemptFacts } from './attempts';

// A (mediaId, jobType) is "taken" by any job NOT failed/canceled — the same set the partial unique index
// `jobs_live_media_type_idx` enforces. A `ready` job STILL occupies the slot; only failed/canceled frees it.
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

// Driven off the EVENT inside `transition` rather than re-derived per wrapper. A requeue seals
// `abandoned`; terminal events seal their own name. DISPATCH/ACCEPT/PROGRESS/REPRIORITIZE seal nothing —
// DISPATCH/ACCEPT instead PATCH the open attempt via `assign`/`accept`, data the machine does not have.
const OUTCOME_FOR_EVENT: Partial<Record<JobEvent, AttemptOutcome>> = {
	COMPLETE: 'ready',
	FAIL: 'failed',
	CANCEL: 'canceled',
	REJECT: 'abandoned',
	LEASE_EXPIRED: 'abandoned',
	RECOVER: 'abandoned'
};

/** The requeue events — those that seal the old attempt AND open a fresh one after the status write. */
const REQUEUE_EVENTS: ReadonlySet<JobEvent> = new Set<JobEvent>(['REJECT', 'LEASE_EXPIRED', 'RECOVER']);

// WORKER-REPORTED events ONLY, and the exclusions are deliberate — see
// docs/SERVER.md#idempotency-and-the-process-cap. Adding FAIL, LEASE_EXPIRED, RECOVER or CANCEL here
// double-frees a slot the registry already reclaims, which drives an assign/reject storm.
const SLOT_RELEASING_EVENTS: ReadonlySet<JobEvent> = new Set<JobEvent>(['REJECT', 'COMPLETE']);

export class JobRepository {
	#db: DB;
	#ledger: AttemptLedger | null;
	#releaseSlot: ((workerId: string) => void) | null = null;
	/** OPTIONAL — a missing ledger is a no-op, never a throw: it is observability, not correctness. */
	constructor(db: DB, ledger?: AttemptLedger) {
		this.#db = db;
		this.#ledger = ledger ?? null;
	}

	/** Injected rather than constructor-passed, since app.ts builds the registry after the repository.
	 *  Fires on a SLOT_RELEASING_EVENT with the owning worker id read PRE-write, before the patch clears
	 *  `workerId`. */
	setSlotReleaseHook(release: (workerId: string) => void): void {
		this.#releaseSlot = release;
	}

	/** REUSES the existing live job when there is one (idempotent dedup), without re-opening an attempt:
	 *  the caller is subscribing to work already in flight. An omitted `processingId` mints a new process
	 *  id. A REUSED job keeps its ORIGINAL requester rather than being re-attributed to the second tap. */
	enqueue(
		mediaId: string,
		jobType: JobType,
		priority: number,
		now: number,
		processingId?: string,
		singerId?: string
	): Job {
		const existing = this.findLive(mediaId, jobType);
		if (existing) return existing;

		const job: Job = {
			id: ulid(now),
			mediaId,
			processingId: processingId ?? ulid(now),
			singerId: singerId ?? null,
			jobType,
			status: 'queued',
			priority,
			attempts: 0,
			maxAttempts: 3,
			workerId: null,
			stage: null,
			progressPct: 0,
			etaSec: null,
			error: null,
			leaseExpiresAt: null,
			createdAt: now,
			updatedAt: now
		};
		this.#db.insert(jobs).values(job).run();
		this.#ledger?.open(job, now);
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
			.where(and(eq(jobs.mediaId, mediaId), eq(jobs.jobType, jobType), notInArray(jobs.status, SLOT_FREEING_STATUSES)))
			.all()[0];
		return this.#toJob(row);
	}

	/** Frees a FINISHED job's dedup slot so the song can be re-processed. Without it a re-run silently
	 *  does nothing, because `ready` is terminal (no `cancel()` edge) and `enqueue` hands the old job
	 *  back. Deletes only the row `findLive` names, and only when TERMINAL, so a running worker's job can
	 *  never be yanked away. `job_attempts` is untouched, so the audit trail survives. */
	supersedeForRerun(mediaId: string, jobType: JobType): boolean {
		const job = this.findLive(mediaId, jobType);
		if (!job || !isTerminalJob(job.status)) return false;
		this.#db.delete(jobs).where(eq(jobs.id, job.id)).run();
		return true;
	}

	/** The first not-yet-finished job in pipeline order — checked across all three steps, so a song
	 *  mid-fetch or mid-align is not reported idle. `stems-upgrade` is excluded: background work on an
	 *  already-finished song is not a step the room waits on. */
	findOutstandingForMedia(mediaId: string): Job | null {
		const chain: JobType[] = ['fetch', 'stems', 'align'];
		for (const jobType of chain) {
			const job = this.findLive(mediaId, jobType);
			if (!job) continue; // never enqueued (a local file skips fetch) — look further down the chain
			if (job.status !== 'ready') return job; // the step in flight or waiting
		}
		return null; // every enqueued step finished
	}

	/** All jobs in any of the given statuses — feeds dispatch (queued) and the reaper. */
	listByStatus(...statuses: JobStatus[]): Job[] {
		if (statuses.length === 0) return [];
		return this.#db
			.select()
			.from(jobs)
			.where(inArray(jobs.status, statuses))
			.all()
			.map((r) => this.#toJob(r)!);
	}

	/** The EVENT, not a bare destination status, is the input — the machine can tell a REJECT from a
	 *  LEASE_EXPIRED even though both land on `queued`. Throws on an illegal event or unknown id. */
	transition(id: string, event: JobEvent, patch: JobPatch, now: number): Job {
		const current = this.byId(id);
		if (!current) throw new Error(`unknown job: ${id}`);
		const to = assertEvent(current.status, event);

		// Sealed BEFORE the row write, so the abandon dates from the pre-transition attempt; the fresh
		// attempt opens AFTER it, so its number counts the row just sealed. Reordering breaks both.
		const outcome = OUTCOME_FOR_EVENT[event];
		if (outcome) this.#ledger?.closed(id, outcome, now, patch.error ?? null);

		// PRE-WRITE row, because a requeue patch (REJECT) clears `workerId` before the write.
		if (current.workerId && SLOT_RELEASING_EVENTS.has(event)) this.#releaseSlot?.(current.workerId);

		const next = { ...patch, status: to, updatedAt: now };
		this.#db.update(jobs).set(next).where(eq(jobs.id, id)).run();
		const updated = this.byId(id)!;

		// A requeue opens the next attempt dated from now, not the abandoned attempt's queue time.
		if (REQUEUE_EVENTS.has(event)) this.#ledger?.open(updated, now);
		return updated;
	}

	/** A status-free scheduling write, so it bypasses `transition`: `queued → queued` is deliberately not
	 *  a legal edge, and opening one would let a lease-expiry requeue masquerade as a no-op update. Can
	 *  only ever LOWER the number, which is what makes it safe to call on every queue add. */
	reprioritize(id: string, priority: number, now: number): Job {
		const current = this.byId(id);
		if (!current) throw new Error(`unknown job: ${id}`);
		if (isTerminalJob(current.status)) return current;
		if (priority >= current.priority) return current;
		// The guards above stay: they encode policy the pure machine does not know (only-lower, terminal).
		return this.transition(id, 'REPRIORITIZE', { priority }, now);
	}

	/** Dispatch: offer the job to a worker; the caller sets the ack-lease deadline. */
	assign(id: string, workerId: string, leaseExpiresAt: number | null, now: number, facts: AttemptFacts = {}): Job {
		const job = this.transition(id, 'DISPATCH', { workerId, leaseExpiresAt }, now);
		this.#ledger?.assigned(id, workerId, facts, now);
		return job;
	}

	/** Stamps a fresh PROGRESS lease: the ack lease no longer applies, so a worker accepting near the ack
	 *  deadline is not instantly reaped as dead. */
	accept(id: string, leaseExpiresAt: number | null, now: number): Job {
		const job = this.transition(id, 'ACCEPT', { leaseExpiresAt }, now);
		this.#ledger?.started(id, now);
		return job;
	}

	/** Worker progress (`job:progress`): self-loop in `running`, refresh stage/pct/lease. */
	progress(id: string, patch: JobPatch, now: number): Job {
		return this.transition(id, 'PROGRESS', patch, now);
	}

	/** Worker finished (`job:complete`): terminal `ready`. */
	complete(id: string, now: number): Job {
		// `transition` seals the attempt `ready` off the COMPLETE event (see OUTCOME_FOR_EVENT).
		return this.transition(id, 'COMPLETE', { progressPct: 100, leaseExpiresAt: null, workerId: null }, now);
	}

	/** `attempts` is optional: the reaper passes the final exhausting count, a direct non-retryable fail
	 *  omits it and leaves the count as-is. */
	fail(id: string, error: string, now: number, attempts?: number): Job {
		const patch: JobPatch = { error, leaseExpiresAt: null, workerId: null };
		if (attempts !== undefined) patch.attempts = attempts;
		// `transition` seals the attempt `failed` off the FAIL event, reading the error from `patch`.
		return this.transition(id, 'FAIL', patch, now);
	}

	/** Song removed before finish (`job:cancel`): terminal `canceled`, frees the dedup slot. */
	cancel(id: string, now: number): Job {
		// `transition` seals the attempt `canceled` off the CANCEL event.
		return this.transition(id, 'CANCEL', { leaseExpiresAt: null, workerId: null }, now);
	}

	/** `cause` names WHY — REJECT, LEASE_EXPIRED or boot RECOVER — three distinct events all landing on
	 *  `queued`, validated against the machine so a caller cannot smuggle in one the status forbids. The
	 *  CALLER decides whether `attempts` increments: an ack-timeout does not, a progress expiry does. */
	requeue(id: string, attempts: number, now: number, cause: JobEvent = 'LEASE_EXPIRED'): Job {
		// Both ledger writes ride the machine off `cause` (see REQUEUE_EVENTS).
		return this.transition(id, cause, { workerId: null, leaseExpiresAt: null, attempts }, now);
	}

	/** What the per-singer cap is derived from. Counts only a live ROOT-process job (`fetch`/`stems`),
	 *  never a chained follow-up: `align`/`stems-upgrade` inherit the same `singerId` but are downstream
	 *  of an already-admitted process, so counting them lets one process consume several cap slots.
	 *  Ledger-backed, never entry-derived — see docs/SERVER.md#idempotency-and-the-process-cap. */
	liveProcessMediaForSinger(singerId: string): Set<string> {
		const rows = this.#db
			.select({ mediaId: jobs.mediaId })
			.from(jobs)
			.where(
				and(
					eq(jobs.singerId, singerId),
					inArray(jobs.jobType, ['fetch', 'stems']),
					notInArray(jobs.status, [...SLOT_FREEING_STATUSES, 'ready'])
				)
			)
			.all();
		return new Set(rows.map((r) => r.mediaId));
	}

	/** The row shape mirrors Job 1:1 — see schema.ts. */
	#toJob(row: typeof jobs.$inferSelect | undefined): Job | null {
		return row ?? null;
	}
}
