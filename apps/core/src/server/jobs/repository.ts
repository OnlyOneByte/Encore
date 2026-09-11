// Job ledger — the durable state-of-record for process processing (Demucs stems, WhisperX
// align, scoring). SQLite is authority here (NOT the transport): workers dial home over WS and the
// ledger tracks ownership/lifecycle. This is the I/O layer; the legal-transition rules live in the
// pure transitions.ts (mirrors store.ts ↔ shared/applyAndReseq). See
// docs/ARCHITECTURE.md.

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
} from '@encore/shared';
import { assertEvent } from './transitions';
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

// The attempt OUTCOME each terminal-or-requeue event seals, so the ledger can be driven off the
// event inside `transition` rather than re-derived in each named wrapper. A requeue (REJECT /
// LEASE_EXPIRED / RECOVER) seals the dying attempt `abandoned`; the terminal events seal their own
// name. Events absent here (DISPATCH / ACCEPT / PROGRESS / REPRIORITIZE) seal nothing — DISPATCH and
// ACCEPT PATCH the open attempt with dispatch facts / a start time via `assign`/`accept`, which stay
// in the wrappers because they carry data the machine does not have.
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

// The WORKER-REPORTED events that hand a worker's concurrency slot back — a live worker over its WS
// session declined (REJECT) or finished (COMPLETE) the job it held, so its slot is free NOW.
// Reaper/boot events (LEASE_EXPIRED, RECOVER) are deliberately ABSENT: they fire when the worker is
// presumed dead and its session gone, so the registry reclaims its slots on the next heartbeat or
// session drop rather than the machine double-freeing against an in-flight completion.
//
// FAIL is ABSENT even though a worker-reported terminal failure DOES free a live slot, because FAIL
// is NOT exclusively worker-reported: it also arrives from the reaper's exhausted-attempts branch
// (reaper.ts, `fail()` on a `running` job whose progress lease lapsed — the worker is presumed dead)
// and from the unservable-TTL branch (worker-hub.ts, on a still-`queued` job). Keying release off the
// FAIL event alone freed the slot of a worker that still holds the job whenever the reaper fired,
// driving an assign/reject storm (issue #555). Release for the worker-reported terminal FAIL is
// therefore made explicitly at its ONE worker-report call site — `#onFailed`'s terminal branch in
// worker-hub.ts, guarded by `job.workerId === msg.workerId` so the worker is provably alive — exactly
// as that handler's retryable branch already does its own explicit release (both are the one true
// worker report). The reaper's own dead-worker fail then correctly frees nothing: the registry
// reclaims that slot on the next heartbeat or session drop.
//
// CANCEL is ABSENT for the same double-free reason cancel.ts documents: after cancel() clears
// `workerId` there is no owner to notify, and a proactive release could race a completion that is
// already in flight — the worker frees its own slot and the registry catches up.
const SLOT_RELEASING_EVENTS: ReadonlySet<JobEvent> = new Set<JobEvent>(['REJECT', 'COMPLETE']);

export class JobRepository {
	#db: DB;
	#ledger: AttemptLedger | null;
	#releaseSlot: ((workerId: string) => void) | null = null;
	/**
	 * The ledger is OPTIONAL so every existing unit test that constructs a bare repository keeps
	 * working, and so a missing ledger can never break a process — it is observability, not correctness.
	 * app.ts wires it; tests that assert on history pass one in.
	 */
	constructor(db: DB, ledger?: AttemptLedger) {
		this.#db = db;
		this.#ledger = ledger ?? null;
	}

	/**
	 * Register the worker-slot release action. OPTIONAL and wired by app.ts (the registry is
	 * constructed after the repository, so it is injected rather than passed to the constructor —
	 * mirroring the ledger). Fired by `transition` on a SLOT_RELEASING_EVENT with the OWNING worker
	 * id (read pre-write, before the patch clears `workerId`). Unit tests that never touch worker
	 * capacity leave it unset and the hook is a no-op, so slot accounting can never break a process.
	 */
	setSlotReleaseHook(release: (workerId: string) => void): void {
		this.#releaseSlot = release;
	}

	/**
	 * Enqueue a job for (mediaId, jobType), or REUSE the existing live one (idempotent — §6 dedup).
	 * Two singers queueing the same song get one job; the second add just subscribes to it. A new
	 * job is only created when no slot-occupying job exists (i.e. the previous one failed/canceled,
	 * or there never was one).
	 *
	 * `processingId` threads an existing process through a chained step (stems inherits fetch's process). Omitted
	 * = this job STARTS a process and mints its own. Reusing an existing live job does not re-open an
	 * attempt: the caller is subscribing to work already in flight, not causing new work.
	 *
	 * `singerId` attributes the process to the requesting singer for the per-singer concurrent-process cap
	 * (`countLiveProcessesForSinger`). Omitted by internal callers that impose no cap; a REUSED live job
	 * keeps its original requester rather than being re-attributed to whoever tapped second.
	 */
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
			// Who this process is attributed to for the per-singer cap. Omitted by internal callers
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
			.where(and(eq(jobs.mediaId, mediaId), eq(jobs.jobType, jobType), notInArray(jobs.status, SLOT_FREEING_STATUSES)))
			.all()[0];
		return this.#toJob(row);
	}

	/**
	 * Free a FINISHED job's dedup slot so the song can be re-processed (#640). A `ready` job still
	 * occupies the slot in both the app check and the partial unique index, and `ready` is TERMINAL —
	 * `cancel()` cannot move it (the state machine gives terminal states no outgoing events). So a
	 * re-run of a completed step (a human re-picking lyrics, a future re-process button) has no way to
	 * proceed: `enqueue` would return the old `ready` job and nothing would run, silently.
	 *
	 * This deletes the SLOT-OCCUPYING row for the key — the one `findLive` names, which is exactly the
	 * row a fresh `enqueue` would otherwise hand back. `findLive` already excludes the slot-freeing
	 * statuses (`failed`/`canceled`), so it can only return the row that actually holds the slot; a
	 * key with several terminal rows (e.g. a `failed` attempt plus a later `ready` one — an ordinary
	 * state, since `enqueue` inserts a new row whenever nothing is live) resolves to the `ready`
	 * occupant, not an arbitrary `.all()[0]`. Only a TERMINAL occupant is removed — a live one is left
	 * untouched and returned as `false`, so this can never yank a job out from under a running worker,
	 * and a key with NO live occupant returns `false` (nothing to free) rather than deleting a stray
	 * slot-freed row. The attempt history lives in the separate `job_attempts` ledger and is NOT
	 * touched, so the audit trail of the prior attempt survives the supersession. Returns true when a
	 * row was freed.
	 */
	supersedeForRerun(mediaId: string, jobType: JobType): boolean {
		// findLive returns precisely the slot occupant (it filters out failed/canceled), so this frees
		// the row enqueue would reuse — never a slot-freed sibling that leaves the real occupant in place.
		const job = this.findLive(mediaId, jobType);
		if (!job || !isTerminalJob(job.status)) return false;
		this.#db.delete(jobs).where(eq(jobs.id, job.id)).run();
		return true;
	}

	/**
	 * The step of this song's process that is CURRENTLY outstanding — the first not-yet-finished job in
	 * pipeline order, or null when nothing is in flight.
	 *
	 * Exists because /api/library used to answer "what is processing right now?" by looking for a live
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
		return this.#db
			.select()
			.from(jobs)
			.where(inArray(jobs.status, statuses))
			.all()
			.map((r) => this.#toJob(r)!);
	}

	/**
	 * Fire a lifecycle EVENT through the pure state machine, patching any provided fields and always
	 * bumping `updatedAt`. The event (not a bare destination status) is the input, so the machine can
	 * tell a REJECT from a LEASE_EXPIRED even though both land on `queued` — the distinction the
	 * status-pair table lost (#471). Throws on an unknown id or an event illegal from the current
	 * status (the machine is the authority). Returns the updated job.
	 */
	transition(id: string, event: JobEvent, patch: JobPatch, now: number): Job {
		const current = this.byId(id);
		if (!current) throw new Error(`unknown job: ${id}`);
		const to = assertEvent(current.status, event);

		// The event carries the ledger outcome, so the ledger hooks the MACHINE, not seven hand-written
		// wrappers (#471 step 2). Now that the event is a parameter, `transition` alone knows both that
		// a status changed AND what caused it — a REJECT and a LEASE_EXPIRED both land on `queued` but
		// seal the attempt as `abandoned` identically, while a COMPLETE seals `ready`. Sealing the
		// in-flight attempt happens BEFORE the row write (it patches the open attempt by jobId, and a
		// requeue's abandon must date from the pre-transition attempt); a fresh attempt is opened AFTER
		// the write so its 1-based number counts the row just sealed. The consequence the issue wants:
		// a caller reaching `transition` directly is no longer invisible to history — the wrappers are
		// ergonomics (§5 names), not the enforcement boundary.
		const outcome = OUTCOME_FOR_EVENT[event];
		if (outcome) this.#ledger?.closed(id, outcome, now, patch.error ?? null);

		// Slot accounting via the machine (issue #524 step 3). A worker-reported release event frees
		// the OWNING worker's concurrency slot — read from the pre-write row, because a requeue patch
		// (REJECT) clears `workerId` before the write. This retires the three hand-paired
		// registry.releaseSlot() calls in worker-hub.ts (#onReject/#onComplete/#onFailed): the release
		// now rides ENTERING the released state, so it cannot be forgotten by a new terminal path.
		if (current.workerId && SLOT_RELEASING_EVENTS.has(event)) this.#releaseSlot?.(current.workerId);

		const next = { ...patch, status: to, updatedAt: now };
		this.#db.update(jobs).set(next).where(eq(jobs.id, id)).run();
		const updated = this.byId(id)!;

		// A requeue (REJECT / LEASE_EXPIRED / RECOVER back to `queued`) opens the next attempt so the
		// new wait is dated from now rather than inheriting the abandoned attempt's queue time.
		if (REQUEUE_EVENTS.has(event)) this.#ledger?.open(updated, now);
		return updated;
	}

	/**
	 * Lower a queued/in-flight job's scheduling priority WITHOUT a status change.
	 *
	 * `priority` is scheduling metadata, not lifecycle: dispatch sorts `priority ASC, createdAt ASC`
	 * (dispatch.ts), so a smaller number is more urgent. A process's priority is a snapshot of
	 * `soonestSeqFor` taken ONCE at enqueue (process.ts). When the singer's queue add is dropped
	 * over a reconnecting socket, that snapshot is `NO_QUEUE_PRIORITY` — nobody was waiting yet — and
	 * nothing ever revises it, so the process sorts behind the lyrics backfill forever even after the
	 * turn lands (the starvation half of #135).
	 *
	 * This cannot go through `transition`: a starved process is still `queued`, and `queued → queued` is
	 * deliberately not a legal edge (transitions.ts) — opening one would let a lease-expiry requeue
	 * masquerade as a no-op progress update. So this is a narrow, status-free write that touches only
	 * `priority` + `updatedAt` and emits no ledger event.
	 *
	 * Two guards keep it safe:
	 *   • terminal jobs are never touched — a ready/failed/canceled process has no scheduling future;
	 *   • it only ever LOWERS the number (makes a process more urgent). A reorder that would raise a
	 *     process's priority — push it further back — is refused, so this hook can only ever unstick a
	 *     starved process, never demote one another entry still needs.
	 *
	 * No-op (returns the unchanged job) when the id is terminal or the new priority is not strictly
	 * lower, so callers can fire it unconditionally on any add.
	 */
	reprioritize(id: string, priority: number, now: number): Job {
		const current = this.byId(id);
		if (!current) throw new Error(`unknown job: ${id}`);
		if (isTerminalJob(current.status)) return current; // no scheduling future (also has no REPRIORITIZE edge)
		if (priority >= current.priority) return current; // only ever more urgent, never less
		// Now an in-machine edge: queued|running --REPRIORITIZE--> same status. The machine is the
		// authority for "may this job be rescheduled at all" (terminal states have no REPRIORITIZE
		// edge); the two guards above stay because they encode POLICY the pure machine does not know
		// (only-lower, and the cheap terminal short-circuit before a byId re-read inside transition).
		return this.transition(id, 'REPRIORITIZE', { priority }, now);
	}

	// — semantic lifecycle helpers (thin wrappers over transition, named for the wire protocol §5) —

	/** Dispatch: offer the job to a worker; the caller sets the ack-lease deadline. */
	assign(id: string, workerId: string, leaseExpiresAt: number | null, now: number, facts: AttemptFacts = {}): Job {
		const job = this.transition(id, 'DISPATCH', { workerId, leaseExpiresAt }, now);
		this.#ledger?.assigned(id, workerId, facts, now);
		return job;
	}

	/**
	 * Worker accepted (`job:accept`): begin processing. Stamps a fresh PROGRESS lease — the ack lease
	 * from `assign` no longer applies, so a worker that accepts near the ack deadline isn't instantly
	 * reaped as a dead running job. Pass the deadline (lease policy lives in the pure leases.ts).
	 */
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

	/**
	 * Terminal failure (retries exhausted or non-retryable). `attempts` is optional: the reaper
	 * passes the final exhausting count so the ledger records the attempt that died; a direct
	 * non-retryable fail omits it and leaves the count as-is.
	 */
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

	/**
	 * Return a non-terminal job to the queue. `cause` names WHY — the whole point of #471: a worker
	 * REJECT, an ack-timeout or progress-lease `LEASE_EXPIRED`, and a boot `RECOVER` are three
	 * distinct events that a status-pair machine could not tell apart because all three land on
	 * `queued`. It is validated against the machine (a REJECT is only legal from `assigned`; RECOVER
	 * only from `running`), so a caller cannot smuggle in an event the current status forbids. The
	 * caller still decides whether to increment `attempts` — an ack-timeout doesn't (work never
	 * started), a progress-lease expiry does. Clears the owner + lease.
	 *
	 * Defaults to `LEASE_EXPIRED` (legal from both `assigned` and `running`) so a caller that does not
	 * care about the distinction — most tests, and the generic reaper requeue — keeps working.
	 *
	 * Two ledger writes, in order: the in-flight attempt is ABANDONED (it is over — a retry is not a
	 * continuation of it), then a fresh attempt opens so the new wait is dated from now rather than
	 * inheriting the abandoned attempt's queue time.
	 */
	requeue(id: string, attempts: number, now: number, cause: JobEvent = 'LEASE_EXPIRED'): Job {
		// `transition` seals the dying attempt `abandoned` before the status write and opens the fresh
		// one after it (see REQUEUE_EVENTS), so both ledger writes ride the machine off `cause`.
		return this.transition(id, cause, { workerId: null, leaseExpiresAt: null, attempts }, now);
	}

	/**
	 * The DISTINCT media this singer has an in-flight process JOB for — the ledger-backed attribution the
	 * per-singer concurrent-process cap is derived from.
	 *
	 * Returns the set of `mediaId`s with a live root-process job (`fetch` or `stems`) attributed to this
	 * singer, where "live" = the dedup-occupying statuses (everything except failed/canceled) MINUS
	 * `ready`. Only the root steps count, never the chained follow-ups: `align`/`stems-upgrade` reuse
	 * the same `singerId` but are downstream of a process already admitted, so counting them would let one
	 * admitted process consume several cap slots as it advances.
	 *
	 * WHY THE LEDGER, NOT QUEUE ENTRIES. The process (HTTP) and the queue entry (WebSocket) ride different
	 * transports and only the entry is droppable. A phone that taps Sing while its socket is
	 * reconnecting files the process with NO entry, so an entry-derived count saw zero and admitted every
	 * tap — the exact cap bypass this closes. The job ledger is the thing being bounded and does not
	 * depend on the second transport. The caller drops media already marked ready (a finished process no
	 * longer costs the fleet) and the media being re-requested.
	 */
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
