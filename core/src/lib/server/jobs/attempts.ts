// The ONLY place a duration is kept. Every attempt gets its own row: opened on queue entry, sealed on
// outcome, and a retry opens a NEW row rather than overwriting. The named lifecycle helpers below are the
// only supported way to touch a row — calling `transition` directly leaves no trace here.
// See docs/SERVER.md#the-attempt-ledger.

import { and, asc, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DB } from '../db/index';
import { jobAttempts } from '../db/schema';
import { ulid, type AttemptOutcome, type Job, type JobAttempt } from '../../contract';

/** An absent field means "not applicable to this step" and is recorded as NULL, never a placeholder: a
 *  fabricated value corrupts the per-model rollup that reads these columns. */
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
	trail?: string | null; // the worker's decision history, serialized, from job:state / job:complete
}

export class AttemptLedger {
	#db: DB;
	constructor(db: DB) {
		this.#db = db;
	}

	/** On enqueue AND requeue: both begin a fresh wait, so dating a retry from the job's `createdAt` would
	 *  charge it for the prior attempt's time. `attempt` comes from the ROW COUNT, not `job.attempts`,
	 *  which is deliberately not incremented on an ack-timeout and would undercount. */
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
			selection: null,
			trail: null
		};
		this.#db.insert(jobAttempts).values(row).run();
		return row;
	}

	/** Records what was ASKED for, not what ran. */
	assigned(jobId: string, workerId: string, facts: AttemptFacts, now: number): void {
		this.#patchOpen(jobId, { workerId, assignedAt: now, ...pickFacts(facts) });
	}

	/** `finishedAt − startedAt` is the number that matters. */
	started(jobId: string, now: number): void {
		this.#patchOpen(jobId, { startedAt: now });
	}

	/** After this the row is NEVER written again; a retry calls `open()`. `abandoned` covers a return to
	 *  the queue: the attempt is over even though the job lives on. */
	closed(jobId: string, outcome: AttemptOutcome, now: number, error?: string | null): void {
		this.#patchOpen(jobId, { finishedAt: now, outcome, error: error ?? null });
	}

	/** What the worker actually resolved, a different claim from `assigned`'s request. Only the REPORTED
	 *  fields are touched, so a partial report cannot blank out what dispatch already knew. */
	reportFacts(jobId: string, facts: AttemptFacts): void {
		const patch = pickFacts(facts);
		if (Object.keys(patch).length === 0) return;
		this.#patchOpen(jobId, patch);
	}

	/** Oldest first. */
	byMedia(mediaId: string): JobAttempt[] {
		return this.#db
			.select()
			.from(jobAttempts)
			.where(eq(jobAttempts.mediaId, mediaId))
			.orderBy(asc(jobAttempts.enqueuedAt))
			.all();
	}

	/** Oldest first; an end-to-end duration spans one of these. */
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

	/** A TIME window, not a row-count cap, so the caller can pair `sinceMs` with `perProcess` to flag a
	 *  boundary-straddling process `clipped` rather than understate its span from surviving rows. */
	finishedSince(sinceMs: number, limit = 20_000): JobAttempt[] {
		return this.#db
			.select()
			.from(jobAttempts)
			.where(and(isNotNull(jobAttempts.outcome), gte(jobAttempts.finishedAt, sinceMs)))
			.orderBy(desc(jobAttempts.finishedAt))
			.limit(limit)
			.all();
	}

	/** The latest successful runs of one step, newest first, for the ETA (`eta.ts`); on one worker when
	 *  `workerId` is given, on any otherwise. */
	recentReady(jobType: JobAttempt['jobType'], workerId: string | null | undefined, limit: number): JobAttempt[] {
		return this.#db
			.select()
			.from(jobAttempts)
			.where(
				and(
					eq(jobAttempts.jobType, jobType),
					eq(jobAttempts.outcome, 'ready'),
					isNotNull(jobAttempts.startedAt),
					workerId ? eq(jobAttempts.workerId, workerId) : undefined
				)
			)
			.orderBy(desc(jobAttempts.finishedAt))
			.limit(limit)
			.all();
	}

	/** The honest denominator behind a windowed sample. */
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
		const row = this.#db
			.select({ n: sql<number>`count(*)` })
			.from(jobAttempts)
			.where(eq(jobAttempts.jobId, jobId))
			.all();
		return Number(row[0]?.n ?? 0);
	}

	/** No-op when there is no open attempt, never a throw: the ledger is OBSERVABILITY and must never be
	 *  able to break a process. */
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
		'trail',
		'selection'
	] as const) {
		if (facts[k] !== undefined) out[k] = facts[k] as never;
	}
	return out;
}
