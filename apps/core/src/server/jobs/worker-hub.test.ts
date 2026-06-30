// M7-C3 done-when: a fake worker socket drives a job to `ready`. Also covers welcome handshake,
// dispatch-on-hello, progress→media:status rebroadcast, reject/requeue, retryable vs terminal
// failure, and need-ordered dispatch across workers. No real socket — sinks capture the effects.
import { test, expect } from 'bun:test';
import { WorkerHub } from './worker-hub';
import { WorkerRegistry } from './registry';
import { JobRepository } from './repository';
import { openDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import type { WorkerCommand, ServerEvent, Media } from '@encore/shared';

const T0 = 1_700_000_000_000;

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id, source: 'youtube', sourceRef: 'vid-' + id, title: id, durationSec: 200, stemStatus: 'none', playMode: 'iframe', ...over
});

function harness() {
	const { db } = openDb(':memory:');
	runMigrations(db, './drizzle');
	const jobs = new JobRepository(db);
	const registry = new WorkerRegistry();
	const mediaById = new Map<string, Media>([['m1', media('m1')], ['m2', media('m2')]]);
	const sent: { workerId: string; cmd: WorkerCommand }[] = [];
	const broadcasts: ServerEvent[] = [];
	let clock = T0;
	const readied: string[] = [];
	const hub = new WorkerHub({
		jobs,
		registry,
		mediaById,
		toWorker: (workerId, cmd) => sent.push({ workerId, cmd }),
		broadcast: (e) => broadcasts.push(e),
		onMediaReady: (mediaId) => readied.push(mediaId),
		now: () => clock
	});
	return { hub, jobs, registry, mediaById, sent, broadcasts, readied, setClock: (t: number) => (clock = t) };
}

const cmdsOfType = (sent: { cmd: WorkerCommand }[], type: WorkerCommand['type']) =>
	sent.filter((s) => s.cmd.type === type).map((s) => s.cmd);

test('hello → welcome handshake + dispatch of a waiting job', () => {
	const { hub, jobs, sent } = harness();
	jobs.enqueue('m1', 'stems', 0, T0); // a job is already waiting

	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });

	const welcome = cmdsOfType(sent, 'worker:welcome')[0];
	expect(welcome).toMatchObject({ type: 'worker:welcome', ackTimeoutSec: 10, heartbeatIntervalSec: 30 });
	const assign = cmdsOfType(sent, 'job:assign')[0] as Extract<WorkerCommand, { type: 'job:assign' }>;
	expect(assign).toBeTruthy();
	expect(assign.mediaId).toBe('m1');
	expect(assign.jobType).toBe('stems');
	expect(assign.sourceUri).toContain('youtube.com/watch?v=vid-m1');
	expect(assign.params.model).toBe('htdemucs');
});

test('FULL LIFECYCLE: hello → assign → accept → progress → complete drives the job to ready', () => {
	const { hub, jobs, registry, mediaById, broadcasts, setClock } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	expect(jobs.byId(job.id)!.status).toBe('assigned');
	expect(registry.get('w1')!.slotsFree).toBe(0); // slot claimed on dispatch

	setClock(T0 + 1000);
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	expect(jobs.byId(job.id)!.status).toBe('running');
	expect(jobs.byId(job.id)!.leaseExpiresAt).toBe(T0 + 1000 + 30_000); // fresh progress lease

	setClock(T0 + 2000);
	hub.handle({ type: 'job:progress', workerId: 'w1', jobId: job.id, stage: 'separating', pct: 68, etaSec: 12 });
	const sep = broadcasts.at(-1) as Extract<ServerEvent, { type: 'media:status' }>;
	expect(sep).toMatchObject({ type: 'media:status', mediaId: 'm1', status: 'separating', pct: 68, etaSec: 12 });

	setClock(T0 + 3000);
	hub.handle({ type: 'job:complete', workerId: 'w1', jobId: job.id, mediaUri: 'media/m1-instrumental.mp3' });
	const done = jobs.byId(job.id)!;
	expect(done.status).toBe('ready'); // ← drove to ready
	expect(done.progressPct).toBe(100);
	// M7-C6: media flips to the playable instrumental (playMode→file, sourceRef→stems key)
	const m = mediaById.get('m1')!;
	expect(m.stemStatus).toBe('ready');
	expect(m.playMode).toBe('file');
	expect(m.sourceRef).toBe('stems/m1-instrumental.wav');
	const ready = broadcasts.at(-1) as Extract<ServerEvent, { type: 'media:status' }>;
	expect(ready).toMatchObject({ type: 'media:status', mediaId: 'm1', status: 'ready' });
	expect(registry.get('w1')!.slotsFree).toBe(1); // slot released on complete → free for new work
});

test('M7-C6: complete fires onMediaReady so the core reconciles playback', () => {
	const { hub, jobs, mediaById, readied } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	expect(readied).toEqual([]); // not until complete
	hub.handle({ type: 'job:complete', workerId: 'w1', jobId: job.id, mediaUri: 'x' });
	expect(readied).toEqual(['m1']); // fired exactly once, after the media flip
	expect(mediaById.get('m1')!.stemStatus).toBe('ready');
});

test('idempotency: accept/progress/complete from the WRONG worker or wrong state are ignored', () => {
	const { hub, jobs } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });

	// a different worker can't accept someone else's job
	hub.handle({ type: 'job:accept', workerId: 'w-evil', jobId: job.id });
	expect(jobs.byId(job.id)!.status).toBe('assigned');
	// progress before accept (still assigned, not running) is ignored
	hub.handle({ type: 'job:progress', workerId: 'w1', jobId: job.id, stage: 'separating', pct: 10 });
	expect(jobs.byId(job.id)!.progressPct).toBe(0);
});

test('job:reject → back to queued (no attempt burned), slot freed, redispatched', () => {
	const { hub, jobs, registry, sent } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	expect(registry.get('w1')!.slotsFree).toBe(0); // claimed on dispatch

	hub.handle({ type: 'job:reject', workerId: 'w1', jobId: job.id, reason: 'busy' });
	const after = jobs.byId(job.id)!;
	expect(after.attempts).toBe(0); // never ran
	// slot was released then immediately re-claimed by the redispatch to the same worker
	expect(after.status).toBe('assigned');
	expect(cmdsOfType(sent, 'job:assign')).toHaveLength(2); // initial + redispatch
});

test('job:failed retryable with attempts left → requeue + redispatch; exhausted → failed', () => {
	const { hub, jobs, setClock } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });

	// 3 attempts (maxAttempts default 3): the first two retry (requeue → immediately redispatched to
	// the now-free worker, so status returns to 'assigned'); the third exhausts → terminal failed.
	for (let i = 1; i <= 3; i++) {
		setClock(T0 + i * 1000);
		hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
		hub.handle({ type: 'job:failed', workerId: 'w1', jobId: job.id, error: 'demucs blew up', retryable: true });
		const j = jobs.byId(job.id)!;
		expect(j.attempts).toBe(i);
		if (i < 3) {
			expect(j.status).toBe('assigned'); // requeued then redispatched (transient failure, keep trying)
		} else {
			expect(j.status).toBe('failed'); // attempts exhausted → terminal
			expect(j.error).toBe('demucs blew up');
		}
	}
});

test('non-retryable failure fails immediately even with attempts left', () => {
	const { hub, jobs } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	hub.handle({ type: 'job:failed', workerId: 'w1', jobId: job.id, error: 'source gone (404)', retryable: false });
	const j = jobs.byId(job.id)!;
	expect(j.status).toBe('failed');
	expect(j.attempts).toBe(1);
});

test('dispatch is need-ordered: the sooner-needed job (lower priority) is assigned to the one slot', () => {
	const { hub, jobs, sent } = harness();
	jobs.enqueue('m2', 'stems', 9, T0); // far away in rotation
	jobs.enqueue('m1', 'stems', 1, T0); // up next
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	const assigns = cmdsOfType(sent, 'job:assign') as Extract<WorkerCommand, { type: 'job:assign' }>[];
	expect(assigns).toHaveLength(1);
	expect(assigns[0].mediaId).toBe('m1'); // the up-next song wins the slot
});

test('a job with no capable worker stays queued (unservable by the current fleet)', () => {
	const { hub, jobs, sent } = harness();
	const job = jobs.enqueue('m1', 'align', 0, T0); // needs align
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' }); // only stems
	expect(jobs.byId(job.id)!.status).toBe('queued');
	expect(cmdsOfType(sent, 'job:assign')).toHaveLength(0);
});
