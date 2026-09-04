// Cancelling a song that is mid-processing — the ONE piece of core glue the feature was missing.
//
// Everything else already exists: `canceled` is a terminal job state with legal edges from
// queued/assigned/running (transitions.ts), JobRepository.cancel() seals the ledger and frees the
// dedup slot, the `job:cancel` WorkerCommand is on the wire, and the Python worker implements it end
// to end (subprocess kill, slot release, scratch cleanup). What was absent is that the queue `remove`
// op only ever mutated the queue array: it never told the job system to stop. So the phone's remove
// button on a cooking row LIED — the row vanished while the worker kept cooking, holding a
// concurrency slot and finishing an instrumental nobody would hear. This closes that gap.
//
// Deliberately NOT wired into a `leave` (singers/leave.ts): an in-flight cook survives a leave on
// purpose, because a cooked instrumental is a durable library asset anyone can reuse, whereas an
// explicit remove is a person saying "stop this one now". Two different acts, kept different.

import { isTerminalJob, type JobType, type QueueEntry, type WorkerCommand } from '@encore/shared';
import type { JobRepository } from './repository';

// The full pipeline. A cook can be live at ANY of these stages — `fetch` (downloading), `stems`
// (separating), `align` (timing lyrics), or a background `stems-upgrade` — and a remove should stop
// whichever is running. Enumerated (not inferred) so a new job type is a compile error here rather
// than a silently un-cancellable cook. Mirrors packages/shared JobType exactly.
const PIPELINE_JOB_TYPES: readonly JobType[] = ['fetch', 'stems', 'align', 'stems-upgrade'];

export interface CancelJobsDeps {
	jobs: JobRepository;
	/** Send a WorkerCommand to ONE worker session (app.toWorker). */
	toWorker: (workerId: string, cmd: WorkerCommand) => void;
	/**
	 * The queue AFTER the remove has been applied. Edge (a): two singers can queue the same song and
	 * dedup means ONE job, so a cook must only be cancelled when NOTHING left in the queue still needs
	 * that media — otherwise one singer's remove kills a cook another is still waiting for.
	 */
	remainingEntries: QueueEntry[];
	now: () => number;
}

export interface CancelResult {
	/** Job ids moved to `canceled`. Empty when the media was still needed, or had no live cook. */
	canceled: string[];
	/** Worker ids sent a `job:cancel` (a subset — only jobs a worker actually owns). */
	notifiedWorkers: string[];
}

/**
 * Cancel every live cook for `mediaId`, unless another queue entry still references it.
 *
 * Called from the queue-command remove path (realtime/hub.ts). Idempotent and safe to call for a
 * media that was never cooking: it simply finds no live jobs and returns empty.
 */
export function cancelJobsForMedia(mediaId: string, deps: CancelJobsDeps): CancelResult {
	const result: CancelResult = { canceled: [], notifiedWorkers: [] };

	// Edge (a) — the most important correctness condition. If ANY surviving entry still points at this
	// media, the cook is shared and must live on. Check the post-remove queue, so the entry just
	// removed is already gone from it.
	if (deps.remainingEntries.some((e) => e.mediaId === mediaId)) return result;

	for (const jobType of PIPELINE_JOB_TYPES) {
		const job = deps.jobs.findLive(mediaId, jobType);
		// `findLive` excludes failed/canceled but INCLUDES `ready`. Edge (b): a job that already
		// reached a terminal state (it finished the instant before the tap) cannot be cancelled —
		// `cancel` would throw an illegal-transition error. Guard on non-terminal status rather than
		// blindly swallowing the throw, so a real bug still surfaces.
		if (!job || isTerminalJob(job.status)) continue;

		// If a worker owns it (assigned or running), tell that worker to kill its subprocess BEFORE we
		// seal the ledger row — after cancel() clears workerId there is no one left to notify. The
		// worker frees its own concurrency slot and the registry catches up on the next heartbeat; we
		// deliberately do NOT release the slot here, since a proactive release could double-free while
		// racing an in-flight completion.
		if (job.workerId) {
			deps.toWorker(job.workerId, { type: 'job:cancel', jobId: job.id, reason: 'song removed from queue' });
			result.notifiedWorkers.push(job.workerId);
		}

		deps.jobs.cancel(job.id, deps.now());
		result.canceled.push(job.id);
	}

	return result;
}
