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

import {
	isTerminalJob,
	type JobType,
	type QueueEntry,
	type WorkerCommand,
	type ServerEvent,
	type Media
} from '$shared';
import type { JobRepository } from './repository';
import { settleLyricsGate, settleStemsGate } from './make-karaoke';

// The full pipeline. A cook can be live at ANY of these stages — `fetch` (downloading), `stems`
// (separating), `align` (timing lyrics), or a background `stems-upgrade` — and a remove should stop
// whichever is running. Enumerated (not inferred) so a new job type is a compile error here rather
// than a silently un-cancellable cook. Mirrors apps/core/src/shared JobType exactly.
//
// The promise is delivered by `CANCELLABLE_JOB_TYPES`, an exhaustive `Record<JobType, true>`:
// TypeScript requires EVERY `JobType` member as a key, so adding a fifth job type without listing
// it here fails typecheck at this table (a bare `readonly JobType[]` literal would silently accept
// the omission). `PIPELINE_JOB_TYPES` is derived from its keys, so the loop bound cannot drift from
// the witness and cannot be missing a member.
const CANCELLABLE_JOB_TYPES: Record<JobType, true> = {
	fetch: true,
	stems: true,
	align: true,
	'stems-upgrade': true
};
// The cancel loop walks these in the record's own insertion order (fetch → stems → align →
// stems-upgrade), derived from the single exhaustive source above.
const PIPELINE_JOB_TYPES = Object.keys(CANCELLABLE_JOB_TYPES) as readonly JobType[];

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
	/**
	 * The runtime catalog + room broadcast sink, so a cancel can un-strand the song the way a
	 * terminal FAILURE already does. Optional so the pure job-ledger tests (and any caller that only
	 * cares about the ledger) stay bare; server.ts wires both.
	 *
	 * WHY this exists: cancelling the JOB (below) is only half the story. `requestMakeKaraoke` set
	 * `media.stemStatus = 'queued'` before the cook started, and nothing here reset it — so after the
	 * row vanished the media still read as cooking on every surface FOREVER, and `cookState` answered
	 * 'cooking' and refused a re-cook. That is the exact stranding `settleStemsGate` was added to fix
	 * for the failure path; the cancel path had the identical hole. We reuse that helper and emit a
	 * `media:status` so phones drop the stale "Making karaoke…" line.
	 */
	mediaById?: Map<string, Media>;
	broadcast?: (event: ServerEvent) => void;
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

	// Which pipeline gates the cancelled jobs belong to, so the settle below walks back exactly the
	// gate(s) that were mid-flight — not just the stems one.
	const canceledTypes = new Set<JobType>();

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
		canceledTypes.add(jobType);
	}

	// The job ledger is now clear, but the MEDIA still reads as cooking: requestMakeKaraoke flipped
	// stemStatus to 'queued' before the cook, and the loop above never touched it. Settle it back to
	// un-cooked (the same remedy the terminal-failure path uses) and tell the room, so the phone drops
	// the stale progress line and the Sing button comes back. Only when we actually cancelled a cook:
	// a no-op cancel (nothing live, or a shared cook that lived on via the edge-(a) return) must not
	// walk an unrelated media's status, and settleStemsGate already refuses to touch a finished cook.
	if (result.canceled.length > 0 && deps.mediaById) {
		// Settle WHICHEVER gate the cancelled job(s) belong to, mirroring the terminal-failure path in
		// worker-hub.ts (#onFailed): a cancelled `align` settles the LYRICS gate (align having stopped is
		// a legitimate "no words" outcome — a song with no words is a finished song), while a cancelled
		// `fetch`/`stems` settles the STEMS gate back to un-cooked. `stems-upgrade` settles neither: the
		// song still has its working instrumental, which settleStemsGate refuses to walk back anyway.
		//
		// WHY this matters: once singing waits on the lyrics gate, cancelling a song mid-`align` left the
		// gate open forever with no lyricsRef, so readyToSing stayed false and every future queue entry
		// for the song was held and skipped — permanently, for everyone — while its live instrumental made
		// cookState answer 'ready' and refuse a re-cook. Settling only stems (which no-ops on a finished
		// cook) fixed neither half and, because the broadcast was gated on that no-op, emitted no event at
		// all. Settle the real gate and broadcast when EITHER settle landed.
		const stemsSettled =
			(canceledTypes.has('fetch') || canceledTypes.has('stems')) && settleStemsGate(mediaId, deps.mediaById);
		const lyricsSettled = canceledTypes.has('align') && settleLyricsGate(mediaId, deps.mediaById);
		if (stemsSettled || lyricsSettled) {
			// `MediaStatus` has a dedicated 'canceled' precisely so this is not a lie. The two statuses a
			// client settles as terminal are 'ready' and 'failed'; every OTHER mid-flight value is written
			// back as 'queued' by the phone and reads as cooking, i.e. it would re-strand the row we just
			// freed. 'failed' would settle it correctly but makes the phone say "Couldn't make karaoke"
			// to the guest who deliberately removed the song. 'canceled' settles the same way and says
			// nothing. The removed row itself is already gone via queue:patch; this only tells a surface
			// still keyed on the live-status map (a search row) to stop showing the song as cooking.
			deps.broadcast?.({ type: 'media:status', mediaId, status: 'canceled', pct: 0 });
		}
	}

	return result;
}
