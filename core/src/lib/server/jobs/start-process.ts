// Starting a song's process, shared by POST /api/process and a queue add of a song that isn't ready (#1162), so a turn
// is never booked for a song nothing will make. See docs/SERVER.md#idempotency-and-the-process-cap.
import type { EncoreApp } from '../app';
import type { Job, MediaStatus } from '../../contract';
import { readyToSing } from '../../contract';
import { completedStatusFor, mediaStatusFor } from './media-status';
import {
	processState,
	requestProcess,
	maxProcessesPerSinger,
	claimsStems,
	claimedStemsRef,
	stemsMissing,
	forgetProcess,
	type ProcessState
} from './process';
import { clearArtifacts } from '../media/sidecar';
import type { MediaStore } from '../media/store';

const STORE_CHECK_MS = 2_000;

/** A store that errors or doesn't answer in time trusts the status, as picks did before the file check. */
export async function storeHas(store: MediaStore, ref: string): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), STORE_CHECK_MS)));
	try {
		return await Promise.race([store.exists(ref), late]);
	} catch {
		return true;
	} finally {
		clearTimeout(timer);
	}
}

/** Whether the stems a song claims are in the store; true for a song that claims none. */
export async function stemsPresent(app: EncoreApp, mediaId: string): Promise<boolean> {
	const media = app.mediaById.get(mediaId);
	return media && claimsStems(media, app.jobs) ? storeHas(app.mediaStore, claimedStemsRef(media)) : true;
}

/** Why a process can't start, in the words the phone shows; null for a state that can go ahead. */
export function processRefusal(
	app: EncoreApp,
	state: ProcessState
): { error: string; reason?: string; status: number } | null {
	if (state === 'unknown') return { error: 'unknown media', status: 409 };
	// A metadata-only source (Spotify): no fetcher can pull its bytes, so this is a permanent refusal.
	if (state === 'not-processable')
		return {
			error: 'that’s a name match, not a playable song — search for it to make karaoke',
			reason: 'not-processable',
			status: 409
		};
	if (state === 'playing') return { error: 'that song is playing right now', status: 409 };
	if (state === 'over-limit')
		return {
			error: `you already have ${maxProcessesPerSinger({ getSettings: () => app.settings.getGlobal() })} songs processing — wait for one to finish`,
			reason: 'over-limit',
			status: 429
		};
	return null;
}

/**
 * Starts the process for `mediaId` (or dedupes to the live one) and tells the room. `present` is the store check's
 * answer for a song that claims stems. Returns the job, or null when there is no work: ready, or refused (read
 * `processState` for which).
 */
export async function startProcess(
	app: EncoreApp,
	mediaId: string,
	singerId: string,
	present: boolean
): Promise<Job | null> {
	const getSettings = () => app.settings.getGlobal();
	const stemsOnDisk = () => present;
	const media = app.mediaById.get(mediaId);
	const missing = !!media && stemsMissing(media, { jobs: app.jobs, stemsOnDisk });
	const job = requestProcess(
		mediaId,
		{ jobs: app.jobs, mediaById: app.mediaById, state: app.state, now: app.now, getSettings, stemsOnDisk },
		singerId
	);
	if (!job) return null;
	// The media just flipped to a processing file: persist it so a restart mid-process still knows its stems are pending.
	const m = app.mediaById.get(mediaId);
	if (m) app.media.upsert(m);
	// upsert's sidecar merge keeps the old refs; see clearArtifacts.
	if (missing) await clearArtifacts(mediaId);
	// Show the live bar, THEN kick the dispatcher. The order is load-bearing: dispatch's unservable sweep says
	// `unservable: true` once, and a status published after it without the flag reads on every phone as "the stall
	// cleared". A repeat request gets the same deduped job, so this frame carries the hub's current verdict itself.
	// Where the song IS, never a hardcoded 'queued': `enqueue` hands back the existing live job on a second tap.
	app.publish({
		type: 'media:status',
		mediaId,
		// A `ready` job goes through the gate check the hub's completion path uses.
		status:
			job.status === 'ready'
				? completedStatusFor(job, m)
				: mediaStatusFor(job, (job.stage as MediaStatus) ?? undefined),
		pct: job.progressPct,
		unservable: app.workerHub.isUnservable(job.id) || undefined
	});
	app.workerHub.dispatch();
	return job;
}

/**
 * The hub's `prepareAdd`: a turn for `mediaId` is about to be booked. Returns a refusal, or null to book it.
 *  - Ready by the Sing tab's rule (`readyToSing`): book. Its stems are then checked in the store, and a song whose
 *    file is gone (evicted, deleted by hand) is made again, as a pick through /api/process would.
 *  - Already being made: book; rotation holds the turn until it is.
 *  - Otherwise start the process, as Sing does, and refuse the add with the same reason when it can't start.
 */
export function prepareTurn(app: EncoreApp, mediaId: string, singerId: string): string | null {
	const media = app.mediaById.get(mediaId);
	if (!media) return null; // validateCommand already refused it
	if (readyToSing(media)) {
		void stemsPresent(app, mediaId)
			.then(async (present) => {
				if (present || (await startProcess(app, mediaId, singerId, false))) return;
				// The remake was refused (the singer's cap): the song is not made, so say so (#1341). The turn is then the
				// honest dead turn, with Try again and Pick another, never one waiting on a job nobody filed.
				// Never over a job another singer filed for it meanwhile (their add is under the cap): resetting the
				// song would supersede that job.
				if (
					!hasLiveJob(app, mediaId) &&
					processState(mediaId, { mediaById: app.mediaById, state: app.state, jobs: app.jobs }) !== 'playing'
				)
					await forgetMissing(app, mediaId);
			})
			.catch(() => {});
		return null;
	}
	const state = processState(
		mediaId,
		{ mediaById: app.mediaById, state: app.state, jobs: app.jobs, getSettings: () => app.settings.getGlobal() },
		singerId
	);
	// Stems made, or a live job has it: the song is on its way (the lyrics step follows the stems by itself). The song
	// on stage is never refused a turn, nor restarted under the room.
	if (state === 'ready' || state === 'playing' || (state === 'processing' && hasLiveJob(app, mediaId))) return null;
	const refused = processRefusal(app, state);
	if (refused) return refused.error;
	// The job is filed before this returns (only clearing old files waits), so the turn is booked onto a song being made.
	void startProcess(app, mediaId, singerId, true).catch(() => {});
	return null;
}

/** A song whose stems are gone, reset to not made as eviction resets one, and the room told the same way. */
async function forgetMissing(app: EncoreApp, mediaId: string): Promise<void> {
	const media = app.mediaById.get(mediaId);
	if (!media) return;
	forgetProcess(media, app.jobs);
	app.media.upsert(media);
	// upsert's sidecar merge would restore the refs just cleared; see clearArtifacts.
	await clearArtifacts(mediaId);
	// A job filed while the files were cleared (another add, a Try again) already told the room it is being made.
	if (hasLiveJob(app, mediaId)) return;
	// `canceled` is eviction's quiet exit: open phones settle the song to not made.
	app.publish({ type: 'media:status', mediaId, status: 'canceled', pct: 0 });
}

/** A fetch or stems job still running or waiting: `stemStatus: 'queued'` with neither is a stall, not a song on its way. */
function hasLiveJob(app: EncoreApp, mediaId: string): boolean {
	return (['fetch', 'stems'] as const).some((t) => {
		const job = app.jobs.findLive(mediaId, t);
		return !!job && job.status !== 'ready';
	});
}
