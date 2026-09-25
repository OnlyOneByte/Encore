// Pure lease policy — no DB, no clock, no IO; the I/O orchestrator is reaper.ts. A job is "owned" by a
// worker only while a deadline the reaper checks hasn't passed; the lease kind is inferred from the
// job's STATUS, not stored separately. Ack lease (assigned, pre-accept) requeues with attempts
// unchanged on expiry — the worker never started. Progress lease (running) means expiry burns an
// attempt (worker assumed dead). See docs/ARCHITECTURE.md §7.

import type { Job } from '../../contract';

export interface LeaseConfig {
	/** Grace for a worker to `job:accept` after dispatch before requeue (§3, default 10s). */
	ackTimeoutMs: number;
	/** Grace for the next `job:progress`/heartbeat while running before assumed-dead (§3, default 30s). */
	progressLeaseMs: number;
}

export const DEFAULT_LEASE_CONFIG: LeaseConfig = {
	ackTimeoutMs: 10_000,
	progressLeaseMs: 30_000
};

/** The ONE place the retry-exhaustion rule is written; `sweep` below and worker-hub's `job:failed`
 *  handler both call it rather than re-testing `attempts >= maxAttempts` themselves, so a policy change
 *  (e.g. a per-job-type cap) cannot leave the two call sites silently disagreeing about when a job is dead. */
export function attemptsExhausted(attempts: number, maxAttempts: number): boolean {
	return attempts >= maxAttempts;
}

/** Deadline to stamp on a job at dispatch (`assign`) — the ack lease. */
export function ackDeadline(now: number, cfg: LeaseConfig = DEFAULT_LEASE_CONFIG): number {
	return now + cfg.ackTimeoutMs;
}

/** Deadline to stamp on `accept`/`progress` — the (re)freshed progress lease. */
export function progressDeadline(now: number, cfg: LeaseConfig = DEFAULT_LEASE_CONFIG): number {
	return now + cfg.progressLeaseMs;
}

/** What the reaper should do with one expired job. */
export type ReapAction =
	| { id: string; kind: 'requeue'; attempts: number; reason: 'ack-timeout' | 'progress-lease-expired' }
	| { id: string; kind: 'fail'; attempts: number; error: string };

/** PURE — reaper.ts applies the actions. `assigned` expiry (ack-timeout) requeues with attempts
 *  UNCHANGED since the worker never started; `running` expiry burns an attempt, failing if exhausted. */
export function sweep(jobs: Job[], now: number): ReapAction[] {
	const actions: ReapAction[] = [];
	for (const job of jobs) {
		if (job.leaseExpiresAt == null || now <= job.leaseExpiresAt) continue; // lease alive

		if (job.status === 'assigned') {
			actions.push({ id: job.id, kind: 'requeue', attempts: job.attempts, reason: 'ack-timeout' });
		} else if (job.status === 'running') {
			const attempts = job.attempts + 1;
			if (attemptsExhausted(attempts, job.maxAttempts)) {
				actions.push({
					id: job.id,
					kind: 'fail',
					attempts,
					error: `worker died: progress-lease expired (attempts exhausted ${attempts}/${job.maxAttempts})`
				});
			} else {
				actions.push({ id: job.id, kind: 'requeue', attempts, reason: 'progress-lease-expired' });
			}
		}
	}
	return actions;
}

/** Boot recovery: every owning WS session is gone by definition, so every in-flight job resets to
 *  `queued`. PURE — returns ids for the caller to requeue. Attempts are NOT incremented; a core
 *  restart isn't the worker's fault. */
export function inflightToRecover(jobs: Job[]): string[] {
	return jobs.filter((j) => j.status === 'assigned' || j.status === 'running').map((j) => j.id);
}
