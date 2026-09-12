// unit: a permanently failed cook stays failed across a restart, and an unservable job dies on a clock.
//
// TWO DEFECTS, found while writing the XR-JOB requirement rows. They share one shape: the fix that was
// applied worked in memory, and the durable or periodic half was never wired.
//
// 1. THE READINESS GATE SETTLED IN MEMORY ONLY. `settleStemsGate` puts a dead cook's song back to
//    `stemStatus: 'none'` so `isCooking` stops reading it as in-flight — its own comment describes the
//    "cooking FOREVER" bug it was written to end. But `stem_status` is a STORED column, the *queued* flip
//    IS persisted (the make-karaoke route upserts right after enqueue), and the terminal-failure epilogue
//    carried no persistence sink at all. `hydrateMediaCatalog` wins at boot, so a restart resurrected
//    exactly the stranding the settle exists to prevent: terminal job row, song reads as cooking, no Sing
//    button, and nothing a guest can do about it.
//
// 2. THE UNSERVABLE TTL WAS NOT ON A CLOCK. Both the stamp and the expiry check live inside `dispatch()`,
//    which is event-driven. The reaper does tick every ~3s, but it only called its dispatch hook on a tick
//    that CHANGED a job — and an unservable job is never assigned or running, so the sweep produces no
//    actions, `dispatch()` is never called again, and the 120s TTL is never reached. The job parks queued
//    forever: the exact hang the TTL was introduced to end.
//
//    The existing coverage in `worker-hub.test.ts` cannot catch this, and the reason is the point: it calls
//    `hub.dispatch()` itself to advance the clock, supplying the second pass production may never make. It
//    is green about a path the running system cannot reach. The arms below drive the TTL through the
//    REAPER, so removing the periodic trigger reds them.

import { test, expect } from 'bun:test';
import { migratedDb } from '$server/db/test-db';
import { JobReaper } from '$server/jobs/reaper';
import { WorkerHub } from '$server/jobs/worker-hub';
import { WorkerRegistry } from '$server/jobs/registry';
import { JobRepository } from '$server/jobs/repository';
import { AttemptLedger } from '$server/jobs/attempts';
import { reportTerminalFailure, settleStemsGate } from '$server/jobs/make-karaoke';
import type { Media, ServerEvent } from '@encore/shared';

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

function harness(over: { capabilities?: string[] } = {}) {
	const db = migratedDb();
	const attempts = new AttemptLedger(db);
	const jobs = new JobRepository(db, attempts);
	const mediaById = new Map<string, Media>([['m1', media('m1', { stemStatus: 'queued' })]]);
	const broadcasts: ServerEvent[] = [];
	const persisted: string[] = [];
	let clock = T0;
	const hub = new WorkerHub({
		jobs,
		attempts,
		registry: new WorkerRegistry(),
		mediaById,
		toWorker: () => {},
		broadcast: (e) => broadcasts.push(e),
		persistMedia: (mediaId) => persisted.push(mediaId),
		now: () => clock
	});
	void over;
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
	// the in-memory half, which already worked
	expect(mediaById.get('m1')!.stemStatus).toBe('none');
	// the durable half — without it the next boot re-reads 'queued' from the row and strands the song
	expect(
		persisted,
		'the settled gate was never handed to a persistence sink, so a restart resurrects the dead cook'
	).toEqual(['m1']);
});

test('a failure that settles NO gate does not write', () => {
	// stems-upgrade deliberately keeps the working instrumental, so there is nothing to settle and
	// nothing to persist. A sink called unconditionally would write a row per failure for no reason.
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
	// `persist` is optional on purpose: WorkerHubDeps.persistMedia is already optional so the hub can be
	// built without a DB. An epilogue that REQUIRED a sink would break every such test.
	const { jobs, mediaById } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	const failed = jobs.fail(job.id, 'boom', T0 + 1_000);
	expect(() =>
		reportTerminalFailure(failed, 'reaper', { broadcast: () => {}, mediaById })
	).not.toThrow();
	expect(mediaById.get('m1')!.stemStatus).toBe('none');
});

test('settleStemsGate alone does not persist — the epilogue owns that', () => {
	// Pins the division of labour. If settling grew its own write, the epilogue would double-write and the
	// two sites could disagree about when a row is flushed.
	const mediaById = new Map<string, Media>([['m1', media('m1', { stemStatus: 'queued' })]]);
	expect(settleStemsGate('m1', mediaById)).toBe(true);
	expect(mediaById.get('m1')!.stemStatus).toBe('none');
});

test('the hub wires its own persistMedia into the terminal-failure epilogue', () => {
	// End to end through the hub rather than through the exported function: a worker reports a terminal
	// failure and the hub must hand its persistence sink to the epilogue. This is the arm that fails if
	// only the standalone function is fixed and the two call sites in worker-hub are missed.
	const { hub, jobs, persisted, mediaById } = harness();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	expect(jobs.byId(job.id)!.status).toBe('assigned');

	// The worker has to ACCEPT before it can report a failure: #onFailed refuses anything not `running`,
	// which is what keeps a stale session from failing a job it no longer owns.
	hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	expect(jobs.byId(job.id)!.status).toBe('running');
	// `retryable: false` is terminal on the first report — no need to exhaust attempts.
	hub.handle({ type: 'job:failed', jobId: job.id, workerId: 'w1', error: 'boom', retryable: false });
	expect(jobs.byId(job.id)!.status).toBe('failed');
	expect(mediaById.get('m1')!.stemStatus).toBe('none');
	expect(persisted, 'the hub settled the gate in memory but never persisted it').toContain('m1');
});

// ── 2. the unservable TTL, driven by the clock rather than by the test ─────────────────────────────

test('an unservable job reaches terminal failed on the reaper clock, with nobody calling dispatch', () => {
	const { hub, jobs, setClock } = harness();
	const job = jobs.enqueue('m1', 'align', 0, T0);
	// A worker connects that can never serve it, exactly as the existing TTL test sets up. The job is
	// first seen unservable here — and from now on nothing is assigned or running, so the reaper's sweep
	// has no actions to take on any tick.
	hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['stems'], concurrency: 1, version: '1' });
	expect(jobs.byId(job.id)!.status).toBe('queued');

	// The reaper is the only clock in the system. Wire it as app.ts does and let it tick. Crucially this
	// test never calls hub.dispatch() again — production would not.
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
	// The load-bearing difference from `onReaped`, and the whole fix for the starvation above: this is what
	// makes the reaper a CLOCK rather than a change notifier.
	const db = migratedDb();
	const jobs = new JobRepository(db, new AttemptLedger(db));
	let ticks = 0;
	const reaper = new JobReaper(jobs, { now: () => T0, tickMs: 1_000_000, onTick: () => (ticks += 1) });
	expect(reaper.tick()).toBe(0);
	expect(reaper.tick()).toBe(0);
	expect(ticks, 'a no-op tick must still advance the clock for time-based sweeps').toBe(2);
});

test('onReaped keeps its documented meaning: only on a tick that changed a job', () => {
	// Deliberately NOT merged into onTick. They answer different questions — "capacity may have changed,
	// redispatch now" versus "time has passed" — and collapsing them makes the no-op case invisible.
	const db = migratedDb();
	const jobs = new JobRepository(db, new AttemptLedger(db));
	let reaped = 0;
	const reaper = new JobReaper(jobs, { now: () => T0, tickMs: 1_000_000, onReaped: () => (reaped += 1) });
	expect(reaper.tick()).toBe(0);
	expect(reaped).toBe(0);
});

test('a job that finds a worker before the TTL is not failed by the periodic pass', () => {
	// Regression guard for fix 2: making dispatch periodic must not start failing healthy jobs.
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
