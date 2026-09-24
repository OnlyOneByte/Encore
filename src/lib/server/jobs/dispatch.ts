// Pure dispatch policy — no DB, no IO, no sockets. Capability match, least-loaded selection, and
// need-order (priority = the rotationSeq of the soonest entry needing this media; lower = sooner).

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

/** PURE. Follow-ups CHAIN and are never enqueued together — see docs/SERVER.md#idempotency-and-the-process-cap. */
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
 * PURE — no DB, no clock. An align job gets CANONICAL artist/title only when the normalizer was
 * confident: an ABSENT key tells the worker "no authoritative lookup is possible, transcribe instead",
 * where a raw uploader string would look like an answer. `fetch` is the deliberate exception.
 */
export function assignParams(jobType: JobType, media: Media | undefined, settings?: GlobalSettings): JobParams {
	const fetcher = media ? fetcherFor(media.source, settings?.defaultFetcher) : DEFAULT_FETCHER;
	if (jobType === 'fetch') return { fetcher, ...annotationKeys(media) };
	// THROUGH separatorFor (non-undefined for exactly the two separation types), not a second spelling of
	// the same defaults: `markMediaReady` judges an upgrade by comparing the pair a completion PUBLISHES —
	// resolved there by separatorFor — against the pair on the media, so a drifted literal here would rank
	// a job against a separator it was never dispatched with.
	const separator = separatorFor(jobType, settings);
	if (separator) return { fetcher, ...separator };
	if (jobType !== 'align') return { fetcher };
	return {
		fetcher,
		asrModel: settings?.asrModel ?? DEFAULT_ASR_MODEL,
		syncMode: settings?.syncMode ?? DEFAULT_SYNC_MODE,
		...lookupKeys(media),
		// With an override the align must RE-TIME that exact candidate, never re-select, or it can discard
		// the candidate the human chose. `pinnedText` rides ONLY inside this block: it is meaningless
		// without a `pinnedRef` to name.
		...(media?.lyricsOverrideRef
			? {
					pinnedRef: media.lyricsOverrideRef,
					...(media.lyricsOverrideText ? { pinnedText: media.lyricsOverrideText } : {})
				}
			: {})
	};
}

/**
 * Canonical artist/title only when the parse was confident, plus duration whenever it is real. `align`'s
 * trap is that a lookup on a guessed title returns nothing or ANOTHER SONG'S words, and the second is
 * worse — so an absent key is the signal to decline.
 */
function lookupKeys(media: Media | undefined): Partial<JobParams> {
	const out: Partial<JobParams> = {};
	if (media?.artistCanonical) out.artist = media.artistCanonical;
	if (media?.titleCanonical) out.track = media.titleCanonical;
	// NOT a lookup key: rides along so the worker can RANK records of the same song.
	if (media?.artistCredit && media.artistCredit !== media.artistCanonical) out.artistCredit = media.artistCredit;
	if (media && Number.isFinite(media.durationSec) && media.durationSec > 0) {
		out.durationSec = media.durationSec;
	}
	return out;
}

/** Takes the normalizer's UNCONFIDENT guess where `lookupKeys` refuses to, and that is safe ONLY here:
 *  MusicBrainz's `pick_best` requires agreement on artist AND title, so a wrong guess writes nothing,
 *  while LRCLIB returns its closest record — another song's words. The parse is re-run rather than
 *  stored, since a low-confidence twin of the persisted canonical columns would be a trap. */
function annotationKeys(media: Media | undefined): Partial<JobParams> {
	const out = lookupKeys(media);
	if (!media || (out.artist && out.track)) return out;
	// media.artist is the UPLOADER. An aggregator channel yields null instead, so this never asks
	// MusicBrainz about a lyrics channel.
	const guess = parseTrackTitle(media.title, media.artist);
	if (!out.artist && guess.artist) out.artist = guess.artist;
	// Only worth sending alongside an artist: the worker declines unless it has both.
	if (!out.track && out.artist) out.track = guess.title;
	return out;
}

/** Only separation publishes a playable instrumental: `markMediaReady` on a `fetch` completion would
 *  derive a key for a file that does not exist yet and mark the media ready anyway, 404ing the TV. */
export function publishesInstrumental(jobType: JobType): boolean {
	return jobType === 'stems' || jobType === 'stems-upgrade';
}

/** Controls the process id AND singer attribution together — see docs/SERVER.md#idempotency-and-the-process-cap. */
export function inheritsProcess(next: JobType): boolean {
	return next !== 'stems-upgrade';
}

/** For `markMediaReady`'s quality comparison. Non-separation jobs return undefined. */
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

/** PURE. A separation job's capability is ENGINE-derived: a roformer process needs `stems:roformer` and
 *  must NOT go to a demucs-only worker. With no `settings`, falls back to the default engine's. */
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

/** Defaults to the job's own type, for callers that do not care about engine routing. */
export type CapabilityFor = (job: Pick<Job, 'jobType'>) => string;
const defaultCapabilityFor: CapabilityFor = (job) => job.jobType;

/** A worker can take a job iff it has a free slot and advertises the job's REQUIRED capability. */
function eligible(worker: WorkerSession, job: Job, capabilityFor: CapabilityFor = defaultCapabilityFor): boolean {
	return worker.slotsFree > 0 && worker.capabilities.includes(capabilityFor(job));
}

/** PURE and greedy: highest-priority queued job (priority ASC, createdAt ASC) to the least-loaded
 *  eligible worker (slotsFree DESC), decrement locally, repeat. No eligible worker leaves it queued. */
export function planAssignments(
	queued: Job[],
	workers: WorkerSession[],
	capabilityFor: CapabilityFor = defaultCapabilityFor
): Assignment[] {
	// Local slot view, so one planning pass cannot over-assign.
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

/** Capability match ignoring current load: separates "wait for capacity" from "unservable". */
export function hasCapableWorker(
	job: Job,
	workers: WorkerSession[],
	capabilityFor: CapabilityFor = defaultCapabilityFor
): boolean {
	const cap = capabilityFor(job);
	return workers.some((w) => w.capabilities.includes(cap));
}

export { eligible };
