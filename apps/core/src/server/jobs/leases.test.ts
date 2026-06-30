// Pure lease policy — deadlines, sweep decisions, boot-recovery selection. No DB, no clock.
import { test, expect } from 'bun:test';
import {
	ackDeadline,
	progressDeadline,
	sweep,
	inflightToRecover,
	DEFAULT_LEASE_CONFIG,
	type ReapAction
} from './leases';
import type { Job } from '@encore/shared';

const T0 = 1_700_000_000_000;

function job(over: Partial<Job>): Job {
	return {
		id: 'j',
		mediaId: 'm',
		jobType: 'stems',
		status: 'running',
		priority: 0,
		attempts: 0,
		maxAttempts: 3,
		workerId: 'w',
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

test('deadlines use the configured timeouts', () => {
	expect(ackDeadline(T0)).toBe(T0 + DEFAULT_LEASE_CONFIG.ackTimeoutMs);
	expect(progressDeadline(T0)).toBe(T0 + DEFAULT_LEASE_CONFIG.progressLeaseMs);
	expect(ackDeadline(T0, { ackTimeoutMs: 5, progressLeaseMs: 9 })).toBe(T0 + 5);
	expect(progressDeadline(T0, { ackTimeoutMs: 5, progressLeaseMs: 9 })).toBe(T0 + 9);
});

test('a live (or null) lease is never reaped', () => {
	const live = job({ id: 'a', status: 'running', leaseExpiresAt: T0 + 1000 });
	const noLease = job({ id: 'b', status: 'assigned', leaseExpiresAt: null });
	expect(sweep([live, noLease], T0)).toEqual([]);
	// exactly-at-deadline is still alive (expiry is strictly past it)
	expect(sweep([job({ leaseExpiresAt: T0 })], T0)).toEqual([]);
});

test('assigned + expired → ack-timeout requeue, NO attempt burned', () => {
	const j = job({ id: 'a', status: 'assigned', attempts: 1, leaseExpiresAt: T0 - 1 });
	expect(sweep([j], T0)).toEqual([
		{ id: 'a', kind: 'requeue', attempts: 1, reason: 'ack-timeout' } satisfies ReapAction
	]);
});

test('running + expired (attempts left) → progress-lease requeue with attempts++', () => {
	const j = job({ id: 'a', status: 'running', attempts: 0, maxAttempts: 3, leaseExpiresAt: T0 - 1 });
	expect(sweep([j], T0)).toEqual([
		{ id: 'a', kind: 'requeue', attempts: 1, reason: 'progress-lease-expired' } satisfies ReapAction
	]);
});

test('running + expired (attempts would exhaust) → fail', () => {
	const j = job({ id: 'a', status: 'running', attempts: 2, maxAttempts: 3, leaseExpiresAt: T0 - 1 });
	const actions = sweep([j], T0);
	expect(actions).toHaveLength(1);
	expect(actions[0]!.kind).toBe('fail');
	expect(actions[0]!.id).toBe('a');
	expect(actions[0]).toMatchObject({ kind: 'fail', attempts: 3 }); // the exhausting attempt recorded
});

test('sweep handles a mixed batch independently', () => {
	const actions = sweep(
		[
			job({ id: 'live', status: 'running', leaseExpiresAt: T0 + 1000 }),
			job({ id: 'ack', status: 'assigned', attempts: 0, leaseExpiresAt: T0 - 1 }),
			job({ id: 'dead', status: 'running', attempts: 1, maxAttempts: 3, leaseExpiresAt: T0 - 1 }),
			job({ id: 'gone', status: 'running', attempts: 2, maxAttempts: 3, leaseExpiresAt: T0 - 1 })
		],
		T0
	);
	expect(actions.map((a) => a.id)).toEqual(['ack', 'dead', 'gone']); // 'live' untouched
	expect(actions.find((a) => a.id === 'ack')).toMatchObject({ kind: 'requeue', attempts: 0 });
	expect(actions.find((a) => a.id === 'dead')).toMatchObject({ kind: 'requeue', attempts: 2 });
	expect(actions.find((a) => a.id === 'gone')!.kind).toBe('fail');
});

test('inflightToRecover selects every assigned/running job (and nothing else)', () => {
	const jobs = [
		job({ id: 'a', status: 'assigned' }),
		job({ id: 'r', status: 'running' }),
		job({ id: 'q', status: 'queued' }),
		job({ id: 'done', status: 'ready' })
	];
	expect(inflightToRecover(jobs)).toEqual(['a', 'r']);
});
