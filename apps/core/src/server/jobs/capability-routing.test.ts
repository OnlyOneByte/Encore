import { test, expect } from 'bun:test';
import { requiredCapability, planAssignments, hasCapableWorker, type CapabilityFor } from './dispatch';
import type { Job, GlobalSettings } from '@encore/shared';
import type { WorkerSession } from './registry';

function job(id: string, jobType: Job['jobType']): Job {
	return {
		id,
		mediaId: 'm-' + id,
		jobType,
		status: 'queued',
		priority: 1,
		attempts: 0,
		maxAttempts: 3,
		workerId: null,
		stage: null,
		progressPct: 0,
		etaSec: null,
		error: null,
		leaseExpiresAt: null,
		createdAt: 1,
		updatedAt: 1
	} as Job;
}

function worker(id: string, capabilities: string[], slotsFree = 1): WorkerSession {
	return { workerId: id, capabilities, concurrency: slotsFree, version: '1', slotsFree, lastSeen: 0 };
}

const settings = (o: Partial<GlobalSettings>): GlobalSettings => ({
	defaultEngine: 'demucs',
	defaultModel: 'htdemucs',
	enqueueUpgrade: false,
	upgradeEngine: 'roformer',
	upgradeModel: 'bs-roformer-1297',
	...o
});

test('requiredCapability is engine-derived for stems, plain type otherwise', () => {
	expect(requiredCapability('stems', settings({ defaultEngine: 'demucs' }))).toBe('stems');
	expect(requiredCapability('stems', settings({ defaultEngine: 'roformer' }))).toBe('stems:roformer');
	expect(requiredCapability('stems-upgrade', settings({ upgradeEngine: 'ensemble' }))).toBe('stems:ensemble');
	expect(requiredCapability('align', settings({}))).toBe('align');
	// no settings → demucs default → plain 'stems' (no regression for existing single-cap workers)
	expect(requiredCapability('stems')).toBe('stems');
});

test('a roformer cook is NOT dispatched to a demucs-only worker', () => {
	const cap: CapabilityFor = (j) => requiredCapability(j.jobType, settings({ defaultEngine: 'roformer' }));
	const demucsOnly = [worker('w1', ['stems'])];
	const stems = [job('a', 'stems')];
	expect(planAssignments(stems, demucsOnly, cap)).toEqual([]); // left queued, not mis-assigned
	expect(hasCapableWorker(stems[0], demucsOnly, cap)).toBe(false);

	const roformerWorker = [worker('w2', ['stems', 'stems:roformer'])];
	expect(planAssignments(stems, roformerWorker, cap)).toEqual([{ jobId: 'a', workerId: 'w2' }]);
	expect(hasCapableWorker(stems[0], roformerWorker, cap)).toBe(true);
});

test('default capabilityFor (no resolver) preserves plain job-type routing', () => {
	const demucsOnly = [worker('w1', ['stems'])];
	expect(planAssignments([job('a', 'stems')], demucsOnly)).toEqual([{ jobId: 'a', workerId: 'w1' }]);
});
