// THE MONOTONICITY INVARIANT. A process is three jobs — fetch → stems → align — and the phone renders their combined
// progress as ONE five-stop line. Each job reports its own private stages, so forwarding them verbatim walks that line
// BACKWARDS: stems and align each open with a download of their own, which reads as a song on "Making karaoke" jumping
// back to "Fetched". The first test drives a REAL WorkerHub through a whole process and asserts the sequence never
// decreases — end-to-end deliberately, because the three causes live in three places (the status map, the stage
// passthrough, the completion handler) and a unit test of any one passes while the guest's line regresses.
import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { WorkerHub } from '$lib/server/jobs/worker-hub';
import { WorkerRegistry } from '$lib/server/jobs/registry';
import { JobRepository } from '$lib/server/jobs/repository';
import {
	completedStatusFor,
	jobStageFloor,
	mediaStatusFor,
	shouldBroadcastProcess
} from '$lib/server/jobs/media-status';
import {
	mediaStagePosition,
	pendingGates,
	GATES,
	MEDIA_STAGES,
	type Job,
	type Media,
	type ServerEvent
} from '$lib/contract';

const T0 = 1_700_000_000_000;

const media = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid1',
	title: 'song',
	durationSec: 200,
	stemStatus: 'none',
	...over
});

const job = (over: Partial<Job> = {}): Job =>
	({
		id: 'j1',
		mediaId: 'm1',
		jobType: 'stems',
		status: 'running',
		priority: 0,
		attempts: 0,
		maxAttempts: 3,
		progressPct: 0,
		createdAt: T0,
		updatedAt: T0,
		...over
	}) as Job;

function harness(startMedia: Media = media({ stemStatus: 'queued' })) {
	const db = migratedDb();
	const jobs = new JobRepository(db);
	const registry = new WorkerRegistry();
	const mediaById = new Map<string, Media>([[startMedia.id, startMedia]]);
	const broadcasts: ServerEvent[] = [];
	const hub = new WorkerHub({
		jobs,
		registry,
		mediaById,
		toWorker: () => {},
		broadcast: (e) => broadcasts.push(e),
		now: () => T0
	});
	const statuses = () =>
		broadcasts.filter((e): e is Extract<ServerEvent, { type: 'media:status' }> => e.type === 'media:status');
	return { hub, jobs, mediaById, broadcasts, statuses };
}

/** Run one job of the chain end to end, reporting the stages the worker really reports for its type. */
function runStep(
	h: ReturnType<typeof harness>,
	jobType: 'fetch' | 'stems' | 'align',
	stages: string[],
	artifacts?: Record<string, unknown>
) {
	const j = h.jobs.findLive('m1', jobType)!;
	h.hub.handle({ type: 'job:accept', workerId: 'w1', jobId: j.id });
	for (const stage of stages) {
		h.hub.handle({ type: 'job:progress', workerId: 'w1', jobId: j.id, stage: stage as never, pct: 50 });
	}
	h.hub.handle({ type: 'job:complete', workerId: 'w1', jobId: j.id, mediaUri: 'x', artifacts: artifacts as never });
}

test('THE INVARIANT: a process never reports a stage it has already passed', () => {
	const h = harness();
	h.jobs.enqueue('m1', 'fetch', 0, T0);
	h.hub.handle({
		type: 'worker:hello',
		workerId: 'w1',
		capabilities: ['fetch:ytdlp', 'stems', 'stems:demucs', 'align'],
		concurrency: 1,
		version: '1'
	});

	// The worker's REAL stage plans (worker/src/vocabulary.py STAGE_PLANS): stems and align both open with
	// a download of their own, which is what leaks through.
	runStep(h, 'fetch', ['downloading'], { annotation: undefined });
	runStep(h, 'stems', ['downloading', 'separating'], { stems: { instrumental: 'derived/stems/m1-instrumental.flac' } });
	runStep(h, 'align', ['downloading', 'aligning'], { lyrics: { uri: 'derived/lyrics/m1.json' } });

	const seq = h.statuses().map((e) => e.status);
	// Spelled out in full because the sequence IS the contract.
	expect(seq).toEqual([
		'downloading', // fetch accepted
		'downloading', // fetch progress
		'separating', // fetch complete → now waiting on separation, NOT 'ready'
		'separating', // stems accepted
		'separating', // stems' OWN download — clamped to its floor, no longer a jump back to 'Fetched'
		'separating', // stems progress
		'aligning', // stems complete → waiting on lyrics, NOT 'ready'
		'aligning', // align accepted
		'aligning', // align's OWN download — clamped
		'aligning', // align progress
		'ready' // align complete → every gate satisfied, and only NOW
	]);

	// Stated as the invariant too, so a step added to the chain is checked by intent, not by the list.
	const positions = seq.map(mediaStagePosition);
	expect(positions.every((p) => p >= 0)).toBe(true); // nothing off the line during a healthy process
	for (let i = 1; i < positions.length; i++) {
		expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]);
	}
	// 'ready' is the LAST thing said, never an intermediate.
	expect(seq.indexOf('ready')).toBe(seq.length - 1);
});

test('a completed fetch reports the step it is WAITING on, not the step it finished', () => {
	// Mapping a completed job of ANY type to 'ready' tells every phone a finished DOWNLOAD is singable:
	// readiness.ts lets a live 'ready' win over the catalog, so entryPlayable says yes with no instrumental on disk.
	const m = media({ stemStatus: 'queued' });
	expect(completedStatusFor(job({ jobType: 'fetch', status: 'ready' }), m)).toBe('separating');
	expect(completedStatusFor(job({ jobType: 'stems', status: 'ready' }), m)).toBe('separating');
});

test("a completed stems reports 'aligning' while the lyrics gate is outstanding", () => {
	const m = media({
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		lyricsStatus: 'queued'
	});
	expect(completedStatusFor(job({ jobType: 'stems', status: 'ready' }), m)).toBe('aligning');
});

test("only the media's own gates can say 'ready'", () => {
	const finished = media({
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		lyricsStatus: 'ready'
	});
	expect(completedStatusFor(job({ jobType: 'align', status: 'ready' }), finished)).toBe('ready');
	// An align that completes WITHOUT satisfying its gate must not walk back to 'separating' either.
	const stalled = media({ stemStatus: 'ready', instrumentalRef: 'derived/stems/m1-instrumental.flac' });
	expect(completedStatusFor(job({ jobType: 'align', status: 'ready' }), stalled)).toBe('aligning');
});

test('a completed align whose EARLIER gate is still outstanding is clamped, not walked back below its floor', () => {
	// The ONLY test that reaches completedStatusFor's `: floor` clamp: every other completed-path case has
	// `pendingGates(media)[0].stage` at or above the completed step's floor, so the `nextStatus` branch is taken and
	// deleting the clamp leaves them byte-identical. Here the first outstanding gate is `stems`/'separating' (position 2)
	// while the completed job is `align`, floor 'aligning' (position 3), so nextStatus is strictly BELOW the floor —
	// reachable when an align completes with separation's artifact missing. Without the clamp the strip jumps from
	// "Adding lyrics" back to "Making karaoke".
	const alignAheadOfStems = media({ stemStatus: 'none', lyricsStatus: 'ready', lyricsRef: 'derived/lyrics/m1.json' });
	// Guard the premise, or this test drifts vacuous: the first pending gate must be strictly below the
	// align floor, or the `: floor` branch is never exercised.
	expect(pendingGates(alignAheadOfStems)[0]!.stage).toBe('separating');
	expect(mediaStagePosition('separating')).toBeLessThan(mediaStagePosition(jobStageFloor('align')));
	expect(completedStatusFor(job({ jobType: 'align', status: 'ready' }), alignAheadOfStems)).toBe('aligning');
});

test("a job's own download stage is clamped to the step it IS", () => {
	// The worker is not lying — a stems job really does decode, an align job really does fetch captions —
	// but neither is true of the SONG, which finished fetching before either ran.
	expect(mediaStatusFor(job({ jobType: 'stems' }), 'downloading')).toBe('separating');
	expect(mediaStatusFor(job({ jobType: 'align' }), 'downloading')).toBe('aligning');
	expect(mediaStatusFor(job({ jobType: 'fetch' }), 'downloading')).toBe('downloading');
	// A stage LATER than the floor is honoured: the clamp is a floor, not an override.
	expect(mediaStatusFor(job({ jobType: 'stems' }), 'aligning')).toBe('aligning');
});

test('a job with no reported stage yet reports its OWN step, not a generic "separating"', () => {
	// Mapping `running` to 'separating' for every job type opens all three jobs on "Making karaoke" and
	// then falls back one message later to whatever each was really doing.
	expect(mediaStatusFor(job({ jobType: 'fetch' }))).toBe('downloading');
	expect(mediaStatusFor(job({ jobType: 'align' }))).toBe('aligning');
});

test('a queued step reports the step the song is waiting on — except a queued fetch', () => {
	// A later step is queued only BECAUSE its predecessor completed, so its floor is earned. A queued
	// fetch has earned nothing: claiming 'downloading' ticks a chip for a song no worker has picked up.
	expect(mediaStatusFor(job({ jobType: 'fetch', status: 'queued' }))).toBe('queued');
	expect(mediaStatusFor(job({ jobType: 'stems', status: 'queued' }))).toBe('separating');
	expect(mediaStatusFor(job({ jobType: 'align', status: 'assigned' }))).toBe('aligning');
});

test('a background stems-upgrade stays silent on an already-singable song', () => {
	// An upgrade's accept must not flip every ready row back to "Making karaoke" for the length of a
	// re-separation, on a song that plays fine throughout.
	const finished = media({ stemStatus: 'ready', instrumentalRef: 'x', lyricsStatus: 'ready' });
	expect(shouldBroadcastProcess(job({ jobType: 'stems-upgrade' }), finished)).toBe(false);
	expect(shouldBroadcastProcess(job({ jobType: 'stems' }), finished)).toBe(true);
	expect(shouldBroadcastProcess(job({ jobType: 'stems-upgrade' }), media({ stemStatus: 'queued' }))).toBe(true);
});

test('the hub suppresses an upgrade broadcast end to end', () => {
	const finished = media({
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		lyricsStatus: 'ready'
	});
	const h = harness(finished);
	const j = h.jobs.enqueue('m1', 'stems-upgrade', 0, T0);
	h.hub.handle({
		type: 'worker:hello',
		workerId: 'w1',
		capabilities: ['stems', 'stems:demucs'],
		concurrency: 1,
		version: '1'
	});
	h.hub.handle({ type: 'job:accept', workerId: 'w1', jobId: j.id });
	h.hub.handle({ type: 'job:progress', workerId: 'w1', jobId: j.id, stage: 'separating', pct: 40 });
	expect(h.statuses()).toEqual([]); // the ready row never flickers back to processing
});

test('a failure is a terminal exit from the line, not a stop on it', () => {
	expect(mediaStatusFor(job({ status: 'failed' }))).toBe('failed');
	expect(mediaStatusFor(job({ status: 'canceled' }))).toBe('failed');
	expect(mediaStagePosition('failed')).toBe(-1);
	expect(mediaStagePosition('canceled')).toBe(-1);
});

test('a second Sing tap on a song already separating does not snap the room back to "Queued"', () => {
	// /api/process is the FOURTH producer of a media:status, and a hardcoded `job.status === 'ready' ? 'ready' : 'queued'`
	// is only safe if the job is always new. `enqueue` is idempotent and hands back the EXISTING live job, so a guest
	// tapping Sing on a song someone else started broadcasts 'queued' to the WHOLE ROOM and resets every phone's strip to
	// the first chip. Asserted at the mapping the route calls, since the route needs a live app and socket.
	const running = job({ jobType: 'stems', status: 'running' });
	expect(mediaStatusFor(running, 'separating')).toBe('separating'); // not 'queued'
	expect(mediaStatusFor(running)).toBe('separating');
	// A re-tap mid-DOWNLOAD stays where it is rather than jumping back a chip.
	expect(mediaStatusFor(job({ jobType: 'fetch', status: 'running' }), 'downloading')).toBe('downloading');
	expect(mediaStatusFor(job({ jobType: 'fetch', status: 'queued' }))).toBe('queued');
	// A handed-back COMPLETED job goes through the gates like any completion, so the route cannot announce
	// a song its own gates disagree with.
	const stemsOnly = media({ stemStatus: 'ready', instrumentalRef: 'derived/stems/m1-instrumental.flac' });
	expect(completedStatusFor(job({ jobType: 'stems', status: 'ready' }), stemsOnly)).toBe('aligning');
});

test('every job type has a floor, and every floor is on the shared line', () => {
	// A new job type must decide where it sits before it can broadcast anything, rather than defaulting
	// to a generic stage.
	for (const jobType of ['fetch', 'stems', 'stems-upgrade', 'align'] as const) {
		expect(MEDIA_STAGES).toContain(jobStageFloor(jobType));
	}
});

test('every process gate declares the stop a song waits at, and it is on the shared line', () => {
	// The gate table is the ONE place a pipeline step is registered, so completedStatusFor reads `stage` straight off the
	// gate: a parallel lookup keyed by gate id makes "adding a step is one entry in GATES" false. A gate added without a
	// stage must red here, not report the wrong chip to a room.
	expect(GATES.length).toBeGreaterThan(0);
	for (const gate of GATES) {
		expect(MEDIA_STAGES).toContain(gate.stage);
	}
	const stops = GATES.filter((g) => g.required).map((g) => mediaStagePosition(g.stage));
	for (let i = 1; i < stops.length; i++) {
		expect(stops[i]).toBeGreaterThan(stops[i - 1]!);
	}
});
