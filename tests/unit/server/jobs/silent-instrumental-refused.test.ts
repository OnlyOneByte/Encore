// A worker-reported instrumental that MEASURES as digital silence is refused, not published. Every
// readiness check verifies a ref EXISTS; none verifies the file behind it carries sound, so a worker
// writing silence produces a READY song and the singer finds out by singing four minutes of nothing.
//
// The verdict is INJECTED here rather than measured: the real probe shells out to
// `ffmpeg -af volumedetect`, a decode-only host returns null (unmeasurable), and a box with no ffmpeg
// cannot make the guard fire at all. The hub takes `verifyInstrumental` as an optional dep for exactly this
// reason, so what is pinned is the HUB's decision — ffmpeg's parsing is `loudness.test.ts`.

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
	// The gate is async: the probe is awaited before the completion body runs. One drain suffices because
	// the injected verdict resolves immediately; the REAL probe decodes a whole file, which is why the gate
	// cannot be synchronous.
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

	// Both halves matter: `stemStatus` is what the gates read, `instrumentalRef` is what rotation plays.
	const m = h.mediaById.get('m1')!;
	expect(m.stemStatus).not.toBe('ready');
	expect(m.instrumentalRef).toBeUndefined();
	expect(h.readied).toEqual([]); // no playback reconciliation for a song that never became playable
});

test('a silent refusal is TERMINAL, not a requeue that burns the remaining attempts', async () => {
	// Re-running the same separator over the same source produces the same silence, so a retry only spends
	// an attempt. Pinned because retryable is the DEFAULT shape for a worker-reported problem.
	const h = harness('silent');
	const job = await runToCompletion(h, SILENT_REF);
	expect(job.status).toBe('failed');
	expect(job.status).not.toBe('queued');

	// The room is told, rather than the song silently sitting un-processed.
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
	// THE SAFETY PROPERTY: a box with no ffmpeg measures nothing, so if "cannot measure" refused the publish
	// that box would fail every process it ran — an outage strictly worse than the defect being guarded.
	const h = harness('unknown');
	const job = await runToCompletion(h, 'derived/stems/m1-instrumental.flac');

	expect(h.measured).toHaveLength(1); // it did try
	expect(job.status).toBe('ready');
	expect(h.mediaById.get('m1')!.stemStatus).toBe('ready');
});

test('a probe that THROWS publishes too, rather than wedging the completion', async () => {
	// A rejected probe is unmeasurable by another route, and the completion must still land: a crash in a
	// verification step must not strand a job the worker finished successfully.
	const h = harness('throw');
	const job = await runToCompletion(h, 'derived/stems/m1-instrumental.flac');
	expect(job.status).toBe('ready');
	expect(h.mediaById.get('m1')!.stemStatus).toBe('ready');
});

test('with no probe wired the hub behaves exactly as it did before', async () => {
	// The dep is optional, so the hub unit-tests bare and an unwired core is unchanged.
	const h = harness(undefined);
	const job = await runToCompletion(h, 'derived/stems/m1-instrumental.flac');
	expect(h.measured).toEqual([]);
	expect(job.status).toBe('ready');
	expect(h.mediaById.get('m1')!.stemStatus).toBe('ready');
});

test('a completion that reports NO instrumental never consults the probe', async () => {
	// Only a job that publishes an instrumental has something to measure: a fetch produces nothing
	// singable, and measuring a ref the frame did not send resolves a path from nothing.
	const h = harness('silent'); // would refuse if it were consulted
	const job = await runToCompletion(h, undefined);
	expect(h.measured).toEqual([]);
	expect(job.status).toBe('ready');
});
