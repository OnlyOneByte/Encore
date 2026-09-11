// The job machine read slot release off the EVENT NAME alone, so the reaper's terminal
// FAIL (a presumed-DEAD worker whose progress lease lapsed with attempts exhausted) freed the slot
// of a worker that was STILL holding a live job, driving an assign/reject storm.
//
// FAIL reaches `JobRepository.transition` from three callers and only ONE is a worker report:
//   • worker-hub `#onFailed` terminal branch — worker-reported, workerId set → SHOULD release
//   • worker-hub unservable-TTL branch        — job still `queued`, workerId null → cannot release
//   • reaper `tick()` exhausted-attempts       — presumed-dead worker, workerId still set → MUST NOT release
// The machine treated all three the same because it keyed off the event name. The fix removes FAIL
// from SLOT_RELEASING_EVENTS and releases explicitly at the one worker-report call site; the reaper's
// dead-worker fail then frees nothing (the registry reclaims that slot on the next heartbeat).
//
// These tests wire the real JobReaper against a real JobRepository + WorkerRegistry with the hub's
// own release hook (`setSlotReleaseHook`), exactly as worker-hub.ts:167 wires it in production, and
// assert the reaper's FAIL does not disturb a live worker's slot. RED on base: the reaper's fail()
// fires the machine's release hook, so slotsFree goes 0 → 1 and planAssignments lands a job on the
// still-busy worker.
import { test, expect } from 'bun:test';
import { JobRepository } from './repository';
import { AttemptLedger } from './attempts';
import { WorkerRegistry } from './registry';
import { JobReaper } from './reaper';
import { planAssignments } from './dispatch';
import { progressDeadline, DEFAULT_LEASE_CONFIG } from './leases';
import { migratedDb } from '../db/test-db';

const T0 = 1_700_000_000_000;

/**
 * Real machine wired the way app.ts wires it: the repository's slot-release hook drives the
 * registry, so a release event visibly moves the owning worker's slotsFree.
 */
function fleet() {
	const db = migratedDb();
	const ledger = new AttemptLedger(db);
	const jobs = new JobRepository(db, ledger);
	const registry = new WorkerRegistry();
	// Production wiring (worker-hub.ts): a machine release event frees the owning worker's slot.
	jobs.setSlotReleaseHook((wid) => registry.releaseSlot(wid));
	return { jobs, registry };
}

// A worker w1 at concurrency 2 holding two jobs: `a` with a DEAD progress lease and attempts one
// short of exhaustion, `b` still running with a live lease. slotsFree is 0 (both slots claimed).
function busyWorkerHoldingDeadAndLive(jobs: JobRepository, registry: WorkerRegistry) {
	registry.hello('w1', ['stems'], 2, 'test', T0);
	const a = jobs.enqueue('mA', 'stems', 0, T0);
	const b = jobs.enqueue('mB', 'stems', 0, T0);
	// a: dispatched, accepted, then progressed twice so attempts == 2 (next reap exhausts 3/3)
	jobs.assign(a.id, 'w1', null, T0 + 1);
	registry.claimSlot('w1');
	jobs.accept(a.id, progressDeadline(T0 + 1), T0 + 2);
	jobs.requeue(a.id, 1, T0 + 3, 'LEASE_EXPIRED'); // burn one attempt without releasing (reaper path)
	jobs.assign(a.id, 'w1', null, T0 + 4);
	jobs.accept(a.id, progressDeadline(T0 + 4), T0 + 5);
	jobs.progress(a.id, { attempts: 2, leaseExpiresAt: T0 + 5 }, T0 + 5); // attempts=2, lease will be dead by trigger time
	// b: dispatched + accepted, live lease well into the future
	jobs.assign(b.id, 'w1', null, T0 + 6);
	registry.claimSlot('w1');
	jobs.accept(b.id, progressDeadline(T0 + 1_000_000), T0 + 7);
	return { a, b };
}

test("the reaper terminal FAIL does NOT free a live worker's slot", () => {
	const { jobs, registry } = fleet();
	const { a } = busyWorkerHoldingDeadAndLive(jobs, registry);
	expect(registry.get('w1')!.slotsFree).toBe(0); // both slots occupied

	// TRIGGER: a's lease is dead and its next attempt (3) is exhausting → reaper fails it.
	const trigger = T0 + 5 + DEFAULT_LEASE_CONFIG.progressLeaseMs + 1;
	const reaper = new JobReaper(jobs, { now: () => trigger, tickMs: 1_000_000 });
	reaper.tick();

	expect(jobs.byId(a.id)!.status).toBe('failed'); // the job still goes terminal — we did NOT skip fail()
	expect(registry.get('w1')!.slotsFree).toBe(0); // RED ON BASE: base frees it (0 → 1) — a live worker is at 2/2
});

test('no phantom assignment lands on the still-busy worker after a reaper FAIL', () => {
	const { jobs, registry } = fleet();
	busyWorkerHoldingDeadAndLive(jobs, registry);
	// A third song is waiting in the queue.
	jobs.enqueue('mC', 'stems', 0, T0 + 8);

	const trigger = T0 + 5 + DEFAULT_LEASE_CONFIG.progressLeaseMs + 1;
	new JobReaper(jobs, { now: () => trigger, tickMs: 1_000_000 }).tick();

	const queued = jobs.listByStatus('queued');
	const plan = planAssignments(queued, registry.list(), () => 'stems');
	// RED ON BASE: base over-freed a slot, so the plan hands mC to w1 while w1 is truly at 2/2 —
	// the worker's own capacity gate rejects it, requeue re-dispatches, and the storm begins.
	expect(plan).toEqual([]);
});
