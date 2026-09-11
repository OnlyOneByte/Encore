// Done-when: full lifecycle (queued→assigned→running→ready) + dedup on (mediaId,jobType) +
// idempotent re-add. Plus the failure/cancel/requeue edges and the DB-level dedup guarantee.
import { test, expect } from 'bun:test';
import { migratedDb } from '$server/db/test-db';
import { JobRepository } from '$server/jobs/repository';
import type { JobType } from '@encore/shared';
import { jobs } from '$server/db/schema';

function makeRepo() {
	const db = migratedDb();
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
			.values({
				id: 'dup',
				mediaId: 'media-1',
				jobType: 'stems',
				status: 'queued',
				priority: 0,
				createdAt: T0,
				updatedAt: T0
			})
			.run()
	).toThrow();
	// but a row for the SAME key in a terminal status is allowed (index is partial)
	db.insert(jobs)
		.values({
			id: 'old',
			mediaId: 'media-1',
			jobType: 'stems',
			status: 'failed',
			priority: 0,
			createdAt: T0,
			updatedAt: T0
		})
		.run();
	expect(repo.findLive('media-1', 'stems')!.id).toBe(live.id); // still the one live job
});

test('requeue distinguishes REJECT from LEASE_EXPIRED through the machine', () => {
	const { repo } = makeRepo();

	// A worker REJECT is only legal from `assigned` — the machine now knows it is a distinct event,
	// not the same `assigned → queued` status pair an ack-timeout LEASE_EXPIRED produces.
	const rejected = repo.enqueue('m-reject', 'stems', 0, T0);
	repo.assign(rejected.id, 'w', T0 + 10_000, T0 + 1);
	expect(repo.requeue(rejected.id, rejected.attempts, T0 + 2, 'REJECT').status).toBe('queued');

	// The same requeue as an ack-timeout LEASE_EXPIRED — also legal from `assigned`, same landing.
	const timedOut = repo.enqueue('m-timeout', 'stems', 0, T0);
	repo.assign(timedOut.id, 'w', T0 + 10_000, T0 + 1);
	expect(repo.requeue(timedOut.id, timedOut.attempts, T0 + 2, 'LEASE_EXPIRED').status).toBe('queued');

	// But a REJECT is refused from `running` — a worker cannot decline work it already accepted. The
	// escape a status-pair machine allowed (any `running → queued` write) is now typed shut.
	const running = repo.enqueue('m-running', 'stems', 0, T0);
	repo.assign(running.id, 'w', T0 + 10_000, T0 + 1);
	repo.accept(running.id, T0 + 30_000, T0 + 2);
	expect(() => repo.requeue(running.id, 1, T0 + 3, 'REJECT')).toThrow('no event REJECT from running');
	// …while a progress-lease expiry and a boot RECOVER ARE legal from `running`.
	expect(repo.requeue(running.id, 1, T0 + 4, 'LEASE_EXPIRED').status).toBe('queued');
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
	expect(() => repo.complete(job.id, T0 + 1)).toThrow('no event COMPLETE from queued'); // can't skip to ready
	expect(() => repo.transition(job.id, 'ACCEPT', {}, T0 + 1)).toThrow('no event ACCEPT from queued');
	repo.cancel(job.id, T0 + 2);
	expect(() => repo.accept(job.id, null, T0 + 3)).toThrow('canceled is terminal');
});

test('unknown job id throws', () => {
	const { repo } = makeRepo();
	expect(() => repo.transition('nope', 'DISPATCH', {}, T0)).toThrow('unknown job: nope');
	expect(repo.byId('nope')).toBeNull();
});

// — findOutstandingForMedia: the lookup behind /api/library's "what is cooking right now?" —
// It walks the cook chain fetch → stems → align in order and returns the first step that is NOT
// `ready` (in flight or waiting), skips finished/never-enqueued steps, and excludes stems-upgrade
// (background work on an already-singable song). A silent regression here snaps the phone's
// progress strip back to queued/0% on reload while a song is mid-cook.

/** Drive a fresh job to `running` (queued → assigned → running). Returns its id. */
function runningJob(repo: JobRepository, mediaId: string, jobType: JobType, at = T0): string {
	const job = repo.enqueue(mediaId, jobType, 0, at);
	repo.assign(job.id, 'w', null, at + 1);
	repo.accept(job.id, null, at + 2);
	return job.id;
}

/** Drive a fresh job all the way to terminal `ready`. */
function readyJob(repo: JobRepository, mediaId: string, jobType: JobType, at = T0): void {
	repo.complete(runningJob(repo, mediaId, jobType, at), at + 3);
}

test('findOutstandingForMedia: fetch running is the outstanding step', () => {
	const { repo } = makeRepo();
	runningJob(repo, 'media-1', 'fetch');
	const out = repo.findOutstandingForMedia('media-1');
	expect(out?.jobType).toBe('fetch');
	expect(out?.status).toBe('running');
});

test('findOutstandingForMedia: a ready fetch is skipped, running stems is returned', () => {
	const { repo } = makeRepo();
	readyJob(repo, 'media-1', 'fetch');
	runningJob(repo, 'media-1', 'stems', T0 + 100);
	const out = repo.findOutstandingForMedia('media-1');
	expect(out?.jobType).toBe('stems'); // walked past the ready fetch
	expect(out?.status).toBe('running');
});

test('findOutstandingForMedia: fetch+stems ready, running align is returned', () => {
	const { repo } = makeRepo();
	readyJob(repo, 'media-1', 'fetch');
	readyJob(repo, 'media-1', 'stems', T0 + 100);
	runningJob(repo, 'media-1', 'align', T0 + 200);
	const out = repo.findOutstandingForMedia('media-1');
	expect(out?.jobType).toBe('align'); // last step in the chain
	expect(out?.status).toBe('running');
});

test('findOutstandingForMedia: every step ready → null (nothing outstanding)', () => {
	const { repo } = makeRepo();
	readyJob(repo, 'media-1', 'fetch');
	readyJob(repo, 'media-1', 'stems', T0 + 100);
	readyJob(repo, 'media-1', 'align', T0 + 200);
	expect(repo.findOutstandingForMedia('media-1')).toBeNull();
});

test('findOutstandingForMedia: a local file (no fetch job) with stems running is still outstanding', () => {
	const { repo } = makeRepo();
	// no fetch job at all — a local file skips acquisition; the walk must not stop at the gap
	runningJob(repo, 'media-1', 'stems');
	const out = repo.findOutstandingForMedia('media-1');
	expect(out?.jobType).toBe('stems');
	expect(out?.status).toBe('running');
});

test('findOutstandingForMedia: a queued (waiting) step counts as outstanding', () => {
	const { repo } = makeRepo();
	repo.enqueue('media-1', 'fetch', 0, T0); // queued, never assigned — a step waiting to start
	const out = repo.findOutstandingForMedia('media-1');
	expect(out?.jobType).toBe('fetch');
	expect(out?.status).toBe('queued');
});

test('findOutstandingForMedia: a live stems-upgrade on an all-ready song reads as null (not cooking)', () => {
	const { repo } = makeRepo();
	readyJob(repo, 'media-1', 'fetch');
	readyJob(repo, 'media-1', 'stems', T0 + 100);
	readyJob(repo, 'media-1', 'align', T0 + 200);
	// background upgrade running on a finished, singable song — must NOT report the song as cooking
	runningJob(repo, 'media-1', 'stems-upgrade', T0 + 300);
	expect(repo.findOutstandingForMedia('media-1')).toBeNull();
});

test('findOutstandingForMedia: null for a media with no jobs at all', () => {
	const { repo } = makeRepo();
	expect(repo.findOutstandingForMedia('media-unknown')).toBeNull();
});

// — reprioritize: the status-free priority write (starvation half) —

test('reprioritize lowers a queued job priority without a status change or ledger event', () => {
	const { repo } = makeRepo();
	// filed at NO_QUEUE_PRIORITY (nobody waiting yet) — the reconnect-starvation snapshot
	const job = repo.enqueue('m-starved', 'stems', Number.MAX_SAFE_INTEGER, T0);
	expect(job.priority).toBe(Number.MAX_SAFE_INTEGER);

	const after = repo.reprioritize(job.id, 1, T0 + 5);
	expect(after.priority).toBe(1); // pulled to the singer's rotation position
	expect(after.status).toBe('queued'); // NOT a transition — still queued (that's what starvation is)
	expect(after.updatedAt).toBe(T0 + 5);
	// no ledger event was opened/closed by a reprioritise — it is scheduling metadata, not lifecycle
	expect(repo.byId(job.id)!.priority).toBe(1);
});

test('reprioritize only ever LOWERS: an equal-or-higher target is a no-op', () => {
	const { repo } = makeRepo();
	const job = repo.enqueue('m1', 'stems', 3, T0);

	expect(repo.reprioritize(job.id, 3, T0 + 1).priority).toBe(3); // equal — refused
	expect(repo.reprioritize(job.id, 7, T0 + 2).priority).toBe(3); // higher (less urgent) — refused
	expect(repo.reprioritize(job.id, 1, T0 + 3).priority).toBe(1); // strictly lower — applied
});

test('reprioritize refuses a terminal job (no scheduling future)', () => {
	const { repo } = makeRepo();
	const job = repo.enqueue('m1', 'stems', 5, T0);
	repo.assign(job.id, 'w', null, T0 + 1);
	repo.accept(job.id, null, T0 + 2);
	repo.complete(job.id, T0 + 3); // → ready (terminal)

	const after = repo.reprioritize(job.id, 0, T0 + 4);
	expect(after.status).toBe('ready');
	expect(after.priority).toBe(5); // untouched — a finished cook has no queue position to fix
});

test('reprioritize works on an ASSIGNED job (event-typed-machine regression): the reconnect add lands during the ack window', () => {
	// The starvation feature exists for a cook already in flight when the singer's queue `add`
	// finally lands. "In flight" includes ASSIGNED (offered to a worker, ack still pending). Before
	// the event-typed machine this was a raw db.update that never consulted the table; after it,
	// reprioritize() routes through transition('REPRIORITIZE', …), so `assigned` MUST carry a
	// REPRIORITIZE self-loop or the whole onEntryAdded → reprioritizeCookForMedia path throws and the
	// queue:patch broadcast is dropped (clients silently diverge). This is that guard.
	const { repo } = makeRepo();
	const job = repo.enqueue('m-assigned', 'stems', Number.MAX_SAFE_INTEGER, T0); // NO_QUEUE_PRIORITY
	repo.assign(job.id, 'w', T0 + 10_000, T0 + 1); // assigned, ack lease pending
	expect(repo.byId(job.id)!.status).toBe('assigned');
	const after = repo.reprioritize(job.id, 1, T0 + 2); // must NOT throw
	expect(after.status).toBe('assigned'); // scheduling-only: status unchanged
	expect(after.priority).toBe(1); // pulled to the singer's rotation position
	expect(after.updatedAt).toBe(T0 + 2);
});

test('reprioritize on an assigned job still honours the only-lower guard', () => {
	const { repo } = makeRepo();
	const job = repo.enqueue('m-assigned2', 'stems', 3, T0);
	repo.assign(job.id, 'w', T0 + 10_000, T0 + 1);
	expect(repo.reprioritize(job.id, 5, T0 + 2).priority).toBe(3); // higher — refused, no throw
	expect(repo.reprioritize(job.id, 1, T0 + 3).priority).toBe(1); // lower — applied
	expect(repo.byId(job.id)!.status).toBe('assigned'); // never a lifecycle change
});

test('reprioritize works on an in-flight (running) job too, not only queued', () => {
	const { repo } = makeRepo();
	const job = repo.enqueue('m1', 'stems', 9, T0);
	repo.assign(job.id, 'w', null, T0 + 1);
	repo.accept(job.id, null, T0 + 2); // running
	const after = repo.reprioritize(job.id, 2, T0 + 3);
	expect(after.status).toBe('running');
	expect(after.priority).toBe(2);
});
