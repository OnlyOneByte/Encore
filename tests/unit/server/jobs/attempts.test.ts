// The attempt ledger is the historical record the `jobs` table cannot be: in-place mutation destroyed
// processing time separable from queue wait, a prior attempt after a retry, which model ran, and per-process
// grouping that does not blend in a re-process or an upgrade.

import { describe, expect, it } from 'bun:test';
import { realtimeFactor, attemptSelection } from '$lib/contract';
import { AttemptLedger } from '$lib/server/jobs/attempts';
import { JobRepository } from '$lib/server/jobs/repository';
import { inheritsProcess } from '$lib/server/jobs/dispatch';
import type { DB } from '$lib/server/db/index';
import { migratedDb } from '$lib/server/db/test-db';
import { readFileSync } from 'node:fs';
import { at } from '$test';
import { stripComments } from '$test';

const T0 = 1_700_000_000_000;

function freshDb(): DB {
	const db = migratedDb();
	return db;
}

function wired(): { jobs: JobRepository; ledger: AttemptLedger } {
	const db = freshDb();
	const ledger = new AttemptLedger(db);
	return { jobs: new JobRepository(db, ledger), ledger };
}

describe('attempt ledger — the four clocks', () => {
	it('separates queue wait from processing time, which one updatedAt cannot', () => {
		const { jobs, ledger } = wired();
		const job = jobs.enqueue('m1', 'stems', 0, T0);
		jobs.assign(job.id, 'w1', null, T0 + 5_000); // waited 5s in the queue
		jobs.accept(job.id, null, T0 + 6_000); // worker took 1s to ack
		jobs.complete(job.id, T0 + 96_000); // then ran for 90s

		const [a] = ledger.byMedia('m1');
		expect(a.assignedAt! - a.enqueuedAt).toBe(5_000);
		expect(a.startedAt! - a.assignedAt!).toBe(1_000);
		expect(a.finishedAt! - a.startedAt!).toBe(90_000); // real processing time, not the 6s of waiting
		expect(a.outcome).toBe('ready');
	});

	it('leaves a clock null rather than 0 when that moment never happened', () => {
		const { jobs, ledger } = wired();
		const job = jobs.enqueue('m1', 'stems', 0, T0);
		jobs.cancel(job.id, T0 + 1_000); // removed before any worker took it

		const [a] = ledger.byMedia('m1');
		expect(a.assignedAt).toBeNull();
		expect(a.startedAt).toBeNull(); // 0 here would invent work that never ran
		expect(a.outcome).toBe('canceled');
	});

	it('rates an attempt that was assigned then abandoned before accept as null, not the epoch over the song', () => {
		// audioSec is stamped at assign and startedAt only at accept, so assign→seal-without-accept has a known
		// length and no start clock: only realtimeFactor's startedAt === null guard stops it dividing the epoch
		// by the song length, which read ~9.4M× on the audit page.
		const { jobs, ledger } = wired();
		const job = jobs.enqueue('m1', 'stems', 0, T0);
		jobs.assign(job.id, 'w1', null, T0 + 1_000, { audioSec: 180 }); // dispatch stamps audioSec
		jobs.requeue(job.id, 1, T0 + 31_000); // ack timeout / lease expiry before accept → abandoned

		const [a] = ledger.byMedia('m1');
		expect(a.startedAt).toBeNull(); // never accepted
		expect(a.audioSec).toBe(180); // but the song length is known
		expect(a.outcome).toBe('abandoned');
		expect(realtimeFactor(a)).toBeNull(); // audioSec is set, so only the clock guard can pass this
	});

	it('rates an attempt canceled while assigned as null, not the epoch over the song', () => {
		// The same never-ran clock guard, via cancel-while-assigned instead of lease expiry.
		const { jobs, ledger } = wired();
		const job = jobs.enqueue('m1', 'stems', 0, T0);
		jobs.assign(job.id, 'w1', null, T0 + 1_000, { audioSec: 240 }); // dispatch stamps audioSec
		jobs.cancel(job.id, T0 + 2_000); // removed while assigned, before accept

		const [a] = ledger.byMedia('m1');
		expect(a.startedAt).toBeNull();
		expect(a.audioSec).toBe(240);
		expect(a.outcome).toBe('canceled');
		expect(realtimeFactor(a)).toBeNull();
	});

	it('reports cost as a rate, so songs of different lengths compare', () => {
		const { jobs, ledger } = wired();
		const job = jobs.enqueue('m1', 'stems', 0, T0);
		jobs.assign(job.id, 'w1', null, T0, { audioSec: 180 });
		jobs.accept(job.id, null, T0);
		jobs.complete(job.id, T0 + 90_000); // 90s of compute for 180s of audio

		expect(realtimeFactor(ledger.byMedia('m1')[0])).toBeCloseTo(0.5, 5);
	});
});

describe('attempt ledger — history survives a retry', () => {
	it('keeps the abandoned attempt as its own row instead of overwriting it', () => {
		const { jobs, ledger } = wired();
		const job = jobs.enqueue('m1', 'stems', 0, T0);
		jobs.assign(job.id, 'w1', null, T0 + 1_000);
		jobs.accept(job.id, null, T0 + 2_000);
		jobs.requeue(job.id, 1, T0 + 3_000); // lease expired mid-run
		jobs.assign(job.id, 'w2', null, T0 + 4_000);
		jobs.accept(job.id, null, T0 + 5_000);
		jobs.complete(job.id, T0 + 6_000);

		const all = ledger.byMedia('m1');
		expect(all.length).toBe(2);
		expect(all[0].attempt).toBe(1); // attempt 1 is still readable — the whole point
		expect(all[0].outcome).toBe('abandoned');
		expect(all[0].workerId).toBe('w1');
		expect(all[1].attempt).toBe(2);
		expect(all[1].outcome).toBe('ready');
		expect(all[1].workerId).toBe('w2');
	});

	it("dates the retry's queue wait from the requeue, not the job's original creation", () => {
		const { jobs, ledger } = wired();
		const job = jobs.enqueue('m1', 'stems', 0, T0);
		jobs.assign(job.id, 'w1', null, T0 + 1_000);
		jobs.requeue(job.id, 1, T0 + 60_000);
		jobs.assign(job.id, 'w2', null, T0 + 61_000);

		const [, second] = ledger.byMedia('m1');
		expect(second.assignedAt! - second.enqueuedAt).toBe(1_000); // 1s, not 61s: attempt 2 is not charged for 1
	});

	it('records every failure message, not just the last one', () => {
		const { jobs, ledger } = wired();
		const job = jobs.enqueue('m1', 'stems', 0, T0);
		jobs.assign(job.id, 'w1', null, T0);
		jobs.accept(job.id, null, T0);
		jobs.requeue(job.id, 1, T0 + 1_000);
		jobs.assign(job.id, 'w1', null, T0 + 2_000);
		jobs.accept(job.id, null, T0 + 2_000);
		jobs.fail(job.id, 'CUDA out of memory', T0 + 3_000, 2);

		const all = ledger.byMedia('m1');
		expect(all.map((a) => a.outcome)).toEqual(['abandoned', 'failed']);
		expect(all[1].error).toBe('CUDA out of memory');
	});

	it('has at most one attempt in flight per job', () => {
		const { jobs, ledger } = wired();
		const job = jobs.enqueue('m1', 'stems', 0, T0);
		expect(ledger.openFor(job.id)?.attempt).toBe(1);
		jobs.assign(job.id, 'w1', null, T0);
		jobs.requeue(job.id, 1, T0 + 1_000);
		expect(ledger.openFor(job.id)?.attempt).toBe(2);
		jobs.assign(job.id, 'w1', null, T0 + 2_000);
		jobs.accept(job.id, null, T0 + 2_000);
		jobs.complete(job.id, T0 + 3_000);
		expect(ledger.openFor(job.id)).toBeNull(); // sealed
	});
});

describe('attempt ledger — model attribution', () => {
	it('records what was dispatched, so a later settings change cannot rewrite history', () => {
		const { jobs, ledger } = wired();
		const job = jobs.enqueue('m1', 'stems', 0, T0);
		jobs.assign(job.id, 'w1', null, T0, { engine: 'demucs', model: 'htdemucs' });
		jobs.accept(job.id, null, T0);
		jobs.complete(job.id, T0 + 1_000);

		const [a] = ledger.byMedia('m1');
		expect(a.engine).toBe('demucs');
		expect(a.model).toBe('htdemucs');
	});

	it("lets the worker's actual resolution overwrite what was asked for", () => {
		const { jobs, ledger } = wired();
		const job = jobs.enqueue('m1', 'stems', 0, T0);
		jobs.assign(job.id, 'w1', null, T0, { engine: 'roformer', model: 'bs-roformer-1297' });
		jobs.accept(job.id, null, T0);
		// The worker resolved another checkpoint and fell back to CPU: the truth, not the request.
		ledger.reportFacts(job.id, { model: 'mel-band-roformer', backend: 'torch', device: 'cpu' });
		jobs.complete(job.id, T0 + 1_000);

		const [a] = ledger.byMedia('m1');
		expect(a.model).toBe('mel-band-roformer');
		expect(a.device).toBe('cpu');
		expect(a.engine).toBe('roformer'); // untouched by a partial report
	});

	it("leaves a step's inapplicable fields null rather than inventing them", () => {
		const { jobs, ledger } = wired();
		const job = jobs.enqueue('m1', 'align', 0, T0);
		jobs.assign(job.id, 'w1', null, T0, { asrModel: 'base', syncMode: 'forced' });

		const [a] = ledger.byMedia('m1');
		expect(a.asrModel).toBe('base');
		// An align has no separator; a fabricated 'htdemucs' would corrupt the per-model rollup.
		expect(a.engine).toBeNull();
		expect(a.model).toBeNull();
	});
});

describe('process grouping', () => {
	it('threads one process id through a chained run', () => {
		const { jobs, ledger } = wired();
		const fetch = jobs.enqueue('m1', 'fetch', 0, T0);
		const stems = jobs.enqueue('m1', 'stems', 0, T0 + 1, fetch.processingId);
		const align = jobs.enqueue('m1', 'align', 0, T0 + 2, stems.processingId);

		expect(stems.processingId).toBe(fetch.processingId);
		expect(align.processingId).toBe(fetch.processingId);
		expect(ledger.byProcess(fetch.processingId).map((a) => a.jobType)).toEqual(['fetch', 'stems', 'align']);
	});

	it('gives an unchained job its own process', () => {
		const { jobs } = wired();
		const a = jobs.enqueue('m1', 'stems', 0, T0);
		const b = jobs.enqueue('m2', 'stems', 0, T0 + 1);
		expect(a.processingId).not.toBe(b.processingId);
	});

	it('excludes stems-upgrade from the process that triggered it', () => {
		// Keeps a 43-minute background upgrade out of a 90-second process's end-to-end.
		expect(inheritsProcess('stems')).toBe(true);
		expect(inheritsProcess('align')).toBe(true);
		expect(inheritsProcess('stems-upgrade')).toBe(false);
	});

	it('computes end-to-end for one process without blending in a re-process of the same song', () => {
		const { jobs, ledger } = wired();
		const f1 = jobs.enqueue('m1', 'fetch', 0, T0); // process 1 — fetch → stems, both complete
		jobs.assign(f1.id, 'w1', null, T0);
		jobs.accept(f1.id, null, T0);
		jobs.complete(f1.id, T0 + 10_000);
		const s1 = jobs.enqueue('m1', 'stems', 0, T0 + 10_000, f1.processingId);
		jobs.assign(s1.id, 'w1', null, T0 + 10_000);
		jobs.accept(s1.id, null, T0 + 10_000);
		jobs.complete(s1.id, T0 + 100_000);

		const up = jobs.enqueue('m1', 'stems-upgrade', 0, T0 + 500_000); // same mediaId, different proc
		jobs.assign(up.id, 'w1', null, T0 + 500_000);
		jobs.accept(up.id, null, T0 + 500_000);
		jobs.complete(up.id, T0 + 3_000_000);

		const proc = ledger.byProcess(f1.processingId);
		const e2e = Math.max(...proc.map((a) => a.finishedAt!)) - Math.min(...proc.map((a) => a.enqueuedAt));
		expect(e2e).toBe(100_000); // 100s — the honest answer

		// Grouping by mediaId reports ~50 minutes for a song singable in 100s — what processingId prevents.
		const byMedia = ledger.byMedia('m1');
		const wrong = Math.max(...byMedia.map((a) => a.finishedAt!)) - Math.min(...byMedia.map((a) => a.enqueuedAt));
		expect(wrong).toBe(3_000_000);
		expect(up.processingId).not.toBe(f1.processingId);
	});
});

describe('the ledger is observability, never a failure mode', () => {
	it('a repository with no ledger behaves exactly as before', () => {
		const jobs = new JobRepository(freshDb()); // no ledger
		const job = jobs.enqueue('m1', 'stems', 0, T0);
		jobs.assign(job.id, 'w1', null, T0);
		jobs.accept(job.id, null, T0);
		expect(jobs.complete(job.id, T0 + 1_000).status).toBe('ready');
	});

	it('a lifecycle event for a job with no open attempt does not throw', () => {
		// The upgrade case: a job already in flight when this deploys has no attempt row.
		const { jobs, ledger } = wired();
		const job = jobs.enqueue('m1', 'stems', 0, T0);
		jobs.assign(job.id, 'w1', null, T0);
		jobs.accept(job.id, null, T0);
		jobs.complete(job.id, T0 + 1_000); // seals attempt 1
		expect(() => ledger.reportFacts(job.id, { device: 'cuda' })).not.toThrow();
		expect(ledger.byMedia('m1')[0].device).toBeNull(); // sealed rows stay sealed
	});
});

// `AttemptLedger.allFinished` is gone: `finishedSince` + `countFinished` replaced it, and its bare-row-count
// semantics are measurably wrong (a straddling process reports complete with an understated span). A public
// method on an exported class is invisible to the unused-EXPORT sweep, so only this scan catches its return.
describe('the removed row-count window stays removed', () => {
	const SRC = stripComments(readFileSync(at('src/lib/server/jobs/attempts.ts'), 'utf8'));

	it('exposes no `allFinished` method outside comments', () => {
		expect(SRC).not.toMatch(/\ballFinished\b/);
	});

	it('still exposes its window-based replacements (not vacuous — a rename or empty read reds here)', () => {
		expect(SRC).toMatch(/\bfinishedSince\b/);
		expect(SRC).toMatch(/\bcountFinished\b/);
	});
});

// Variant-pick provenance must reach DURABLE state, not just the process log, which bites the whole
// worker→core persist mapping at the ledger seam (AttemptFacts.selection, open()'s null default, the column).
describe('attempt ledger — variant-pick provenance', () => {
	const RECORD = JSON.stringify({
		baselineFallback: false,
		winnerSuspect: false,
		winnerScore: 0.94,
		choices: [
			{
				textSource: 'lrclib',
				considered: 3,
				chosen: 'lrclib-synced',
				chosenScore: 0.94,
				decidedBy: 'agreement',
				votes: 2,
				rejected: [
					{ label: 'lrclib-plain', score: 0.61 },
					{ label: 'captions-stub', score: null }
				]
			}
		]
	});

	it('persists the serialized selection reported on complete, and defaults it null', () => {
		const { jobs, ledger } = wired();
		const job = jobs.enqueue('m1', 'align', 0, T0);
		// Freshly opened: null, never undefined — the column exists and starts empty.

		expect(ledger.openFor(job.id)!.selection).toBeNull();

		jobs.assign(job.id, 'w1', null, T0 + 1_000);
		jobs.accept(job.id, null, T0 + 2_000);
		ledger.reportFacts(job.id, { selection: RECORD });
		jobs.complete(job.id, T0 + 3_000);

		const [a] = ledger.byMedia('m1');
		expect(a.selection).toBe(RECORD); // survived to durable state, byte-for-byte
		const parsed = attemptSelection(a);
		expect(parsed!.choices[0].rejected).toEqual([
			{ label: 'lrclib-plain', score: 0.61 },
			{ label: 'captions-stub', score: null }
		]);
		expect(parsed!.choices[0].decidedBy).toBe('agreement');
		expect(parsed!.choices[0].votes).toBe(2);
	});

	it('leaves selection null on an attempt that reported none (a non-align step)', () => {
		const { jobs, ledger } = wired();
		const job = jobs.enqueue('m1', 'stems', 0, T0);
		jobs.assign(job.id, 'w1', null, T0 + 1_000);
		jobs.accept(job.id, null, T0 + 2_000);
		ledger.reportFacts(job.id, { engine: 'demucs' }); // no selection reported
		jobs.complete(job.id, T0 + 3_000);
		expect(ledger.byMedia('m1')[0].selection).toBeNull();
	});
});
