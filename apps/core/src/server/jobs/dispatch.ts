// Pure dispatch policy (§4) — no DB, no IO, no sockets. Decides which queued job goes to which
// worker, honoring capability match, least-loaded selection, and need-order (priority = the
// rotationSeq of the soonest queue entry that needs this media; lower = sooner). The I/O wrapper
// (worker-hub.ts) applies the assignments: marks the job assigned + sends job:assign.

import type { Job, JobParams, JobType, Media, GlobalSettings } from '@encore/shared';
import { DEFAULT_ENGINE, DEFAULT_MODEL, DEFAULT_GLOBAL_SETTINGS, getEngine, isQualityUpgrade } from '@encore/shared';
import type { WorkerSession } from './registry';

/**
 * The jobs a just-COMPLETED job should enqueue next — the cook pipeline. PURE.
 *
 * `stems` chains to `align` + `score` rather than enqueueing all three up front because both read the
 * VOCALS STEM, which does not exist until stems finishes — enqueueing at once would race the
 * separation that produces their input and contend for the same cores. Both are strictly after stems
 * and neither chains further, so the pipeline stays a depth-1 fan-out. (Chaining costs nothing
 * user-visible: the song isn't singable until stems completes either.)
 */
export function followUps(jobType: JobType, settings?: GlobalSettings): JobType[] {
	if (jobType !== 'stems') return [];
	const next: JobType[] = ['align', 'score'];
	// A completed cook optionally chains a re-separation at higher quality. It runs from the RETAINED
	// raw audio, so it costs CPU but no re-download, and `markMediaReady` refuses to publish its
	// result unless it actually outranks what is already there.
	if (settings?.enqueueUpgrade && isQualityUpgrade(
		{ engine: settings.defaultEngine, model: settings.defaultModel },
		{ engine: settings.upgradeEngine, model: settings.upgradeModel }
	)) {
		next.push('stems-upgrade');
	}
	return next;
}

/**
 * The inputs a job of this type needs, derived from its media. PURE — no DB, no clock.
 *
 * An align job gets the CANONICAL artist/title only when the normalizer was confident: a lookup on a
 * guessed title returns nothing or another song's words, so omitting keys is how the worker learns
 * "no authoritative lookup is possible" and transcribes instead — meaningfully different from sending
 * the raw uploader string. `durationSec` is always safe: it narrows an LRCLIB match and bounds the
 * line-sync fallback's synthetic timings.
 */
export function assignParams(jobType: JobType, media: Media | undefined, settings?: GlobalSettings): JobParams {
	// stems carries the room's engine+model, the upgrade its upgrade engine+model. Both fall back to
	// shared defaults when no settings are provided (e.g. a unit test), so the worker still gets a
	// valid pairing.
	if (jobType === 'stems') {
		return { engine: settings?.defaultEngine ?? DEFAULT_ENGINE, model: settings?.defaultModel ?? DEFAULT_MODEL };
	}
	if (jobType === 'stems-upgrade') {
		return {
			engine: settings?.upgradeEngine ?? DEFAULT_GLOBAL_SETTINGS.upgradeEngine,
			model: settings?.upgradeModel ?? DEFAULT_GLOBAL_SETTINGS.upgradeModel
		};
	}
	if (jobType !== 'align') return {};
	const params: JobParams = {};
	if (media?.artistCanonical) params.artist = media.artistCanonical;
	if (media?.titleCanonical) params.track = media.titleCanonical;
	if (media && Number.isFinite(media.durationSec) && media.durationSec > 0) {
		params.durationSec = media.durationSec;
	}
	return params;
}

/**
 * The engine+model a completed separation job used, so `markMediaReady` can compare quality before
 * swapping a published instrumental. Non-separation jobs have no separator and return undefined,
 * which keeps their completion path unconditional.
 */
export function separatorFor(
	jobType: JobType,
	settings?: GlobalSettings
): { engine: string; model: string } | undefined {
	if (jobType === 'stems') {
		return { engine: settings?.defaultEngine ?? DEFAULT_ENGINE, model: settings?.defaultModel ?? DEFAULT_MODEL };
	}
	if (jobType === 'stems-upgrade') {
		return {
			engine: settings?.upgradeEngine ?? DEFAULT_GLOBAL_SETTINGS.upgradeEngine,
			model: settings?.upgradeModel ?? DEFAULT_GLOBAL_SETTINGS.upgradeModel
		};
	}
	return undefined;
}

export interface Assignment {
	jobId: string;
	workerId: string;
}

/**
 * The worker CAPABILITY a job requires. For a separation job it is engine-derived — a roformer cook
 * needs `stems:roformer` and must NOT go to a demucs-only worker; everything else requires a
 * capability named after its job type. PURE. With no `settings` a separation job falls back to the
 * default engine's capability (plain `'stems'` for demucs), so existing single-capability workers
 * keep matching.
 */
export function requiredCapability(jobType: JobType, settings?: GlobalSettings): string {
	if (jobType === 'stems') return getEngine(settings?.defaultEngine ?? DEFAULT_ENGINE)?.capability ?? 'stems';
	if (jobType === 'stems-upgrade') {
		return getEngine(settings?.upgradeEngine ?? DEFAULT_GLOBAL_SETTINGS.upgradeEngine)?.capability ?? 'stems';
	}
	return jobType;
}

/** Resolves the capability a job needs. Defaults to the job's own type so callers that don't care
 *  about engine routing (older tests) behave exactly as before. */
export type CapabilityFor = (job: Pick<Job, 'jobType'>) => string;
const defaultCapabilityFor: CapabilityFor = (job) => job.jobType;

/** A worker can take a job iff it has a free slot and advertises the job's REQUIRED capability. */
function eligible(worker: WorkerSession, job: Job, capabilityFor: CapabilityFor = defaultCapabilityFor): boolean {
	return worker.slotsFree > 0 && worker.capabilities.includes(capabilityFor(job));
}

/**
 * Plan assignments for the current queued jobs against available worker capacity. PURE and greedy:
 * take the highest-priority queued job, give it to the least-loaded eligible worker (most slotsFree),
 * decrement that worker's slots locally, repeat until no job can be placed.
 *
 *   next_job = queued.order_by(priority ASC, createdAt ASC).first
 *   worker   = eligible.order_by(slotsFree DESC).first
 *
 * A job with no eligible worker is left queued (it dispatches when a worker frees up / a matching
 * worker connects). Returns the assignments in send order.
 */
export function planAssignments(
	queued: Job[],
	workers: WorkerSession[],
	capabilityFor: CapabilityFor = defaultCapabilityFor
): Assignment[] {
	// local slot view so we don't over-assign within a single planning pass
	const slots = new Map(workers.map((w) => [w.workerId, w.slotsFree]));
	const byId = new Map(workers.map((w) => [w.workerId, w]));

	const jobs = [...queued].sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
	const assignments: Assignment[] = [];

	for (const job of jobs) {
		const cap = capabilityFor(job);
		let best: WorkerSession | null = null;
		for (const w of workers) {
			if (!w.capabilities.includes(cap)) continue;
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
export function hasCapableWorker(
	job: Job,
	workers: WorkerSession[],
	capabilityFor: CapabilityFor = defaultCapabilityFor
): boolean {
	const cap = capabilityFor(job);
	return workers.some((w) => w.capabilities.includes(cap));
}

export { eligible };
