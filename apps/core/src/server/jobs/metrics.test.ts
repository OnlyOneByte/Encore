// Every number the internal dashboard shows is computed here, so it is pinned here.
import { describe, expect, it } from 'bun:test';
import type { JobAttempt, JobType } from '@encore/shared';
import {
	CONFIDENT_SAMPLE,
	e2e,
	isAnecdote,
	mean,
	percentile,
	perAsrModel,
	perCook,
	perModel,
	perStage,
	perStep,
	processingMs,
	queueWaitMs
} from './metrics';

const T0 = 1_700_000_000_000;

function attempt(over: Partial<JobAttempt> = {}): JobAttempt {
	return {
		id: 'a' + Math.random(),
		jobId: 'j1',
		mediaId: 'm1',
		cookId: 'c1',
		jobType: 'stems' as JobType,
		attempt: 1,
		workerId: 'w1',
		enqueuedAt: T0,
		assignedAt: T0,
		startedAt: T0,
		finishedAt: T0 + 1_000,
		outcome: 'ready',
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
		...over
	};
}

describe('percentile — nearest rank, not interpolated', () => {
	it('returns a value that was actually measured', () => {
		// Interpolation over a tiny sample invents a number lying between two real measurements and
		// equal to neither. On a box with eight cooks that is a fabricated data point.
		const vals = [10, 20, 30, 40];
		const p95 = percentile(vals, 95);
		expect(p95).not.toBeNull();
		expect(vals).toContain(p95 as number);
		expect(percentile(vals, 50)).toBe(20);
		expect(percentile(vals, 100)).toBe(40);
	});

	it('is null on no data rather than 0', () => {
		expect(percentile([], 50)).toBeNull();
		expect(mean([])).toBeNull();
	});

	it('handles a single sample', () => {
		expect(percentile([7], 95)).toBe(7);
	});
});

describe('the two durations are genuinely different numbers', () => {
	it('excludes queue wait from processing time', () => {
		const a = attempt({ enqueuedAt: T0, assignedAt: T0 + 5_000, startedAt: T0 + 6_000, finishedAt: T0 + 96_000 });
		expect(queueWaitMs(a)).toBe(5_000);
		expect(processingMs(a)).toBe(90_000); // not 96_000 — the whole reason for four clocks
	});

	it('is null, not zero, when the work never started', () => {
		expect(processingMs(attempt({ startedAt: null, finishedAt: null }))).toBeNull();
		expect(queueWaitMs(attempt({ assignedAt: null }))).toBeNull();
	});
});

describe('perStep', () => {
	it('reports timings in pipeline order, not alphabetical', () => {
		const rows = perStep([attempt({ jobType: 'align' }), attempt({ jobType: 'fetch' }), attempt({ jobType: 'stems' })]);
		expect(rows.map((r) => r.jobType)).toEqual(['fetch', 'stems', 'align']);
	});

	it('counts failures and abandons beside the timings, and excludes them from the mean', () => {
		const rows = perStep([
			attempt({ startedAt: T0, finishedAt: T0 + 10_000 }),
			attempt({ outcome: 'failed', startedAt: T0, finishedAt: T0 + 500_000 }),
			attempt({ outcome: 'abandoned', startedAt: T0, finishedAt: T0 + 900_000 })
		]);
		expect(rows[0].n).toBe(1);
		expect(rows[0].failed).toBe(1);
		expect(rows[0].abandoned).toBe(1);
		// A job that died after 500s must not be averaged in as if it had delivered a song.
		expect(rows[0].meanMs).toBe(10_000);
	});

	it('omits a step that has never run rather than showing it as zero', () => {
		expect(perStep([attempt({ jobType: 'stems' })]).map((r) => r.jobType)).toEqual(['stems']);
	});

	it('reports the rate when song length is known', () => {
		const rows = perStep([attempt({ startedAt: T0, finishedAt: T0 + 90_000, audioSec: 180 })]);
		expect(rows[0].meanRtFactor).toBeCloseTo(0.5, 5);
	});
});

describe('perCook and e2e', () => {
	it('spans the whole run and separates waited-time from worked-time', () => {
		const cook = [
			attempt({ jobType: 'fetch', cookId: 'c1', enqueuedAt: T0, startedAt: T0, finishedAt: T0 + 10_000 }),
			// 30s of idle queue between the two steps
			attempt({
				jobType: 'stems',
				cookId: 'c1',
				enqueuedAt: T0 + 10_000,
				startedAt: T0 + 40_000,
				finishedAt: T0 + 100_000
			})
		];
		const [c] = perCook(cook);
		expect(c.totalMs).toBe(100_000); // what the singer waited
		expect(c.workMs).toBe(70_000); // what the CPU did
		expect(c.complete).toBe(true);
	});

	it('excludes a cook still in flight instead of reporting a shrinking duration', () => {
		const rows = perCook([
			attempt({ cookId: 'c1', finishedAt: T0 + 1_000 }),
			attempt({ cookId: 'c2', outcome: null, finishedAt: null })
		]);
		expect(rows.map((r) => r.cookId)).toEqual(['c1']);
	});

	it('counts only complete cooks in the aggregate', () => {
		const stats = e2e([
			attempt({ cookId: 'c1', finishedAt: T0 + 1_000 }),
			attempt({ cookId: 'c2', outcome: 'failed', finishedAt: T0 + 9_000 })
		]);
		expect(stats.n).toBe(1); // a failed cook has no end-to-end delivery time
	});

	it('ignores rows written before cook ids existed', () => {
		expect(perCook([attempt({ cookId: '' })])).toEqual([]);
	});
});

describe('perModel — measured against what the whitelist claims', () => {
	it('compares the measured rate to the declared rtFactor as a ratio', () => {
		// htdemucs declares rtFactor 0.29 (measured on a 32-core Graviton 3). Say this box does 0.58.
		const rows = perModel([
			attempt({ engine: 'demucs', model: 'htdemucs', startedAt: T0, finishedAt: T0 + 58_000, audioSec: 100 })
		]);
		expect(rows[0].declared?.rtFactor).toBe(0.29);
		expect(rows[0].meanRtFactor).toBeCloseTo(0.58, 5);
		// 2x slower than the benchmark — the useful signal is the magnitude, not a pass/fail.
		expect(rows[0].ratioToDeclared).toBeCloseTo(2, 5);
	});

	it('leaves the ratio null for a model the whitelist does not know', () => {
		const rows = perModel([
			attempt({
				engine: 'roformer',
				model: 'some-unlisted-checkpoint',
				startedAt: T0,
				finishedAt: T0 + 1_000,
				audioSec: 10
			})
		]);
		expect(rows[0].declared).toBeUndefined();
		expect(rows[0].ratioToDeclared).toBeNull();
	});

	it('does not invent a model row for a step that has no model axis', () => {
		expect(perModel([attempt({ jobType: 'fetch' })])).toEqual([]);
	});

	it('groups the same model across cooks and songs', () => {
		const rows = perModel([
			attempt({
				mediaId: 'm1',
				engine: 'demucs',
				model: 'htdemucs',
				startedAt: T0,
				finishedAt: T0 + 1_000,
				audioSec: 10
			}),
			attempt({
				mediaId: 'm2',
				engine: 'demucs',
				model: 'htdemucs',
				startedAt: T0,
				finishedAt: T0 + 3_000,
				audioSec: 10
			})
		]);
		expect(rows.length).toBe(1);
		expect(rows[0].n).toBe(2);
		expect(rows[0].meanRtFactor).toBeCloseTo(0.2, 5); // (0.1 + 0.3) / 2
	});
});

describe('perAsrModel — the axis with no declared cost at all', () => {
	it('produces the first measured rate for a Whisper checkpoint', () => {
		// AsrModel deliberately carries no rtFactor: "Do not add an rtFactor here until someone has
		// actually timed these on the target hardware." This is that timing.
		const rows = perAsrModel([
			attempt({
				jobType: 'align',
				asrModel: 'base',
				syncMode: 'forced',
				startedAt: T0,
				finishedAt: T0 + 30_000,
				audioSec: 200
			})
		]);
		expect(rows[0].asrModel).toBe('base');
		expect(rows[0].meanRtFactor).toBeCloseTo(0.15, 5);
	});

	it('separates sync modes for the same checkpoint', () => {
		const rows = perAsrModel([
			attempt({ asrModel: 'base', syncMode: 'forced' }),
			attempt({ asrModel: 'base', syncMode: 'lines' })
		]);
		expect(rows.length).toBe(2);
	});
});

describe('perStage — the split the core cannot see on its own', () => {
	it('averages each sub-step and ranks the expensive one first', () => {
		const rows = perStage([
			attempt({
				stages: JSON.stringify([
					{ stage: 'downloading', ms: 9_000 },
					{ stage: 'separating', ms: 81_000 }
				])
			}),
			attempt({
				stages: JSON.stringify([
					{ stage: 'downloading', ms: 11_000 },
					{ stage: 'separating', ms: 79_000 }
				])
			})
		]);
		expect(rows[0]).toEqual({ stage: 'separating', n: 2, meanMs: 80_000 });
		expect(rows[1]).toEqual({ stage: 'downloading', n: 2, meanMs: 10_000 });
	});

	it('ignores attempts with no breakdown rather than counting them as zero', () => {
		expect(perStage([attempt({ stages: null })])).toEqual([]);
	});

	it('survives malformed stage JSON', () => {
		// A corrupt diagnostic must degrade to "no breakdown", never throw inside a render.
		expect(() => perStage([attempt({ stages: '{not json' })])).not.toThrow();
		expect(perStage([attempt({ stages: '{not json' })])).toEqual([]);
	});
});

describe('sample-size honesty', () => {
	it('flags a small sample as an anecdote', () => {
		// On a box with 8 cooked songs a "mean" reads with the same authority as one over 200.
		expect(isAnecdote(2)).toBe(true);
		expect(isAnecdote(CONFIDENT_SAMPLE)).toBe(false);
	});
});

describe('— the read window no longer understates the boundary cook', () => {
	// A cook whose earlier steps finished before the window opened is handed to perCook missing those
	// rows. Its span would then be measured from the earliest SURVIVING step (too short) while still
	// passing the sealed===list completeness test over the rows that happened to be fetched. That is
	// the silent under-count. The window edge lets perCook detect and refuse it.
	const boundary = T0 + 100_000; // the older edge of the read window

	function clippedCook(): JobAttempt[] {
		// The real cook ran fetch (enqueued at T0) then stems; only the stems row survived the window.
		return [attempt({ jobType: 'stems', cookId: 'boundary', enqueuedAt: T0, finishedAt: boundary + 60_000 })];
	}

	it('flags a cook that began before the window as clipped, and never complete', () => {
		const [c] = perCook(clippedCook(), boundary);
		expect(c.clipped).toBe(true);
		expect(c.complete).toBe(false);
	});

	it('keeps a clipped boundary cook out of the end-to-end aggregate', () => {
		// Base behaviour (no window arg) counts the truncated cook and averages its understated span in.
		// With the window edge, the aggregate refuses it rather than reporting a low number.
		const stats = e2e(clippedCook(), boundary);
		expect(stats.n).toBe(0);
	});

	it('still reports a cook that lives entirely inside the window as complete', () => {
		const inside = [
			attempt({
				jobType: 'fetch',
				cookId: 'inside',
				enqueuedAt: boundary + 1_000,
				startedAt: boundary + 1_000,
				finishedAt: boundary + 5_000
			}),
			attempt({
				jobType: 'stems',
				cookId: 'inside',
				enqueuedAt: boundary + 5_000,
				startedAt: boundary + 5_000,
				finishedAt: boundary + 65_000
			})
		];
		const [c] = perCook(inside, boundary);
		expect(c.clipped).toBe(false);
		expect(c.complete).toBe(true);
		expect(c.totalMs).toBe(64_000);
		expect(e2e(inside, boundary).n).toBe(1);
	});

	it('with no window (whole ledger read) nothing is clipped', () => {
		const [c] = perCook(clippedCook());
		expect(c.clipped).toBe(false);
	});
});
