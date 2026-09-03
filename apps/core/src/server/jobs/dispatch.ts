// Pure dispatch policy (§4) — no DB, no IO, no sockets. Decides which queued job goes to which
// worker, honoring capability match, least-loaded selection, and need-order (priority = the
// rotationSeq of the soonest queue entry that needs this media; lower = sooner). The I/O wrapper
// (worker-hub.ts) applies the assignments: marks the job assigned + sends job:assign.

import type { Job, JobParams, JobType, Media } from '@encore/shared';
import type { WorkerSession } from './registry';

/**
 * The inputs a job of this type needs, derived from its media. PURE — no DB, no clock (B-3-C1).
 *
 * An align job needs the CANONICAL artist/title, and only when the normalizer was confident: a
 * lookup on a guessed title returns nothing or, worse, another song's words. Absent keys are how the
 * worker learns "no authoritative lookup is possible here" and goes straight to transcription, so
 * omitting is meaningfully different from sending the raw uploader string.
 *
 * `durationSec` is always safe to send — it narrows an LRCLIB match and bounds the line-sync
 * fallback's synthetic timings.
 */
/**
 * The jobs a just-COMPLETED job should enqueue next — the cook pipeline. PURE.
 *
 * `stems` → `align` because lyrics run on every cook (owner's call), and chaining rather than
 * enqueueing both up front is deliberate: the ASR tier transcribes the VOCALS STEM, which does not
 * exist until stems finishes. Enqueueing both at once would have the align job race the very
 * separation that produces its input, and on a fixed core count the two would contend for the same
 * cores instead of running one after the other.
 *
 * Chaining costs nothing user-visible: the song is not singable until stems completes either, because
 * the instrumental IS the stems output.
 *
 * `score` (M8-C3) is unreachable for exactly the same reason align was and belongs here too, but it
 * is out of B-3's scope — add it when that milestone is revisited.
 */
export function followUps(jobType: JobType): JobType[] {
	return jobType === 'stems' ? ['align'] : [];
}

export function assignParams(jobType: JobType, media: Media | undefined): JobParams {
	if (jobType === 'stems') return { model: 'htdemucs' };
	if (jobType !== 'align') return {};
	const params: JobParams = {};
	if (media?.artistCanonical) params.artist = media.artistCanonical;
	if (media?.titleCanonical) params.track = media.titleCanonical;
	if (media && Number.isFinite(media.durationSec) && media.durationSec > 0) {
		params.durationSec = media.durationSec;
	}
	return params;
}

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
