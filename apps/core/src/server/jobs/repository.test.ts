// M7-C1 done-when: full lifecycle (queued→assigned→running→ready) + dedup on (mediaId,jobType) +
// idempotent re-add. Plus the failure/cancel/requeue edges and the DB-level dedup guarantee.
import { test, expect } from 'bun:test';
import { JobRepository } from './repository';
import { openDb } from '../db/index';
import { runMigrations } from '../db/migrate';
import { jobs } from '../db/schema';

function makeRepo() {
	const { db } = openDb(':memory:');
	runMigrations(db, './drizzle');
	return { repo: new JobRepository(db), db };
}

const T0 = 1_700_000_000_000;

test('full lifecycle: queued → assigned → running → ready', () => {
	const { repo } = makeRepo();
	const job = repo.enqueue('media-1', 'stems', 0, T0);
	expect(job.status).toBe('queued');
	expect(job.attempts).toBe(0);
	expect(job.maxAttempts).toBe(3);

	const assigned = repo.assign(job.id, 'worker-A', T0 + 10_000, T0 + 1);
	expect(assigned.status).toBe('assigned');
	expect(assigned.workerId).toBe('worker-A');
	expect(assigned.leaseExpiresAt).toBe(T0 + 10_000);

	const running = repo.accept(job.id, T0 + 30_000, T0 + 2);
	expect(running.status).toBe('running');
	expect(running.leaseExpiresAt).toBe(T0 + 30_000); // ack lease replaced by fresh progress lease

	const progressed = repo.progress(job.id, { stage: 'separating', progressPct: 68, etaSec: 12 }, T0 + 3);
	expect(progressed.status).toBe('running'); // self-loop
	expect(progressed.stage).toBe('separating');
	expect(progressed.progressPct).toBe(68);

	const ready = repo.complete(job.id, T0 + 4);
	expect(ready.status).toBe('ready');
	expect(ready.progressPct).toBe(100);
	expect(ready.workerId).toBeNull();
	expect(ready.leaseExpiresAt).toBeNull();
	expect(ready.updatedAt).toBe(T0 + 4);
});

test('idempotent re-add: queueing the same (mediaId,jobType) reuses the live job', () => {
	const { repo } = makeRepo();
	const first = repo.enqueue('media-1', 'stems', 5, T0);
	const second = repo.enqueue('media-1', 'stems', 0, T0 + 100); // different priority, same key
	expect(second.id).toBe(first.id); // same job, not a new one
	expect(repo.listByStatus('queued')).toHaveLength(1);

	// reuse holds through the running state too (not just queued)
	repo.assign(first.id, 'w', null, T0 + 1);
	repo.accept(first.id, null, T0 + 2);
	const third = repo.enqueue('media-1', 'stems', 0, T0 + 200);
	expect(third.id).toBe(first.id);
	expect(third.status).toBe('running');
});

test('dedup is per (mediaId, jobType): different media or type get distinct jobs', () => {
	const { repo } = makeRepo();
	const a = repo.enqueue('media-1', 'stems', 0, T0);
	const b = repo.enqueue('media-2', 'stems', 0, T0); // different media
	const c = repo.enqueue('media-1', 'align', 0, T0); // different type
	expect(new Set([a.id, b.id, c.id]).size).toBe(3);
});

test('a terminal (canceled/failed) job frees the slot → re-add creates a NEW job', () => {
	const { repo } = makeRepo();
	const first = repo.enqueue('media-1', 'stems', 0, T0);
	repo.cancel(first.id, T0 + 1);
	expect(repo.findLive('media-1', 'stems')).toBeNull(); // slot freed

	const reborn = repo.enqueue('media-1', 'stems', 0, T0 + 2);
	expect(reborn.id).not.toBe(first.id); // genuinely new job, song re-processable

	// the same holds after a hard failure
	repo.assign(reborn.id, 'w', null, T0 + 3);
	repo.accept(reborn.id, null, T0 + 4);
	repo.fail(reborn.id, 'demucs OOM', T0 + 5);
	expect(repo.findLive('media-1', 'stems')).toBeNull();
	const third = repo.enqueue('media-1', 'stems', 0, T0 + 6);
	expect(third.id).not.toBe(reborn.id);
});

test('the DB partial unique index enforces dedup even if the app check is bypassed', () => {
	const { repo, db } = makeRepo();
	const live = repo.enqueue('media-1', 'stems', 0, T0);
	// Insert a second LIVE row for the same key directly (simulating a dispatch race that slips
	// past findLive) — the partial unique index must reject it.
	expect(() =>
		db
			.insert(jobs)
			.values({ id: 'dup', mediaId: 'media-1', jobType: 'stems', status: 'queued', priority: 0, createdAt: T0, updatedAt: T0 })
			.run()
	).toThrow();
	// but a row for the SAME key in a terminal status is allowed (index is partial)
	db.insert(jobs)
		.values({ id: 'old', mediaId: 'media-1', jobType: 'stems', status: 'failed', priority: 0, createdAt: T0, updatedAt: T0 })
		.run();
	expect(repo.findLive('media-1', 'stems')!.id).toBe(live.id); // still the one live job
});

test('requeue clears ownership/lease; attempts is caller-controlled', () => {
	const { repo } = makeRepo();
	const job = repo.enqueue('media-1', 'stems', 0, T0);
	repo.assign(job.id, 'worker-A', T0 + 10_000, T0 + 1);
	repo.accept(job.id, T0 + 30_000, T0 + 2);

	// progress-lease expiry → requeue with attempts++ (caller's policy)
	const requeued = repo.requeue(job.id, 1, T0 + 3);
	expect(requeued.status).toBe('queued');
	expect(requeued.workerId).toBeNull();
	expect(requeued.leaseExpiresAt).toBeNull();
	expect(requeued.attempts).toBe(1);
});

test('illegal transitions throw (state machine is enforced through the repo)', () => {
	const { repo } = makeRepo();
	const job = repo.enqueue('media-1', 'stems', 0, T0);
	expect(() => repo.complete(job.id, T0 + 1)).toThrow('no edge queued → ready'); // can't skip to ready
	expect(() => repo.transition(job.id, 'running', {}, T0 + 1)).toThrow('no edge queued → running');
	repo.cancel(job.id, T0 + 2);
	expect(() => repo.accept(job.id, null, T0 + 3)).toThrow('canceled is terminal');
});

test('unknown job id throws', () => {
	const { repo } = makeRepo();
	expect(() => repo.transition('nope', 'assigned', {}, T0)).toThrow('unknown job: nope');
	expect(repo.byId('nope')).toBeNull();
});
