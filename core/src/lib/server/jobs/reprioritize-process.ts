// Fixes reconnect starvation: a process's `priority` is a ONE-TIME snapshot of `soonestSeqFor` at
// enqueue (process.ts), so if the `process` POST lands before the singer's queue `add` (reconnecting
// socket), it's filed at NO_QUEUE_PRIORITY ("nobody is waiting") and nothing revisits it — dispatch's
// priority-ASC sort then strands it behind even the boot lyrics backfill forever. Mirrors the existing
// cancelJobsForMedia hook that fires on entry removal (hub.ts `onEntryRemoved`).
//
// Only corrects the OUTSTANDING step (findOutstandingForMedia): worker-hub.ts inherits `job.priority`
// through the fetch→stems→align chain, so fixing the step a room is actually waiting on carries down;
// `stems-upgrade` (background work on an already-finished song) is excluded and stays at the back.
// `JobRepository.reprioritize` only ever LOWERS the number, so calling this on every add is safe — it
// can unstick a starved process but never demote a healthy one.

import type { QueueEntry } from '../../contract';
import type { JobRepository } from './repository';
import { soonestSeqFor } from './process';

export interface ReprioritizeProcessDeps {
	jobs: JobRepository;
	/** The queue AFTER the add has been applied — so the just-added entry is already in it. */
	entries: QueueEntry[];
	now: () => number;
	/** Kicks the scheduler after a successful reprioritise so the un-stuck process is offered to a
	 *  worker without waiting for the next unrelated trigger. app.workerHub.dispatch() in server.ts. */
	dispatch: () => void;
}

/** Lowers the outstanding process for `mediaId` to the soonest turn now waiting on it and kicks
 *  dispatch; idempotent, safe on every add. Returns whether it actually changed a priority. */
export function reprioritizeProcessForMedia(mediaId: string, deps: ReprioritizeProcessDeps): boolean {
	const job = deps.jobs.findOutstandingForMedia(mediaId);
	if (!job) return false;

	const target = soonestSeqFor(mediaId, deps.entries);
	if (target >= job.priority) return false;

	deps.jobs.reprioritize(job.id, target, deps.now());
	deps.dispatch();
	return true;
}
