// The historical record of job processing, and the ONLY place a duration is kept. The `jobs` table
// (repository.ts) is the dispatch slot — one live row per (mediaId, jobType), mutated in place, always
// describing the present, never the past. Every attempt gets its own row here: opened on queue entry,
// sealed on outcome; a retry opens a new row rather than overwriting the old one. The named lifecycle
// helpers below (not `transition`, which can't tell a reject from a lease expiry) are the ONLY
// supported way to touch a row — bypassing them to call `transition` directly leaves no trace here.

import { and, asc, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DB } from '../db/index';
import { jobAttempts } from '../db/schema';
import { ulid, type AttemptOutcome, type Job, type JobAttempt } from '../../contract';

/** Every field optional: an absent field means "not applicable to this step" (e.g. a `fetch` has no
 *  separator) and is recorded as NULL, never a placeholder — a fabricated value would corrupt the
 *  per-model rollup that reads these columns. */
export interface AttemptFacts {
	engine?: string | null;
	model?: string | null;
	backend?: string | null;
	device?: string | null;
	asrModel?: string | null;
	syncMode?: string | null;
	audioSec?: number | null;
	stages?: string | null; // per-stage breakdown, serialized, from job:complete
	selection?: string | null; // variant-pick provenance, serialized, from job:complete on align
}

export class AttemptLedger {
	#db: DB;
	constructor(db: DB) {
		this.#db = db;
	}

	/** Called on enqueue AND requeue — both are the moment a fresh wait begins, so dating a retry's
	 *  queue wait from the job's original `createdAt` would charge it for time the prior attempt spent.
	 *  `attempt` is derived from the row count, not `job.attempts`, because the job counter is
	 *  deliberately not incremented on an ack-timeout (no work was performed) and would undercount. */
	open(job: Pick<Job, 'id' | 'mediaId' | 'processingId' | 'jobType'>, now: number): JobAttempt {
		const attempt = this.#countFor(job.id) + 1;
		const row: JobAttempt = {
			id: ulid(now),
			jobId: job.id,
			mediaId: job.mediaId,
			processingId: job.processingId,
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
			stages: null,
			selection: null
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

	/** Seals the in-flight attempt; after this the row is never written again — a retry calls `open()`.
	 *  `abandoned` covers a return to the queue (worker reject, lease expiry, boot recovery): the attempt
	 *  is over even though the job lives on. */
	closed(jobId: string, outcome: AttemptOutcome, now: number, error?: string | null): void {
		this.#patchOpen(jobId, { finishedAt: now, outcome, error: error ?? null });
	}

	/** Overwrites facts with what the worker actually resolved — a different claim from `assigned`'s
	 *  request, since a worker can legitimately resolve a model alias, an unsupported backend, or a
	 *  device fallback. Only the reported fields are touched, so a partial report can't blank out
	 *  what dispatch already knew. */
	reportFacts(jobId: string, facts: AttemptFacts): void {
		const patch = pickFacts(facts);
		if (Object.keys(patch).length === 0) return;
		this.#patchOpen(jobId, patch);
	}

	/** Every attempt for one song, oldest first — the per-song audit timeline. */
	byMedia(mediaId: string): JobAttempt[] {
		return this.#db
			.select()
			.from(jobAttempts)
			.where(eq(jobAttempts.mediaId, mediaId))
			.orderBy(asc(jobAttempts.enqueuedAt))
			.all();
	}

	/** Every attempt of one process, oldest first — end-to-end spans one of these. */
	byProcess(processingId: string): JobAttempt[] {
		return this.#db
			.select()
			.from(jobAttempts)
			.where(eq(jobAttempts.processingId, processingId))
			.orderBy(asc(jobAttempts.enqueuedAt))
			.all();
	}

	/** The attempt still in flight for a job, if any. At most one by construction. */
	openFor(jobId: string): JobAttempt | null {
		return this.#findOpen(jobId) ?? null;
	}

	/** A TIME window (not a row-count cap), so the caller can pair the edge `sinceMs` with
	 *  `perProcess(rows, sinceMs)` to flag a boundary-straddling process `clipped` and exclude it,
	 *  rather than measure its span from only the surviving rows and understate it. */
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

	/** No-op when there's no open attempt, never a throw: the ledger is OBSERVABILITY and must never be
	 *  able to break a process — a job in flight when this table was added has no open attempt to patch. */
	#patchOpen(jobId: string, patch: Partial<JobAttempt>): void {
		const open = this.#findOpen(jobId);
		if (!open) return;
		this.#db.update(jobAttempts).set(patch).where(eq(jobAttempts.id, open.id)).run();
	}
}

function pickFacts(facts: AttemptFacts): Partial<JobAttempt> {
	const out: Partial<JobAttempt> = {};
	for (const k of [
		'engine',
		'model',
		'backend',
		'device',
		'asrModel',
		'syncMode',
		'audioSec',
		'stages',
		'selection'
	] as const) {
		if (facts[k] !== undefined) out[k] = facts[k] as never;
	}
	return out;
}
