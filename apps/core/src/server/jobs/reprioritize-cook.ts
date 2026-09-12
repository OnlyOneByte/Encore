// Re-prioritising a cook whose turn arrived AFTER it was filed — the starvation half of the late queue-add defect.
//
// A cook's `priority` is a snapshot of `soonestSeqFor` taken ONCE, at enqueue (make-karaoke.ts).
// The queue entry that gives a song its rotation position, though, does not always exist yet when
// the cook is filed: a `make-karaoke` POST can land while the singer's queue `add` is still in
// flight over a reconnecting socket, so at enqueue `soonestSeqFor` sees no waiting turn and the cook
// is filed at NO_QUEUE_PRIORITY (MAX_SAFE_INTEGER, "nobody is waiting"). When the add finally lands
// on reconnect, nothing revisits the cook's priority — so dispatch's `priority ASC, createdAt ASC`
// sort (dispatch.ts) keeps it behind even the boot-time lyrics backfill FOREVER, while a singer
// stands there waiting. Its sibling — cancelling a cook when its LAST entry is removed — already has
// a symmetric hook (cancelJobsForMedia, off hub.ts `onEntryRemoved`). This is the add-side mirror.
//
// Deliberately narrow (this issue is only the reconnect-starvation path):
//   • It corrects the OUTSTANDING step only (findOutstandingForMedia), not the whole chain —
//     worker-hub.ts inherits `job.priority` when it chains fetch → stems → align, so fixing the step
//     the room is actually waiting on carries down. `stems-upgrade` (background work on a finished
//     song) is excluded by findOutstandingForMedia and stays at the back where it belongs.
//   • JobRepository.reprioritize only ever LOWERS the number, so this can never demote a cook, only
//     unstick a starved one. Firing it on every add is therefore safe: a healthy cook (already filed
//     at its singer's position) sees an equal-or-higher target and is left untouched.
//
// NOT in scope (see the issue's out-of-scope note): reseqAll renumbers every entry's rotationSeq on
// every mutation, so a cook's priority also goes stale on move/remove, not only on reconnect. Only
// the reconnect case has a real starvation consequence; a general "recompute on every applyQueueOp"
// would naturally land on this same add hook later.

import type { QueueEntry } from '$shared';
import type { JobRepository } from './repository';
import { soonestSeqFor } from './make-karaoke';

export interface ReprioritizeCookDeps {
	jobs: JobRepository;
	/** The queue AFTER the add has been applied — so the just-added entry is already in it. */
	entries: QueueEntry[];
	now: () => number;
	/**
	 * Kick the scheduler after a successful reprioritise, so the un-stuck cook is offered to a worker
	 * without waiting for the next unrelated dispatch trigger. app.workerHub.dispatch() in server.ts.
	 */
	dispatch: () => void;
}

/**
 * If the outstanding cook for `mediaId` is filed at a WORSE priority than the soonest turn now
 * waiting on it, lower it to that turn's position and kick dispatch. Idempotent and safe to call on
 * every add: it finds no outstanding job, or nothing more urgent to do, and returns false.
 *
 * Returns whether it actually changed a priority (for tests / callers that want to know).
 */
export function reprioritizeCookForMedia(mediaId: string, deps: ReprioritizeCookDeps): boolean {
	const job = deps.jobs.findOutstandingForMedia(mediaId);
	if (!job) return false; // no cook in flight for this song — nothing to unstick

	const target = soonestSeqFor(mediaId, deps.entries);
	// reprioritize is a no-op unless `target` is strictly more urgent than the job's current
	// priority, so the guard here only avoids the needless dispatch() kick. Compare against the
	// job we read rather than re-reading after the write.
	if (target >= job.priority) return false;

	deps.jobs.reprioritize(job.id, target, deps.now());
	deps.dispatch();
	return true;
}
