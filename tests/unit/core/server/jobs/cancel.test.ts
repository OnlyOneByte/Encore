// Done-when: an explicit remove of a mid-processing song cancels its live cook — marking the job
// canceled (freeing the dedup slot so a re-add mints a NEW job), and telling the OWNING worker to
// kill its subprocess. Plus the four correctness edges: a shared cook (another entry still needs the
// media) is NOT cancelled; an already-terminal (ready) job is not touched; and the whole thing runs
// through the real queue-command remove path (handleQueueCommand) exactly as server.ts composes it.
import { test, expect } from 'bun:test';
import { migratedDb } from '$server/db/test-db';
import { cancelJobsForMedia } from '$server/jobs/cancel';
import { JobRepository } from '$server/jobs/repository';
import { handleQueueCommand, type HubDeps } from '$server/realtime/hub';
import { AuthoritativeState } from '$server/state/store';
import { WorkerHub } from '$server/jobs/worker-hub';
import { WorkerRegistry } from '$server/jobs/registry';
import type { WorkerCommand, QueueEntry, Media, ClientCommand, ServerEvent } from '$shared';
import { readyToSing } from '$shared';

const T0 = 1_700_000_000_000;

function makeRepo() {
	const db = migratedDb();
	return new JobRepository(db);
}

const cookingMedia = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 100,
	stemStatus: 'queued'
});

/** A capturing toWorker sink + the deps the helper needs, with an empty post-remove queue by default.
 *  Also wires a media catalog + a broadcast sink so the settle-and-notify half of a cancel can be
 *  asserted; the mediaById defaults to one cooking entry for `m1`. */
function cancelDeps(
	jobs: JobRepository,
	remainingEntries: QueueEntry[] = [],
	mediaById: Map<string, Media> = new Map([['m1', cookingMedia('m1')]])
) {
	const sent: { workerId: string; cmd: WorkerCommand }[] = [];
	const broadcasts: ServerEvent[] = [];
	return {
		sent,
		broadcasts,
		mediaById,
		deps: {
			jobs,
			toWorker: (workerId: string, cmd: WorkerCommand) => sent.push({ workerId, cmd }),
			remainingEntries,
			now: () => T0 + 1000,
			mediaById,
			broadcast: (e: ServerEvent) => broadcasts.push(e)
		}
	};
}

test('cancelling a sole QUEUED job marks it canceled and frees the dedup slot', () => {
	const jobs = makeRepo();
	const job = jobs.enqueue('m1', 'stems', 0, T0); // queued, no worker yet
	const { sent, deps } = cancelDeps(jobs);

	const res = cancelJobsForMedia('m1', deps);

	expect(res.canceled).toEqual([job.id]);
	expect(jobs.byId(job.id)!.status).toBe('canceled');
	expect(jobs.findLive('m1', 'stems')).toBeNull(); // slot freed
	expect(sent).toHaveLength(0); // no worker owned it — nothing to notify
});

test('a later re-add after a cancel creates a genuinely NEW job (song re-cookable)', () => {
	const jobs = makeRepo();
	const first = jobs.enqueue('m1', 'stems', 0, T0);
	const { deps } = cancelDeps(jobs);
	cancelJobsForMedia('m1', deps);

	const reborn = jobs.enqueue('m1', 'stems', 0, T0 + 5000);
	expect(reborn.id).not.toBe(first.id);
	expect(reborn.status).toBe('queued');
});

test('cancelling a RUNNING job also emits job:cancel to the OWNING worker', () => {
	const jobs = makeRepo();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'worker-A', T0 + 10_000, T0 + 1);
	jobs.accept(job.id, T0 + 30_000, T0 + 2); // running, owned by worker-A
	const { sent, deps } = cancelDeps(jobs);

	const res = cancelJobsForMedia('m1', deps);

	expect(res.canceled).toEqual([job.id]);
	expect(res.notifiedWorkers).toEqual(['worker-A']);
	expect(sent).toHaveLength(1);
	expect(sent[0].workerId).toBe('worker-A');
	expect(sent[0].cmd).toMatchObject({ type: 'job:cancel', jobId: job.id });
	expect(jobs.byId(job.id)!.status).toBe('canceled');
});

test('cancels across pipeline stages: fetch, stems, align, and a background upgrade', () => {
	const jobs = makeRepo();
	// One live job per stage for the same media (distinct jobType each → distinct dedup slots).
	const fetch = jobs.enqueue('m1', 'fetch', 0, T0);
	const stems = jobs.enqueue('m1', 'stems', 0, T0);
	const align = jobs.enqueue('m1', 'align', 0, T0);
	const upgrade = jobs.enqueue('m1', 'stems-upgrade', 0, T0);
	const { deps } = cancelDeps(jobs);

	const res = cancelJobsForMedia('m1', deps);

	expect(new Set(res.canceled)).toEqual(new Set([fetch.id, stems.id, align.id, upgrade.id]));
	for (const t of ['fetch', 'stems', 'align', 'stems-upgrade'] as const) {
		expect(jobs.findLive('m1', t)).toBeNull();
	}
});

test('EDGE (a) shared cook: does NOT cancel while another entry still references the media', () => {
	const jobs = makeRepo();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'worker-A', T0 + 10_000, T0 + 1);
	jobs.accept(job.id, T0 + 30_000, T0 + 2); // running
	// The post-remove queue STILL has an entry pointing at m1 (a second singer queued the same song).
	const survivor: QueueEntry = {
		id: 'q-other',
		mediaId: 'm1',
		singerId: 's2',
		status: 'queued',
		rotationSeq: 0,
		addedAt: T0
	};
	const { sent, deps } = cancelDeps(jobs, [survivor]);

	const res = cancelJobsForMedia('m1', deps);

	expect(res.canceled).toEqual([]); // the shared cook lives on
	expect(res.notifiedWorkers).toEqual([]);
	expect(sent).toHaveLength(0);
	expect(jobs.byId(job.id)!.status).toBe('running'); // untouched — another singer is waiting on it
});

test('EDGE (b) already-terminal: a job that finished (ready) is not cancelled', () => {
	const jobs = makeRepo();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'worker-A', T0 + 10_000, T0 + 1);
	jobs.accept(job.id, T0 + 30_000, T0 + 2);
	jobs.complete(job.id, T0 + 3); // terminal `ready` — still occupies the dedup slot
	expect(jobs.findLive('m1', 'stems')!.status).toBe('ready'); // findLive returns it
	const { sent, deps } = cancelDeps(jobs);

	// Must NOT throw (cancel on a terminal job is an illegal transition) and must not touch it.
	const res = cancelJobsForMedia('m1', deps);

	expect(res.canceled).toEqual([]);
	expect(sent).toHaveLength(0);
	expect(jobs.byId(job.id)!.status).toBe('ready'); // left ready
});

test('no live cook for the media: a plain (never-cooked) remove is a harmless no-op', () => {
	const jobs = makeRepo();
	const { deps } = cancelDeps(jobs);
	const res = cancelJobsForMedia('m-never-cooked', deps);
	expect(res).toEqual({ canceled: [], notifiedWorkers: [] });
});

// ── FIX 1: a cancel must un-strand the MEDIA, not just clear the job ledger ───────────────────────
// requestMakeKaraoke flips stemStatus to 'queued' BEFORE the cook. Cancelling the job left that flag
// mid-flight, so the song read as cooking forever on every surface and cookState refused a re-cook —
// the identical stranding settleStemsGate already fixes on the FAILURE path.

test('cancelling a live cook settles the media back to un-cooked and broadcasts it', () => {
	const jobs = makeRepo();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'worker-A', T0 + 10_000, T0 + 1);
	jobs.accept(job.id, T0 + 30_000, T0 + 2); // running, cooking
	const { deps, mediaById, broadcasts } = cancelDeps(jobs);
	expect(mediaById.get('m1')!.stemStatus).toBe('queued'); // in flight before

	cancelJobsForMedia('m1', deps);

	expect(mediaById.get('m1')!.stemStatus).toBe('none'); // settled → cookable + Sing button back
	// The one signal the phone treats as "settle to un-cooked" is 'failed' (see cancel.ts) — every
	// other value would be written back as mid-flight 'queued' and re-strand the row.
	const statuses = broadcasts.filter((e) => e.type === 'media:status');
	// 'canceled', not 'failed': it settles the row the same way but never makes the phone tell the
	// guest who removed the song that the cook broke.
	expect(statuses.at(-1)).toMatchObject({ type: 'media:status', mediaId: 'm1', status: 'canceled', pct: 0 });
});

test('a SHARED cook (edge a) neither settles the media nor broadcasts — another singer still wants it', () => {
	const jobs = makeRepo();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'worker-A', T0 + 10_000, T0 + 1);
	jobs.accept(job.id, T0 + 30_000, T0 + 2);
	const survivor: QueueEntry = {
		id: 'q-other',
		mediaId: 'm1',
		singerId: 's2',
		status: 'queued',
		rotationSeq: 0,
		addedAt: T0
	};
	const { deps, mediaById, broadcasts } = cancelDeps(jobs, [survivor]);

	cancelJobsForMedia('m1', deps);

	expect(mediaById.get('m1')!.stemStatus).toBe('queued'); // the shared cook lives on, so does the flag
	expect(broadcasts).toHaveLength(0);
});

test('a no-op cancel (nothing live) does not touch the media or broadcast', () => {
	const jobs = makeRepo();
	const { deps, mediaById, broadcasts } = cancelDeps(jobs);
	cancelJobsForMedia('m1', deps); // no live job for m1
	expect(mediaById.get('m1')!.stemStatus).toBe('queued'); // unchanged — we cancelled nothing
	expect(broadcasts).toHaveLength(0);
});

// ── through the real remove path (handleQueueCommand), the way server.ts composes it ──────────────

const media = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'x',
	title: id,
	durationSec: 100,
	stemStatus: 'queued'
});
const addCmd = (id: string, mediaId: string, singerId: string): ClientCommand => ({
	clientOpId: 'add-' + id,
	op: {
		op: 'add',
		entry: { id, mediaId, singerId, status: 'queued', rotationSeq: -1, addedAt: Date.now() } as QueueEntry
	}
});
const removeCmd = (id: string, _singerId: string): ClientCommand => ({
	clientOpId: 'rm-' + id,
	op: { op: 'remove', id }
});

function hubHarness(jobs: JobRepository, actorSingerId: string) {
	const state = new AuthoritativeState();
	const sent: { workerId: string; cmd: WorkerCommand }[] = [];
	const deps: HubDeps = {
		state,
		publish: () => {},
		mediaById: new Map([['m1', media('m1')]]),
		actorSingerId,
		// Exactly the wiring server.ts uses.
		onEntryRemoved: (mediaId, remainingEntries) =>
			cancelJobsForMedia(mediaId, {
				jobs,
				toWorker: (w, c) => sent.push({ workerId: w, cmd: c }),
				remainingEntries,
				now: () => T0 + 1000
			})
	};
	return { state, deps, sent };
}

test('remove op through handleQueueCommand cancels the sole live cook', () => {
	const jobs = makeRepo();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'worker-A', T0 + 10_000, T0 + 1);
	jobs.accept(job.id, T0 + 30_000, T0 + 2);
	const { deps, sent } = hubHarness(jobs, 's1');
	handleQueueCommand(addCmd('q1', 'm1', 's1'), deps);

	handleQueueCommand(removeCmd('q1', 's1'), deps);

	expect(jobs.byId(job.id)!.status).toBe('canceled');
	expect(sent).toHaveLength(1);
	expect(sent[0].cmd).toMatchObject({ type: 'job:cancel', jobId: job.id });
});

test('remove of ONE of two entries for the same song does NOT cancel the shared cook', () => {
	const jobs = makeRepo();
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	const { deps, sent } = hubHarness(jobs, 's1');
	// Two singers queue the same song; one job (dedup). Both entries authored by the same session for
	// the test's actor gate, but they are two distinct queue entries pointing at m1.
	handleQueueCommand(addCmd('q1', 'm1', 's1'), deps);
	handleQueueCommand(addCmd('q2', 'm1', 's1'), deps);

	handleQueueCommand(removeCmd('q1', 's1'), deps); // q2 still needs m1

	expect(jobs.byId(job.id)!.status).toBe('queued'); // cook untouched
	expect(sent).toHaveLength(0);
});

test('EDGE (b) reverse: a job:complete landing AFTER a cancel is dropped as stale', () => {
	// worker-hub's #onComplete already guards `status !== 'running'`; a canceled job is terminal, so a
	// late completion from the worker (kill and completion crossing on the wire) must not resurrect it.
	const jobs = makeRepo();
	const registry = new WorkerRegistry();
	const mediaById = new Map<string, Media>([['m1', media('m1')]]);
	const hub = new WorkerHub({
		jobs,
		registry,
		mediaById,
		toWorker: () => {},
		broadcast: () => {},
		now: () => T0 + 2000
	});
	const job = jobs.enqueue('m1', 'stems', 0, T0);
	jobs.assign(job.id, 'worker-A', T0 + 10_000, T0 + 1);
	jobs.accept(job.id, T0 + 30_000, T0 + 2); // running, worker-A owns it

	// The remove cancels it first.
	cancelJobsForMedia('m1', cancelDeps(jobs).deps);
	expect(jobs.byId(job.id)!.status).toBe('canceled');

	// Then the worker's completion arrives late. It is a no-op — the media never flips to ready.
	hub.handle({ type: 'job:complete', workerId: 'worker-A', jobId: job.id, mediaUri: 'media/m1-instrumental.mp3' });

	expect(jobs.byId(job.id)!.status).toBe('canceled'); // still canceled, not resurrected to ready
	expect(mediaById.get('m1')!.stemStatus).toBe('queued'); // never flipped to ready
});

// ── FIX: a cancel on the LYRICS step must settle THAT gate, not only stems ───────────────────
// A song finishes separation (stemStatus 'ready', a real instrumentalRef), followUps enqueues `align`
// and markLyricsQueued sets lyricsStatus 'queued' — the phone shows "Timing lyrics". A remove cancels
// the align job. Before the fix, cancel.ts only called settleStemsGate, which refuses a finished cook
// (a no-op), so the lyrics gate stayed OPEN forever: readyToSing was false, every future queue entry
// for the song was held and skipped, yet the live instrumental made cookState refuse a re-cook — and
// the broadcast, gated on that no-op settle, never fired. A song with no words is a finished song, so
// cancelling align must settle the lyrics gate exactly as the terminal-failure path does.

const separatedTimingLyrics = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 100,
	stemStatus: 'ready',
	instrumentalRef: 'derived/stems/' + id + '-instrumental.flac',
	lyricsStatus: 'queued'
});

test('cancelling an ALIGN job on a separated song settles the lyrics gate → readyToSing (not bricked)', () => {
	const jobs = makeRepo();
	const align = jobs.enqueue('m1', 'align', 0, T0);
	jobs.assign(align.id, 'worker-A', T0 + 10_000, T0 + 1);
	jobs.accept(align.id, T0 + 30_000, T0 + 2); // running — the "Timing lyrics" step
	const mediaById = new Map<string, Media>([['m1', separatedTimingLyrics('m1')]]);
	const { deps, broadcasts } = cancelDeps(jobs, [], mediaById);

	expect(readyToSing(mediaById.get('m1')!)).toBe(false); // lyrics gate open before the cancel

	const res = cancelJobsForMedia('m1', deps);

	expect(res.canceled).toEqual([align.id]);
	// The whole point: the song is now a finished (word-less) song, playable rather than held forever.
	expect(mediaById.get('m1')!.lyricsStatus).toBe('ready');
	expect(readyToSing(mediaById.get('m1')!)).toBe(true);
	// The separation is NOT walked back — cancelling align must not un-cook a finished separation.
	expect(mediaById.get('m1')!.stemStatus).toBe('ready');
	expect(mediaById.get('m1')!.instrumentalRef).toBe('derived/stems/m1-instrumental.flac');
	// And the room hears about it — before the fix the broadcast was gated on the stems no-op and never fired.
	const statuses = broadcasts.filter((e) => e.type === 'media:status');
	expect(statuses.at(-1)).toMatchObject({ type: 'media:status', mediaId: 'm1', status: 'canceled', pct: 0 });
});
