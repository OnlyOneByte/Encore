// M7-C2 done-when: a stalled job requeues; boot recovery clears in-flight. Drives the real
// JobRepository (in-memory sqlite) through the reaper with an injected clock — no wall-clock waits.
import { test, expect } from 'bun:test';
import { JobReaper } from './reaper';
import { JobRepository } from './repository';
import { ackDeadline, progressDeadline } from './leases';
import { openDb } from '../db/index';
import { runMigrations } from '../db/migrate';

function setup(now: () => number, onReaped?: () => void) {
	const { db } = openDb(':memory:');
	runMigrations(db, './drizzle');
	const jobs = new JobRepository(db);
	const reaper = new JobReaper(jobs, { now, onReaped, tickMs: 1_000_000 }); // tick only when we call it
	return { jobs, reaper };
}

const T0 = 1_700_000_000_000;

test('ack-timeout: an assigned job that never accepts requeues (no attempt burned)', () => {
	let clock = T0;
	const { jobs, reaper } = setup(() => clock);
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'worker-A', ackDeadline(T0), T0); // 10s ack lease

	clock = T0 + 5_000; // still within ack window
	expect(reaper.tick()).toBe(0);
	expect(jobs.byId(job.id)!.status).toBe('assigned');

	clock = T0 + 11_000; // past the 10s ack deadline
	expect(reaper.tick()).toBe(1);
	const after = jobs.byId(job.id)!;
	expect(after.status).toBe('queued');
	expect(after.workerId).toBeNull();
	expect(after.leaseExpiresAt).toBeNull();
	expect(after.attempts).toBe(0); // worker never started → no attempt burned
});

test('progress-lease: a running job that stops heartbeating requeues with attempts++', () => {
	let clock = T0;
	const { jobs, reaper } = setup(() => clock);
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'worker-A', ackDeadline(T0), T0);
	jobs.accept(job.id, progressDeadline(T0), T0 + 1); // 30s progress lease

	clock = T0 + 31_000; // missed the heartbeat window
	expect(reaper.tick()).toBe(1);
	const after = jobs.byId(job.id)!;
	expect(after.status).toBe('queued');
	expect(after.attempts).toBe(1);
	expect(after.workerId).toBeNull();
});

test('a heartbeat (progress) refreshes the lease so the reaper leaves it alone', () => {
	let clock = T0;
	const { jobs, reaper } = setup(() => clock);
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'w', ackDeadline(T0), T0);
	jobs.accept(job.id, progressDeadline(T0), T0 + 1);

	clock = T0 + 25_000;
	jobs.progress(job.id, { stage: 'separating', progressPct: 50, leaseExpiresAt: progressDeadline(clock) }, clock);
	clock = T0 + 31_000; // past the FIRST lease, but the heartbeat pushed it to T0+55s
	expect(reaper.tick()).toBe(0);
	expect(jobs.byId(job.id)!.status).toBe('running');
});

test('progress-lease exhaustion → terminal failed (not requeued forever)', () => {
	let clock = T0;
	const { jobs, reaper } = setup(() => clock);
	const job = jobs.enqueue('m1', 'stems', 0, T0);

	// burn attempts up to maxAttempts-1 via repeated assign→accept→lease-expiry
	for (let i = 0; i < 2; i++) {
		jobs.assign(job.id, 'w', ackDeadline(clock), clock);
		jobs.accept(job.id, progressDeadline(clock), clock);
		clock += 31_000;
		reaper.tick();
		expect(jobs.byId(job.id)!.status).toBe('queued');
	}
	// third strike: attempts hits maxAttempts → failed
	jobs.assign(job.id, 'w', ackDeadline(clock), clock);
	jobs.accept(job.id, progressDeadline(clock), clock);
	clock += 31_000;
	reaper.tick();
	const dead = jobs.byId(job.id)!;
	expect(dead.status).toBe('failed');
	expect(dead.attempts).toBe(3);
	expect(dead.error).toContain('attempts exhausted');
});

test('boot recovery resets every assigned/running job to queued (attempts preserved)', () => {
	const { jobs, reaper } = setup(() => T0 + 100);
	const a = jobs.enqueue('m1', 'stems', 0, T0); // will be assigned
	const r = jobs.enqueue('m2', 'stems', 0, T0); // will be running (attempts=2)
	const q = jobs.enqueue('m3', 'stems', 0, T0); // already queued — untouched
	jobs.assign(a.id, 'worker-A', ackDeadline(T0), T0);
	jobs.assign(r.id, 'worker-B', ackDeadline(T0), T0);
	jobs.accept(r.id, progressDeadline(T0), T0);
	jobs.requeue(r.id, 2, T0); // simulate prior retries so attempts=2
	jobs.assign(r.id, 'worker-B', ackDeadline(T0), T0);
	jobs.accept(r.id, progressDeadline(T0), T0);

	const recovered = reaper.recoverOnBoot();
	expect(recovered).toBe(2); // a + r, not q
	expect(jobs.byId(a.id)!.status).toBe('queued');
	expect(jobs.byId(a.id)!.workerId).toBeNull();
	expect(jobs.byId(r.id)!.status).toBe('queued');
	expect(jobs.byId(r.id)!.attempts).toBe(2); // a core restart isn't the worker's fault
	expect(jobs.byId(q.id)!.status).toBe('queued');
});

test('onReaped fires once per tick that changed ≥1 job, and not on a no-op', () => {
	let clock = T0;
	let calls = 0;
	const { jobs, reaper } = setup(() => clock, () => calls++);
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'w', ackDeadline(T0), T0);

	reaper.tick(); // within window — no change
	expect(calls).toBe(0);
	clock = T0 + 11_000;
	reaper.tick(); // ack-timeout requeue
	expect(calls).toBe(1);
});
