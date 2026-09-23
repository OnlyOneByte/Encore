// Cancelling a song mid-processing. Wires the queue's `remove` op — which only ever mutated the queue
// array — to the job system (transitions.ts's `canceled` state, JobRepository.cancel(), the
// `job:cancel` wire command, the worker's subprocess kill), so a removed row's process actually stops
// instead of finishing unseen and holding a concurrency slot.
//
// Deliberately NOT wired into `leave` (singers/leave.ts): an in-flight process survives a leave on
// purpose, because a processed instrumental is a durable library asset anyone can reuse, whereas an
// explicit remove is a person saying "stop this one now".

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

// A process can be live at any of these stages; a remove should stop whichever is running. Kept as an
// exhaustive `Record<JobType, true>` rather than a `JobType[]` literal so TypeScript forces every new
// JobType to be listed here, turning a forgotten job type into a typecheck failure instead of a
// silently un-cancellable process. The loop below walks `PIPELINE_JOB_TYPES`, derived from these keys
// in insertion order (fetch → stems → align → stems-upgrade), so it can't drift from this table.
const CANCELLABLE_JOB_TYPES: Record<JobType, true> = {
	fetch: true,
	stems: true,
	align: true,
	'stems-upgrade': true
};
const PIPELINE_JOB_TYPES = Object.keys(CANCELLABLE_JOB_TYPES) as readonly JobType[];

export interface CancelJobsDeps {
	jobs: JobRepository;
	/** Send a WorkerCommand to ONE worker session (app.toWorker). */
	toWorker: (workerId: string, cmd: WorkerCommand) => void;
	/** The queue AFTER the remove has been applied. Two singers can queue the same song and dedup means
	 *  ONE job, so a process must only be cancelled when nothing left in the queue still needs that
	 *  media — else one singer's remove kills a process another is still waiting for. */
	remainingEntries: QueueEntry[];
	now: () => number;
	/** Runtime catalog + broadcast sink, so a cancel can un-strand the song the way a terminal FAILURE
	 *  already does via `settleStemsGate` — cancelling the JOB alone leaves `media.stemStatus` at the
	 *  'queued' `requestProcess` set, stranding the song as "processing" forever and refusing a
	 *  re-process. Optional so pure job-ledger tests stay bare; server.ts wires both. */
	mediaById?: Map<string, Media>;
	broadcast?: (event: ServerEvent) => void;
}

export interface CancelResult {
	/** Job ids moved to `canceled`. Empty when the media was still needed, or had no live process. */
	canceled: string[];
	/** Worker ids sent a `job:cancel` (a subset — only jobs a worker actually owns). */
	notifiedWorkers: string[];
}

/** Cancels every live process for `mediaId` unless another queue entry still references it. Called
 *  from the queue-command remove path (realtime/hub.ts); idempotent for media that was never processing. */
export function cancelJobsForMedia(mediaId: string, deps: CancelJobsDeps): CancelResult {
	const result: CancelResult = { canceled: [], notifiedWorkers: [] };

	// If any surviving entry still points at this media, the process is shared and must live on.
	if (deps.remainingEntries.some((e) => e.mediaId === mediaId)) return result;

	const canceledTypes = new Set<JobType>(); // which gate(s) to settle below

	for (const jobType of PIPELINE_JOB_TYPES) {
		const job = deps.jobs.findLive(mediaId, jobType);
		// `findLive` includes `ready`: a job that reached a terminal state an instant before the tap
		// can't be cancelled (`cancel` throws on an illegal transition), so skip rather than swallow it.
		if (!job || isTerminalJob(job.status)) continue;

		// Notify the worker BEFORE sealing the ledger row — cancel() clears workerId, so after that
		// there's no one left to tell. The worker frees its own slot on the next heartbeat; a proactive
		// release here could double-free while racing an in-flight completion.
		if (job.workerId) {
			deps.toWorker(job.workerId, { type: 'job:cancel', jobId: job.id, reason: 'song removed from queue' });
			result.notifiedWorkers.push(job.workerId);
		}

		deps.jobs.cancel(job.id, deps.now());
		result.canceled.push(job.id);
		canceledTypes.add(jobType);
	}

	// Only when we actually cancelled something: a no-op (nothing live, or a shared process left alone
	// above) must not walk an unrelated media's status. Settle WHICHEVER gate the cancelled type(s)
	// belong to, mirroring worker-hub.ts's terminal-failure path: a cancelled `align` settles the LYRICS
	// gate (stopped align is a legitimate "no words" outcome), a cancelled `fetch`/`stems` settles the
	// STEMS gate back to un-processed, and `stems-upgrade` settles neither (the song keeps its working
	// instrumental). Without this the media stays stuck reading 'processing' forever, refusing a
	// re-process, since nothing else resets the `stemStatus`/lyrics gate that `requestProcess` opened.
	if (result.canceled.length > 0 && deps.mediaById) {
		const stemsSettled =
			(canceledTypes.has('fetch') || canceledTypes.has('stems')) && settleStemsGate(mediaId, deps.mediaById);
		const lyricsSettled = canceledTypes.has('align') && settleLyricsGate(mediaId, deps.mediaById);
		if (stemsSettled || lyricsSettled) {
			// 'canceled' (not 'failed', not left as 'queued') is the honest terminal status here: 'queued'
			// would re-strand the row as processing, and 'failed' would tell the guest who removed the
			// song that karaoke-making failed. This only updates a live-status-keyed surface (a search
			// row) — the removed queue row itself is already gone via queue:patch.
			deps.broadcast?.({ type: 'media:status', mediaId, status: 'canceled', pct: 0 });
		}
	}

	return result;
}
