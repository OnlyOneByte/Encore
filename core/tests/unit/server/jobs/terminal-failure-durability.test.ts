// A permanently failed process stays failed across a RESTART, and an unservable job dies on a CLOCK. Two
// defects of one shape: the in-memory fix works and the durable or periodic half is never wired.
//
// 1. `settleStemsGate` puts a dead process's song back to `stemStatus: 'none'`, but that is a STORED column
//    and the queued flip IS persisted, so without a persistence sink on the terminal-failure epilogue
//    `hydrateMediaCatalog` wins at boot and a restart resurrects the stranding the settle exists to prevent.
// 2. Both the unservable stamp and its expiry check live inside `dispatch()`, which is event-driven, and the
//    reaper only called its dispatch hook on a tick that CHANGED a job — but an unservable job is never
//    assigned or running, so the sweep has no actions, `dispatch()` is never called again, and the TTL is
//    never reached. `worker-hub.test.ts` cannot catch that: it calls `hub.dispatch()` itself, supplying a
//    second pass production may never make. These arms drive the TTL through the REAPER instead.

import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { JobReaper } from '$lib/server/jobs/reaper';
import { WorkerHub } from '$lib/server/jobs/worker-hub';
import { WorkerRegistry } from '$lib/server/jobs/registry';
import { JobRepository } from '$lib/server/jobs/repository';
import { AttemptLedger } from '$lib/server/jobs/attempts';
import { reportTerminalFailure, settleStemsGate } from '$lib/server/jobs/process';
import type { Media, ServerEvent } from '$lib/contract';

const T0 = 1_700_000_000_000;

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 200,
	stemStatus: 'none',
	...over
});

function harness() {
	const db = migratedDb();
	const attempts = new AttemptLedger(db);
	const jobs = new JobRepository(db, attempts);
	const mediaById = new Map<string, Media>([['m1', media('m1', { stemStatus: 'queued' })]]);
	const broadcasts: ServerEvent[] = [];
	const persisted: string[] = [];
	let clock = T0;
	const hub = new WorkerHub({
		queueEntries: () => [],
		jobs,
		attempts,
		registry: new WorkerRegistry(),
		mediaById,
		toWorker: () => {},
		broadcast: (e) => broadcasts.push(e),
		persistMedia: (mediaId) => persisted.push(mediaId),
		now: () => clock
	});
	return { hub, jobs, mediaById, broadcasts, persisted, setClock: (t: number) => (clock = t) };
}

// ── 1. the durable half of the terminal-failure epilogue ──────────────────────────────────────────

test('a terminal stems failure persists the settled gate, not only the in-memory one', () => {
	const { jobs, mediaById } = harness();
	const persisted: string[] = [];
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	const failed = jobs.fail(job.id, 'boom', T0 + 1_000);

	const settled = reportTerminalFailure(failed, 'worker', {
		broadcast: () => {},
		mediaById,
		persist: (mediaId) => persisted.push(mediaId)
	});

	expect(settled).toBe(true);
	expect(mediaById.get('m1')!.stemStatus).toBe('none');
	// The durable half: without it the next boot re-reads 'queued' from the row and strands the song.
	expect(
		persisted,
		'the settled gate was never handed to a persistence sink, so a restart resurrects the dead process'
	).toEqual(['m1']);
});

test('a failure that settles NO gate does not write', () => {
	// A stems-upgrade keeps the working instrumental, so there is nothing to settle and nothing to persist:
	// a sink called unconditionally writes a row per failure for no reason.
	const { jobs, mediaById } = harness();
	mediaById.set('m1', media('m1', { stemStatus: 'ready' }));
	const persisted: string[] = [];
	const job = jobs.enqueue('m1', 'stems-upgrade', 0, T0);
	const failed = jobs.fail(job.id, 'boom', T0 + 1_000);

	const settled = reportTerminalFailure(failed, 'worker', {
		broadcast: () => {},
		mediaById,
		persist: (mediaId) => persisted.push(mediaId)
	});
	expect(settled).toBe(false);
	expect(persisted).toEqual([]);
});

test('the epilogue still works with no sink wired, so the hub unit-tests bare', () => {
	// `persist` is optional because `WorkerHubDeps.persistMedia` is, so the hub can be built without a DB.
	const { jobs, mediaById } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	const failed = jobs.fail(job.id, 'boom', T0 + 1_000);
	expect(() => reportTerminalFailure(failed, 'reaper', { broadcast: () => {}, mediaById })).not.toThrow();
	expect(mediaById.get('m1')!.stemStatus).toBe('none');
});

test('settleStemsGate alone does not persist — the epilogue owns that', () => {
	// The division of labour: settling must not grow its own write, or the epilogue double-writes and the
	// two sites disagree about when a row is flushed.
	const mediaById = new Map<string, Media>([['m1', media('m1', { stemStatus: 'queued' })]]);
	expect(settleStemsGate('m1', mediaById)).toBe(true);
	expect(mediaById.get('m1')!.stemStatus).toBe('none');
});

test('the hub wires its own persistMedia into the terminal-failure epilogue', () => {
	// End to end through the HUB, not the exported function: this is the arm that fails if the standalone
	// function is fixed and the two call sites in worker-hub are missed.
	const { hub, jobs, persisted, mediaById } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	expect(jobs.byId(job.id)!.status).toBe('assigned');

	// The worker must ACCEPT before it can fail: #onFailed refuses anything not `running`, which is what
	// keeps a stale session from failing a job it no longer owns.
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	expect(jobs.byId(job.id)!.status).toBe('running');
	hub.handle({ type: 'job:failed', jobId: job.id, workerId: 'w1', error: 'boom', retryable: false });
	expect(jobs.byId(job.id)!.status).toBe('failed');
	expect(mediaById.get('m1')!.stemStatus).toBe('none');
	expect(persisted, 'the hub settled the gate in memory but never persisted it').toContain('m1');
});

test('the REAPER path persists too — the fourth terminal path, wired as app.ts wires it', () => {
	/* THE PATH THAT WAS MISSING A SINK. The reaper fails a job whose progress lease expired for the last
	   time; `JobReaper.onFailed` hands it to the same epilogue. app.ts assembled that bag INLINE as
	   `{ broadcast, mediaById }` with no `persist`, so a reaper-killed process settled its stem gate in
	   memory while the stored row still said 'queued' — and `hydrateMediaCatalog` wins at the next boot,
	   resurrecting exactly the stranding the settle exists to prevent (repaired only one boot later still,
	   incidentally, by `reconcileStrandedGates`).
	   DRIVEN THROUGH `hub.terminalFailureSinks()`, which is the bag app.ts now passes, so this arm reds if
	   that bag loses `persist` — the same way the arm above reds for the hub's own paths. What it cannot
	   see is app.ts going back to building its own bag; that is the reason the method exists at all, so
	   there is one bag rather than two sites that must remember the same thing. */
	const { hub, jobs, mediaById, persisted } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'w1', T0 + 10_000, T0);
	jobs.accept(job.id, T0 + 40_000, T0 + 1);
	// One attempt short of the cap (maxAttempts is 3), so the next lease expiry is terminal rather than a requeue.
	jobs.progress(job.id, { attempts: 2, leaseExpiresAt: T0 + 40_000 }, T0 + 2);

	const clock = T0 + 60_000; // past the progress lease
	const reaper = new JobReaper(jobs, {
		now: () => clock,
		tickMs: 1_000_000,
		onFailed: (dead) => reportTerminalFailure(dead, 'reaper', hub.terminalFailureSinks())
	});
	expect(reaper.tick()).toBe(1);

	expect(jobs.byId(job.id)!.status).toBe('failed');
	expect(mediaById.get('m1')!.stemStatus).toBe('none'); // settled in memory — this half always worked
	expect(
		persisted,
		'the reaper settled the gate in memory and never persisted it, so the next boot reads "queued" back'
	).toContain('m1');
});

// ── 2. the unservable TTL, driven by the clock rather than by the test ─────────────────────────────

test('an unservable job reaches terminal failed on the reaper clock, with nobody calling dispatch', () => {
	const { hub, jobs, setClock } = harness();
	const job = jobs.enqueue('m1', 'align', 0, T0);
	// A worker that can never serve it, so the job is first seen unservable here — and from now on nothing
	// is assigned or running, so the reaper's sweep has no actions to take on any tick.
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	expect(jobs.byId(job.id)!.status).toBe('queued');

	// The reaper is the only CLOCK in the system, wired as app.ts does. This test never calls
	// hub.dispatch() again, because production would not.
	const reaper = new JobReaper(jobs, {
		now: () => jobsNow,
		tickMs: 1_000_000,
		onTick: () => hub.dispatch()
	});
	let jobsNow = T0;

	jobsNow = T0 + 119_000;
	setClock(jobsNow);
	expect(reaper.tick()).toBe(0); // genuinely changes nothing: no in-flight jobs
	expect(jobs.byId(job.id)!.status).toBe('queued'); // still inside the TTL

	jobsNow = T0 + 121_000;
	setClock(jobsNow);
	reaper.tick();
	expect(
		jobs.byId(job.id)!.status,
		'the TTL never fired: with nothing in flight the reaper changes no jobs, so a dispatch hook gated ' +
			'on "changed >= 1 job" never runs and the expiry check inside dispatch() is never reached'
	).toBe('failed');
});

test('the reaper fires its tick hook even when it changes nothing', () => {
	// The difference from `onReaped`: this is what makes the reaper a CLOCK rather than a change notifier.
	const db = migratedDb();
	const jobs = new JobRepository(db, new AttemptLedger(db));
	let ticks = 0;
	const reaper = new JobReaper(jobs, { now: () => T0, tickMs: 1_000_000, onTick: () => (ticks += 1) });
	expect(reaper.tick()).toBe(0);
	expect(reaper.tick()).toBe(0);
	expect(ticks, 'a no-op tick must still advance the clock for time-based sweeps').toBe(2);
});

test('onReaped keeps its documented meaning: only on a tick that changed a job', () => {
	// Deliberately NOT merged into onTick: "capacity may have changed, redispatch now" and "time has
	// passed" are different questions, and collapsing them makes the no-op case invisible.
	const db = migratedDb();
	const jobs = new JobRepository(db, new AttemptLedger(db));
	let reaped = 0;
	const reaper = new JobReaper(jobs, { now: () => T0, tickMs: 1_000_000, onReaped: () => (reaped += 1) });
	expect(reaper.tick()).toBe(0);
	expect(reaped).toBe(0);
});

test('a job that finds a worker before the TTL is not failed by the periodic pass', () => {
	// Making dispatch periodic must not start failing healthy jobs.
	const { hub, jobs, setClock } = harness();
	const job = jobs.enqueue('m1', 'align', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w-stems', capabilities: ['stems'], concurrency: 1, version: '1' });
	setClock(T0 + 30_000);
	hub.handle({ type: 'worker:hello', workerId: 'w-align', capabilities: ['align'], concurrency: 1, version: '1' });
	expect(jobs.byId(job.id)!.status).toBe('assigned');

	const clock = T0 + 500_000; // far past the TTL
	setClock(clock);
	const reaper = new JobReaper(jobs, { now: () => clock, tickMs: 1_000_000, onTick: () => hub.dispatch() });
	reaper.tick();
	expect(jobs.byId(job.id)!.status).not.toBe('failed');
});
