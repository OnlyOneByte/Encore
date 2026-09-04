// Pure dispatch policy (§4) — no DB, no IO, no sockets. Decides which queued job goes to which
// worker, honoring capability match, least-loaded selection, and need-order (priority = the
// rotationSeq of the soonest queue entry that needs this media; lower = sooner). The I/O wrapper
// (worker-hub.ts) applies the assignments: marks the job assigned + sends job:assign.

import type { Job, JobParams, JobType, Media, GlobalSettings } from '@encore/shared';
import { DEFAULT_ENGINE, DEFAULT_MODEL, DEFAULT_GLOBAL_SETTINGS, DEFAULT_FETCHER, DEFAULT_ASR_MODEL, DEFAULT_SYNC_MODE, getEngine, getFetcher, fetcherFor, isQualityUpgrade } from '@encore/shared';
import type { WorkerSession } from './registry';

/**
 * The jobs a just-COMPLETED job should enqueue next — the cook pipeline. PURE.
 *
 * `stems` chains to `align` rather than enqueueing both up front because align reads the VOCALS
 * STEM, which does not exist until stems finishes — enqueueing at once would race the separation
 * that produces its input and contend for the same cores. align is strictly after stems and chains
 * no further, so the pipeline stays a depth-1 fan-out. (Chaining costs nothing user-visible: the
 * song isn't singable until stems completes either.)
 */
export function followUps(jobType: JobType, settings?: GlobalSettings): JobType[] {
	// Acquisition chains to separation: the song is not singable until it is separated, and separation
	// needs bytes on disk. Kept as a chain rather than enqueued together so `stems` cannot be dispatched
	// before its input exists — the same reason align chains after stems.
	if (jobType === 'fetch') return ['stems'];
	if (jobType !== 'stems') return [];
	// The COOK is fetch → stems → align, and nothing else. A song is not finished until its words are
	// timed, so `align` is the last step of the pipeline rather than an optional garnish.
	const next: JobType[] = ['align'];
	// A completed cook optionally chains a re-separation at higher quality. It runs from the RETAINED
	// raw audio, so it costs CPU but no re-download, and `markMediaReady` refuses to publish its
	// result unless it actually outranks what is already there. Off unless a setting asks for it, so
	// it is background work on a finished song rather than part of the cook.
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
	// Every job that touches source audio declares HOW to obtain it. The worker parses this at its
	// boundary instead of testing the URI for an `http` prefix, which is what used to misclassify any
	// scheme that was neither a watch URL nor a bare file key.
	const fetcher = media ? fetcherFor(media.source, settings?.defaultFetcher) : DEFAULT_FETCHER;
	// A fetch carries the lookup keys too: annotation runs as its final step, and it needs the same
	// confidence-gated canonicals an align job gets. Omitting them is how the worker learns "no
	// authoritative identification is possible" and declines rather than searching on a guess.
	if (jobType === 'fetch') return { fetcher, ...lookupKeys(media) };
	// stems carries the room's engine+model, the upgrade its upgrade engine+model. Both fall back to
	// shared defaults when no settings are provided (e.g. a unit test), so the worker still gets a
	// valid pairing.
	if (jobType === 'stems') {
		return { fetcher, engine: settings?.defaultEngine ?? DEFAULT_ENGINE, model: settings?.defaultModel ?? DEFAULT_MODEL };
	}
	if (jobType === 'stems-upgrade') {
		return {
			fetcher,
			engine: settings?.upgradeEngine ?? DEFAULT_GLOBAL_SETTINGS.upgradeEngine,
			model: settings?.upgradeModel ?? DEFAULT_GLOBAL_SETTINGS.upgradeModel
		};
	}
	if (jobType !== 'align') return { fetcher };
	// An align job carries the LYRICS engines the same way a stems job carries its separator: the model
	// that reads the words and the mode that timestamps them. Before this the worker hardcoded both, so
	// an operator watching wrong words scroll past the TV had nothing to change. Falls back to the
	// shared defaults when no settings are provided (a unit test), which are the values the worker used
	// when they were hardcoded — so an align job with no settings behaves exactly as it always did.
	return {
		fetcher,
		asrModel: settings?.asrModel ?? DEFAULT_ASR_MODEL,
		syncMode: settings?.syncMode ?? DEFAULT_SYNC_MODE,
		...lookupKeys(media)
	};
}

/**
 * The confidence-gated lookup keys a metadata call needs: canonical artist/title only when the parse
 * was confident, plus duration whenever it is real.
 *
 * Shared by `align` (LRCLIB) and `fetch` (MusicBrainz) because both face the same trap — a lookup on a
 * guessed title returns nothing, or another song's data, and the second is worse. An absent key is the
 * signal to decline; a raw uploader string would look like an answer.
 */
function lookupKeys(media: Media | undefined): Partial<JobParams> {
	const out: Partial<JobParams> = {};
	if (media?.artistCanonical) out.artist = media.artistCanonical;
	if (media?.titleCanonical) out.track = media.titleCanonical;
	if (media && Number.isFinite(media.durationSec) && media.durationSec > 0) {
		out.durationSec = media.durationSec;
	}
	return out;
}

/**
 * Does a completed job of this type publish a playable instrumental?
 *
 * Only separation does. This is a guard, not a formality: `markMediaReady` derives the instrumental
 * key when the worker does not report one, so calling it for a `fetch` completion marked the media
 * `ready` with a key for a file that does not exist yet — the TV would then load a 404 for any song
 * whose separation had not landed. It was invisible end to end because `stems` follows a `fetch`
 * within seconds, so the bogus state was overwritten before anyone tried to sing.
 */
export function publishesInstrumental(jobType: JobType): boolean {
	return jobType === 'stems' || jobType === 'stems-upgrade';
}

/**
 * Does a follow-up step belong to the SAME cook as the job that triggered it?
 *
 * `fetch → stems → align` is one run: the song is not finished until its words are timed, so an
 * end-to-end duration should span all three under one cook id.
 *
 * `stems-upgrade` is NOT, and this is the one case worth stating plainly. It is background work on an
 * ALREADY-FINISHED song, chained off the cook only because completion is when the decision can be
 * made. Letting it inherit would corrupt the headline number the internal dashboard exists to report:
 * a 43-minute upgrade would be folded into a cook that actually delivered a singable song in 90
 * seconds, making every end-to-end average a fiction. Its own cook id keeps its cost attributed to
 * itself, which is also what makes an upgrade comparable model against model.
 */
export function inheritsCook(next: JobType): boolean {
	return next !== 'stems-upgrade';
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
	// A fetch routes by its DOWNLOADER's capability, so a box that can pull audio and a box that can
	// separate it need not be the same machine.
	if (jobType === 'fetch') {
		return getFetcher(settings?.defaultFetcher ?? DEFAULT_FETCHER)?.capability ?? `fetch:${DEFAULT_FETCHER}`;
	}
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
