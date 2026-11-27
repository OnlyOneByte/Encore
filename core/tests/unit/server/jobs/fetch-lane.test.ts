// #1176: a worker that sends `lanes` has a fetch slot of its own, so a download never waits behind a
// separation. A worker that sends none keeps the single count, exactly as before.
import { expect, test } from 'bun:test';
import type { Job, JobType, Media, WorkerCommand } from '$lib/contract';
import { migratedDb } from '$lib/server/db/test-db';
import { AttemptLedger } from '$lib/server/jobs/attempts';
import { planAssignments } from '$lib/server/jobs/dispatch';
import { WorkerRegistry, workerLanes, type WorkerSession } from '$lib/server/jobs/registry';
import { JobRepository } from '$lib/server/jobs/repository';
import { WorkerHub } from '$lib/server/jobs/worker-hub';

const T0 = 1_700_000_000_000;
const ALL: JobType[] = ['fetch', 'stems', 'align'];

function job(id: string, jobType: JobType, createdAt = T0): Job {
	return {
		id,
		mediaId: 'm-' + id,
		processingId: 'p-' + id,
		singerId: null,
		jobType,
		status: 'queued',
		priority: 0,
		attempts: 0,
		maxAttempts: 3,
		workerId: null,
		stage: null,
		progressPct: 0,
		etaSec: null,
		error: null,
		leaseExpiresAt: null,
		createdAt,
		updatedAt: createdAt
	};
}

function registered(lanes?: { fetch: number; compute: number }): WorkerRegistry {
	const r = new WorkerRegistry();
	r.hello('w1', ALL, 2, '1', T0, undefined, undefined, [], lanes);
	return r;
}

const ids = (plan: { jobId: string }[]) => plan.map((a) => a.jobId);

test('a laned worker with its compute lane full still takes a fetch', () => {
	const r = registered({ fetch: 1, compute: 2 });
	r.claimSlot('w1', 'compute');
	r.claimSlot('w1', 'compute');
	const queued = [job('align-1', 'align'), job('fetch-2', 'fetch', T0 + 1)];
	expect(ids(planAssignments(queued, r.list()))).toEqual(['fetch-2']);
});

test('a lane-less worker with its slots full takes nothing, as before', () => {
	const r = registered();
	r.claimSlot('w1');
	r.claimSlot('w1');
	const queued = [job('align-1', 'align'), job('fetch-2', 'fetch', T0 + 1)];
	expect(planAssignments(queued, r.list())).toEqual([]);
});

test('one pass fills each lane to its own size and no further', () => {
	const r = registered({ fetch: 1, compute: 2 });
	const queued = [
		job('f1', 'fetch'),
		job('f2', 'fetch', T0 + 1),
		job('s1', 'stems', T0 + 2),
		job('s2', 'stems', T0 + 3),
		job('s3', 'stems', T0 + 4)
	];
	expect(ids(planAssignments(queued, r.list()))).toEqual(['f1', 's1', 's2']);
});

test('a lane-less worker draws every job type on one count, in priority order', () => {
	const r = registered();
	const queued = [job('f1', 'fetch'), job('f2', 'fetch', T0 + 1), job('s1', 'stems', T0 + 2)];
	expect(ids(planAssignments(queued, r.list()))).toEqual(['f1', 'f2']);
});

test('a fetch goes to the worker with the freest fetch lane, not the freest overall', () => {
	const r = new WorkerRegistry();
	r.hello('big', ALL, 4, '1', T0, undefined, undefined, [], { fetch: 1, compute: 4 });
	r.hello('small', ALL, 1, '1', T0, undefined, undefined, [], { fetch: 1, compute: 1 });
	r.claimSlot('big', 'fetch');
	expect(planAssignments([job('f1', 'fetch')], r.list())).toEqual([{ jobId: 'f1', workerId: 'small' }]);
});

test('claim and release move only their own lane, each clamped to its size', () => {
	const r = registered({ fetch: 1, compute: 2 });
	r.claimSlot('w1', 'fetch');
	r.claimSlot('w1', 'fetch');
	expect(r.get('w1')!.lanesFree).toEqual({ fetch: 0, compute: 2 });
	expect(r.get('w1')!.slotsFree).toBe(2);
	r.releaseSlot('w1', 'fetch');
	r.releaseSlot('w1', 'fetch');
	r.releaseSlot('w1', 'compute');
	expect(r.get('w1')!.lanesFree).toEqual({ fetch: 1, compute: 2 });
	expect(r.get('w1')!.slotsFree).toBe(3);
});

test("a heartbeat's lanesFree sets each lane; one without it keeps core's lane view", () => {
	const r = registered({ fetch: 1, compute: 2 });
	r.heartbeat('w1', 1, T0 + 1, { fetch: 0, compute: 9 });
	expect(r.get('w1')!.lanesFree).toEqual({ fetch: 0, compute: 2 });
	expect(r.get('w1')!.slotsFree).toBe(2);
	r.heartbeat('w1', 0, T0 + 2);
	expect(r.get('w1')!.lanesFree).toEqual({ fetch: 0, compute: 2 });
});

test('a hold empties both lanes until the next heartbeat', () => {
	const r = registered({ fetch: 1, compute: 2 });
	r.heartbeat('w1', 3, T0 + 1, { fetch: 1, compute: 2 });
	r.hold('w1');
	expect(r.get('w1')!.lanesFree).toEqual({ fetch: 0, compute: 0 });
	expect(planAssignments([job('f1', 'fetch')], r.list())).toEqual([]);
});

test('a lane-less session carries no lane fields', () => {
	const s: WorkerSession = registered().get('w1')!;
	expect(s.lanes).toBeUndefined();
	expect(s.lanesFree).toBeUndefined();
	expect(s.slotsFree).toBe(2);
});

test('workerLanes keeps only a well-shaped pair of whole counts', () => {
	expect(workerLanes({ fetch: 1, compute: 2 }, 1)).toEqual({ fetch: 1, compute: 2 });
	expect(workerLanes({ fetch: 0, compute: 2 }, 1)).toBeUndefined();
	expect(workerLanes({ fetch: 0, compute: 0 })).toEqual({ fetch: 0, compute: 0 });
	for (const bad of [undefined, null, 3, [1, 2], { fetch: 1 }, { fetch: 1.5, compute: 2 }, { fetch: -1, compute: 2 }])
		expect(workerLanes(bad)).toBeUndefined();
	expect(workerLanes({ fetch: 1, compute: 65 })).toBeUndefined();
});

// ── through the hub: hello, assign, the release hook and heartbeats ──────────────────────────────

const CAPS = ['fetch:ytdlp', 'stems', 'align'];

function hub() {
	const db = migratedDb();
	const attempts = new AttemptLedger(db);
	const jobs = new JobRepository(db, attempts);
	const registry = new WorkerRegistry();
	const song = (id: string): Media => ({
		id,
		source: 'youtube',
		sourceRef: 'v-' + id,
		title: id,
		durationSec: 200,
		stemStatus: 'none'
	});
	const mediaById = new Map<string, Media>(['m1', 'm2', 'm3'].map((id) => [id, song(id)]));
	const sent: { workerId: string; cmd: WorkerCommand }[] = [];
	const h = new WorkerHub({
		jobs,
		attempts,
		registry,
		mediaById,
		toWorker: (workerId, cmd) => sent.push({ workerId, cmd }),
		broadcast: () => {},
		onMediaReady: () => {},
		now: () => T0,
		queueEntries: () => []
	});
	const assigned = () => sent.filter((s) => s.cmd.type === 'job:assign').map((s) => (s.cmd as { jobId: string }).jobId);
	return { hub: h, jobs, registry, assigned };
}

test("a laned worker busy separating is sent the next song's fetch at once", () => {
	const { hub: h, jobs, registry, assigned } = hub();
	const s1 = jobs.enqueue('m1', 'stems', 0, T0);
	const s2 = jobs.enqueue('m2', 'stems', 1, T0);
	h.handle({
		type: 'worker:hello',
		workerId: 'w1',
		capabilities: CAPS,
		concurrency: 2,
		version: '1',
		lanes: { fetch: 1, compute: 2 }
	});
	expect(assigned()).toEqual([s1.id, s2.id]);
	const f3 = jobs.enqueue('m3', 'fetch', 2, T0);
	h.dispatch();
	expect(assigned()).toEqual([s1.id, s2.id, f3.id]);
	expect(registry.get('w1')!.lanesFree).toEqual({ fetch: 0, compute: 0 });
	// The fetch's REJECT gives back the FETCH slot (the release hook carries the job type), and the redispatch
	// takes it again: nothing leaks into the compute lane.
	h.handle({ type: 'job:reject', workerId: 'w1', jobId: f3.id, reason: 'busy' });
	expect([jobs.byId(f3.id)!.status, registry.get('w1')!.lanesFree]).toEqual(['assigned', { fetch: 0, compute: 0 }]);
	// The worker's own per-lane count wins on the next heartbeat.
	h.handle({
		type: 'worker:heartbeat',
		workerId: 'w1',
		slotsFree: 0,
		runningJobIds: [],
		lanesFree: { fetch: 1, compute: 2 }
	});
	expect(registry.get('w1')!.lanesFree).toEqual({ fetch: 1, compute: 2 });
});

test('a worker that sends no lanes waits for a free slot before its fetch, as before', () => {
	const { hub: h, jobs, registry, assigned } = hub();
	const s1 = jobs.enqueue('m1', 'stems', 0, T0);
	const s2 = jobs.enqueue('m2', 'stems', 1, T0);
	h.handle({ type: 'worker:hello', workerId: 'w1', capabilities: CAPS, concurrency: 2, version: '1' });
	const f3 = jobs.enqueue('m3', 'fetch', 2, T0);
	h.dispatch();
	expect(assigned()).toEqual([s1.id, s2.id]);
	expect(registry.get('w1')!.lanes).toBeUndefined();
	h.handle({ type: 'job:accept', workerId: 'w1', jobId: s1.id });
	h.handle({ type: 'job:failed', workerId: 'w1', jobId: s1.id, error: 'boom', retryable: false });
	expect(assigned()).toEqual([s1.id, s2.id]);
	h.dispatch();
	expect(assigned()).toEqual([s1.id, s2.id, f3.id]);
});

test('malformed lanes on hello leave the worker on the single count', () => {
	const { hub: h, registry } = hub();
	h.handle({
		type: 'worker:hello',
		workerId: 'w1',
		capabilities: CAPS,
		concurrency: 2,
		version: '1',
		lanes: { fetch: 0, compute: 2 }
	});
	expect(registry.get('w1')!.lanes).toBeUndefined();
	expect(registry.get('w1')!.slotsFree).toBe(2);
});
