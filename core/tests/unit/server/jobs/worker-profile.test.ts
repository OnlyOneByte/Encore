// The worker's resolved profile (device, backend, threads) reaches every attempt row. Before this, the
// worker sent backend only when set by hand and device never, and core dropped both from hello, so
// `job_attempts.backend` and `device` were empty on every row.
import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { WorkerHub, workerProfile, resolvedFacts } from '$lib/server/jobs/worker-hub';
import { WorkerRegistry } from '$lib/server/jobs/registry';
import { JobRepository } from '$lib/server/jobs/repository';
import { AttemptLedger } from '$lib/server/jobs/attempts';
import { modelFacts, workerFacts } from '$lib/metrics-format';
import { toAudit } from '../../../../src/routes/api/audit/[mediaId]/audit-shape';
import type { Media, WorkerMessage } from '$lib/contract';

const T0 = 1_700_000_000_000;

function harness() {
	const db = migratedDb();
	const attempts = new AttemptLedger(db);
	const jobs = new JobRepository(db, attempts);
	const registry = new WorkerRegistry();
	const mediaById = new Map<string, Media>([
		['m1', { id: 'm1', source: 'youtube', sourceRef: 'vid-m1', title: 'm1', durationSec: 200, stemStatus: 'none' }]
	]);
	const hub = new WorkerHub({
		jobs,
		attempts,
		registry,
		mediaById,
		toWorker: () => {},
		broadcast: () => {},
		now: () => T0,
		queueEntries: () => []
	});
	return { hub, jobs, attempts, registry };
}

const hello = (extra: Record<string, unknown> = {}): WorkerMessage =>
	({
		type: 'worker:hello',
		workerId: 'w1',
		capabilities: ['stems'],
		concurrency: 1,
		version: '1',
		...extra
	}) as WorkerMessage;

const PROFILE = { backend: 'torch', device: 'cuda:0', threads: 16 };

test('the hello profile is stamped on the attempt at assignment', () => {
	const { hub, jobs, attempts } = harness();
	jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle(hello(PROFILE));
	const [a] = attempts.byMedia('m1');
	expect([a.backend, a.device, a.threads]).toEqual(['torch', 'cuda:0', 16]);
});

test('a FAILED attempt still says what it ran on', () => {
	const { hub, jobs, attempts } = harness();
	jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle(hello(PROFILE));
	const jobId = jobs.listByStatus('assigned')[0].id;
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId });
	hub.handle({ type: 'job:failed', workerId: 'w1', jobId, error: 'boom', retryable: false });
	const [a] = attempts.byMedia('m1');
	expect(a.outcome).toBe('failed');
	expect([a.backend, a.device, a.threads]).toEqual(['torch', 'cuda:0', 16]);
});

test('a null or junk fact in a completion cannot blank the stamped profile', () => {
	const { hub, jobs, attempts } = harness();
	jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle(hello(PROFILE));
	const jobId = jobs.listByStatus('assigned')[0].id;
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId });
	hub.handle({
		type: 'job:complete',
		workerId: 'w1',
		jobId,
		mediaUri: '/media/x.flac',
		artifacts: { stems: { instrumental: '/media/x.flac' } },
		facts: { engine: 'demucs', backend: null, device: { evil: 1 } } as never
	});
	const [a] = attempts.byMedia('m1');
	expect([a.engine, a.backend, a.device]).toEqual(['demucs', 'torch', 'cuda:0']);
});

test('a profile field that is not a short name or a sane count is dropped, and the worker still joins', () => {
	expect(workerProfile({ backend: 'mlx', device: 'cpu', threads: 8 })).toEqual({
		backend: 'mlx',
		device: 'cpu',
		threads: 8
	});
	expect(workerProfile({ backend: 'x'.repeat(40), device: '/home/someone/.venv', threads: 1.5 })).toEqual({});
	expect(workerProfile({ device: 'box.local lan', threads: '8' })).toEqual({});
	expect(workerProfile({ threads: 0 })).toEqual({});

	const { hub, registry } = harness();
	hub.handle(hello({ device: '../../etc', threads: -1 }));
	expect(registry.get('w1')).not.toBeNull();
	expect(registry.get('w1')!.profile).toEqual({ concurrency: 1 }); // the hello's own slots
});

test('completion facts keep only bounded strings', () => {
	expect(resolvedFacts({ engine: 'demucs', model: 'm'.repeat(129), asrModel: 3, syncMode: '' }, 'stems')).toEqual({
		engine: 'demucs'
	});
	expect(resolvedFacts(null, 'stems')).toEqual({});
	expect(resolvedFacts(['engine'], 'stems')).toEqual({});
});

test("a stems job's own -j and threads are kept, within hello's bounds (#1330)", () => {
	expect(resolvedFacts({ threads: 32, demucsJobs: 4 }, 'stems')).toEqual({ threads: 32, demucsJobs: 4 });
	expect(resolvedFacts({ threads: 32, demucsJobs: 4 }, 'stems-upgrade')).toEqual({ threads: 32, demucsJobs: 4 });
	expect(resolvedFacts({ threads: 0, demucsJobs: 1.5 }, 'stems')).toEqual({});
	expect(resolvedFacts({ threads: '32', demucsJobs: 5000 }, 'stems')).toEqual({});
});

test('a lyrics note is kept only when it is a known reason: it reaches the song page (#1221, #1288)', () => {
	expect(resolvedFacts({ lyricsNote: 'asr-offline' }, 'align')).toEqual({ lyricsNote: 'asr-offline' });
	expect(resolvedFacts({ lyricsNote: 'asr-babble' }, 'align')).toEqual({ lyricsNote: 'asr-babble' });
	for (const lyricsNote of ['<b>hi</b>', 'ASR-OFFLINE', '', 1, null])
		expect(resolvedFacts({ lyricsNote }, 'align')).toEqual({});
});

test('a completion backend or device is held to the same names hello is', () => {
	expect(resolvedFacts({ device: 'cpu', backend: 'mlx' }, 'align')).toEqual({ device: 'cpu', backend: 'mlx' });
	expect(resolvedFacts({ device: '/home/someone/.venv', backend: '<script>x</script>' }, 'align')).toEqual({});
	expect(resolvedFacts({ device: 'box.local lan', backend: 'x'.repeat(40) }, 'align')).toEqual({});
});

test('each override comes only from a job kind that runs it (#1113)', () => {
	const sent = { device: 'cpu', backend: 'mlx', threads: 16, demucsJobs: 2 };
	const where = { device: 'cpu', backend: 'mlx' };
	// A model may run off the process's device; the separator's share is a stems job's; a fetch runs neither.
	expect(resolvedFacts(sent, 'align')).toEqual(where);
	expect(resolvedFacts(sent, 'align-remake')).toEqual(where);
	expect(resolvedFacts(sent, 'stems')).toEqual({ ...where, threads: 16, demucsJobs: 2 });
	expect(resolvedFacts(sent, 'stems-remake')).toEqual({ ...where, threads: 16, demucsJobs: 2 });
	expect(resolvedFacts(sent, 'fetch')).toEqual({});
});

/** The attempt dispatch stamps for a queued `jobType`, assigned to a worker whose hello carried `profile`. */
function stamped(jobType: 'fetch' | 'stems', profile: Record<string, unknown>) {
	const { hub, jobs, attempts } = harness();
	jobs.enqueue('m1', jobType, 0, T0);
	hub.handle(hello({ capabilities: [jobType === 'fetch' ? 'fetch:ytdlp' : 'stems'], ...profile }));
	return attempts.byMedia('m1')[0];
}

const GPU = { backend: 'torch', device: 'cuda:0', threads: 16, demucsJobs: 1, asrCompute: 'float16', concurrency: 2 };

test('a fetch attempt records no accelerator: yt-dlp runs on none (#1112)', () => {
	const a = stamped('fetch', GPU);
	expect([a.backend, a.device, a.threads, a.demucsJobs, a.asrCompute]).toEqual([null, null, null, null, null]);
	expect(a.concurrency).toBe(2); // the worker's jobs at once still describe the box it ran on
});

test('a stems attempt records the demucs -j the worker sent in hello (#1114)', () => {
	const a = stamped('stems', { ...GPU, demucsJobs: 4 });
	expect([a.backend, a.device, a.threads, a.demucsJobs]).toEqual(['torch', 'cuda:0', 16, 4]);
});

test('an align completion can say its transcriber ran on cpu over the stamped mps', () => {
	const { hub, jobs, attempts } = harness();
	jobs.enqueue('m1', 'align', 0, T0);
	hub.handle(hello({ capabilities: ['align'], device: 'mps', backend: 'mlx' }));
	const jobId = jobs.listByStatus('assigned')[0].id;
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId });
	hub.handle({
		type: 'job:complete',
		workerId: 'w1',
		jobId,
		mediaUri: '',
		facts: { device: 'cpu', asrModel: 'small' }
	} as never);
	const [a] = attempts.byMedia('m1');
	expect([a.device, a.backend]).toEqual(['cpu', 'mlx']);
});

test('demucsJobs is a count like threads', () => {
	expect(workerProfile({ demucsJobs: 4 })).toEqual({ demucsJobs: 4 });
	expect(workerProfile({ demucsJobs: '4' })).toEqual({});
	expect(workerProfile({ demucsJobs: 0 })).toEqual({});
});

test('/metrics lists what a worker resolved before what it measured', () => {
	expect(workerFacts({ ...PROFILE, demucsJobs: 2 }, { cpuCount: 8 })).toEqual([
		['hardware', 'cuda:0'],
		['runtime', 'torch'],
		['torch threads', '16'],
		['demucs jobs', '2'],
		['cpus', '8']
	]);
	expect(workerFacts(null, null)).toEqual([]);
});

test('/metrics says the device once: a resolved device hides the host accelerator', () => {
	const host = { accelerator: 'cuda', deviceName: 'NVIDIA RTX 4070' };
	expect(workerFacts({ device: 'cuda' }, host)).toEqual([
		['hardware', 'cuda'],
		['gpu', 'NVIDIA RTX 4070']
	]);
	// An older worker sends no profile, so the host's accelerator is all there is.
	expect(workerFacts(null, host)).toEqual([
		['accelerator', 'cuda'],
		['gpu', 'NVIDIA RTX 4070']
	]);
});

test('the rest of the profile, and what was set by hand, is held to known names and sane values', () => {
	expect(
		workerProfile({ concurrency: 2, asrCompute: 'int8', warmup: false, handSet: ['warmup', 'threads', 'threads'] })
	).toEqual({ concurrency: 2, asrCompute: 'int8', warmup: false, handSet: ['threads', 'warmup'] });
	expect(workerProfile({ asrCompute: 'float64', warmup: 'no', handSet: 'threads' })).toEqual({});
	expect(workerProfile({ handSet: ['<b>x</b>', 'ENCORE_THREADS', 7] })).toEqual({ handSet: [] });
	expect(workerProfile({ handSet: Array(33).fill('threads') })).toEqual({}); // an oversized list is dropped
	expect(workerProfile({ concurrency: 5000 })).toEqual({});
});

test('every attempt records the jobs at once, the demucs jobs, the speech compute and what was set by hand', () => {
	const { hub, jobs, attempts } = harness();
	jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle(hello({ ...PROFILE, concurrency: 2, demucsJobs: 4, asrCompute: 'float16', handSet: ['concurrency'] }));
	const [a] = attempts.byMedia('m1');
	expect([a.concurrency, a.demucsJobs, a.asrCompute, a.handSet]).toEqual([2, 4, 'float16', 'concurrency']);
	const audit = toAudit(a);
	expect([audit.models.concurrency, audit.models.demucsJobs, audit.handSet]).toEqual(['2', '4', ['concurrency']]);
	const facts = modelFacts(audit.models, audit.handSet);
	expect(facts).toContainEqual(['jobs at once', '2 (set by hand)']);
	// The box picks the compute type, the threads and the demucs jobs (#1284).
	expect(facts).toContainEqual(['speech compute', 'float16 (auto)']);
	expect(facts).toContainEqual(['torch threads', '16 (auto)']);
	expect(facts).toContainEqual(['demucs jobs', '4 (auto)']);
});

test('a worker too old to say what it set by hand records null, not "all auto"', () => {
	const { hub, jobs, attempts } = harness();
	jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle(hello(PROFILE));
	const a = attempts.byMedia('m1')[0];
	expect(a.handSet).toBeNull();
	expect(modelFacts(toAudit(a).models, toAudit(a).handSet)).toContainEqual(['torch threads', '16']);
});

test('/metrics marks each setting of a worker as set by hand or picked by the box', () => {
	const profile = { device: 'cpu', threads: 6, demucsJobs: 4, concurrency: 2, asrCompute: 'float32', warmup: true };
	expect(workerFacts({ ...profile, handSet: ['threads'] }, null)).toEqual([
		['hardware', 'cpu (auto)'],
		['torch threads', '6 (set by hand)'],
		['demucs jobs', '4 (auto)'],
		['jobs at once', '2 (auto)'],
		['speech compute', 'float32 (auto)'],
		['warm-up at boot', 'on (auto)']
	]);
});

test('the per-song audit shows the threads an attempt ran with', () => {
	const { hub, jobs, attempts } = harness();
	jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle(hello(PROFILE));
	expect(toAudit(attempts.byMedia('m1')[0]).models.threads).toBe('16');
});

/** A completed stems attempt that carried `stages`, read back from the ledger as stored. */
function storedStages(stages: unknown): string | null {
	const { hub, jobs, attempts } = harness();
	jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle(hello(PROFILE));
	const jobId = jobs.listByStatus('assigned')[0].id;
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId });
	hub.handle({
		type: 'job:complete',
		workerId: 'w1',
		jobId,
		mediaUri: '/media/x.flac',
		artifacts: { stems: { instrumental: '/media/x.flac' } },
		stages: stages as never
	});
	return attempts.byMedia('m1')[0].stages;
}

test('a worker’s stages are stored as the speed page can show them, bounded (#1357)', () => {
	const sent = [
		{ stage: 'separate', ms: 48_700 },
		{ stage: 'publish_stems', ms: 2_900.4 }
	];
	expect(JSON.parse(storedStages(sent)!)).toEqual([
		{ stage: 'separate', ms: 48_700 },
		{ stage: 'publish_stems', ms: 2_900 }
	]);
	// Oversized and malformed: 500 entries, junk shapes, impossible times, and names the page has no label for.
	const junk = [
		{ stage: 'separate', ms: -1 },
		{ stage: 'separate', ms: Number.NaN },
		{ stage: 'separate', ms: 1e12 },
		{ stage: 'separate', ms: '5' },
		null,
		'separate',
		{ stage: '<img src=x onerror=alert(1)>', ms: 1_000 },
		{ stage: 'x'.repeat(10_000), ms: 2_000 },
		{ ms: 500 },
		{ stage: 'transcribe', ms: 30_000 },
		...Array.from({ length: 490 }, (_, i) => ({ stage: `step${i}`, ms: 1 }))
	];
	const kept = JSON.parse(storedStages(junk)!) as { stage: string; ms: number }[];
	// The first 32 entries only: `transcribe` and 22 unnamed `stepN`, after 3 unnamed ones, summed into `other`.
	expect(kept).toEqual([
		{ stage: 'other', ms: 1_000 + 2_000 + 500 + 22 },
		{ stage: 'transcribe', ms: 30_000 }
	]);
	expect(JSON.stringify(kept)).not.toContain('<img');
});

test('a worker that sends no stages, or nothing usable, stores none, as before (#1357)', () => {
	expect(storedStages(undefined)).toBeNull();
	expect(storedStages([])).toBeNull();
	expect(storedStages({ stage: 'separate', ms: 1 })).toBeNull();
	expect(storedStages([{ stage: 'separate', ms: -5 }])).toBeNull();
});
