// Pure dispatch policy (§4) — no DB, no IO, no sockets. Decides which queued job goes to which
// worker, honoring capability match, least-loaded selection, and need-order (priority = the
// rotationSeq of the soonest queue entry that needs this media; lower = sooner). The I/O wrapper
// (worker-hub.ts) applies the assignments: marks the job assigned + sends job:assign.

import type { Job, JobParams, JobType, Media, RoomSettings } from '@encore/shared';
import { DEFAULT_ENGINE, DEFAULT_MODEL, DEFAULT_ROOM_SETTINGS, getEngine, isQualityUpgrade } from '@encore/shared';
import type { WorkerSession } from './registry';

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
 * `score` rides along for the same reason: live scoring was unreachable through the identical
 * bug (nothing enqueued it), and its processor extracts the reference pitch track from the same vocals
 * stem align needs. Both are strictly after stems, neither chains further, so the pipeline stays a
 * depth-1 fan-out rather than a graph.
 */
export function followUps(jobType: JobType, settings?: RoomSettings): JobType[] {
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
 * An align job needs the CANONICAL artist/title, and only when the normalizer was confident: a
 * lookup on a guessed title returns nothing or, worse, another song's words. Absent keys are how the
 * worker learns "no authoritative lookup is possible here" and goes straight to transcription, so
 * omitting is meaningfully different from sending the raw uploader string.
 *
 * `durationSec` is always safe to send — it narrows an LRCLIB match and bounds the line-sync
 * fallback's synthetic timings.
 */
export function assignParams(jobType: JobType, media: Media | undefined, settings?: RoomSettings): JobParams {
	// A stems cook carries the room's chosen engine+model; the upgrade carries the room's
	// upgrade engine+model. Both fall back to the shared defaults when no settings are provided (a
	// hub built without a settings getter — e.g. a unit test), so the worker still gets a valid
	// pairing rather than an empty one.
	if (jobType === 'stems') {
		return { engine: settings?.defaultEngine ?? DEFAULT_ENGINE, model: settings?.defaultModel ?? DEFAULT_MODEL };
	}
	if (jobType === 'stems-upgrade') {
		return {
			engine: settings?.upgradeEngine ?? DEFAULT_ROOM_SETTINGS.upgradeEngine,
			model: settings?.upgradeModel ?? DEFAULT_ROOM_SETTINGS.upgradeModel
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
	settings?: RoomSettings
): { engine: string; model: string } | undefined {
	if (jobType === 'stems') {
		return { engine: settings?.defaultEngine ?? DEFAULT_ENGINE, model: settings?.defaultModel ?? DEFAULT_MODEL };
	}
	if (jobType === 'stems-upgrade') {
		return {
			engine: settings?.upgradeEngine ?? DEFAULT_ROOM_SETTINGS.upgradeEngine,
			model: settings?.upgradeModel ?? DEFAULT_ROOM_SETTINGS.upgradeModel
		};
	}
	return undefined;
}

export interface Assignment {
	jobId: string;
	workerId: string;
}

/**
 * The worker CAPABILITY a job requires. For a separation job it is engine-derived — a
 * roformer cook needs `stems:roformer`, so it must NOT be handed to a demucs-only worker — and the
 * engine comes from the room settings the same way assignParams derives its params. Everything else
 * requires a capability named after its job type. PURE.
 *
 * `settings` is optional: with none (a hub/test without settings) a separation job falls back to the
 * default engine's capability, which for demucs is plain `'stems'` — so existing single-capability
 * workers keep matching exactly as before.
 */
export function requiredCapability(jobType: JobType, settings?: RoomSettings): string {
	if (jobType === 'stems') return getEngine(settings?.defaultEngine ?? DEFAULT_ENGINE)?.capability ?? 'stems';
	if (jobType === 'stems-upgrade') {
		return getEngine(settings?.upgradeEngine ?? DEFAULT_ROOM_SETTINGS.upgradeEngine)?.capability ?? 'stems';
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
