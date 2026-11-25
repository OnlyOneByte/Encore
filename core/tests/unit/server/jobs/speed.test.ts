// The host speed page: pick to ready as a multiple of song length, per machine, and what went wrong.
// Pick-to-ready cases run through the real JobRepository → AttemptLedger → finishedSince path, because the route
// reads sealed rows only and an in-flight step is visible solely as a missing row.
import { describe, expect, it } from 'bun:test';
import type { JobAttempt, JobType } from '$lib/contract';
import { attemptsCsv, classifyError, e2e, failures, perDevice, readySongs, speed } from '$lib/server/jobs/metrics';
import { AttemptLedger } from '$lib/server/jobs/attempts';
import { JobRepository } from '$lib/server/jobs/repository';
import { migratedDb } from '$lib/server/db/test-db';

const T0 = 1_700_000_000_000;
const S = 1_000;
const at = (sec: number) => T0 + sec * S;

interface Machine {
	worker?: string;
	device?: string;
	threads?: number;
	audioSec?: number | null;
}

function ledger() {
	const db = migratedDb();
	const attempts = new AttemptLedger(db);
	const jobs = new JobRepository(db, attempts);
	/** One step: queued at q, started at s, then sealed at e as `end` (or left running). */
	const step = (
		media: string,
		type: JobType,
		pid: string,
		[q, s, e]: [number, number, number],
		end: 'ready' | 'failed' | 'running' = 'ready',
		m: Machine = {}
	) => {
		const job = jobs.enqueue(media, type, 0, at(q), pid);
		const facts = {
			device: m.device ?? 'mps',
			threads: m.threads ?? 10,
			audioSec: m.audioSec === undefined ? 200 : m.audioSec
		};
		jobs.assign(job.id, m.worker ?? 'mac', null, at(q), facts);
		jobs.accept(job.id, null, at(s));
		if (end === 'ready') jobs.complete(job.id, at(e));
		if (end === 'failed') jobs.fail(job.id, 'instrumental measures as digital silence (x)', at(e));
		return job;
	};
	/** fetch 0–10 s, stems 15–75 s, align 80–100 s: 100 s for a 200 s song, so 0.5x. */
	const pick = (media: string, pid: string, m: Machine = {}) => {
		step(media, 'fetch', pid, [0, 0, 10], 'ready', m);
		step(media, 'stems', pid, [10, 15, 75], 'ready', m);
		step(media, 'align', pid, [75, 80, 100], 'ready', m);
	};
	return {
		jobs,
		step,
		pick,
		read: () => readySongs(attempts.finishedSince(0)),
		sealed: () => attempts.finishedSince(0)
	};
}

describe('pick to ready counts a song only once its chain reached a ready align', () => {
	it('reads a whole pick as a multiple of its length, split by step', () => {
		const l = ledger();
		l.pick('m1', 'p1');
		const [s] = l.read().songs;
		expect(s!.multiple).toBeCloseTo(0.5);
		expect([s!.fetchMs, s!.stemsMs, s!.alignMs, s!.waitMs]).toEqual([10 * S, 60 * S, 20 * S, 10 * S]);
	});

	it('leaves out a song whose stems are still running', () => {
		const l = ledger();
		l.step('m1', 'fetch', 'p1', [0, 0, 10]);
		l.step('m1', 'stems', 'p1', [10, 15, 0], 'running');
		expect(l.read().songs).toEqual([]);
		expect(e2e(l.sealed()).n).toBe(0);
	});

	it('leaves out a song whose align is still running, here and in "From request to ready to sing"', () => {
		const l = ledger();
		l.step('m1', 'fetch', 'p1', [0, 0, 10]);
		l.step('m1', 'stems', 'p1', [10, 15, 75]);
		l.step('m1', 'align', 'p1', [75, 80, 0], 'running');
		expect(l.read().songs).toEqual([]);
		expect(e2e(l.sealed()).n).toBe(0);
	});

	it('never counts a lyrics-only re-align, such as the boot backfill', () => {
		const l = ledger();
		l.step('m1', 'align', 'p-backfill', [0, 0, 20]);
		expect(l.read().songs).toEqual([]);
		expect(e2e(l.sealed()).n).toBe(0);
	});

	it('leaves out a song whose stems failed, including a refused silent instrumental', () => {
		const l = ledger();
		l.pick('m1', 'p1');
		l.step('m2', 'fetch', 'p2', [0, 0, 10]);
		l.step('m2', 'stems', 'p2', [10, 15, 75], 'failed');
		expect(l.read().songs.map((s) => s.processingId)).toEqual(['p1']);
	});

	it('counts a retried song with its retry time, since the singer waited through it', () => {
		const l = ledger();
		l.step('m1', 'fetch', 'p1', [0, 0, 10]);
		const stems = l.step('m1', 'stems', 'p1', [10, 15, 0], 'running');
		l.jobs.requeue(stems.id, 1, at(40)); // the worker was lost
		l.jobs.assign(stems.id, 'mac', null, at(40), { device: 'mps', threads: 10, audioSec: 200 });
		l.jobs.accept(stems.id, null, at(45));
		l.jobs.complete(stems.id, at(105));
		l.step('m1', 'align', 'p1', [105, 110, 130]);
		const [s] = l.read().songs;
		expect(s!.totalMs).toBe(130 * S);
		expect(s!.stemsMs).toBe(60 * S); // the attempt that made it, not the abandoned one
		expect(e2e(l.sealed()).n).toBe(1);
	});

	it('says how many ready songs had no known length instead of dropping them silently', () => {
		const l = ledger();
		l.pick('m1', 'p1');
		l.pick('m2', 'p2', { audioSec: null });
		const r = l.read();
		expect([r.songs.length, r.noLength, r.badClock]).toEqual([1, 1, 0]);
	});

	it('drops a song whose clock jumped back rather than ranking it 0.00x', () => {
		const l = ledger();
		l.step('m1', 'stems', 'p1', [100, 100, 100]);
		l.step('m1', 'align', 'p1', [100, 100, 100]);
		const r = l.read();
		expect([r.songs.length, r.noLength, r.badClock]).toEqual([0, 0, 1]);
		expect(e2e(l.sealed()).n).toBe(0);
	});

	it('groups by worker, device and threads, fastest first, with the stems worker setting the pace', () => {
		const l = ledger();
		const pc = { worker: 'pc', device: 'cpu', threads: 16, audioSec: 100 };
		l.pick('a', 'pa', pc);
		l.pick('b', 'pb');
		l.pick('c', 'pc', pc);
		const { songs } = l.read();
		expect(perDevice(songs).map((r) => [r.workerId, r.n, r.p50Multiple])).toEqual([
			['mac', 1, 0.5],
			['pc', 2, 1]
		]);
		expect(speed(songs).p50AudioSec).toBe(100);
	});
});

let seq = 0;
function attempt(over: Partial<JobAttempt> = {}): JobAttempt {
	return {
		id: `a${++seq}`,
		jobId: 'j1',
		mediaId: 'm1',
		processingId: 'p1',
		jobType: 'stems',
		attempt: 1,
		workerId: 'mac',
		enqueuedAt: T0,
		assignedAt: T0,
		startedAt: T0,
		finishedAt: T0 + S,
		outcome: 'ready',
		error: null,
		engine: null,
		model: null,
		backend: null,
		device: 'mps',
		threads: 10,
		asrModel: null,
		syncMode: null,
		audioSec: 200,
		stages: null,
		selection: null,
		trail: null,
		lyricsNote: null,
		concurrency: null,
		demucsJobs: null,
		handSet: null,
		...over
	};
}

describe('what went wrong', () => {
	it.each([
		['yt-dlp exited 1: ERROR: HTTP Error 429: Too Many Requests', 'rate-limited'],
		['ERROR: [youtube] abc: Video unavailable', 'removed'],
		['took far longer than usual (900s) — stopped as hung', 'hung'],
		['worker died: progress-lease expired (attempts exhausted 3/3)', 'worker-lost'],
		['instrumental measures as digital silence (stems/x.flac) — refused', 'silent'],
		['demucs ran out of memory. This model needs more than this box has', 'out-of-memory'],
		['something new', 'other'],
		[null, 'other']
	])('%s → %s', (error, cause) => {
		expect(classifyError(error)).toBe(cause as ReturnType<typeof classifyError>);
	});

	it('counts songs, not attempts, and skips abandoned retries', () => {
		const rows = failures([
			attempt({ outcome: 'failed', error: 'HTTP Error 429', mediaId: 'x', finishedAt: T0 }),
			attempt({ outcome: 'failed', error: 'HTTP Error 429', mediaId: 'x', finishedAt: T0 + 5 * S }),
			attempt({ outcome: 'failed', error: 'HTTP Error 429', mediaId: 'y', finishedAt: T0 + 2 * S }),
			attempt({ outcome: 'abandoned', error: 'lease expired', mediaId: 'z' })
		]);
		expect(rows).toEqual([
			{ cause: 'rate-limited', songs: 2, attempts: 3, lastSeenAt: T0 + 5 * S, lastError: 'HTTP Error 429' }
		]);
	});
});

describe('CSV export', () => {
	it('quotes commas and quotes, and defuses a cell a spreadsheet would run as a formula', () => {
		const csv = attemptsCsv([attempt({ id: 'r1', error: '=HYPERLINK("x"), boom' })]);
		const [head, row] = csv.trimEnd().split('\r\n');
		expect(head!.startsWith('id,jobId,mediaId')).toBe(true);
		expect(row).toContain(`"'=HYPERLINK(""x""), boom"`);
		expect(row!.startsWith('r1,j1,m1,p1,stems,1,mac,')).toBe(true);
	});
});

describe('attempt prune', () => {
	it('deletes sealed attempts older than the cutoff and never an open one', () => {
		const db = migratedDb();
		const ledger = new AttemptLedger(db);
		const jobs = new JobRepository(db, ledger);
		const old = jobs.enqueue('m-old', 'stems', 0, T0);
		jobs.cancel(old.id, T0 + S);
		jobs.enqueue('m-open', 'stems', 0, T0);
		const recent = jobs.enqueue('m-new', 'stems', 0, T0 + 100 * S);
		jobs.cancel(recent.id, T0 + 101 * S);

		ledger.pruneFinishedBefore(T0 + 50 * S);
		expect(ledger.byMedia('m-old')).toEqual([]);
		expect(ledger.byMedia('m-open')).toHaveLength(1);
		expect(ledger.byMedia('m-new')).toHaveLength(1);
	});
});
