// Attempt ledger — the historical record of job processing, and the ONLY place a duration is kept.
//
// The `jobs` table (repository.ts) is the dispatch slot: exactly one live row per (mediaId, jobType),
// mutated in place, so it always describes the present and never the past. This module writes the
// past. Every attempt at a job gets its own row, opened when the job enters the queue and sealed when
// that attempt reaches an outcome; a retry opens a new row instead of overwriting the old one.
//
// WHY THE HOOKS ARE THE SEMANTIC HELPERS, NOT `transition`. `transition` knows a status pair and
// nothing else — it cannot tell a reject from a lease expiry, and both land on `queued`. The named
// lifecycle helpers map 1:1 to the wire protocol (§5), so hooking them means the ledger records what
// actually happened rather than inferring it from a state pair. The consequence: a caller that
// bypasses the helpers and calls `transition` directly is invisible here, which is why the helpers
// are the only supported lifecycle API.

import { and, asc, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DB } from '../db/index';
import { jobAttempts } from '../db/schema';
import { ulid, type AttemptOutcome, type Job, type JobAttempt } from '@encore/shared';

/**
 * What a dispatch resolved for this attempt. Every field optional: a `fetch` carries no separator and
 * an `align` carries no engine, so an absent field means "not applicable to this step" — recorded as
 * NULL rather than a placeholder, because a fabricated 'htdemucs' on a fetch would corrupt the
 * per-model rollup that reads these columns.
 */
export interface AttemptFacts {
	engine?: string | null;
	model?: string | null;
	backend?: string | null;
	device?: string | null;
	asrModel?: string | null;
	syncMode?: string | null;
	audioSec?: number | null;
	/** Per-stage breakdown, serialized. Set from the worker's `job:complete`. */
	stages?: string | null;
}

export class AttemptLedger {
	#db: DB;
	constructor(db: DB) {
		this.#db = db;
	}

	/**
	 * A job entered the queue: open its next attempt. Called on enqueue AND on requeue, because both
	 * are the moment a fresh wait begins — dating attempt 2's queue wait from the job's original
	 * `createdAt` would charge it for time attempt 1 already spent.
	 *
	 * `attempt` is 1-based and derived from the row count, not from `job.attempts`: the job counter is
	 * deliberately NOT incremented for an ack-timeout (no work was performed), so it undercounts the
	 * attempts that physically happened. The ledger records physical attempts.
	 */
	open(job: Pick<Job, 'id' | 'mediaId' | 'cookId' | 'jobType'>, now: number): JobAttempt {
		const attempt = this.#countFor(job.id) + 1;
		const row: JobAttempt = {
			id: ulid(now),
			jobId: job.id,
			mediaId: job.mediaId,
			cookId: job.cookId,
			jobType: job.jobType,
			attempt,
			workerId: null,
			enqueuedAt: now,
			assignedAt: null,
			startedAt: null,
			finishedAt: null,
			outcome: null,
			error: null,
			engine: null,
			model: null,
			backend: null,
			device: null,
			asrModel: null,
			syncMode: null,
			audioSec: null,
			stages: null
		};
		this.#db.insert(jobAttempts).values(row).run();
		return row;
	}

	/** Offered to a worker. Records the dispatched facts — what was ASKED for (see AttemptFacts). */
	assigned(jobId: string, workerId: string, facts: AttemptFacts, now: number): void {
		this.#patchOpen(jobId, { workerId, assignedAt: now, ...pickFacts(facts) });
	}

	/** Worker accepted: processing begins here. `finishedAt − startedAt` is the number that matters. */
	started(jobId: string, now: number): void {
		this.#patchOpen(jobId, { startedAt: now });
	}

	/**
	 * Seal the in-flight attempt. After this the row is never written again — a retry calls `open()`.
	 * `abandoned` covers a return to the queue (worker reject, lease expiry, boot recovery): the
	 * attempt is over even though the job lives on.
	 */
	closed(jobId: string, outcome: AttemptOutcome, now: number, error?: string | null): void {
		this.#patchOpen(jobId, { finishedAt: now, outcome, error: error ?? null });
	}

	/**
	 * Overwrite the model facts with what the worker actually resolved. Separate from `assigned`
	 * because the two are different claims: dispatch records the request, this records the truth, and
	 * a worker can legitimately resolve something else (a model alias, a backend the host cannot run,
	 * a device fallback). Only the fields the worker reports are touched, so a partial report cannot
	 * blank out what dispatch already knew.
	 */
	reportFacts(jobId: string, facts: AttemptFacts): void {
		const patch = pickFacts(facts);
		if (Object.keys(patch).length === 0) return;
		this.#patchOpen(jobId, patch);
	}

	// — reads (the dashboards) —

	/** Every attempt for one song, oldest first — the per-song audit timeline. */
	byMedia(mediaId: string): JobAttempt[] {
		return this.#db
			.select()
			.from(jobAttempts)
			.where(eq(jobAttempts.mediaId, mediaId))
			.orderBy(asc(jobAttempts.enqueuedAt))
			.all();
	}

	/** Every attempt of one cook, oldest first — end-to-end spans one of these. */
	byCook(cookId: string): JobAttempt[] {
		return this.#db
			.select()
			.from(jobAttempts)
			.where(eq(jobAttempts.cookId, cookId))
			.orderBy(asc(jobAttempts.enqueuedAt))
			.all();
	}

	/** The attempt still in flight for a job, if any. At most one by construction. */
	openFor(jobId: string): JobAttempt | null {
		return this.#findOpen(jobId) ?? null;
	}

	/**
	 * Sealed attempts finished at or after `sinceMs`, newest first, capped at `limit`. A TIME window
	 * rather than a bare row count: the row-count window (`allFinished`) silently dropped a cook's
	 * older steps at the cap, so the cook straddling the boundary reported `complete: true` and
	 * measured its span from only the surviving rows — understating that cook's duration (#472). The
	 * caller pairs the window edge (`sinceMs`) with `perCook(rows, sinceMs)` so a boundary-straddling
	 * cook is flagged `clipped` and excluded rather than counted low.
	 */
	finishedSince(sinceMs: number, limit = 20_000): JobAttempt[] {
		return this.#db
			.select()
			.from(jobAttempts)
			.where(and(isNotNull(jobAttempts.outcome), gte(jobAttempts.finishedAt, sinceMs)))
			.orderBy(desc(jobAttempts.finishedAt))
			.limit(limit)
			.all();
	}

	/** How many sealed attempts exist in total — the honest denominator behind a windowed sample. */
	countFinished(): number {
		const row = this.#db
			.select({ n: sql<number>`count(*)` })
			.from(jobAttempts)
			.where(isNotNull(jobAttempts.outcome))
			.all();
		return row[0]?.n ?? 0;
	}

	#findOpen(jobId: string): JobAttempt | undefined {
		return this.#db
			.select()
			.from(jobAttempts)
			.where(and(eq(jobAttempts.jobId, jobId), isNull(jobAttempts.outcome)))
			.all()[0];
	}

	#countFor(jobId: string): number {
		return this.#db.select().from(jobAttempts).where(eq(jobAttempts.jobId, jobId)).all().length;
	}

	/**
	 * Patch the in-flight attempt. A no-op when there is none rather than a throw: the ledger is
	 * OBSERVABILITY, and a missing record must never be able to break a cook. Jobs that predate this
	 * table have no open attempt, so a running deployment upgrading into this code would otherwise
	 * throw on the first completion of an in-flight job.
	 */
	#patchOpen(jobId: string, patch: Partial<JobAttempt>): void {
		const open = this.#findOpen(jobId);
		if (!open) return;
		this.#db.update(jobAttempts).set(patch).where(eq(jobAttempts.id, open.id)).run();
	}
}

/** Drop undefined keys so a partial report patches only what it actually claims. */
function pickFacts(facts: AttemptFacts): Partial<JobAttempt> {
	const out: Partial<JobAttempt> = {};
	for (const k of ['engine', 'model', 'backend', 'device', 'asrModel', 'syncMode', 'audioSec', 'stages'] as const) {
		if (facts[k] !== undefined) out[k] = facts[k] as never;
	}
	return out;
}
