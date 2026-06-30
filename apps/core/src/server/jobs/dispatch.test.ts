// Pure dispatch policy — need-order (priority ASC, createdAt tiebreak), least-loaded worker,
// capability match, capacity respected within a single planning pass.
import { test, expect } from 'bun:test';
import { planAssignments, hasCapableWorker, eligible } from './dispatch';
import type { WorkerSession } from './registry';
import type { Job, JobType } from '@encore/shared';

const T0 = 1_700_000_000_000;

function job(id: string, over: Partial<Job> = {}): Job {
	return {
		id,
		mediaId: 'm-' + id,
		jobType: 'stems',
		status: 'queued',
		priority: 0,
		attempts: 0,
		maxAttempts: 3,
		workerId: null,
		stage: null,
		progressPct: 0,
		etaSec: null,
		error: null,
		leaseExpiresAt: null,
		createdAt: T0,
		updatedAt: T0,
		...over
	};
}

function worker(id: string, slotsFree: number, capabilities: JobType[] = ['stems']): WorkerSession {
	return { workerId: id, capabilities, concurrency: slotsFree, version: '1', slotsFree, lastSeen: T0 };
}

test('a single queued job goes to the only eligible worker', () => {
	expect(planAssignments([job('a')], [worker('w1', 1)])).toEqual([{ jobId: 'a', workerId: 'w1' }]);
});

test('no eligible worker (capability mismatch) → job left queued', () => {
	const j = job('a', { jobType: 'align' });
	expect(planAssignments([j], [worker('w1', 1, ['stems'])])).toEqual([]);
	expect(hasCapableWorker(j, [worker('w1', 1, ['stems'])])).toBe(false);
	expect(hasCapableWorker(j, [worker('w2', 1, ['align'])])).toBe(true);
});

test('need-order: lower priority (=sooner rotationSeq) dispatches first', () => {
	const a = job('far', { priority: 9 });
	const b = job('soon', { priority: 1 });
	// only ONE slot — the sooner-needed job must win it
	expect(planAssignments([a, b], [worker('w1', 1)])).toEqual([{ jobId: 'soon', workerId: 'w1' }]);
});

test('priority tie broken by createdAt (older first)', () => {
	const older = job('older', { priority: 5, createdAt: T0 });
	const newer = job('newer', { priority: 5, createdAt: T0 + 100 });
	expect(planAssignments([newer, older], [worker('w1', 1)])).toEqual([{ jobId: 'older', workerId: 'w1' }]);
});

test('least-loaded worker chosen (most slotsFree)', () => {
	const a = planAssignments([job('a')], [worker('busy', 1), worker('idle', 4)]);
	expect(a).toEqual([{ jobId: 'a', workerId: 'idle' }]);
});

test('capacity respected within one pass: 3 jobs, worker concurrency 2 → 1 left queued', () => {
	const jobs = [job('a', { priority: 1 }), job('b', { priority: 2 }), job('c', { priority: 3 })];
	const out = planAssignments(jobs, [worker('w1', 2)]);
	expect(out).toHaveLength(2);
	expect(out.map((x) => x.jobId)).toEqual(['a', 'b']); // c starves until a slot frees
});

test('jobs spread across workers, balancing load', () => {
	const jobs = [job('a', { priority: 1 }), job('b', { priority: 2 })];
	const out = planAssignments(jobs, [worker('w1', 1), worker('w2', 1)]);
	expect(new Set(out.map((x) => x.workerId))).toEqual(new Set(['w1', 'w2']));
});

test('eligible() requires both a free slot and a matching capability', () => {
	expect(eligible(worker('w', 1, ['stems']), job('a', { jobType: 'stems' }))).toBe(true);
	expect(eligible(worker('w', 0, ['stems']), job('a', { jobType: 'stems' }))).toBe(false);
	expect(eligible(worker('w', 1, ['align']), job('a', { jobType: 'stems' }))).toBe(false);
});
