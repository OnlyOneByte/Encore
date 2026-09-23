// Three properties of the event-typed job machine:
//
//   LEDGER. `transition` ALONE seals the attempt (COMPLETE→ready, FAIL→failed, CANCEL→canceled,
//   REJECT/LEASE_EXPIRED/RECOVER→abandoned + open the next), so a caller reaching it directly and
//   bypassing complete()/fail()/cancel()/requeue() is not invisible to history. Hooking the wrappers
//   instead leaves a raw transition's attempt open, with outcome === null.
//
//   SLOTS ride the machine's release hook: `transition` frees the OWNING worker's concurrency slot on a
//   worker-reported release event (REJECT/COMPLETE/FAIL) and NOT on a reaper or boot requeue
//   (LEASE_EXPIRED/RECOVER), nor on a CANCEL, which deliberately does not release so it cannot
//   double-free against an in-flight completion. Hand-paired release calls in worker-hub are the
//   alternative this replaces.
//
//   ONE shared exhausted-attempts predicate (`attemptsExhausted`) behind both the reaper's
//   progress-lease-expiry branch and the worker-hub `job:failed` handler, rather than two spellings of
//   the same policy.
import { test, expect } from 'bun:test';
import { JobRepository } from '$lib/server/jobs/repository';
import { AttemptLedger } from '$lib/server/jobs/attempts';
import { attemptsExhausted, sweep } from '$lib/server/jobs/leases';
import { migratedDb } from '$lib/server/db/test-db';
import type { Job } from '$lib/contract';

const T0 = 1_700_000_000_000;

function wired(): { jobs: JobRepository; ledger: AttemptLedger } {
	const db = migratedDb();
	const ledger = new AttemptLedger(db);
	return { jobs: new JobRepository(db, ledger), ledger };
}

// The ledger hooks the machine: a raw `transition` seals the attempt.

test('step2: a raw COMPLETE transition seals the open attempt ready (not just complete())', () => {
	const { jobs, ledger } = wired();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'w1', null, T0 + 1);
	jobs.accept(job.id, null, T0 + 2);
	expect(ledger.openFor(job.id)?.outcome).toBeNull(); // in flight

	// Bypass the complete() wrapper and go straight through the machine.
	jobs.transition(job.id, 'COMPLETE', { progressPct: 100, leaseExpiresAt: null, workerId: null }, T0 + 3);

	expect(ledger.openFor(job.id)).toBeNull(); // sealed — RED on base (transition never touched the ledger)
	const [a] = ledger.byMedia('m1');
	expect(a.outcome).toBe('ready');
	expect(a.finishedAt).toBe(T0 + 3);
});

test('step2: a raw FAIL transition seals failed and records the error from the patch', () => {
	const { jobs, ledger } = wired();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'w1', null, T0 + 1);
	jobs.accept(job.id, null, T0 + 2);

	jobs.transition(job.id, 'FAIL', { error: 'demucs OOM', leaseExpiresAt: null, workerId: null }, T0 + 3);

	const [a] = ledger.byMedia('m1');
	expect(a.outcome).toBe('failed'); // RED on base
	expect(a.error).toBe('demucs OOM'); // pulled from patch.error by transition
});

test('step2: a raw CANCEL transition seals canceled', () => {
	const { jobs, ledger } = wired();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'w1', null, T0 + 1);

	jobs.transition(job.id, 'CANCEL', { leaseExpiresAt: null, workerId: null }, T0 + 2);

	expect(ledger.byMedia('m1')[0].outcome).toBe('canceled'); // RED on base
});

test('step2: a raw requeue event (REJECT) abandons the old attempt AND opens a fresh one', () => {
	const { jobs, ledger } = wired();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'w1', null, T0 + 1);

	jobs.transition(job.id, 'REJECT', { workerId: null, leaseExpiresAt: null, attempts: 0 }, T0 + 2);

	const all = ledger.byMedia('m1');
	expect(all).toHaveLength(2); // RED on base: base's raw transition opened nothing, so length 1
	expect(all[0].outcome).toBe('abandoned'); // the dying attempt
	expect(all[1].outcome).toBeNull(); // the fresh wait, open
	expect(all[1].attempt).toBe(2);
});

// Slot accounting, via the machine's release hook.

function ownedRunning(jobs: JobRepository): Job {
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'w1', null, T0 + 1); // queued → assigned, workerId=w1
	return jobs.accept(job.id, null, T0 + 2); // assigned → running
}

test('step3: COMPLETE fires the slot-release hook with the owning worker', () => {
	const { jobs } = wired();
	const released: string[] = [];
	jobs.setSlotReleaseHook((wid) => released.push(wid));
	const job = ownedRunning(jobs);
	jobs.transition(job.id, 'COMPLETE', { progressPct: 100, leaseExpiresAt: null, workerId: null }, T0 + 3);
	expect(released).toEqual(['w1']); // owner read from the pre-write row
});

// FAIL is NOT a machine-release event, because it is not exclusively worker-reported: the reaper's
// exhausted-attempts and unservable-TTL branches also call fail(), so releasing off FAIL frees the slot of
// a worker still holding the job. The worker-REPORTED terminal FAIL releases explicitly at its one call
// site, so a raw FAIL transition must free NOTHING.
test('step3: FAIL does NOT fire the machine slot-release hook (released at the worker-report call site)', () => {
	const { jobs } = wired();
	const released: string[] = [];
	jobs.setSlotReleaseHook((wid) => released.push(wid));
	const job = ownedRunning(jobs);
	jobs.transition(job.id, 'FAIL', { error: 'x', leaseExpiresAt: null, workerId: null }, T0 + 3);
	expect(released).toEqual([]); // reaper/unservable fail must not over-free a live worker's slot
});

test('step3: REJECT (assigned→queued) releases the slot though the patch clears workerId', () => {
	const { jobs } = wired();
	const released: string[] = [];
	jobs.setSlotReleaseHook((wid) => released.push(wid));
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'w1', null, T0 + 1); // assigned, owner w1
	jobs.transition(job.id, 'REJECT', { workerId: null, leaseExpiresAt: null, attempts: 0 }, T0 + 2);
	expect(released).toEqual(['w1']); // captured before the patch nulled workerId
});

test('step3: CANCEL does NOT release the slot (cancel.ts double-free guard preserved)', () => {
	const { jobs } = wired();
	const released: string[] = [];
	jobs.setSlotReleaseHook((wid) => released.push(wid));
	const job = ownedRunning(jobs);
	jobs.transition(job.id, 'CANCEL', { leaseExpiresAt: null, workerId: null }, T0 + 3);
	expect(released).toEqual([]); // cancel deliberately leaves the worker to free its own slot
});

test('step3: reaper/boot requeue events (LEASE_EXPIRED, RECOVER) do NOT release the slot', () => {
	for (const event of ['LEASE_EXPIRED', 'RECOVER'] as const) {
		const { jobs } = wired();
		const released: string[] = [];
		jobs.setSlotReleaseHook((wid) => released.push(wid));
		const job = ownedRunning(jobs);
		jobs.transition(job.id, event, { workerId: null, leaseExpiresAt: null, attempts: 1 }, T0 + 3);
		expect(released).toEqual([]); // presumed-dead worker; registry reclaims on heartbeat, no double-free
	}
});

// One shared exhausted-attempts predicate.

test('step4: attemptsExhausted is the ceiling — false below maxAttempts, true at and above', () => {
	expect(attemptsExhausted(2, 3)).toBe(false);
	expect(attemptsExhausted(3, 3)).toBe(true);
	expect(attemptsExhausted(4, 3)).toBe(true);
});

test('step4: the reaper progress-lease-expiry branch routes its exhaustion check through the predicate', () => {
	// A running job with a dead lease one below max: NOT exhausted, so sweep requeues; at max it fails.
	// This is what pins leases.sweep and worker-hub to the SAME ceiling.
	const base = {
		id: 'j',
		mediaId: 'm',
		jobType: 'stems',
		workerId: 'w',
		status: 'running',
		leaseExpiresAt: T0
	} as unknown as Job;
	const notYet = sweep([{ ...base, attempts: 1, maxAttempts: 3 }], T0 + 1);
	expect(notYet[0].kind).toBe('requeue'); // attempts→2, !exhausted(2,3)
	const dead = sweep([{ ...base, attempts: 2, maxAttempts: 3 }], T0 + 1);
	expect(dead[0].kind).toBe('fail'); // attempts→3, exhausted(3,3)
});
