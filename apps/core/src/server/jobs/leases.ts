// Pure lease policy — no DB, no clock, no IO (the I/O orchestrator is reaper.ts). Leases are the
// crash-recovery mechanism: a job is only "owned" by a worker with a live WS session, enforced by
// a deadline the reaper checks. See docs/ARCHITECTURE.md.
//
// Two lease kinds, distinguished by the job's STATUS (not stored separately):
//   • ack lease     — set on `assign`; worker must `job:accept` before it expires, else requeue
//                     (NO attempt burned — the worker never started).
//   • progress lease — set on `accept`/`progress`; worker must heartbeat before it expires, else
//                      the worker is assumed dead → attempts++ → requeue, or fail if exhausted.

import type { Job } from '$shared';

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

/**
 * Have this job's processing attempts run out? The §8 retry policy: a job with `attempts` burned may
 * still be retried while it has budget left, and fails terminally once `attempts` reaches
 * `maxAttempts`. This is the ONE place that rule is written. It was inlined in two places that had
 * to stay in lockstep by hand — the reaper's progress-lease-expiry branch (`sweep`, below) and the
 * worker-hub's `job:failed` handler — with the second spelling it as the complement
 * (`attempts < job.maxAttempts`), so a change to the policy (say, a per-job-type cap) had to be
 * mirrored across both sites or they would silently disagree about when a cook is dead. Named once,
 * shared, so the retry ceiling cannot drift between the reaper path and the worker-reported path.
 */
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

/**
 * Decide reaper actions for a batch of in-flight (assigned/running) jobs at time `now`. PURE — the
 * caller (reaper.ts) applies the actions. A job whose lease is still alive (or null) is left alone.
 *   • assigned + expired → ack-timeout → requeue, attempts UNCHANGED (worker never started).
 *   • running  + expired → progress-lease-expired → attempts++; fail if that hits maxAttempts (§8),
 *                          else requeue.
 */
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

/**
 * Boot recovery selector (§3): on core startup every owning WS session is gone by definition, so
 * every `assigned`/`running` job must reset to `queued` for redispatch. PURE — returns the ids;
 * the caller requeues them. Attempts are NOT incremented (a core restart isn't the worker's fault).
 */
export function inflightToRecover(jobs: Job[]): string[] {
	return jobs.filter((j) => j.status === 'assigned' || j.status === 'running').map((j) => j.id);
}
