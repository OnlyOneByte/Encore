// Done-when: an explicit remove of a mid-processing song cancels its live cook — marking the job
// canceled (freeing the dedup slot so a re-add mints a NEW job), and telling the OWNING worker to
// kill its subprocess. Plus the four correctness edges: a shared cook (another entry still needs the
// media) is NOT cancelled; an already-terminal (ready) job is not touched; and the whole thing runs
// through the real queue-command remove path (handleQueueCommand) exactly as server.ts composes it.
import { test, expect } from 'bun:test';
import { cancelJobsForMedia } from './cancel';
import { JobRepository } from './repository';
import { openDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { handleQueueCommand, type HubDeps } from '../realtime/hub';
import { AuthoritativeState } from '../state/store';
import { WorkerHub } from './worker-hub';
import { WorkerRegistry } from './registry';
import type { WorkerCommand, QueueEntry, Media, ClientCommand } from '@encore/shared';

const T0 = 1_700_000_000_000;

function makeRepo() {
	const { db } = openDb(':memory:');
	runMigrations(db);
	return new JobRepository(db);
}

/** A capturing toWorker sink + the deps the helper needs, with an empty post-remove queue by default. */
function cancelDeps(jobs: JobRepository, remainingEntries: QueueEntry[] = []) {
	const sent: { workerId: string; cmd: WorkerCommand }[] = [];
	return {
		sent,
		deps: {
			jobs,
			toWorker: (workerId: string, cmd: WorkerCommand) => sent.push({ workerId, cmd }),
			remainingEntries,
			now: () => T0 + 1000
		}
	};
}

test('cancelling a sole QUEUED job marks it canceled and frees the dedup slot', () => {
	const jobs = makeRepo();
	const job = jobs.enqueue('m1', 'stems', 0, T0); // queued, no worker yet
	const { sent, deps } = cancelDeps(jobs);

	const res = cancelJobsForMedia('m1', deps);

	expect(res.canceled).toEqual([job.id]);
	expect(jobs.byId(job.id)!.status).toBe('canceled');
	expect(jobs.findLive('m1', 'stems')).toBeNull(); // slot freed
	expect(sent).toHaveLength(0); // no worker owned it — nothing to notify
});

test('a later re-add after a cancel creates a genuinely NEW job (song re-cookable)', () => {
	const jobs = makeRepo();
	const first = jobs.enqueue('m1', 'stems', 0, T0);
	const { deps } = cancelDeps(jobs);
	cancelJobsForMedia('m1', deps);

	const reborn = jobs.enqueue('m1', 'stems', 0, T0 + 5000);
	expect(reborn.id).not.toBe(first.id);
	expect(reborn.status).toBe('queued');
});

test('cancelling a RUNNING job also emits job:cancel to the OWNING worker', () => {
	const jobs = makeRepo();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'worker-A', T0 + 10_000, T0 + 1);
	jobs.accept(job.id, T0 + 30_000, T0 + 2); // running, owned by worker-A
	const { sent, deps } = cancelDeps(jobs);

	const res = cancelJobsForMedia('m1', deps);

	expect(res.canceled).toEqual([job.id]);
	expect(res.notifiedWorkers).toEqual(['worker-A']);
	expect(sent).toHaveLength(1);
	expect(sent[0].workerId).toBe('worker-A');
	expect(sent[0].cmd).toMatchObject({ type: 'job:cancel', jobId: job.id });
	expect(jobs.byId(job.id)!.status).toBe('canceled');
});

test('cancels across pipeline stages: fetch, stems, align, and a background upgrade', () => {
	const jobs = makeRepo();
	// One live job per stage for the same media (distinct jobType each → distinct dedup slots).
	const fetch = jobs.enqueue('m1', 'fetch', 0, T0);
	const stems = jobs.enqueue('m1', 'stems', 0, T0);
	const align = jobs.enqueue('m1', 'align', 0, T0);
	const upgrade = jobs.enqueue('m1', 'stems-upgrade', 0, T0);
	const { deps } = cancelDeps(jobs);

	const res = cancelJobsForMedia('m1', deps);

	expect(new Set(res.canceled)).toEqual(new Set([fetch.id, stems.id, align.id, upgrade.id]));
	for (const t of ['fetch', 'stems', 'align', 'stems-upgrade'] as const) {
		expect(jobs.findLive('m1', t)).toBeNull();
	}
});

test('EDGE (a) shared cook: does NOT cancel while another entry still references the media', () => {
	const jobs = makeRepo();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'worker-A', T0 + 10_000, T0 + 1);
	jobs.accept(job.id, T0 + 30_000, T0 + 2); // running
	// The post-remove queue STILL has an entry pointing at m1 (a second singer queued the same song).
	const survivor: QueueEntry = { id: 'q-other', mediaId: 'm1', singerId: 's2', status: 'queued', rotationSeq: 0, addedAt: T0 };
	const { sent, deps } = cancelDeps(jobs, [survivor]);

	const res = cancelJobsForMedia('m1', deps);

	expect(res.canceled).toEqual([]); // the shared cook lives on
	expect(res.notifiedWorkers).toEqual([]);
	expect(sent).toHaveLength(0);
	expect(jobs.byId(job.id)!.status).toBe('running'); // untouched — another singer is waiting on it
});

test('EDGE (b) already-terminal: a job that finished (ready) is not cancelled', () => {
	const jobs = makeRepo();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'worker-A', T0 + 10_000, T0 + 1);
	jobs.accept(job.id, T0 + 30_000, T0 + 2);
	jobs.complete(job.id, T0 + 3); // terminal `ready` — still occupies the dedup slot
	expect(jobs.findLive('m1', 'stems')!.status).toBe('ready'); // findLive returns it
	const { sent, deps } = cancelDeps(jobs);

	// Must NOT throw (cancel on a terminal job is an illegal transition) and must not touch it.
	const res = cancelJobsForMedia('m1', deps);

	expect(res.canceled).toEqual([]);
	expect(sent).toHaveLength(0);
	expect(jobs.byId(job.id)!.status).toBe('ready'); // left ready
});

test('no live cook for the media: a plain (never-cooked) remove is a harmless no-op', () => {
	const jobs = makeRepo();
	const { deps } = cancelDeps(jobs);
	const res = cancelJobsForMedia('m-never-cooked', deps);
	expect(res).toEqual({ canceled: [], notifiedWorkers: [] });
});

// ── through the real remove path (handleQueueCommand), the way server.ts composes it ──────────────

const media = (id: string): Media => ({ id, source: 'youtube', sourceRef: 'x', title: id, durationSec: 100, stemStatus: 'queued' });
const addCmd = (id: string, mediaId: string, singerId: string): ClientCommand => ({
	clientOpId: 'add-' + id,
	baseRev: 0,
	op: { op: 'add', entry: { id, mediaId, singerId, status: 'queued', rotationSeq: -1, addedAt: Date.now() } as QueueEntry }
});
const removeCmd = (id: string, singerId: string): ClientCommand => ({ clientOpId: 'rm-' + id, baseRev: 0, op: { op: 'remove', id }, });

function hubHarness(jobs: JobRepository, actorSingerId: string) {
	const state = new AuthoritativeState();
	const sent: { workerId: string; cmd: WorkerCommand }[] = [];
	const deps: HubDeps = {
		state,
		publish: () => {},
		mediaById: new Map([['m1', media('m1')]]),
		actorSingerId,
		// Exactly the wiring server.ts uses.
		onEntryRemoved: (mediaId, remainingEntries) =>
			cancelJobsForMedia(mediaId, { jobs, toWorker: (w, c) => sent.push({ workerId: w, cmd: c }), remainingEntries, now: () => T0 + 1000 })
	};
	return { state, deps, sent };
}

test('remove op through handleQueueCommand cancels the sole live cook', () => {
	const jobs = makeRepo();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'worker-A', T0 + 10_000, T0 + 1);
	jobs.accept(job.id, T0 + 30_000, T0 + 2);
	const { deps, sent } = hubHarness(jobs, 's1');
	handleQueueCommand(addCmd('q1', 'm1', 's1'), deps);

	handleQueueCommand(removeCmd('q1', 's1'), deps);

	expect(jobs.byId(job.id)!.status).toBe('canceled');
	expect(sent).toHaveLength(1);
	expect(sent[0].cmd).toMatchObject({ type: 'job:cancel', jobId: job.id });
});

test('remove of ONE of two entries for the same song does NOT cancel the shared cook', () => {
	const jobs = makeRepo();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	const { deps, sent } = hubHarness(jobs, 's1');
	// Two singers queue the same song; one job (dedup). Both entries authored by the same session for
	// the test's actor gate, but they are two distinct queue entries pointing at m1.
	handleQueueCommand(addCmd('q1', 'm1', 's1'), deps);
	handleQueueCommand(addCmd('q2', 'm1', 's1'), deps);

	handleQueueCommand(removeCmd('q1', 's1'), deps); // q2 still needs m1

	expect(jobs.byId(job.id)!.status).toBe('queued'); // cook untouched
	expect(sent).toHaveLength(0);
});

test('EDGE (b) reverse: a job:complete landing AFTER a cancel is dropped as stale', () => {
	// worker-hub's #onComplete already guards `status !== 'running'`; a canceled job is terminal, so a
	// late completion from the worker (kill and completion crossing on the wire) must not resurrect it.
	const jobs = makeRepo();
	const registry = new WorkerRegistry();
	const mediaById = new Map<string, Media>([['m1', media('m1')]]);
	const hub = new WorkerHub({ jobs, registry, mediaById, toWorker: () => {}, broadcast: () => {}, now: () => T0 + 2000 });
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'worker-A', T0 + 10_000, T0 + 1);
	jobs.accept(job.id, T0 + 30_000, T0 + 2); // running, worker-A owns it

	// The remove cancels it first.
	cancelJobsForMedia('m1', cancelDeps(jobs).deps);
	expect(jobs.byId(job.id)!.status).toBe('canceled');

	// Then the worker's completion arrives late. It is a no-op — the media never flips to ready.
	hub.handle({ type: 'job:complete', workerId: 'worker-A', jobId: job.id, mediaUri: 'media/m1-instrumental.mp3' });

	expect(jobs.byId(job.id)!.status).toBe('canceled'); // still canceled, not resurrected to ready
	expect(mediaById.get('m1')!.stemStatus).toBe('queued'); // never flipped to ready
});

