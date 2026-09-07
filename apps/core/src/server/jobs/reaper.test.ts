// Done-when: a stalled job requeues; boot recovery clears in-flight. Drives the real
// JobRepository (in-memory sqlite) through the reaper with an injected clock — no wall-clock waits.
import { test, expect } from 'bun:test';
import { migratedDb } from '../db/test-db';
import { JobReaper } from './reaper';
import { JobRepository } from './repository';
import { ackDeadline, progressDeadline } from './leases';

function setup(now: () => number, onReaped?: () => void) {
	const db = migratedDb();
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
	const { jobs, reaper } = setup(
		() => clock,
		() => calls++
	);
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'w', ackDeadline(T0), T0);

	reaper.tick(); // within window — no change
	expect(calls).toBe(0);
	clock = T0 + 11_000;
	reaper.tick(); // ack-timeout requeue
	expect(calls).toBe(1);
});

// ── #90: a reaper-killed cook must settle its readiness gate ──────────────────────
// The worker box died mid-cook, so the failure reaches terminal `failed` via the reaper's own
// attempts-exhaustion path — never through #onFailed. Before #90 the gate stayed mid-flight
// forever: readyToSing never flipped and rotation held the queue entry on every pass, even with the
// instrumental on disk. The reaper has no catalog, so app.ts wires its onFailed hook to
// settleGatesForFailedJob(job, mediaById) — this test drives that live wiring, not a reimplementation.
import { settleGatesForFailedJob } from './make-karaoke';
import type { Media } from '@encore/shared';

const mkMedia = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 200,
	stemStatus: 'none',
	...over
});

function exhaustToFailed(jobType: 'stems' | 'align', over: Partial<Media> = {}) {
	let clock = T0;
	const db = migratedDb();
	const jobs = new JobRepository(db);
	const mediaById = new Map<string, Media>([['m1', mkMedia('m1', over)]]);
	// The exact wiring app.ts uses: the reaper hands the failed job up, we settle its gate.
	const reaper = new JobReaper(jobs, {
		now: () => clock,
		tickMs: 1_000_000,
		onFailed: (job) => settleGatesForFailedJob(job, mediaById)
	});
	const job = jobs.enqueue('m1', jobType, 0, T0);
	for (let i = 0; i < 3; i++) {
		jobs.assign(job.id, 'w', ackDeadline(clock), clock);
		jobs.accept(job.id, progressDeadline(clock), clock);
		clock += 31_000;
		reaper.tick();
	}
	return { jobs, mediaById, job };
}

test('#90 reaper: a dead stems cook settles the STEMS gate back to un-cooked', () => {
	// stemStatus 'queued' (separation in flight) → the box dies → reaper exhausts attempts.
	const { jobs, mediaById, job } = exhaustToFailed('stems', { stemStatus: 'queued' });
	expect(jobs.byId(job.id)!.status).toBe('failed'); // reaper path, not #onFailed
	// The regression: before #90 this stayed 'queued' forever → isCooking true → rotation holds it.
	expect(mediaById.get('m1')!.stemStatus).toBe('none');
});

test('#90 reaper: a dead align cook settles the LYRICS gate so the playable song can be sung', () => {
	// The song already has its instrumental and plays; only lyrics were pending → align dies.
	const { jobs, mediaById, job } = exhaustToFailed('align', {
		stemStatus: 'ready',
		instrumentalRef: 'derived/stems/m1-instrumental.flac',
		lyricsStatus: 'queued'
	});
	expect(jobs.byId(job.id)!.status).toBe('failed');
	expect(mediaById.get('m1')!.lyricsStatus).toBe('ready'); // gate settled → readyToSing can flip
	expect(mediaById.get('m1')!.stemStatus).toBe('ready'); // never walk the finished cook backwards
});
