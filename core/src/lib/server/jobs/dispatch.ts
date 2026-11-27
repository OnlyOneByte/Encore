// Pure dispatch policy — no DB, no IO, no sockets. Capability match, least-loaded selection, and
// need-order (priority = the rotationSeq of the soonest entry needing this media; lower = sooner).

import type { Job, JobParams, JobType, Media, GlobalSettings, QueueEntry } from '../../contract';
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
	isQualityUpgrade,
	SEPARATOR_ENGINES,
	sourceUriFor
} from '../../contract';
import { freeFor, laneOf, type WorkerSession } from './registry';
import { parseTrackTitle } from '../media/track-title';
import { stemOutputTag } from '../media/paths';

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
export function assignParams(
	jobType: JobType,
	media: Media | undefined,
	settings?: GlobalSettings,
	jobId?: string
): JobParams {
	const fetcher = media ? fetcherFor(media.source, settings?.defaultFetcher) : DEFAULT_FETCHER;
	if (jobType === 'fetch') return { fetcher, ...annotationKeys(media) };
	// A kept original is a LOCAL source, with the watch URL along for a worker that cannot see the volume.
	const acquire: JobParams =
		media && keptOriginal(jobType, media)
			? {
					fetcher: 'local',
					remoteUri: sourceUriFor(media, settings?.defaultFetcher),
					originalBytes: media.originalBytes
				}
			: { fetcher };
	// THROUGH separatorFor (non-undefined for exactly the two separation types), not a second spelling of
	// the same defaults: `markMediaReady` judges an upgrade by comparing the pair a completion PUBLISHES —
	// resolved there by separatorFor — against the pair on the media, so a drifted literal here would rank
	// a job against a separator it was never dispatched with.
	const separator = separatorFor(jobType, settings);
	const outputTag = reSeparates(jobType) && jobId ? { outputTag: stemOutputTag(jobId) } : {};
	if (separator) return { ...acquire, ...separator, ...outputTag };
	if (jobType !== 'align' && jobType !== 'align-remake') return acquire;
	const aligning = {
		...acquire,
		asrModel: settings?.asrModel ?? DEFAULT_ASR_MODEL,
		syncMode: settings?.syncMode ?? DEFAULT_SYNC_MODE,
		...lookupKeys(media)
	};
	// A remake searches again from scratch, under new names; a host's fix still outranks what it finds.
	if (jobType === 'align-remake') return { ...aligning, ...(jobId ? { outputTag: stemOutputTag(jobId) } : {}) };
	return {
		...aligning,
		// With an override the align must RE-TIME that exact candidate, never re-select, or it can discard
		// the candidate the human chose. `pinnedText` rides ONLY inside this block: it is meaningless
		// without a `pinnedRef` to name.
		...(media?.lyricsOverrideRef
			? {
					pinnedRef: media.lyricsOverrideRef,
					...(media.lyricsOverrideText ? { pinnedText: media.lyricsOverrideText } : {}),
					// `lyricsRef` moves only when the re-time lands, so until then it is the document being fixed. After
					// an eviction it is gone, and the fix's own document, which eviction keeps, seeds the remake.
					...(media.lyricsOverrideText ? { pinnedFrom: media.lyricsRef ?? media.lyricsOverrideRef } : {})
				}
			: {})
	};
}

/** The download a fetch job kept for this song, which every later stage reads rather than downloading the
 *  song again. Never for a fetch itself, which always downloads. */
function keptOriginal(jobType: JobType, media: Media): string | undefined {
	return jobType === 'fetch' || media.source === 'local' || !media.originalBytes ? undefined : media.originalRef;
}

/** PURE. The `sourceUri` a job is sent: the kept original's store ref, else the media's fetchable address. */
export function assignSourceUri(jobType: JobType, media: Media | undefined, defaultFetcher?: string): string {
	if (!media) return '';
	return keptOriginal(jobType, media) ?? sourceUriFor(media, defaultFetcher);
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
	return jobType === 'stems' || reSeparates(jobType);
}

/** Separates a song that already has stems: background work under new names, never a readiness gate. */
export function reSeparates(jobType: JobType): boolean {
	return jobType === 'stems-upgrade' || jobType === 'stems-remake';
}

type TurnEntries = readonly { id?: string; mediaId: string; status: QueueEntry['status'] | string }[];

/** The song is queued (on deck included) or playing: a screen may be about to play its files, or playing them. */
export function inTurn(mediaId: string, entries: TurnEntries, currentEntryId: string | null | undefined): boolean {
	return entries.some((e) => e.mediaId === mediaId && (e.status === 'queued' || e.id === currentEntryId));
}

/** The host's remake starts after the song's turn (proposal 33). An upgrade does not wait, so it can land before
 *  the first turn; the hub holds back whatever a screen still needs (`WorkerHub.settle`). */
export function waitsForTurn(
	job: Pick<Job, 'jobType' | 'mediaId'>,
	entries: TurnEntries,
	currentEntryId: string | null | undefined
): boolean {
	return job.jobType === 'stems-remake' && inTurn(job.mediaId, entries, currentEntryId);
}

/** Controls the process id AND singer attribution together — see docs/SERVER.md#idempotency-and-the-process-cap. */
export function inheritsProcess(next: JobType): boolean {
	return !reSeparates(next);
}

/** For `markMediaReady`'s quality comparison. Non-separation jobs return undefined. */
export function separatorFor(
	jobType: JobType,
	settings?: GlobalSettings
): { engine: string; model: string } | undefined {
	// A remake is "make it again", so it uses tonight's settings, as a first separation would.
	if (jobType === 'stems' || jobType === 'stems-remake') {
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
 * PURE. A separation job's capability is ENGINE-derived: a roformer process needs `stems:roformer` and
 * must NOT go to a demucs-only worker. With no `settings`, falls back to the default engine's.
 *
 * A NAMED MODEL NARROWS IT FURTHER, to `stems:model:<token>`. Workers advertise one such token per
 * checkpoint they can actually run, so a job asking for a specific model is routed only to a box that has
 * it — using the existing single-capability match rather than any new routing code.
 *
 * ONLY for models a worker ANNOUNCED (`isWorkerModel`). The engine-level tokens that predate this —
 * `htdemucs`, `bs-roformer-1297` — are resolved by the engine's own allowlist on the worker and must keep
 * routing on the engine capability, or every existing job would suddenly require a token no worker sends.
 */
export function requiredCapability(jobType: JobType, settings?: GlobalSettings): string {
	if (jobType === 'fetch') {
		return getFetcher(settings?.defaultFetcher ?? DEFAULT_FETCHER)?.capability ?? `fetch:${DEFAULT_FETCHER}`;
	}
	if (publishesInstrumental(jobType)) {
		const upgrade = jobType === 'stems-upgrade';
		const engineId = upgrade
			? (settings?.upgradeEngine ?? DEFAULT_GLOBAL_SETTINGS.upgradeEngine)
			: (settings?.defaultEngine ?? DEFAULT_ENGINE);
		const model = upgrade ? settings?.upgradeModel : settings?.defaultModel;
		const engineCapability = getEngine(engineId)?.capability ?? 'stems';
		return model && isWorkerModel(model) ? modelCapability(model) : engineCapability;
	}
	// Any aligner can remake lyrics; a worker older than the remake refuses it at accept (`#onReject`).
	return jobType === 'align-remake' ? 'align' : jobType;
}

/** Mirrored in the worker's `adapters/zoo.MODEL_CAPABILITY_PREFIX`. */
export const MODEL_CAPABILITY_PREFIX = 'stems:model:';

export function modelCapability(token: string): string {
	return `${MODEL_CAPABILITY_PREFIX}${token}`;
}

/**
 * Is this token one a worker announced, rather than a checkpoint name built into core's own catalogue?
 *
 * The distinction is a routing one. An announced token has a matching `stems:model:<token>` capability on
 * some worker, so requiring it is safe and precise. A BUILT-IN name has none — the worker resolves those
 * through its own engine allowlist — so requiring `stems:model:htdemucs` would make every demucs job
 * unservable.
 *
 * TESTED AGAINST THE CATALOGUE, not against the token's shape. A first attempt keyed on punctuation
 * ("slugs have hyphens and no underscores") looked reasonable and was wrong for `bs-roformer-1297`, which
 * is built-in and matches that description exactly — every roformer job would have become unroutable.
 * Enumerating what core already knows about has no such edge.
 */
export function isWorkerModel(token: string): boolean {
	return !SEPARATOR_ENGINES.some((engine) => engine.models.some((m) => m.id === token));
}

/** Defaults to the job's own type, for callers that do not care about engine routing. */
export type CapabilityFor = (job: Pick<Job, 'jobType'>) => string;
const defaultCapabilityFor: CapabilityFor = (job) => job.jobType;

/** PURE and greedy: highest-priority queued job (priority ASC, createdAt ASC) to the least-loaded
 *  eligible worker (most free slots in the job's lane), decrement locally, repeat. No eligible worker
 *  leaves it queued. A worker without lanes has one count every job draws on, as before #1176. */
export function planAssignments(
	queued: Job[],
	workers: WorkerSession[],
	capabilityFor: CapabilityFor = defaultCapabilityFor,
	/** A worker that already refused this job as an action it does not know. */
	refused: (jobId: string, workerId: string) => boolean = () => false
): Assignment[] {
	// Local slot view, so one planning pass cannot over-assign.
	const slots = new Map(
		workers.map((w) => [
			w.workerId,
			{ slotsFree: w.slotsFree, ...(w.lanesFree ? { lanesFree: { ...w.lanesFree } } : {}) }
		])
	);

	const jobs = [...queued].sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
	const assignments: Assignment[] = [];

	for (const job of jobs) {
		const cap = capabilityFor(job);
		const lane = laneOf(job.jobType);
		let best: WorkerSession | null = null;
		for (const w of workers) {
			if (!w.capabilities.includes(cap) || refused(job.id, w.workerId)) continue;
			const free = freeFor(slots.get(w.workerId)!, lane);
			if (free <= 0) continue;
			if (!best || free > freeFor(slots.get(best.workerId)!, lane)) best = w;
		}
		if (!best) continue; // no eligible worker with capacity — leave queued
		assignments.push({ jobId: job.id, workerId: best.workerId });
		const view = slots.get(best.workerId)!;
		view.slotsFree -= 1;
		if (view.lanesFree) view.lanesFree[lane] -= 1;
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
