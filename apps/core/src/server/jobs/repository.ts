// Job ledger — the durable state-of-record for make-karaoke processing (Demucs stems, WhisperX
// align, scoring). SQLite is authority here (NOT the transport): workers dial home over WS and the
// ledger tracks ownership/lifecycle. This is the I/O layer; the legal-transition rules live in the
// pure transitions.ts (mirrors store.ts ↔ shared/applyAndReseq). See
// docs/ARCHITECTURE.md.

import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { DB } from '../db/index';
import { jobs } from '../db/schema';
import { ulid, isTerminalJob, type Job, type JobStatus, type JobType } from '@encore/shared';
import { assertTransition } from './transitions';
import type { AttemptLedger, AttemptFacts } from './attempts';

// Dedup slot occupancy: a (mediaId, jobType) is "taken" by any job NOT failed/canceled — the same
// set the partial unique index `jobs_live_media_type_idx` enforces (schema.ts). A `ready` job still
// occupies the slot (reuse the result, skip the worker); only a failed/canceled job frees it so the
// song can be re-processed.
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
	#ledger: AttemptLedger | null;
	/**
	 * The ledger is OPTIONAL so every existing unit test that constructs a bare repository keeps
	 * working, and so a missing ledger can never break a cook — it is observability, not correctness.
	 * app.ts wires it; tests that assert on history pass one in.
	 */
	constructor(db: DB, ledger?: AttemptLedger) {
		this.#db = db;
		this.#ledger = ledger ?? null;
	}

	/**
	 * Enqueue a job for (mediaId, jobType), or REUSE the existing live one (idempotent — §6 dedup).
	 * Two singers queueing the same song get one job; the second add just subscribes to it. A new
	 * job is only created when no slot-occupying job exists (i.e. the previous one failed/canceled,
	 * or there never was one).
	 *
	 * `cookId` threads an existing cook through a chained step (stems inherits fetch's cook). Omitted
	 * = this job STARTS a cook and mints its own. Reusing an existing live job does not re-open an
	 * attempt: the caller is subscribing to work already in flight, not causing new work.
	 *
	 * `singerId` attributes the cook to the requesting singer for the per-singer concurrent-cook cap
	 * (`countLiveCooksForSinger`). Omitted by internal callers that impose no cap; a REUSED live job
	 * keeps its original requester rather than being re-attributed to whoever tapped second.
	 */
	enqueue(mediaId: string, jobType: JobType, priority: number, now: number, cookId?: string, singerId?: string): Job {
		const existing = this.findLive(mediaId, jobType);
		if (existing) return existing;

		const job: Job = {
			id: ulid(now),
			mediaId,
			cookId: cookId ?? ulid(now),
			// Who this cook is attributed to for the per-singer cap. Omitted by internal callers
			// (backfill, chained follow-up steps) which impose no cap.
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

	/**
	 * The step of this song's cook that is CURRENTLY outstanding — the first not-yet-finished job in
	 * pipeline order, or null when nothing is in flight.
	 *
	 * Exists because /api/library used to answer "what is cooking right now?" by looking for a live
	 * `stems` job and nothing else. A song mid-fetch or mid-align has no such job, so a phone that
	 * reloaded during either step found none and fell back to a hardcoded 'queued' — the progress strip
	 * jumping backwards on refresh, for the same reason the broadcasts did (see media-status.ts).
	 *
	 * `stems-upgrade` is excluded: it is background work on a finished song and is not a step the room
	 * is waiting on.
	 */
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

	/**
	 * Lower a queued/in-flight job's scheduling priority WITHOUT a status change.
	 *
	 * `priority` is scheduling metadata, not lifecycle: dispatch sorts `priority ASC, createdAt ASC`
	 * (dispatch.ts), so a smaller number is more urgent. A cook's priority is a snapshot of
	 * `soonestSeqFor` taken ONCE at enqueue (make-karaoke.ts). When the singer's queue add is dropped
	 * over a reconnecting socket, that snapshot is `NO_QUEUE_PRIORITY` — nobody was waiting yet — and
	 * nothing ever revises it, so the cook sorts behind the lyrics backfill forever even after the
	 * turn lands (the starvation half of #135).
	 *
	 * This cannot go through `transition`: a starved cook is still `queued`, and `queued → queued` is
	 * deliberately not a legal edge (transitions.ts) — opening one would let a lease-expiry requeue
	 * masquerade as a no-op progress update. So this is a narrow, status-free write that touches only
	 * `priority` + `updatedAt` and emits no ledger event.
	 *
	 * Two guards keep it safe:
	 *   • terminal jobs are never touched — a ready/failed/canceled cook has no scheduling future;
	 *   • it only ever LOWERS the number (makes a cook more urgent). A reorder that would raise a
	 *     cook's priority — push it further back — is refused, so this hook can only ever unstick a
	 *     starved cook, never demote one another entry still needs.
	 *
	 * No-op (returns the unchanged job) when the id is terminal or the new priority is not strictly
	 * lower, so callers can fire it unconditionally on any add.
	 */
	reprioritize(id: string, priority: number, now: number): Job {
		const current = this.byId(id);
		if (!current) throw new Error(`unknown job: ${id}`);
		if (isTerminalJob(current.status)) return current;
		if (priority >= current.priority) return current; // only ever more urgent, never less
		this.#db.update(jobs).set({ priority, updatedAt: now }).where(eq(jobs.id, id)).run();
		return this.byId(id)!;
	}

	// — semantic lifecycle helpers (thin wrappers over transition, named for the wire protocol §5) —

	/** Dispatch: offer the job to a worker; the caller sets the ack-lease deadline. */
	assign(id: string, workerId: string, leaseExpiresAt: number | null, now: number, facts: AttemptFacts = {}): Job {
		const job = this.transition(id, 'assigned', { workerId, leaseExpiresAt }, now);
		this.#ledger?.assigned(id, workerId, facts, now);
		return job;
	}

	/**
	 * Worker accepted (`job:accept`): begin processing. Stamps a fresh PROGRESS lease — the ack lease
	 * from `assign` no longer applies, so a worker that accepts near the ack deadline isn't instantly
	 * reaped as a dead running job. Pass the deadline (lease policy lives in the pure leases.ts).
	 */
	accept(id: string, leaseExpiresAt: number | null, now: number): Job {
		const job = this.transition(id, 'running', { leaseExpiresAt }, now);
		this.#ledger?.started(id, now);
		return job;
	}

	/** Worker progress (`job:progress`): self-loop in `running`, refresh stage/pct/lease. */
	progress(id: string, patch: JobPatch, now: number): Job {
		return this.transition(id, 'running', patch, now);
	}

	/** Worker finished (`job:complete`): terminal `ready`. */
	complete(id: string, now: number): Job {
		const job = this.transition(id, 'ready', { progressPct: 100, leaseExpiresAt: null, workerId: null }, now);
		this.#ledger?.closed(id, 'ready', now);
		return job;
	}

	/**
	 * Terminal failure (retries exhausted or non-retryable). `attempts` is optional: the reaper
	 * passes the final exhausting count so the ledger records the attempt that died; a direct
	 * non-retryable fail omits it and leaves the count as-is.
	 */
	fail(id: string, error: string, now: number, attempts?: number): Job {
		const patch: JobPatch = { error, leaseExpiresAt: null, workerId: null };
		if (attempts !== undefined) patch.attempts = attempts;
		const job = this.transition(id, 'failed', patch, now);
		this.#ledger?.closed(id, 'failed', now, error);
		return job;
	}

	/** Song removed before finish (`job:cancel`): terminal `canceled`, frees the dedup slot. */
	cancel(id: string, now: number): Job {
		const job = this.transition(id, 'canceled', { leaseExpiresAt: null, workerId: null }, now);
		this.#ledger?.closed(id, 'canceled', now);
		return job;
	}

	/**
	 * Return a non-terminal job to the queue (worker reject, lease expiry, or boot recovery). The
	 * caller decides whether to increment `attempts` — an ack-timeout doesn't (work never started),
	 * a progress-lease expiry does. Clears the owner + lease.
	 *
	 * Two ledger writes, in order: the in-flight attempt is ABANDONED (it is over — a retry is not a
	 * continuation of it), then a fresh attempt opens so the new wait is dated from now rather than
	 * inheriting the abandoned attempt's queue time.
	 */
	requeue(id: string, attempts: number, now: number): Job {
		this.#ledger?.closed(id, 'abandoned', now);
		const job = this.transition(id, 'queued', { workerId: null, leaseExpiresAt: null, attempts }, now);
		this.#ledger?.open(job, now);
		return job;
	}

	/**
	 * The DISTINCT media this singer has an in-flight cook JOB for — the ledger-backed attribution the
	 * per-singer concurrent-cook cap is derived from.
	 *
	 * Returns the set of `mediaId`s with a live root-cook job (`fetch` or `stems`) attributed to this
	 * singer, where "live" = the dedup-occupying statuses (everything except failed/canceled) MINUS
	 * `ready`. Only the root steps count, never the chained follow-ups: `align`/`stems-upgrade` reuse
	 * the same `singerId` but are downstream of a cook already admitted, so counting them would let one
	 * admitted cook consume several cap slots as it advances.
	 *
	 * WHY THE LEDGER, NOT QUEUE ENTRIES. The cook (HTTP) and the queue entry (WebSocket) ride different
	 * transports and only the entry is droppable. A phone that taps Sing while its socket is
	 * reconnecting files the cook with NO entry, so an entry-derived count saw zero and admitted every
	 * tap — the exact cap bypass this closes. The job ledger is the thing being bounded and does not
	 * depend on the second transport. The caller drops media already marked ready (a finished cook no
	 * longer costs the fleet) and the media being re-requested.
	 */
	liveCookMediaForSinger(singerId: string): Set<string> {
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
