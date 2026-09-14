// guard: a worker-reported instrumental that MEASURES as digital silence is refused, not published.
//
// THE DEFECT THIS EXISTS FOR. `media/loudness.ts` has been able to spot a digitally-silent stem since
// two songs in the live library turned out to be exactly that — instrumental AND vocals at the 16-bit
// floor, 44-124KB against 14-28MB for a healthy process. They sat in the Ready list ready to play four
// minutes of nothing, because every readiness check verified that a ref EXISTED and none verified that
// the file behind it carried sound.
//
// That measurement was wired into the boot guiding-track backfill and NOWHERE ELSE. The path that
// publishes a fresh separation — `WorkerHub#onComplete` → `markMediaReady` — trusted whatever the
// worker reported, so a worker writing silence still produced a READY song and the singer found out by
// singing it. `p5-process-lifecycle` reports that as a HIGH finding under FAKE_SILENT_INSTRUMENTAL.
//
// WHY THESE ARE UNIT TESTS AND NOT AN E2E RUN. The real probe shells out to `ffmpeg -af volumedetect`.
// This repo's own e2e note records that a host with decode-only ffmpeg returns null — unmeasurable —
// so the guard cannot be made to FIRE on such a box at all, and the machine this was written on has no
// ffmpeg whatsoever. The verdict is therefore INJECTED here, which is the only way to exercise all
// three branches deterministically: the hub takes `verifyInstrumental` as an optional dep for exactly
// this reason, and what these tests pin is the hub's decision, not ffmpeg's parsing (that is
// `loudness.test.ts`, pure and separate).

import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { WorkerHub } from '$lib/server/jobs/worker-hub';
import { WorkerRegistry } from '$lib/server/jobs/registry';
import { JobRepository } from '$lib/server/jobs/repository';
import { AttemptLedger } from '$lib/server/jobs/attempts';
import type { ServerEvent, Media, WorkerCommand } from '$lib/contract';

const T0 = 1_700_000_000_000;
const SILENT_REF = 'derived/stems/m1-instrumental.wav';

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 200,
	stemStatus: 'none',
	...over
});

/** @param verdict what the injected probe reports for the instrumental, or undefined for no probe. */
function harness(verdict?: 'audible' | 'silent' | 'unknown' | 'throw') {
	const db = migratedDb();
	const attempts = new AttemptLedger(db);
	const jobs = new JobRepository(db, attempts);
	const registry = new WorkerRegistry();
	const mediaById = new Map<string, Media>([['m1', media('m1')]]);
	const broadcasts: ServerEvent[] = [];
	const sent: { workerId: string; cmd: WorkerCommand }[] = [];
	const readied: string[] = [];
	const measured: string[] = [];
	const hub = new WorkerHub({
		jobs,
		attempts,
		registry,
		mediaById,
		toWorker: (workerId, cmd) => sent.push({ workerId, cmd }),
		broadcast: (e) => broadcasts.push(e),
		onMediaReady: (mediaId) => readied.push(mediaId),
		now: () => T0,
		...(verdict
			? {
					verifyInstrumental: async (ref: string) => {
						measured.push(ref);
						if (verdict === 'throw') throw new Error('ffmpeg exploded');
						return verdict;
					}
				}
			: {})
	});
	return { hub, jobs, mediaById, broadcasts, readied, measured, registry };
}

/** Drive a worker through hello → assign → accept → complete, reporting `ref` as the instrumental. */
async function runToCompletion(h: ReturnType<typeof harness>, ref: string | undefined) {
	const { hub, jobs } = h;
	const enqueued = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	const job = jobs.byId(enqueued.id)!;
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	hub.handle({
		type: 'job:complete',
		workerId: 'w1',
		jobId: job.id,
		artifacts: ref ? { stems: { instrumental: ref } } : {}
	});
	// The gate is async: the probe is awaited before the completion body runs. One microtask drain is
	// enough because the injected verdict resolves immediately — the REAL probe decodes a whole file,
	// which is exactly why the gate cannot be synchronous.
	await Promise.resolve();
	await Promise.resolve();
	return jobs.byId(job.id)!;
}

test('a measurably silent instrumental is refused: the job fails and the song does not go ready', async () => {
	const h = harness('silent');
	const job = await runToCompletion(h, SILENT_REF);

	expect(h.measured).toEqual([SILENT_REF]); // the gate actually consulted the probe
	expect(job.status).toBe('failed');
	expect(job.error ?? '').toContain('digital silence');

	// The song must NOT be singable. Both halves matter: `stemStatus` is what the gates read, and
	// `instrumentalRef` is the file rotation would try to play.
	const m = h.mediaById.get('m1')!;
	expect(m.stemStatus).not.toBe('ready');
	expect(m.instrumentalRef).toBeUndefined();
	expect(h.readied).toEqual([]); // no playback reconciliation for a song that never became playable
});

test('a silent refusal is TERMINAL, not a requeue that burns the remaining attempts', async () => {
	/*
	 * Re-running the same separator over the same source produces the same silence, so a retry can only
	 * arrive back here having spent an attempt. Pinned because the retryable path is the default shape for
	 * a worker-reported problem, and this one deliberately is not it.
	 */
	const h = harness('silent');
	const job = await runToCompletion(h, SILENT_REF);
	expect(job.status).toBe('failed');
	expect(job.status).not.toBe('queued');

	// …and the room is told, rather than the song silently sitting un-processed.
	const kinds = h.broadcasts.map((e) => e.type);
	expect(kinds).toContain('media:status');
});

test('an AUDIBLE measurement publishes exactly as before', async () => {
	const h = harness('audible');
	const job = await runToCompletion(h, 'derived/stems/m1-instrumental.flac');

	expect(h.measured).toHaveLength(1);
	expect(job.status).toBe('ready');
	expect(h.mediaById.get('m1')!.stemStatus).toBe('ready');
	expect(h.readied).toEqual(['m1']);
});

test('UNMEASURABLE publishes — an unknown reading is not silence', async () => {
	/*
	 * THE SAFETY PROPERTY, and the reason this is a separate test from the audible case. A box with no
	 * ffmpeg measures nothing. If "cannot measure" refused the publish, that box would fail every process
	 * it ran — a self-inflicted outage strictly worse than the defect being guarded. `isDigitalSilence`
	 * documents the same rule for the same reason; this pins that the HUB honours it.
	 */
	const h = harness('unknown');
	const job = await runToCompletion(h, 'derived/stems/m1-instrumental.flac');

	expect(h.measured).toHaveLength(1); // it did try
	expect(job.status).toBe('ready');
	expect(h.mediaById.get('m1')!.stemStatus).toBe('ready');
});

test('a probe that THROWS publishes too, rather than wedging the completion', async () => {
	// A rejected probe is unmeasurable by another route. The completion must still land: a crash in a
	// verification step must not be able to strand a job that the worker finished successfully.
	const h = harness('throw');
	const job = await runToCompletion(h, 'derived/stems/m1-instrumental.flac');
	expect(job.status).toBe('ready');
	expect(h.mediaById.get('m1')!.stemStatus).toBe('ready');
});

test('with no probe wired the hub behaves exactly as it did before', async () => {
	// The dep is optional so the hub unit-tests bare and an unwired core is unchanged. Without this the
	// gate would be a silent behaviour change for every caller that does not know about it.
	const h = harness(undefined);
	const job = await runToCompletion(h, 'derived/stems/m1-instrumental.flac');
	expect(h.measured).toEqual([]);
	expect(job.status).toBe('ready');
	expect(h.mediaById.get('m1')!.stemStatus).toBe('ready');
});

test('a completion that reports NO instrumental never consults the probe', async () => {
	// Only a job that publishes an instrumental has something to measure. A fetch produces nothing
	// singable, and measuring a ref the frame did not send would resolve a path from nothing.
	const h = harness('silent'); // would refuse if it were consulted
	const job = await runToCompletion(h, undefined);
	expect(h.measured).toEqual([]);
	expect(job.status).toBe('ready');
});
