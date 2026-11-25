// Wires the queue's `remove` op to the job system, so a removed row's process actually stops instead of
// finishing unseen and holding a concurrency slot.
//
// Deliberately NOT wired into `leave`: an in-flight process SURVIVES a leave, because a processed
// instrumental is a durable library asset anyone can reuse, while an explicit remove is "stop this one".

import {
	isTerminalJob,
	type JobType,
	type QueueEntry,
	type WorkerCommand,
	type ServerEvent,
	type Media
} from '../../contract';
import type { JobRepository } from './repository';
import { settleLyricsGate, settleStemsGate } from './process';

// An exhaustive `Record<JobType, true>` rather than a `JobType[]` literal, so TypeScript forces every new
// JobType to be listed and a forgotten one is a typecheck failure rather than a silently un-cancellable
// process. The loop walks `PIPELINE_JOB_TYPES`, derived from these keys, so it cannot drift from them.
const CANCELLABLE_JOB_TYPES: Record<JobType, true> = {
	fetch: true,
	stems: true,
	align: true,
	'stems-upgrade': true,
	'stems-remake': true
};
const PIPELINE_JOB_TYPES = Object.keys(CANCELLABLE_JOB_TYPES) as readonly JobType[];

export interface CancelJobsDeps {
	jobs: JobRepository;
	/** Send a WorkerCommand to ONE worker session (app.toWorker). */
	toWorker: (workerId: string, cmd: WorkerCommand) => void;
	/** AFTER the remove. Two singers sharing a song share ONE job, so a process may only be cancelled
	 *  when nothing left in the queue still needs that media. */
	remainingEntries: QueueEntry[];
	now: () => number;
	/** Lets a cancel un-strand the song the way a terminal FAILURE does: cancelling the JOB alone leaves
	 *  `stemStatus` at the 'queued' requestProcess set, stranding it as "processing" forever. */
	mediaById?: Map<string, Media>;
	broadcast?: (event: ServerEvent) => void;
}

export interface CancelResult {
	/** Job ids moved to `canceled`. Empty when the media was still needed, or had no live process. */
	canceled: string[];
	/** Worker ids sent a `job:cancel` (a subset — only jobs a worker actually owns). */
	notifiedWorkers: string[];
}

/** Unless another queue entry still references it. Idempotent for media that was never processing. */
export function cancelJobsForMedia(mediaId: string, deps: CancelJobsDeps): CancelResult {
	const result: CancelResult = { canceled: [], notifiedWorkers: [] };

	// A surviving entry pointing at this media means the process is SHARED and must live on.
	if (deps.remainingEntries.some((e) => e.mediaId === mediaId)) return result;

	const canceledTypes = new Set<JobType>(); // which gate(s) to settle below

	for (const jobType of PIPELINE_JOB_TYPES) {
		const job = deps.jobs.findLive(mediaId, jobType);
		// `findLive` includes `ready`, and `cancel` throws on that illegal transition, so skip it.
		if (!job || isTerminalJob(job.status)) continue;

		// Notify the worker BEFORE sealing the row: cancel() clears workerId, so afterwards there is no
		// one left to tell. The worker frees its own slot on the next heartbeat, and a proactive release
		// here could double-free while racing an in-flight completion.
		if (job.workerId) {
			deps.toWorker(job.workerId, { type: 'job:cancel', jobId: job.id, reason: 'song removed from queue' });
			result.notifiedWorkers.push(job.workerId);
		}

		deps.jobs.cancel(job.id, deps.now());
		result.canceled.push(job.id);
		canceledTypes.add(jobType);
	}

	// ONLY when something was actually cancelled: a no-op must not walk an unrelated media's status.
	// Settles whichever gate the cancelled types belong to, mirroring worker-hub's terminal-failure path.
	// Without it the media reads 'processing' forever and refuses a re-process, since nothing else resets
	// the gate `requestProcess` opened.
	if (result.canceled.length > 0 && deps.mediaById) {
		const stemsSettled =
			(canceledTypes.has('fetch') || canceledTypes.has('stems')) && settleStemsGate(mediaId, deps.mediaById);
		const lyricsSettled = canceledTypes.has('align') && settleLyricsGate(mediaId, deps.mediaById);
		if (stemsSettled || lyricsSettled) {
			// 'canceled', not 'failed' and not left 'queued': 'queued' re-strands the row as processing, and
			// 'failed' tells the guest who removed the song that karaoke-making failed.
			deps.broadcast?.({ type: 'media:status', mediaId, status: 'canceled', pct: 0 });
		}
	}

	return result;
}
