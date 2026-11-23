// The host speed page: pick to ready as a multiple of song length, per machine, and what went wrong.
import { describe, expect, it } from 'bun:test';
import type { JobAttempt, JobType } from '$lib/contract';
import { attemptsCsv, classifyError, failures, perDevice, readySongs, speed } from '$lib/server/jobs/metrics';
import { AttemptLedger } from '$lib/server/jobs/attempts';
import { JobRepository } from '$lib/server/jobs/repository';
import { migratedDb } from '$lib/server/db/test-db';

const T0 = 1_700_000_000_000;
const S = 1_000;

let seq = 0;
function attempt(over: Partial<JobAttempt> = {}): JobAttempt {
	return {
		id: `a${++seq}`,
		jobId: 'j1',
		mediaId: 'm1',
		processingId: 'p1',
		jobType: 'stems' as JobType,
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
		...over
	};
}

/** fetch 0–10 s, stems 15–75 s, align 80–100 s on a 200 s song: 100 s in all, so 0.5x. */
function song(p: string, over: Partial<JobAttempt> = {}): JobAttempt[] {
	const base = { processingId: p, mediaId: `m-${p}`, ...over };
	return [
		attempt({ ...base, jobId: `${p}-f`, jobType: 'fetch', enqueuedAt: T0, startedAt: T0, finishedAt: T0 + 10 * S }),
		attempt({
			...base,
			jobId: `${p}-s`,
			jobType: 'stems',
			enqueuedAt: T0 + 10 * S,
			startedAt: T0 + 15 * S,
			finishedAt: T0 + 75 * S
		}),
		attempt({
			...base,
			jobId: `${p}-a`,
			jobType: 'align',
			enqueuedAt: T0 + 75 * S,
			startedAt: T0 + 80 * S,
			finishedAt: T0 + 100 * S
		})
	];
}

describe('pick to ready counts only songs that reached ready', () => {
	it('reads a whole song as a multiple of its length, split by step', () => {
		const [s] = readySongs(song('p1'));
		expect(s!.multiple).toBeCloseTo(0.5);
		expect([s!.fetchMs, s!.stemsMs, s!.alignMs, s!.waitMs]).toEqual([10 * S, 60 * S, 20 * S, 10 * S]);
	});

	it('leaves out a song whose stems failed, including a refused silent instrumental', () => {
		const failed = song('p2').map((a) =>
			a.jobType === 'stems'
				? { ...a, outcome: 'failed' as const, error: 'instrumental measures as digital silence (x)' }
				: a
		);
		expect(readySongs([...song('p1'), ...failed]).map((s) => s.processingId)).toEqual(['p1']);
	});

	it('counts a retried song with its retry time, since the singer waited through it', () => {
		const [f, st, al] = song('p3');
		const lost = { ...st!, outcome: 'abandoned' as const, finishedAt: T0 + 40 * S };
		const retry = {
			...st!,
			id: 'retry',
			attempt: 2,
			enqueuedAt: T0 + 40 * S,
			startedAt: T0 + 45 * S,
			finishedAt: T0 + 105 * S
		};
		const late = { ...al!, enqueuedAt: T0 + 105 * S, startedAt: T0 + 110 * S, finishedAt: T0 + 130 * S };
		const [s] = readySongs([f!, lost, retry, late]);
		expect(s!.totalMs).toBe(130 * S);
		expect(s!.stemsMs).toBe(60 * S); // the attempt that made it, not the abandoned one
	});

	it('skips a song still in flight, one older than the window, and a later stems-upgrade', () => {
		const open = song('p4').map((a) => (a.jobType === 'align' ? { ...a, finishedAt: null, outcome: null } : a));
		const upgrade = attempt({ processingId: 'p1', jobId: 'up', jobType: 'stems-upgrade', finishedAt: T0 + 900 * S });
		expect(readySongs([...song('p1'), upgrade, ...open]).map((s) => s.totalMs)).toEqual([100 * S]);
		expect(readySongs(song('p1'), T0 + 1)).toEqual([]);
	});

	it('groups by worker, device and threads, fastest first', () => {
		const pc = (p: string) => song(p, { workerId: 'pc', device: 'cpu', threads: 16, audioSec: 100 });
		const rows = perDevice(readySongs([...pc('a'), ...song('b'), ...pc('c')]));
		expect(rows.map((r) => [r.workerId, r.n, r.p50Multiple])).toEqual([
			['mac', 1, 0.5],
			['pc', 2, 1]
		]);
		expect(speed(readySongs(song('b'))).p50AudioSec).toBe(200);
	});
});

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
