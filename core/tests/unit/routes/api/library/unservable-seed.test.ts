// A client that loads INSIDE the 120s window must still hear "no worker can run this". The hub's sweep says it once,
// on first sight, and a phone or TV that loads after that seeds its live statuses from /api/library's `processing`
// rows — which carried no verdict, so the reload drew "Making karaoke… 20%" and the TV "this takes a minute" again.
import { test, expect, afterEach } from 'bun:test';
import { GET } from '$routes/api/library/+server';
import { JobRepository } from '$lib/server/jobs/repository';
import { MediaRepository } from '$lib/server/media/repository';
import { migratedDb } from '$lib/server/db/test-db';
import { RoomLink } from '$lib/stores/room';
import { seedLiveStatus } from '$lib/tv/catalog';
import { AuthoritativeState } from '$lib/server/state/store';
import { UNSERVABLE_ERROR_PREFIX, WorkerHub } from '$lib/server/jobs/worker-hub';
import { WorkerRegistry } from '$lib/server/jobs/registry';
import { requiredCapability } from '$lib/server/jobs/dispatch';
import type { Media, QueueEntry } from '$lib/contract';

const APP_KEY = Symbol.for('encore.app');

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[APP_KEY];
});

const cooking = (id: string): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: id,
	durationSec: 200,
	stemStatus: 'queued'
});

async function processingRows(unservableJobs: (jobId: string) => boolean) {
	const db = migratedDb();
	const jobs = new JobRepository(db);
	jobs.enqueue('dead', 'stems', 0, 1_700_000_000_000);
	jobs.enqueue('live', 'stems', 0, 1_700_000_000_000);
	const deadJob = jobs.findOutstandingForMedia('dead')!.id;
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		mediaById: new Map([
			['dead', cooking('dead')],
			['live', cooking('live')]
		]),
		media: new MediaRepository(db),
		jobs,
		state: new AuthoritativeState(),
		workerHub: { isUnservable: (id: string) => id === deadJob && unservableJobs(id), noMakerMedia: () => [] },
		pendingDeletes: { has: () => false }
	};
	const res = await GET({
		url: new URL('http://x/api/library'),
		request: new Request('http://x/api/library')
	} as never);
	const body = (await res.json()) as { processing: { media: Media; unservable?: boolean }[] };
	return Object.fromEntries(body.processing.map((p) => [p.media.id, p]));
}

test("the library's processing row carries the hub's unservable verdict, and only for the job it names", async () => {
	const rows = await processingRows(() => true);
	expect(rows.dead).toMatchObject({ unservable: true });
	expect(rows.live!.unservable).toBeUndefined();
});

test('a job the sweep has not condemned seeds no verdict', async () => {
	const rows = await processingRows(() => false);
	expect(rows.dead!.unservable).toBeUndefined();
});

test('the phone keeps the verdict when it seeds its live statuses from that row', () => {
	const room = new RoomLink();
	room.seedMediaStatus([{ media: cooking('dead'), status: 'queued', pct: 0, unservable: true }]);
	expect(room.mediaStatus.get('dead')).toMatchObject({ unservable: true });
});

test('the TV keeps the verdict too, and a status already heard live wins', () => {
	const seeded = seedLiveStatus(new Map(), [{ media: cooking('dead'), status: 'queued', pct: 0, unservable: true }]);
	expect(seeded.get('dead')).toMatchObject({ mediaId: 'dead', unservable: true });
	const heard = new Map([
		['dead', { type: 'media:status' as const, mediaId: 'dead', status: 'failed' as const, pct: 0 }]
	]);
	expect(
		seedLiveStatus(heard, [{ media: cooking('dead'), status: 'queued', pct: 0, unservable: true }]).get('dead')
	).toMatchObject({ status: 'failed' });
});

test("a reconnecting TV's seed gives a held failure the server's current cause, both ways", () => {
	const fail = (id: string, unservable?: true) =>
		[id, { type: 'media:status' as const, mediaId: id, status: 'failed' as const, pct: 0, unservable }] as const;
	const seeded = seedLiveStatus(new Map([fail('plain'), fail('stale', true)]), [], ['plain']);
	expect(seeded.get('plain')).toMatchObject({ status: 'failed', unservable: true });
	expect(seeded.get('stale')?.unservable).toBeUndefined();
});

/* AFTER THE TTL: the job is terminal and the media settled back to un-processed, so it is in no `processing` row.
   The reason it died is only in `jobs.error`, and a client that loads now must still say "no maker". */
const settled = (id: string): Media => ({ ...cooking(id), stemStatus: 'none' });
const queued = (id: string, mediaId: string): QueueEntry => ({
	id,
	mediaId,
	singerId: 's1',
	status: 'queued',
	rotationSeq: 0,
	addedAt: 1
});

/** The route against a REAL hub, with one connected worker offering `caps` (none when empty). */
async function noMakerFailed(caps: string[] = []) {
	const db = migratedDb();
	const jobs = new JobRepository(db);
	const T = 1_700_000_000_000;
	jobs.fail(jobs.enqueue('nomaker', 'stems', 0, T).id, `${UNSERVABLE_ERROR_PREFIX} 'stems' within 120s`, T);
	// A real failure that happens to quote a name: only the TTL's own prefix makes a death "no maker".
	jobs.fail(jobs.enqueue('broke', 'stems', 0, T).id, "worker 'w1' ran out of memory", T);
	// Died for want of a worker, but nobody holds a turn for it: not the room's business.
	jobs.fail(jobs.enqueue('unqueued', 'stems', 0, T).id, `${UNSERVABLE_ERROR_PREFIX} 'stems' within 120s`, T);
	// Same death, but its turn is not a waiting one: the list names turns that are WAITING on a maker.
	jobs.fail(jobs.enqueue('sung', 'stems', 0, T).id, `${UNSERVABLE_ERROR_PREFIX} 'stems' within 120s`, T);
	// Same death, but a Try again has the song cooking again: its live row speaks for it, not this list.
	jobs.fail(jobs.enqueue('retried', 'stems', 0, T).id, `${UNSERVABLE_ERROR_PREFIX} 'stems' within 120s`, T);
	const state = new AuthoritativeState();
	state.hydrate(
		[
			queued('e1', 'nomaker'),
			queued('e2', 'broke'),
			{ ...queued('e3', 'sung'), status: 'playing' },
			queued('e4', 'retried')
		],
		null
	);
	const mediaById = new Map([
		...['nomaker', 'broke', 'unqueued', 'sung'].map((id) => [id, settled(id)] as const),
		['retried', cooking('retried')]
	]);
	const registry = new WorkerRegistry();
	if (caps.length) registry.hello('w1', caps, 1, '1', T);
	const workerHub = new WorkerHub({
		queueEntries: () => [],
		jobs,
		registry,
		mediaById,
		toWorker: () => {},
		broadcast: () => {},
		now: () => T
	});
	(globalThis as Record<PropertyKey, unknown>)[APP_KEY] = {
		mediaById,
		media: new MediaRepository(db),
		jobs,
		state,
		workerHub,
		pendingDeletes: { has: () => false }
	};
	const res = await GET({
		url: new URL('http://x/api/library'),
		request: new Request('http://x/api/library')
	} as never);
	return ((await res.json()) as { noMakerFailed: string[] }).noMakerFailed;
}

test('after the TTL the library names the queued turns that died for want of a worker, and only those', async () => {
	expect(await noMakerFailed()).toEqual(['nomaker']);
});

const STEMS = requiredCapability('stems');
const ALIGN = requiredCapability('align');

test('"no maker" is about now: once workers bring every step from the dead one on, the list is empty', async () => {
	expect(await noMakerFailed([STEMS, ALIGN])).toEqual([]);
	// The dead step alone does not make the song singable: its lyrics still have no maker.
	expect(await noMakerFailed([STEMS])).toEqual(['nomaker']);
	// A worker that brings something else changes nothing.
	expect(await noMakerFailed([ALIGN])).toEqual(['nomaker']);
});

test("a scar is this device's stand-in: the server's library row replaces it, a live status is kept", () => {
	const room = new RoomLink();
	room.seedScars([settled('retried'), settled('heard')]);
	// This phone has acted on `heard` since (a Try again); the scar for `retried` is still all it knows.
	room.setMediaStatus('heard', { status: 'separating', pct: 40 });
	room.seedMediaStatus([
		{ media: cooking('retried'), status: 'queued', pct: 0, unservable: true },
		{ media: cooking('heard'), status: 'queued', pct: 0 }
	]);
	expect(room.mediaStatus.get('retried')).toMatchObject({ status: 'queued', unservable: true });
	expect(room.mediaStatus.get('heard')).toMatchObject({ status: 'separating', pct: 40 });
});

test("after the TTL a scar takes the server's no-maker cause, so the phone says what the TV says", () => {
	const room = new RoomLink();
	room.seedScars([settled('nomaker')]);
	room.seedNoMakerFailures(['nomaker']);
	expect(room.mediaStatus.get('nomaker')).toMatchObject({ status: 'failed', unservable: true });
	const tv = seedLiveStatus(new Map(), [], ['nomaker']);
	expect(tv.get('nomaker')).toMatchObject({ status: 'failed', unservable: true });
});

test("the phone's library refresh reads noMakerFailed, so a reload after the TTL still says no maker", async () => {
	const real = globalThis.fetch;
	globalThis.fetch = (() =>
		Promise.resolve(
			new Response(JSON.stringify({ library: [], processing: [], noMakerFailed: ['nomaker'] }), { status: 200 })
		)) as unknown as typeof fetch;
	try {
		const room = new RoomLink();
		await room.refreshLibrary();
		expect(room.mediaStatus.get('nomaker')).toMatchObject({ status: 'failed', unservable: true });
	} finally {
		globalThis.fetch = real;
	}
});
