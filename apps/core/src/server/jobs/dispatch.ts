// Pure dispatch policy (§4) — no DB, no IO, no sockets. Decides which queued job goes to which
// worker, honoring capability match, least-loaded selection, and need-order (priority = the
// rotationSeq of the soonest queue entry that needs this media; lower = sooner). The I/O wrapper
// (worker-hub.ts) applies the assignments: marks the job assigned + sends job:assign.

import type { Job, JobParams, JobType, Media, GlobalSettings } from '@encore/shared';
import {
	DEFAULT_ENGINE,
	DEFAULT_MODEL,
	DEFAULT_GLOBAL_SETTINGS,
	DEFAULT_FETCHER,
	DEFAULT_ASR_MODEL,
	DEFAULT_SYNC_MODE,
	getEngine,
	getFetcher,
	fetcherFor,
	isQualityUpgrade
} from '@encore/shared';
import type { WorkerSession } from './registry';
import { parseTrackTitle } from '../media/track-title';

/**
 * The jobs a just-COMPLETED job should enqueue next — the process pipeline. PURE.
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
	// The PROCESS is fetch → stems → align, and nothing else. A song is not finished until its words are
	// timed, so `align` is the last step of the pipeline rather than an optional garnish.
	const next: JobType[] = ['align'];
	// A completed process optionally chains a re-separation at higher quality. It runs from the RETAINED
	// raw audio, so it costs CPU but no re-download, and `markMediaReady` refuses to publish its
	// result unless it actually outranks what is already there. Off unless a setting asks for it, so
	// it is background work on a finished song rather than part of the process.
	if (
		settings?.enqueueUpgrade &&
		isQualityUpgrade(
			{ engine: settings.defaultEngine, model: settings.defaultModel },
			{ engine: settings.upgradeEngine, model: settings.upgradeModel }
		)
	) {
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
 * the raw uploader string. A fetch job is the deliberate exception and takes the guess too, because
 * MusicBrainz refuses a disagreement rather than answering with the nearest thing it has
 * (annotationKeys). `durationSec` is always safe: it narrows an LRCLIB match and bounds the
 * line-sync fallback's synthetic timings.
 */
export function assignParams(jobType: JobType, media: Media | undefined, settings?: GlobalSettings): JobParams {
	// Every job that touches source audio declares HOW to obtain it. The worker parses this at its
	// boundary instead of testing the URI for an `http` prefix, which is what used to misclassify any
	// scheme that was neither a watch URL nor a bare file key.
	const fetcher = media ? fetcherFor(media.source, settings?.defaultFetcher) : DEFAULT_FETCHER;
	// A fetch carries the lookup keys too: annotation runs as its final step. Unlike align it gets the
	// UNCONFIDENT parse as well, because MusicBrainz is the one consumer that can safely be handed a
	// guess — see annotationKeys.
	if (jobType === 'fetch') return { fetcher, ...annotationKeys(media) };
	// stems carries the room's engine+model, the upgrade its upgrade engine+model. Both fall back to
	// shared defaults when no settings are provided (e.g. a unit test), so the worker still gets a
	// valid pairing.
	if (jobType === 'stems') {
		return {
			fetcher,
			engine: settings?.defaultEngine ?? DEFAULT_ENGINE,
			model: settings?.defaultModel ?? DEFAULT_MODEL
		};
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
		...lookupKeys(media),
		// A HUMAN re-pick (#640): when the song carries a lyrics override, an align job must RE-TIME that
		// exact candidate rather than run its own comparative selection — otherwise the re-time would
		// re-pick and could discard the very candidate the user chose. Absent on every normal process, where
		// no override is set and the worker selects comparatively as before.
		...(media?.lyricsOverrideRef ? { pinnedRef: media.lyricsOverrideRef } : {})
	};
}

/**
 * The confidence-gated lookup keys a metadata call needs: canonical artist/title only when the parse
 * was confident, plus duration whenever it is real.
 *
 * Used by `align` (LRCLIB), whose trap is that a lookup on a guessed title returns nothing, or another
 * song's words, and the second is worse. An absent key is the signal to decline; a raw uploader string
 * would look like an answer. `fetch` starts from these and then goes further — see annotationKeys.
 */
function lookupKeys(media: Media | undefined): Partial<JobParams> {
	const out: Partial<JobParams> = {};
	if (media?.artistCanonical) out.artist = media.artistCanonical;
	if (media?.titleCanonical) out.track = media.titleCanonical;
	// The full billing, when the upload credited more than the primary artist. NOT a lookup key — it
	// rides along so the worker can RANK several records of the same song, the version with the guest
	// verse against the version without. Absent unless it says something `artist` does not.
	if (media?.artistCredit && media.artistCredit !== media.artistCanonical) out.artistCredit = media.artistCredit;
	if (media && Number.isFinite(media.durationSec) && media.durationSec > 0) {
		out.durationSec = media.durationSec;
	}
	return out;
}

/**
 * The keys a `fetch` job's MusicBrainz step searches with: the confident canonicals when they exist,
 * and otherwise the normalizer's UNCONFIDENT guess.
 *
 * WHY THIS IS NOT THE SAME GATE AS ALIGN. Annotation is the mechanism that turns a bad title parse
 * into a citation, so gating it on a good title parse made it unreachable in exactly the case it was
 * built for. The live library showed this: "Legends Never Die (ft. Against The Current) [OFFICIAL
 * AUDIO] | Worlds 2017 - League of Legends" cleans to a title with no separator left in it, so the
 * parser fell back to the uploader and marked itself `low`, both canonicals were dropped, no keys were
 * sent, MusicBrainz was never asked — and the TV rendered the whole raw upload string. Asked, it
 * answers exactly: artist "League of Legends", recording "Legends Never Die", score 100.
 *
 * A GUESS IS SAFE HERE AND ONLY HERE, because of what the two consumers do with a key that is wrong.
 * MusicBrainz's `pick_best` requires the returned recording to AGREE on artist AND title after
 * normalisation and to be within 5s on length, so a wrong guess produces no match and writes nothing —
 * the identical outcome to not asking. LRCLIB returns the closest record it has, which for a wrong key
 * is another song's words, and `applyAnnotation`'s no-regress rule cannot help there. So the cost of
 * guessing is zero on one path and a wrong-song candidate on the other.
 *
 * The parse is redone here rather than stored: `resultToMedia` deliberately persists canonicals only
 * when confident (browse headings and the align gate both read them), and a second nullable column
 * holding the same function's low-confidence output would be a trap for the next reader. The parser is
 * pure, so re-running it keeps this function pure too.
 */
function annotationKeys(media: Media | undefined): Partial<JobParams> {
	const out = lookupKeys(media);
	if (!media || (out.artist && out.track)) return out;
	// `media.artist` is the UPLOADER — which is what the fallback rule is for, and for "League of
	// Legends" it is also the right answer. An aggregator channel ("7clouds") yields a null artist
	// instead, so this never asks MusicBrainz about a lyrics channel.
	const guess = parseTrackTitle(media.title, media.artist);
	if (!out.artist && guess.artist) out.artist = guess.artist;
	// Only worth sending alongside an artist: the worker declines unless it has both.
	if (!out.track && out.artist) out.track = guess.title;
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
 * Does a follow-up step belong to the SAME process as the job that triggered it?
 *
 * `fetch → stems → align` is one run: the song is not finished until its words are timed, so an
 * end-to-end duration should span all three under one process id.
 *
 * `stems-upgrade` is NOT, and this is the one case worth stating plainly. It is background work on an
 * ALREADY-FINISHED song, chained off the process only because completion is when the decision can be
 * made. Letting it inherit would corrupt the headline number the internal dashboard exists to report:
 * a 43-minute upgrade would be folded into a process that actually delivered a singable song in 90
 * seconds, making every end-to-end average a fiction. Its own process id keeps its cost attributed to
 * itself, which is also what makes an upgrade comparable model against model.
 */
export function inheritsProcess(next: JobType): boolean {
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
 * The worker CAPABILITY a job requires. For a separation job it is engine-derived — a roformer process
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
