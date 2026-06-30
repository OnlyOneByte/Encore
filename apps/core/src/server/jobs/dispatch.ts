// Pure dispatch policy (§4) — no DB, no IO, no sockets. Decides which queued job goes to which
// worker, honoring capability match, least-loaded selection, and need-order (priority = the
// rotationSeq of the soonest queue entry that needs this media; lower = sooner). The I/O wrapper
// (worker-hub.ts) applies the assignments: marks the job assigned + sends job:assign.

import type { Job } from '@encore/shared';
import type { WorkerSession } from './registry';

export interface Assignment {
	jobId: string;
	workerId: string;
}

/** A worker can take a job iff it has a free slot and advertises the job's type. */
function eligible(worker: WorkerSession, job: Job): boolean {
	return worker.slotsFree > 0 && worker.capabilities.includes(job.jobType);
}

/**
 * Plan assignments for the current queued jobs against available worker capacity. PURE and
 * greedy: repeatedly take the highest-priority queued job, give it to the least-loaded eligible
 * worker (most slotsFree), decrement that worker's slots locally, repeat until no job can be
 * placed. Workers' real slot counts are mutated by the caller as it sends assignments.
 *
 *   next_job = queued.order_by(priority ASC, createdAt ASC).first
 *   worker   = eligible.order_by(slotsFree DESC).first
 *
 * A job with no eligible worker is simply left queued (it dispatches when a worker frees up / a
 * matching worker connects). Returns the assignments in the order they should be sent.
 */
export function planAssignments(queued: Job[], workers: WorkerSession[]): Assignment[] {
	// local slot view so we don't over-assign within a single planning pass
	const slots = new Map(workers.map((w) => [w.workerId, w.slotsFree]));
	const byId = new Map(workers.map((w) => [w.workerId, w]));

	const jobs = [...queued].sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
	const assignments: Assignment[] = [];

	for (const job of jobs) {
		let best: WorkerSession | null = null;
		for (const w of workers) {
			if (!w.capabilities.includes(job.jobType)) continue;
			if ((slots.get(w.workerId) ?? 0) <= 0) continue;
			if (!best || slots.get(w.workerId)! > slots.get(best.workerId)!) best = w;
		}
		if (!best) continue; // no eligible worker with capacity — leave queued
		assignments.push({ jobId: job.id, workerId: best.workerId });
		slots.set(best.workerId, slots.get(best.workerId)! - 1);
	}
	return assignments;
}

/** Whether ANY live worker could ever take this job (capability match, ignoring current load) —
 *  used to decide if a job should wait for capacity vs. is unservable by the current fleet. */
export function hasCapableWorker(job: Job, workers: WorkerSession[]): boolean {
	return workers.some((w) => w.capabilities.includes(job.jobType));
}

export { eligible };
