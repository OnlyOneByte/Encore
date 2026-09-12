// THE MONOTONICITY INVARIANT, and the unit behaviour under it.
//
// A cook is three jobs — fetch → stems → align — and the phone renders their combined progress as ONE
// five-stop line (ProcessingCard's chip strip). Each job reports its own private stages, so forwarding
// them verbatim walked that line backwards: a song on "Making karaoke" jumped back to "Fetched" when
// stems began decoding, and again when align pulled its captions. Measured on the real hub before the
// fix, one cook broadcast six backward jumps:
//
//   separating@0 → downloading@0 → downloading@100 → ready@100      (fetch)
//   separating@0 → downloading@10 → separating@68 → ready@100       (stems)
//   separating@0 → downloading@5 → aligning@50 → ready@100          (align)
//
// The first test here is the guard: it drives a REAL WorkerHub through a whole cook and asserts the
// broadcast sequence never decreases. That is deliberately an end-to-end assertion over the hub rather
// than a unit test of the mapping, because every one of the three causes lived in a different place
// (the status map, the stage passthrough, the completion handler) and a unit test of any one of them
// would have passed while the sequence a guest sees still regressed.
import { test, expect } from 'bun:test';
import { migratedDb } from '$server/db/test-db';
import { WorkerHub } from '$server/jobs/worker-hub';
import { WorkerRegistry } from '$server/jobs/registry';
import { JobRepository } from '$server/jobs/repository';
import { completedStatusFor, jobStageFloor, mediaStatusFor, shouldBroadcastCook } from '$server/jobs/media-status';
import {
	mediaStagePosition,
	pendingGates,
	GATES,
	MEDIA_STAGES,
	type Job,
	type Media,
	type ServerEvent
} from '$shared';

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

test('THE INVARIANT: a cook never reports a stage it has already passed', () => {
	const h = harness();
	h.jobs.enqueue('m1', 'fetch', 0, T0);
	h.hub.handle({
		type: 'worker:hello',
		workerId: 'w1',
		capabilities: ['fetch:ytdlp', 'stems', 'stems:demucs', 'align'],
		concurrency: 1,
		version: '1'
	});

	// The stage plans are the worker's real ones (apps/worker/src/vocabulary.py STAGE_PLANS): stems and
	// align BOTH open with a download of their own, which is precisely what used to leak through.
	runStep(h, 'fetch', ['downloading'], { annotation: undefined });
	runStep(h, 'stems', ['downloading', 'separating'], { stems: { instrumental: 'derived/stems/m1-instrumental.flac' } });
	runStep(h, 'align', ['downloading', 'aligning'], { lyrics: { uri: 'derived/lyrics/m1.json' } });

	const seq = h.statuses().map((e) => e.status);
	// Documented in full because the sequence IS the contract — a reader should be able to see the whole
	// guest-visible progression without running anything.
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

	// Stated as the invariant too, so a future step added to the chain is checked by intent rather than
	// by this one hardcoded list.
	const positions = seq.map(mediaStagePosition);
	expect(positions.every((p) => p >= 0)).toBe(true); // nothing off the line during a healthy cook
	for (let i = 1; i < positions.length; i++) {
		expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]);
	}
	// And the one that broke a guest's trust: 'ready' is the LAST thing said, never an intermediate.
	expect(seq.indexOf('ready')).toBe(seq.length - 1);
});

test('a completed fetch reports the step it is WAITING on, not the step it finished', () => {
	// The pre-fix behaviour: mediaStatusFor(job with status 'ready') → 'ready' for every job type, so a
	// finished download told every phone the song was singable. readiness.ts lets a live 'ready' win
	// over the catalog, so entryPlayable said yes for a song with no instrumental on disk.
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
	// The monotonic clamp at the end of completedStatusFor — the `: floor` branch — is the only thing
	// that pins this, and no other test in this file constructs its input. Every other completed-path
	// case has `pendingGates(media)[0].stage` at or ABOVE the completed step's floor, so the `nextStatus`
	// branch is taken and deleting the clamp (`return nextStatus`) leaves them byte-identical.
	//
	// Here the FIRST outstanding gate is `stems`/'separating' (position 2) while the job that just
	// completed is `align`, whose floor is 'aligning' (position 3): nextStatus is strictly BELOW the
	// floor. Reachable — an align completes while separation's artifact is missing (retention evicting
	// instrumentalRef mid-align is the suspected production route; the trigger itself is proven here at
	// the function boundary the clamp lives on). Without the clamp the guest's strip would jump from
	// "Adding lyrics" back to "Making karaoke" — the exact backwards walk the invariant forbids.
	const alignAheadOfStems = media({ stemStatus: 'none', lyricsStatus: 'ready', lyricsRef: 'derived/lyrics/m1.json' });
	// Guard the premise so this test cannot silently drift into the vacuous shape: the first pending
	// gate must be strictly below the align floor, or the `: floor` branch is never exercised.
	expect(pendingGates(alignAheadOfStems)[0]!.stage).toBe('separating');
	expect(mediaStagePosition('separating')).toBeLessThan(mediaStagePosition(jobStageFloor('align')));
	// Clamp intact → the completed align holds at its own floor.
	expect(completedStatusFor(job({ jobType: 'align', status: 'ready' }), alignAheadOfStems)).toBe('aligning');
});

test("a job's own download stage is clamped to the step it IS", () => {
	// Cause 2, in one line per job type. The worker is not lying — a stems job really does decode and an
	// align job really does fetch captions — but neither is true of the SONG, which has finished
	// fetching by the time either runs.
	expect(mediaStatusFor(job({ jobType: 'stems' }), 'downloading')).toBe('separating');
	expect(mediaStatusFor(job({ jobType: 'align' }), 'downloading')).toBe('aligning');
	// A fetch's download IS the song's download, so it passes through.
	expect(mediaStatusFor(job({ jobType: 'fetch' }), 'downloading')).toBe('downloading');
	// A stage LATER than the floor is honoured — the clamp is a floor, not an override.
	expect(mediaStatusFor(job({ jobType: 'stems' }), 'aligning')).toBe('aligning');
});

test('a job with no reported stage yet reports its OWN step, not a generic "separating"', () => {
	// Cause 1: `running` mapped to 'separating' for every job type, so each of the three jobs opened on
	// "Making karaoke" and then fell back one message later to whatever it was really doing.
	expect(mediaStatusFor(job({ jobType: 'fetch' }))).toBe('downloading');
	expect(mediaStatusFor(job({ jobType: 'align' }))).toBe('aligning');
});

test('a queued step reports the step the song is waiting on — except a queued fetch', () => {
	// A later step is only ever queued BECAUSE its predecessor completed, so its floor is earned. A
	// queued fetch has earned nothing yet: claiming 'downloading' would tick the Queued chip for a song
	// no worker has picked up.
	expect(mediaStatusFor(job({ jobType: 'fetch', status: 'queued' }))).toBe('queued');
	expect(mediaStatusFor(job({ jobType: 'stems', status: 'queued' }))).toBe('separating');
	expect(mediaStatusFor(job({ jobType: 'align', status: 'assigned' }))).toBe('aligning');
});

test('a background stems-upgrade stays silent on an already-singable song', () => {
	// The fourth door onto the same bug: an upgrade's accept would flip every ready row back to "Making
	// karaoke" for the length of a re-separation, on a song that plays fine throughout.
	const finished = media({ stemStatus: 'ready', instrumentalRef: 'x', lyricsStatus: 'ready' });
	expect(shouldBroadcastCook(job({ jobType: 'stems-upgrade' }), finished)).toBe(false);
	// Every other job type reaches the room, and so does an upgrade on a song that is NOT yet singable.
	expect(shouldBroadcastCook(job({ jobType: 'stems' }), finished)).toBe(true);
	expect(shouldBroadcastCook(job({ jobType: 'stems-upgrade' }), media({ stemStatus: 'queued' }))).toBe(true);
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
	expect(h.statuses()).toEqual([]); // the ready row never flickers back to cooking
});

test('a failure is a terminal exit from the line, not a stop on it', () => {
	expect(mediaStatusFor(job({ status: 'failed' }))).toBe('failed');
	expect(mediaStatusFor(job({ status: 'canceled' }))).toBe('failed');
	expect(mediaStagePosition('failed')).toBe(-1);
	expect(mediaStagePosition('canceled')).toBe(-1);
});

test('a second Sing tap on a song already separating does not snap the room back to "Queued"', () => {
	// The FOURTH producer of a media:status, and the one the first pass left on a hardcoded literal.
	// /api/make-karaoke published `job.status === 'ready' ? 'ready' : 'queued'`. That reads as safe only
	// if the job is always new — but `enqueue` is idempotent and hands back the EXISTING live job (§6
	// dedup), and `cookState` answers 'cooking' for an in-flight song WITHOUT the route short-circuiting
	// on it. So a guest tapping Sing on a song someone else already started (a stale row, a late-joining
	// phone) broadcast 'queued' to the WHOLE ROOM and reset every phone's strip to the first chip.
	//
	// Asserted at the mapping the route now calls, since the route itself needs a live app + socket.
	const running = job({ jobType: 'stems', status: 'running' });
	expect(mediaStatusFor(running, 'separating')).toBe('separating'); // not 'queued'
	// The re-tap arrives before the worker's first progress frame: still not 'queued'.
	expect(mediaStatusFor(running)).toBe('separating');
	// And a re-tap on a song mid-DOWNLOAD stays where it is rather than jumping back a chip.
	expect(mediaStatusFor(job({ jobType: 'fetch', status: 'running' }), 'downloading')).toBe('downloading');
	// The one case that genuinely is 'queued': a brand-new cook nothing has picked up.
	expect(mediaStatusFor(job({ jobType: 'fetch', status: 'queued' }))).toBe('queued');
	// A handed-back COMPLETED job goes through the gates like any completion, so the route cannot
	// announce a singable song its own gates disagree with.
	const stemsOnly = media({ stemStatus: 'ready', instrumentalRef: 'derived/stems/m1-instrumental.flac' });
	expect(completedStatusFor(job({ jobType: 'stems', status: 'ready' }), stemsOnly)).toBe('aligning');
});

test('every job type has a floor, and every floor is on the shared line', () => {
	// A new job type must decide where it sits before it can broadcast anything — this is what stops the
	// next step added to the cook from defaulting to a generic stage the way `running` used to.
	for (const jobType of ['fetch', 'stems', 'stems-upgrade', 'align'] as const) {
		expect(MEDIA_STAGES).toContain(jobStageFloor(jobType));
	}
});

test('every cook gate declares the stop a song waits at, and it is on the shared line', () => {
	// The gate table is the ONE place a pipeline step is registered (gates.ts says so in its opening
	// comment). completedStatusFor reads `stage` straight off the gate for that reason — a lookup table
	// keyed by gate id lived here first and quietly made "adding a step is one entry in GATES" false.
	// This asserts the field exists and is usable, so a future gate added WITHOUT one fails here rather
	// than reporting the wrong chip to a room full of phones.
	expect(GATES.length).toBeGreaterThan(0);
	for (const gate of GATES) {
		expect(MEDIA_STAGES).toContain(gate.stage);
	}
	// And the order matches the pipeline: an earlier gate's stop is earlier on the line.
	const stops = GATES.filter((g) => g.required).map((g) => mediaStagePosition(g.stage));
	for (let i = 1; i < stops.length; i++) {
		expect(stops[i]).toBeGreaterThan(stops[i - 1]!);
	}
});
