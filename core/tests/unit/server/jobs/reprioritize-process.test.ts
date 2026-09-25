// The starvation half of, end to end. A process filed while the singer's queue add was still in
// flight over a reconnecting socket is stamped NO_QUEUE_PRIORITY (nobody waiting yet). Once the add
// lands, dispatch's `priority ASC, createdAt ASC` sort must NOT keep sorting it behind the
// boot-time lyrics backfill forever. This drives the REAL JobRepository + the real hub add path
// (handleQueueCommand -> onEntryAdded -> reprioritizeProcessForMedia) + the real dispatch policy, so
// the assertion is the observable end effect: the drained dispatch ORDER, not just a priority field.
import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { JobRepository } from '$lib/server/jobs/repository';
import { planAssignments } from '$lib/server/jobs/dispatch';
import { reprioritizeProcessForMedia } from '$lib/server/jobs/reprioritize-process';
import { handleQueueCommand, type HubDeps } from '$lib/server/realtime/hub';
import { AuthoritativeState } from '$lib/server/state/store';
import { NO_QUEUE_PRIORITY } from '$lib/server/jobs/process';
import { EMPTY_SONG_PROFILE, type Media, type QueueEntry, type ClientCommand, type ServerEvent } from '$lib/contract';
import type { WorkerSession } from '$lib/server/jobs/registry';

const T0 = 1_700_000_000_000;

function makeRepo() {
	const db = migratedDb();
	return new JobRepository(db);
}

const media = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	stemStatus: 'queued',
	lyricsStatus: 'queued',
	instrumentalRef: undefined,
	songProfile: EMPTY_SONG_PROFILE
});

let _s = 0;
const addCmd = (id: string, mediaId: string, singerId = 's1'): ClientCommand => ({
	clientOpId: 'op-' + id,
	op: { op: 'add', entry: { id, mediaId, singerId, status: 'queued', rotationSeq: -1, addedAt: ++_s } as QueueEntry }
});

const worker = (id: string, slotsFree: number): WorkerSession => ({
	workerId: id,
	capabilities: ['fetch', 'stems', 'align'],
	concurrency: slotsFree,
	version: '1',
	slotsFree,
	lastSeen: T0
});

// Build the hub deps EXACTLY as server.ts composes them for the add side: wire onEntryAdded to the
// real reprioritizeProcessForMedia over the real repo. dispatch() is a spy so we can assert the kick.
function harness(jobs: JobRepository) {
	const published: ServerEvent[] = [];
	const state = new AuthoritativeState();
	let dispatched = 0;
	const deps: HubDeps = {
		state,
		publish: (e) => published.push(e),
		mediaById: new Map([
			['m-starved', media('m-starved')],
			['m-other', media('m-other')]
		]),
		actorSingerId: 's1',
		onEntryAdded: (mediaId, entries) =>
			reprioritizeProcessForMedia(mediaId, {
				jobs,
				entries,
				now: () => T0 + 100,
				dispatch: () => {
					dispatched++;
				}
			})
	};
	return { published, state, deps, dispatched: () => dispatched };
}

// Drain the whole queued set through the real policy one job at a time, recording pick order —
// this is what the room actually experiences, and where the tiebreak bug is observable.
function drainedOrder(jobs: JobRepository, workers: WorkerSession[]): string[] {
	return planAssignments(jobs.listByStatus('queued'), workers).map((a) => a.jobId);
}

test('BUG SHAPE: a NO_QUEUE_PRIORITY process sorts behind the boot lyrics backfill (createdAt tiebreak)', () => {
	const jobs = makeRepo();
	// A lyrics backfill enqueued at server boot, also at NO_QUEUE_PRIORITY, earlier createdAt.
	jobs.enqueue('m-backfill', 'align', NO_QUEUE_PRIORITY, T0);
	// The reconnect process: filed while nobody was waiting, so also NO_QUEUE_PRIORITY but LATER.
	const starved = jobs.enqueue('m-starved', 'stems', NO_QUEUE_PRIORITY, T0 + 1);
	expect(starved.priority).toBe(NO_QUEUE_PRIORITY);

	// With unlimited slots, both dispatch — but the backfill wins the createdAt tie and goes first.
	const order = drainedOrder(jobs, [worker('w', 4)]);
	expect(order.indexOf(starved.id)).toBeGreaterThan(order.indexOf(jobs.findLive('m-backfill', 'align')!.id));
});

test('reconnect add pulls the starved process AHEAD of the backfill via the hub onEntryAdded seam', () => {
	const jobs = makeRepo();
	const backfill = jobs.enqueue('m-backfill', 'align', NO_QUEUE_PRIORITY, T0);
	const starved = jobs.enqueue('m-starved', 'stems', NO_QUEUE_PRIORITY, T0 + 1);

	const { deps, dispatched } = harness(jobs);
	// Seed a same-media entry via the real add so a turn now precedes the starved process, then the
	// singer's own turn lands on reconnect at a soonest rotationSeq the process should inherit.
	handleQueueCommand(addCmd('e-other', 'm-other'), deps); // rotationSeq 0
	handleQueueCommand(addCmd('e-starved', 'm-starved'), deps); // rotationSeq 1 — the reconnect turn

	// onEntryAdded fired reprioritizeProcessForMedia, which lowered the process and kicked dispatch.
	expect(jobs.byId(starved.id)!.priority).toBe(1); // was NO_QUEUE_PRIORITY, now the turn's rotationSeq
	expect(dispatched()).toBeGreaterThan(0);

	// Observable end effect: the starved process now sorts AHEAD of the untouched backfill.
	const order = drainedOrder(jobs, [worker('w', 4)]);
	expect(order.indexOf(starved.id)).toBeLessThan(order.indexOf(backfill.id));
	// And the backfill was never touched — reprioritize only ever lowers, never demotes a sibling.
	expect(jobs.byId(backfill.id)!.priority).toBe(NO_QUEUE_PRIORITY);
});

test('adding a DIFFERENT song does not disturb an unrelated process', () => {
	const jobs = makeRepo();
	const starved = jobs.enqueue('m-starved', 'stems', NO_QUEUE_PRIORITY, T0);
	const { deps, dispatched } = harness(jobs);
	handleQueueCommand(addCmd('e-other', 'm-other'), deps); // a turn for m-other, not m-starved
	expect(jobs.byId(starved.id)!.priority).toBe(NO_QUEUE_PRIORITY); // untouched
	expect(dispatched()).toBe(0); // no process for m-other in flight → no kick
});

test('reprioritizeProcessForMedia is a no-op when the process already sits at its turn position', () => {
	const jobs = makeRepo();
	const healthy = jobs.enqueue('m-starved', 'stems', 2, T0); // already filed at a good position
	const entries: QueueEntry[] = [
		{ id: 'e1', mediaId: 'm-starved', singerId: 's1', status: 'queued', rotationSeq: 5, addedAt: 1 } as QueueEntry
	];
	let kicked = 0;
	const changed = reprioritizeProcessForMedia('m-starved', {
		jobs,
		entries,
		now: () => T0 + 1,
		dispatch: () => {
			kicked++;
		}
	});
	expect(changed).toBe(false); // soonest turn (5) is WORSE than current (2) → nothing to do
	expect(jobs.byId(healthy.id)!.priority).toBe(2);
	expect(kicked).toBe(0);
});
