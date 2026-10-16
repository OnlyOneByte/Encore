/*
 * ONE RULE, TWO SHAPES. `findOutstandingForMedia` answers for one song in up to three point selects;
 * `mediaWithOutstandingJob` answers for every song in one. The second exists because the dead-turn sweep
 * asks the question about every media holding a queued entry on every 3s reaper tick — 79 such media on the
 * owner's library copy, so up to ~240 point selects every 3 s. WHY the set is cheaper is NOT "one scan of
 * the few live rows", and that phrasing was measured false before it was deleted from here: the set query
 * plans as a full `SCAN jobs` over every row in the ledger. `JobRepository.mediaWithOutstandingJob`'s own
 * doc carries the measurement and the real reason (per-call query-builder overhead, not query cost); this
 * file does not restate it. What this file is for is the other half: the moment there are two statements of
 * a rule, the job of a test is to stop them drifting.
 *
 * THE TRAP BOTH MUST REPEAT: `findLive` excludes only SLOT_FREEING_STATUSES (failed, canceled), so it
 * RETURNS a terminal `ready` job — a `ready` job still occupies the dedup slot. A predicate built on its
 * truthiness therefore calls a fully separated song "still working", and in the dead-turn reader that
 * inverts the answer: every song whose fetch+stems+align all completed would read as in-flight and no dead
 * turn would ever be found. Each arm below walks one status through BOTH functions, so neither can quietly
 * take the `ready` row as live.
 */
import { expect, test } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { JobRepository } from '$lib/server/jobs/repository';
import { TERMINAL_JOB_STATUSES, type JobStatus, type JobType } from '$lib/contract';
import { ackDeadline, progressDeadline } from '$lib/server/jobs/leases';

const T0 = 1_700_000_000_000;

/** Drive a real job to `status` through the real transitions, so no arm asserts over an illegal row. */
function jobAt(jobs: JobRepository, mediaId: string, jobType: JobType, status: JobStatus): void {
	const job = jobs.enqueue(mediaId, jobType, 0, T0);
	if (status === 'queued') return;
	jobs.assign(job.id, 'w1', ackDeadline(T0), T0);
	if (status === 'assigned') return;
	if (status === 'canceled') {
		jobs.cancel(job.id, T0 + 1);
		return;
	}
	jobs.accept(job.id, progressDeadline(T0), T0 + 1);
	if (status === 'running') return;
	if (status === 'failed') jobs.fail(job.id, 'boom', T0 + 2);
	else jobs.complete(job.id, T0 + 2);
}

const ALL_STATUSES: JobStatus[] = ['queued', 'assigned', 'running', 'ready', 'failed', 'canceled'];

for (const status of ALL_STATUSES) {
	const terminal = (TERMINAL_JOB_STATUSES as readonly JobStatus[]).includes(status);
	test(`a ${status} stems job: both readers agree it is ${terminal ? 'NOT ' : ''}outstanding`, () => {
		const jobs = new JobRepository(migratedDb());
		jobAt(jobs, 'm1', 'stems', status);
		const single = jobs.findOutstandingForMedia('m1') !== null;
		const set = jobs.mediaWithOutstandingJob().has('m1');
		expect(single).toBe(!terminal);
		expect(set, 'the set-valued twin disagreed with findOutstandingForMedia').toBe(single);
	});
}

test('a `ready` job does not keep a song outstanding, even though findLive still returns it', () => {
	// Spelled out beyond the loop because it is the one case where "live" and "outstanding" differ, and the
	// reason the chain walk tests `status !== 'ready'` rather than mere presence.
	const jobs = new JobRepository(migratedDb());
	jobAt(jobs, 'm1', 'stems', 'ready');
	expect(jobs.findLive('m1', 'stems')).not.toBeNull();
	expect(jobs.findOutstandingForMedia('m1')).toBeNull();
	expect(jobs.mediaWithOutstandingJob().has('m1')).toBe(false);
});

test('the chain is all three steps: a live align keeps a song outstanding after fetch and stems finished', () => {
	// The arm NO CLIENT CAN SEE, and therefore the one most likely to be dropped as speculative: such a media
	// reads 'processing' off the catalog, not 'unacquired', so the phone's own stalled arm never fires for it.
	const jobs = new JobRepository(migratedDb());
	jobAt(jobs, 'm1', 'fetch', 'ready');
	jobAt(jobs, 'm1', 'stems', 'ready');
	jobAt(jobs, 'm1', 'align', 'running');
	expect(jobs.findOutstandingForMedia('m1')?.jobType).toBe('align');
	expect(jobs.mediaWithOutstandingJob().has('m1')).toBe(true);
});

test('a stems-upgrade is NOT outstanding: it runs on a song that is already singable', () => {
	// Both readers must exclude it, or a background re-separation would protect a turn whose required gates
	// are open — the case `shouldBroadcastProcess` already refuses to report to the room.
	const jobs = new JobRepository(migratedDb());
	jobAt(jobs, 'm1', 'stems-upgrade', 'running');
	expect(jobs.findOutstandingForMedia('m1')).toBeNull();
	expect(jobs.mediaWithOutstandingJob().has('m1')).toBe(false);
});

test('the set names every song with live work and nothing else, in one call', () => {
	const jobs = new JobRepository(migratedDb());
	jobAt(jobs, 'live-fetch', 'fetch', 'queued');
	jobAt(jobs, 'live-stems', 'stems', 'running');
	jobAt(jobs, 'done', 'stems', 'ready');
	jobAt(jobs, 'dead', 'fetch', 'failed');
	jobAt(jobs, 'removed', 'stems', 'canceled');
	expect([...jobs.mediaWithOutstandingJob()].sort()).toEqual(['live-fetch', 'live-stems']);
});
