// Pure dispatch policy (§4) — no DB, no IO, no sockets. Decides which queued job goes to which
// worker, honoring capability match, least-loaded selection, and need-order (priority = the
// rotationSeq of the soonest queue entry that needs this media; lower = sooner). The I/O wrapper
// (worker-hub.ts) applies the assignments: marks the job assigned + sends job:assign.

import type { Job, JobParams, JobType, Media, GlobalSettings } from '../../contract';
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
} from '../../contract';
import type { WorkerSession } from './registry';
import { parseTrackTitle } from '../media/track-title';

/** The jobs a just-completed job should enqueue next, PURE. `fetch → stems → align` is CHAINED, not
 *  enqueued up front, because each step's input (bytes on disk, then the vocals stem) doesn't exist
 *  until the previous step finishes — enqueueing together would race producer and consumer for the
 *  same cores. `align` is the pipeline's last required step. `stems-upgrade` is an optional extra
 *  chain: it runs from retained audio (CPU only, no re-download), gated on a setting since it's
 *  background work on an already-finished song, and `markMediaReady` still gates whether it publishes. */
export function followUps(jobType: JobType, settings?: GlobalSettings): JobType[] {
	if (jobType === 'fetch') return ['stems'];
	if (jobType !== 'stems') return [];
	const next: JobType[] = ['align'];
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
 * The inputs a job of this type needs, derived from its media. PURE — no DB, no clock. An align job
 * gets the CANONICAL artist/title only when the normalizer was confident — an absent key tells the
 * worker "no authoritative lookup is possible, transcribe instead" rather than sending a raw uploader
 * string as if it were an answer. `fetch` is the deliberate exception and takes the guess too, since
 * MusicBrainz refuses a disagreement rather than answering with its nearest match (see annotationKeys).
 */
export function assignParams(jobType: JobType, media: Media | undefined, settings?: GlobalSettings): JobParams {
	const fetcher = media ? fetcherFor(media.source, settings?.defaultFetcher) : DEFAULT_FETCHER;
	if (jobType === 'fetch') return { fetcher, ...annotationKeys(media) };
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
	// Falls back to the pre-settings hardcoded values, so an align job with no settings behaves as before.
	return {
		fetcher,
		asrModel: settings?.asrModel ?? DEFAULT_ASR_MODEL,
		syncMode: settings?.syncMode ?? DEFAULT_SYNC_MODE,
		...lookupKeys(media),
		// A HUMAN re-pick: when the song carries a lyrics override, align must RE-TIME that exact
		// candidate rather than re-select, or it could discard the very candidate the user chose.
		// `pinnedText` only ever rides inside this block (never alone) since it's meaningless without
		// `pinnedRef` to name — present only for a pasted pick; a stored-candidate pick sends the ref alone.
		...(media?.lyricsOverrideRef
			? {
					pinnedRef: media.lyricsOverrideRef,
					...(media.lyricsOverrideText ? { pinnedText: media.lyricsOverrideText } : {})
				}
			: {})
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
	// NOT a lookup key: rides along so the worker can RANK records of the same song (guest verse vs not).
	if (media?.artistCredit && media.artistCredit !== media.artistCanonical) out.artistCredit = media.artistCredit;
	if (media && Number.isFinite(media.durationSec) && media.durationSec > 0) {
		out.durationSec = media.durationSec;
	}
	return out;
}

/** Keys `fetch`'s MusicBrainz step searches with: confident canonicals when they exist, else the
 *  normalizer's UNCONFIDENT guess — unlike `lookupKeys`'s callers, safe ONLY here because of what each
 *  consumer does with a wrong key. MusicBrainz's `pick_best` requires the match to AGREE on artist AND
 *  title (and be within 5s on length), so a wrong guess produces no match and writes nothing — the same
 *  outcome as not asking. LRCLIB instead returns the closest record it has, which for align's wrong key
 *  would be another song's words, so align never gets the unconfident guess. The parse is re-run here
 *  rather than stored, since a low-confidence twin of the persisted canonical columns would be a trap
 *  for the next reader. */
function annotationKeys(media: Media | undefined): Partial<JobParams> {
	const out = lookupKeys(media);
	if (!media || (out.artist && out.track)) return out;
	// media.artist is the UPLOADER, the right fallback answer except on an aggregator channel, which
	// yields a null artist instead — so this never asks MusicBrainz about a lyrics channel.
	const guess = parseTrackTitle(media.title, media.artist);
	if (!out.artist && guess.artist) out.artist = guess.artist;
	// Only worth sending alongside an artist: the worker declines unless it has both.
	if (!out.track && out.artist) out.track = guess.title;
	return out;
}

/** Only separation publishes a playable instrumental. Calling `markMediaReady` for a `fetch`
 *  completion would derive an instrumental key for a file that doesn't exist yet and mark the media
 *  `ready` regardless — the TV then loads a 404 for any song whose separation hasn't landed. */
export function publishesInstrumental(jobType: JobType): boolean {
	return jobType === 'stems' || jobType === 'stems-upgrade';
}

/** Whether a follow-up step belongs to the SAME process as the job that triggered it. `fetch → stems →
 *  align` is one run and shares a process id (see docs/ARCHITECTURE.md §7). `stems-upgrade` does NOT:
 *  it is background work on an already-finished song, and inheriting the process id would fold its own
 *  duration into a process that already delivered a singable song, corrupting the e2e average. */
export function inheritsProcess(next: JobType): boolean {
	return next !== 'stems-upgrade';
}

/** Engine+model a completed separation job used, for `markMediaReady`'s quality comparison before
 *  swapping a published instrumental. Non-separation jobs return undefined. */
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

/** The worker CAPABILITY a job requires. PURE. A separation job's capability is engine-derived (a
 *  roformer process needs `stems:roformer` and must NOT go to a demucs-only worker); everything else
 *  is named after its job type. With no `settings`, falls back to the default engine's capability
 *  (plain `'stems'` for demucs) so existing single-capability workers keep matching. */
export function requiredCapability(jobType: JobType, settings?: GlobalSettings): string {
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

/** PURE and greedy: take the highest-priority queued job, give it to the least-loaded eligible worker,
 *  decrement its slots locally, repeat.
 *    next_job = queued.order_by(priority ASC, createdAt ASC).first
 *    worker   = eligible.order_by(slotsFree DESC).first
 *  A job with no eligible worker is left queued. Returns assignments in send order. */
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
