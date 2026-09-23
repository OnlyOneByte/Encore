// The durable state-of-record for process processing (Demucs stems, WhisperX align, scoring). SQLite
// is authority here, not the transport: workers dial home over WS and the ledger tracks
// ownership/lifecycle. I/O layer; legal-transition rules live in the pure transitions.ts. See
// docs/ARCHITECTURE.md §7.

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

// Dedup slot occupancy: a (mediaId, jobType) is "taken" by any job NOT failed/canceled — the same set
// the partial unique index `jobs_live_media_type_idx` enforces (schema.ts). A `ready` job still
// occupies the slot (reuse the result); only failed/canceled frees it for re-processing.
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

// The attempt OUTCOME each terminal-or-requeue event seals, driven off the event inside `transition`
// rather than re-derived per wrapper. A requeue seals `abandoned`; terminal events seal their own name.
// DISPATCH/ACCEPT/PROGRESS/REPRIORITIZE seal nothing here — DISPATCH/ACCEPT instead PATCH the open
// attempt with dispatch facts / a start time via `assign`/`accept`, data the machine doesn't have.
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

// WORKER-REPORTED events only: a live worker declined (REJECT) or finished (COMPLETE) its job, so its
// slot is free NOW. LEASE_EXPIRED/RECOVER are absent — they fire when the worker is presumed dead, so
// the registry reclaims the slot on the next heartbeat/session-drop instead of double-freeing against
// an in-flight completion. FAIL is absent too, even though a worker-reported failure DOES free a slot,
// because FAIL also arrives from the reaper's exhausted-attempts branch and worker-hub's unservable-TTL
// branch — keying release off FAIL alone would free a slot the reaper's dead worker never actually held,
// driving an assign/reject storm. The worker-reported FAIL instead releases explicitly at its one
// call site (worker-hub.ts `#onFailed`'s terminal branch, guarded by `job.workerId === msg.workerId`
// so the worker is provably alive), so the reaper's own fail correctly frees nothing here. CANCEL is
// absent for the same double-free reason cancel.ts documents: cancel() clears `workerId` before there's
// an owner left to notify, and the worker frees its own slot on the next heartbeat.
const SLOT_RELEASING_EVENTS: ReadonlySet<JobEvent> = new Set<JobEvent>(['REJECT', 'COMPLETE']);

export class JobRepository {
	#db: DB;
	#ledger: AttemptLedger | null;
	#releaseSlot: ((workerId: string) => void) | null = null;
	/** The ledger is OPTIONAL — a missing one is a no-op, never a throw, since it's observability, not
	 *  correctness. app.ts wires it; tests that assert on history pass one in. */
	constructor(db: DB, ledger?: AttemptLedger) {
		this.#db = db;
		this.#ledger = ledger ?? null;
	}

	/** OPTIONAL, injected (not constructor-passed) since app.ts builds the registry after the
	 *  repository. Fires on a SLOT_RELEASING_EVENT with the OWNING worker id read pre-write, before the
	 *  patch clears `workerId`. Unset in tests that never touch capacity — the hook then no-ops. */
	setSlotReleaseHook(release: (workerId: string) => void): void {
		this.#releaseSlot = release;
	}

	/** Enqueues a job for (mediaId, jobType), or REUSES the existing live one (idempotent dedup) — two
	 *  singers queueing the same song get one job, and reusing it does not re-open an attempt since the
	 *  caller is subscribing to work already in flight. `processingId` omitted mints a new process id;
	 *  passed, it threads an existing process through a chained step. `singerId` attributes the process
	 *  to the requester for the per-singer cap; a REUSED job keeps its ORIGINAL requester rather than
	 *  being re-attributed to whoever tapped second. */
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

	/** Frees a FINISHED job's dedup slot so the song can be re-processed. A `ready` job still occupies
	 *  the slot and is TERMINAL (no outgoing `cancel()` edge), so without this a re-run (re-picked
	 *  lyrics, a re-process button) silently does nothing — `enqueue` just hands back the old `ready`
	 *  job. Deletes only the row `findLive` names (the actual slot occupant, never a stray already-freed
	 *  sibling) and only when it's TERMINAL — a live occupant is left untouched and this returns `false`,
	 *  so a running worker's job can never be yanked out from under it. `job_attempts` is untouched, so
	 *  the prior attempt's audit trail survives. Returns true when a row was freed. */
	supersedeForRerun(mediaId: string, jobType: JobType): boolean {
		const job = this.findLive(mediaId, jobType);
		if (!job || !isTerminalJob(job.status)) return false;
		this.#db.delete(jobs).where(eq(jobs.id, job.id)).run();
		return true;
	}

	/** The first not-yet-finished job in pipeline order for this song, or null when nothing is in flight
	 *  — /api/library's "what is processing right now" answer, checked across all three steps (not just
	 *  `stems`) so a song mid-fetch or mid-align isn't reported as idle. `stems-upgrade` is excluded:
	 *  background work on a finished song, not a step the room is waiting on. */
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

	/** Fires a lifecycle EVENT through the pure state machine, patching any provided fields and bumping
	 *  `updatedAt`. The event, not a bare destination status, is the input — the machine can tell a
	 *  REJECT from a LEASE_EXPIRED even though both land on `queued`. Throws on an unknown id or an
	 *  event illegal from the current status. Returns the updated job. */
	transition(id: string, event: JobEvent, patch: JobPatch, now: number): Job {
		const current = this.byId(id);
		if (!current) throw new Error(`unknown job: ${id}`);
		const to = assertEvent(current.status, event);

		// Sealed BEFORE the row write, so a requeue's abandon dates from the pre-transition attempt; a
		// fresh attempt opens AFTER the write (below) so its number counts the row just sealed.
		const outcome = OUTCOME_FOR_EVENT[event];
		if (outcome) this.#ledger?.closed(id, outcome, now, patch.error ?? null);

		// Reads workerId from the PRE-WRITE row: a requeue patch (REJECT) clears it before the write.
		// Release rides ENTERING the released state, so a new terminal path can't forget it.
		if (current.workerId && SLOT_RELEASING_EVENTS.has(event)) this.#releaseSlot?.(current.workerId);

		const next = { ...patch, status: to, updatedAt: now };
		this.#db.update(jobs).set(next).where(eq(jobs.id, id)).run();
		const updated = this.byId(id)!;

		// A requeue opens the next attempt dated from now, not the abandoned attempt's queue time.
		if (REQUEUE_EVENTS.has(event)) this.#ledger?.open(updated, now);
		return updated;
	}

	/** Lowers a queued/in-flight job's priority WITHOUT a status change. `priority` is scheduling
	 *  metadata, not lifecycle (dispatch sorts priority ASC, createdAt ASC); a process snapshots
	 *  `soonestSeqFor` ONCE at enqueue, and if that lands at `NO_QUEUE_PRIORITY` (queue add lost to a
	 *  reconnect) nothing else ever revises it. Bypasses `transition` because `queued → queued` is
	 *  deliberately not a legal edge (transitions.ts) — opening one would let a lease-expiry requeue
	 *  masquerade as a no-op update. Two guards: terminal jobs are never touched, and priority can only
	 *  be LOWERED (more urgent) — so this can unstick a starved process but never demote one another
	 *  entry still needs. No-op when the id is terminal or the new priority isn't strictly lower. */
	reprioritize(id: string, priority: number, now: number): Job {
		const current = this.byId(id);
		if (!current) throw new Error(`unknown job: ${id}`);
		if (isTerminalJob(current.status)) return current;
		if (priority >= current.priority) return current;
		// An in-machine edge (queued|running --REPRIORITIZE--> same status); the two guards above stay
		// because they encode policy the pure machine doesn't know (only-lower, terminal short-circuit).
		return this.transition(id, 'REPRIORITIZE', { priority }, now);
	}

	// — semantic lifecycle helpers (thin wrappers over transition, named for the wire protocol §5) —

	/** Dispatch: offer the job to a worker; the caller sets the ack-lease deadline. */
	assign(id: string, workerId: string, leaseExpiresAt: number | null, now: number, facts: AttemptFacts = {}): Job {
		const job = this.transition(id, 'DISPATCH', { workerId, leaseExpiresAt }, now);
		this.#ledger?.assigned(id, workerId, facts, now);
		return job;
	}

	/** Worker accepted: begin processing. Stamps a fresh PROGRESS lease — the ack lease from `assign`
	 *  no longer applies, so a worker accepting near the ack deadline isn't instantly reaped as dead. */
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

	/** Terminal failure (retries exhausted or non-retryable). `attempts` is optional: the reaper passes
	 *  the final exhausting count; a direct non-retryable fail omits it and leaves the count as-is. */
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

	/** Returns a non-terminal job to the queue. `cause` names WHY: a worker REJECT (legal only from
	 *  `assigned`), a `LEASE_EXPIRED` timeout, or a boot `RECOVER` (legal only from `running`) — three
	 *  distinct events all landing on `queued`, validated against the machine so a caller can't smuggle
	 *  in one the current status forbids. The caller decides whether `attempts` increments (an
	 *  ack-timeout doesn't; a progress-lease expiry does). Defaults to `LEASE_EXPIRED`, legal from both
	 *  statuses, for callers that don't care about the distinction. Two ledger writes in order: the
	 *  in-flight attempt is ABANDONED, then a fresh one opens dated from now. */
	requeue(id: string, attempts: number, now: number, cause: JobEvent = 'LEASE_EXPIRED'): Job {
		// `transition` seals the dying attempt `abandoned` before the status write and opens the fresh
		// one after it (see REQUEUE_EVENTS), so both ledger writes ride the machine off `cause`.
		return this.transition(id, cause, { workerId: null, leaseExpiresAt: null, attempts }, now);
	}

	/** The DISTINCT media this singer has an in-flight process JOB for — what the per-singer
	 *  concurrent-process cap is derived from. Counts only a live ROOT-process job (`fetch`/`stems`,
	 *  live meaning not failed/canceled/ready), never a chained follow-up: `align`/`stems-upgrade`
	 *  inherit the same `singerId` but are downstream of an already-admitted process, so counting them
	 *  would let one process consume several cap slots. Ledger-backed rather than derived from queue
	 *  entries because the process (HTTP) and the entry (WebSocket) are different transports and only
	 *  the entry is droppable — a phone tapping Sing mid-reconnect files a process with NO entry, so an
	 *  entry-derived count would see zero and admit every such tap, the exact bypass this closes. */
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

	/** Map a DB row to the shared Job (the row shape mirrors Job 1:1 — see schema.ts / shared types). */
	#toJob(row: typeof jobs.$inferSelect | undefined): Job | null {
		return row ?? null;
	}
}
