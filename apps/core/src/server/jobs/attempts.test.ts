// The attempt ledger is the historical record the `jobs` table cannot be. These tests assert the
// four things that were IMPOSSIBLE before it existed, because each was destroyed by in-place mutation:
//   1. processing time separable from queue wait
//   2. a previous attempt still readable after a retry
//   3. which model actually ran a given cook
//   4. one cook's steps grouped without blending in a re-cook or an upgrade

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { realtimeFactor } from '@encore/shared';
import { AttemptLedger } from './attempts';
import { JobRepository } from './repository';
import { inheritsCook } from './dispatch';
import type { DB } from '../db/index';

const T0 = 1_700_000_000_000;

function freshDb(): DB {
	const db = drizzle(new Database(':memory:')) as unknown as DB;
	migrate(db, { migrationsFolder: new URL('../../../drizzle', import.meta.url).pathname });
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
		// THE number: real processing time, not polluted by the 6s it spent waiting.
		expect(a.finishedAt! - a.startedAt!).toBe(90_000);
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
		// Regression: realtimeFactor's FIRST guard (startedAt === null) is the sole one that catches an
		// attempt with a known audioSec but no start clock. audioSec is stamped at assign (worker-hub
		// dispatch), startedAt only at accept — so an assign→seal-without-accept lands in exactly that
		// state. Without this case the length guard (audioSec falsy) masks it, and a deleted clock guard
		// divides the whole epoch by the song length: ~9.4M× on the audit page for an abandoned row.
		const { jobs, ledger } = wired();
		const job = jobs.enqueue('m1', 'stems', 0, T0);
		jobs.assign(job.id, 'w1', null, T0 + 1_000, { audioSec: 180 }); // dispatch stamps audioSec
		jobs.requeue(job.id, 1, T0 + 31_000); // ack timeout / lease expiry before accept → abandoned

		const [a] = ledger.byMedia('m1');
		expect(a.startedAt).toBeNull(); // never accepted
		expect(a.audioSec).toBe(180); // but the song length is known
		expect(a.outcome).toBe('abandoned');
		// The length guard cannot fire (audioSec is set), so this can ONLY pass via the clock guard.
		expect(realtimeFactor(a)).toBeNull();
	});

	it('rates an attempt canceled while assigned as null, not the epoch over the song', () => {
		// Same never-ran clock guard, reached via the cancel-while-assigned path instead of lease expiry.
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
		// attempt 1 is still readable — the whole point. Before this table it was gone.
		expect(all[0].attempt).toBe(1);
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
		// 1s, not 61s: attempt 2 must not be charged for attempt 1's time.
		expect(second.assignedAt! - second.enqueuedAt).toBe(1_000);
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
		// The worker resolved a different checkpoint and fell back to CPU — the truth, not the request.
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
		// An align has no separator. A fabricated 'htdemucs' would corrupt the per-model rollup.
		expect(a.engine).toBeNull();
		expect(a.model).toBeNull();
	});
});

describe('cook grouping', () => {
	it('threads one cook id through a chained run', () => {
		const { jobs, ledger } = wired();
		const fetch = jobs.enqueue('m1', 'fetch', 0, T0);
		const stems = jobs.enqueue('m1', 'stems', 0, T0 + 1, fetch.cookId);
		const align = jobs.enqueue('m1', 'align', 0, T0 + 2, stems.cookId);

		expect(stems.cookId).toBe(fetch.cookId);
		expect(align.cookId).toBe(fetch.cookId);
		expect(ledger.byCook(fetch.cookId).map((a) => a.jobType)).toEqual(['fetch', 'stems', 'align']);
	});

	it('gives an unchained job its own cook', () => {
		const { jobs } = wired();
		const a = jobs.enqueue('m1', 'stems', 0, T0);
		const b = jobs.enqueue('m2', 'stems', 0, T0 + 1);
		expect(a.cookId).not.toBe(b.cookId);
	});

	it('excludes stems-upgrade from the cook that triggered it', () => {
		// The rule that keeps a 43-minute background upgrade out of a 90-second cook's end-to-end.
		expect(inheritsCook('stems')).toBe(true);
		expect(inheritsCook('align')).toBe(true);
		expect(inheritsCook('stems-upgrade')).toBe(false);
	});

	it('computes end-to-end for one cook without blending in a re-cook of the same song', () => {
		const { jobs, ledger } = wired();
		// cook 1: fetch → stems, both complete
		const f1 = jobs.enqueue('m1', 'fetch', 0, T0);
		jobs.assign(f1.id, 'w1', null, T0);
		jobs.accept(f1.id, null, T0);
		jobs.complete(f1.id, T0 + 10_000);
		const s1 = jobs.enqueue('m1', 'stems', 0, T0 + 10_000, f1.cookId);
		jobs.assign(s1.id, 'w1', null, T0 + 10_000);
		jobs.accept(s1.id, null, T0 + 10_000);
		jobs.complete(s1.id, T0 + 100_000);

		// A LATER, separate upgrade on the same song — same mediaId, different cook.
		const up = jobs.enqueue('m1', 'stems-upgrade', 0, T0 + 500_000);
		jobs.assign(up.id, 'w1', null, T0 + 500_000);
		jobs.accept(up.id, null, T0 + 500_000);
		jobs.complete(up.id, T0 + 3_000_000);

		const cook = ledger.byCook(f1.cookId);
		const e2e = Math.max(...cook.map((a) => a.finishedAt!)) - Math.min(...cook.map((a) => a.enqueuedAt));
		expect(e2e).toBe(100_000); // 100s — the honest answer

		// Grouping by mediaId instead would have reported ~50 minutes for a song that was singable in
		// 100 seconds. This is exactly the distortion cookId exists to prevent.
		const byMedia = ledger.byMedia('m1');
		const wrong = Math.max(...byMedia.map((a) => a.finishedAt!)) - Math.min(...byMedia.map((a) => a.enqueuedAt));
		expect(wrong).toBe(3_000_000);
		expect(up.cookId).not.toBe(f1.cookId);
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
		// The upgrade case: a job already in flight when this code is deployed has no attempt row.
		const { jobs, ledger } = wired();
		const job = jobs.enqueue('m1', 'stems', 0, T0);
		jobs.assign(job.id, 'w1', null, T0);
		jobs.accept(job.id, null, T0);
		jobs.complete(job.id, T0 + 1_000); // seals attempt 1
		expect(() => ledger.reportFacts(job.id, { device: 'cuda' })).not.toThrow();
		expect(ledger.byMedia('m1')[0].device).toBeNull(); // sealed rows stay sealed
	});
});
