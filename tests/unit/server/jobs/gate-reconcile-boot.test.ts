// Boot reconciliation of a readiness gate left in-flight by a process that can never finish. A durable settle at failure
// time cannot reach BACKWARDS: a row written before it, or by a crash between the settle and the write, still reads
// `'queued'` in SQLite while its job row is terminal or gone. Nothing re-derives it — `hydrateMediaCatalog` reads the
// stored value verbatim and wins at boot over the sidecar path, the job that would have settled the gate is dead, and
// the reaper only sweeps jobs still in flight. So the song comes back reading "Making karaoke… N%" with no Sing button
// and `readyToSing` false, and no guest action clears it.
//
// Two safety properties make the pass shippable, both asserted rather than argued: it NEVER touches a song whose gate is
// legitimately in flight (a queued, assigned or running job of a type that could still settle it), and it is IDEMPOTENT,
// so it stays wired permanently instead of being a one-shot script. The arms drive a REAL migrated database through the
// REAL repositories and restart the way production does, because the defect IS the durable row and the map disagreeing.

import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { JobRepository } from '$lib/server/jobs/repository';
import { AttemptLedger } from '$lib/server/jobs/attempts';
import { MediaRepository, hydrateMediaCatalog } from '$lib/server/media/repository';
import { reconcileStrandedGates } from '$lib/server/jobs/gate-reconcile';
import { instrumentalKey } from '$lib/server/media/paths';
import { EMPTY_SONG_PROFILE, isProcessing, readyToSing, type JobStatus, type Media } from '$lib/contract';

const T0 = 1_700_000_000_000;

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: 'vid-' + id,
	title: 'Song ' + id,
	durationSec: 200,
	stemStatus: 'none',
	...over
});

/** A song whose separation finished — the shape a healthy library row has. */
const processed = (id: string, over: Partial<Media> = {}): Media =>
	media(id, {
		stemStatus: 'ready',
		lyricsStatus: 'ready',
		instrumentalRef: instrumentalKey(id),
		songProfile: { ...EMPTY_SONG_PROFILE },
		...over
	});

interface Harness {
	jobs: JobRepository;
	mediaRepo: MediaRepository;
	/** Everything handed to the persistence sink, in order — the durable half of the settle. */
	persisted: string[];
	/** Re-boot: a fresh runtime map hydrated from the DURABLE rows, exactly as app.ts does. */
	reboot: () => Map<string, Media>;
	/** The pass, wired over this harness's repositories the way boot wires it. */
	run: (mediaById: Map<string, Media>) => string[];
}

function harness(): Harness {
	const db = migratedDb();
	const jobs = new JobRepository(db, new AttemptLedger(db));
	const persisted: string[] = [];
	const mediaRepo = new MediaRepository(db, (m) => persisted.push(m.id));
	return {
		jobs,
		mediaRepo,
		persisted,
		reboot: () => {
			const mediaById = new Map<string, Media>();
			hydrateMediaCatalog(mediaRepo.all(), mediaById);
			return mediaById;
		},
		run: (mediaById) =>
			reconcileStrandedGates(mediaById, {
				findLiveJob: (mediaId, jobType) => jobs.findLive(mediaId, jobType),
				persist: (m) => mediaRepo.upsert(m)
			})
	};
}

/** Drive a real job to a real status through the real lifecycle, so no arm asserts against a fiction. */
function jobAt(jobs: JobRepository, mediaId: string, jobType: 'fetch' | 'stems' | 'align', status: JobStatus) {
	const job = jobs.enqueue(mediaId, jobType, 0, T0);
	if (status === 'queued') return job;
	const assigned = jobs.assign(job.id, 'w1', T0 + 30_000, T0 + 1_000);
	if (status === 'assigned') return assigned;
	const running = jobs.accept(job.id, T0 + 60_000, T0 + 2_000);
	if (status === 'running') return running;
	if (status === 'failed') return jobs.fail(job.id, 'boom', T0 + 3_000);
	if (status === 'canceled') return jobs.cancel(job.id, T0 + 3_000);
	if (status === 'ready') return jobs.complete(job.id, T0 + 3_000);
	throw new Error(`unhandled status ${status}`);
}

// ── 1. a stranded row IS settled, in memory AND durably ────────────────────────────────────────────

test('a stems gate left in-flight by a dead process is settled at boot, and the settle is written back', () => {
	const h = harness();
	// The stranded shape: the processing flip WAS persisted (the route upserts right after enqueue) and
	// the job then died without the durable settle.
	h.mediaRepo.upsert(media('m1', { stemStatus: 'queued' }));
	jobAt(h.jobs, 'm1', 'stems', 'failed');
	h.persisted.length = 0;

	const mediaById = h.reboot();
	expect(mediaById.get('m1')!.stemStatus, 'the stored value is what strands the song').toBe('queued');
	expect(isProcessing(mediaById.get('m1')!)).toBe(true);

	expect(h.run(mediaById)).toEqual(['m1']);

	// Back to un-processed in memory, so the guest gets the Sing button and a re-process can run.
	expect(mediaById.get('m1')!.stemStatus).toBe('none');
	expect(isProcessing(mediaById.get('m1')!)).toBe(false);
	// And DURABLY, or the next restart strands it again.
	expect(h.persisted, 'the pass settled memory only, so the next boot re-reads the stranded row').toEqual(['m1']);
	expect(h.mediaRepo.byId('m1')!.stemStatus).toBe('none');
});

test('a lyrics gate left in-flight by a dead align job is settled to ready, not walked backwards', () => {
	// The other half of the per-type rule, which must NOT settle the same way: the song already plays, so
	// a dead align continues with no words rather than making it un-singable.
	const h = harness();
	h.mediaRepo.upsert(processed('m2', { lyricsStatus: 'queued' }));
	jobAt(h.jobs, 'm2', 'align', 'failed');
	h.persisted.length = 0;

	const mediaById = h.reboot();
	expect(readyToSing(mediaById.get('m2')!), 'the stranded lyrics gate holds the entry').toBe(false);

	expect(h.run(mediaById)).toEqual(['m2']);
	expect(mediaById.get('m2')!.lyricsStatus).toBe('ready');
	expect(mediaById.get('m2')!.stemStatus, 'the stems gate was finished and must be left alone').toBe('ready');
	expect(readyToSing(mediaById.get('m2')!)).toBe(true);
	expect(h.mediaRepo.byId('m2')!.lyricsStatus).toBe('ready');
});

test('a gate with NO job row at all is settled — the cancel-then-free-slot shape', () => {
	// The shape no persistence sink can cover: the job row is GONE (cancelled, then its dedup slot freed),
	// so nothing is left to fire an epilogue from.
	const h = harness();
	h.mediaRepo.upsert(media('m3', { stemStatus: 'queued' }));
	expect(h.jobs.findLive('m3', 'stems')).toBeNull();

	const mediaById = h.reboot();
	expect(h.run(mediaById)).toEqual(['m3']);
	expect(h.mediaRepo.byId('m3')!.stemStatus).toBe('none');
});

// ── 2. a genuinely live process is NEVER touched ────────────────────────────────────────────────────

for (const status of ['queued', 'assigned', 'running'] as const) {
	test(`a song with a ${status} stems job is left alone — that gate is legitimately in flight`, () => {
		const h = harness();
		h.mediaRepo.upsert(media('live', { stemStatus: 'queued' }));
		jobAt(h.jobs, 'live', 'stems', status);
		h.persisted.length = 0;

		const mediaById = h.reboot();
		expect(h.run(mediaById), 'clobbering a live separation would show Sing on a song mid-process').toEqual([]);
		expect(mediaById.get('live')!.stemStatus).toBe('queued');
		expect(h.persisted, 'a no-op pass must not write').toEqual([]);
		expect(h.mediaRepo.byId('live')!.stemStatus).toBe('queued');
	});
}

test('a song mid-FETCH keeps its stems gate — the gate is settled by either step, so either being live protects it', () => {
	// `fetch` counts: requestProcess marks the media processing BEFORE the download, so a live fetch with no stems job yet
	// is a legitimately in-flight stems gate. Looking only for a live `stems` job clobbers every mid-download song.
	const h = harness();
	h.mediaRepo.upsert(media('dl', { stemStatus: 'queued' }));
	jobAt(h.jobs, 'dl', 'fetch', 'running');
	expect(h.jobs.findLive('dl', 'stems')).toBeNull();

	const mediaById = h.reboot();
	expect(h.run(mediaById)).toEqual([]);
	expect(mediaById.get('dl')!.stemStatus).toBe('queued');
});

test('a song mid-ALIGN keeps its lyrics gate', () => {
	const h = harness();
	h.mediaRepo.upsert(processed('al', { lyricsStatus: 'queued' }));
	jobAt(h.jobs, 'al', 'align', 'running');

	const mediaById = h.reboot();
	expect(h.run(mediaById)).toEqual([]);
	expect(mediaById.get('al')!.lyricsStatus).toBe('queued');
});

test('a gate stranded behind a job that already SUCCEEDED is settled — `ready` is terminal too', () => {
	// The crash window between `jobs.complete` and the media flush: the job row says ready, the media row still says
	// queued. A `ready` job never fires an epilogue again, so this gate is as stale as one behind a failure — excluding
	// only failed/canceled strands it forever. Settling to 'none' discards nothing successful: `upsert` writes the whole
	// row at once, so there is no instrumental.
	const h = harness();
	h.mediaRepo.upsert(media('crash', { stemStatus: 'queued' }));
	jobAt(h.jobs, 'crash', 'stems', 'ready');
	expect(h.jobs.findLive('crash', 'stems')!.status, '`findLive` still returns a ready job').toBe('ready');
	expect(h.mediaRepo.byId('crash')!.instrumentalRef).toBeUndefined();

	const mediaById = h.reboot();
	expect(h.run(mediaById)).toEqual(['crash']);
	expect(h.mediaRepo.byId('crash')!.stemStatus).toBe('none');
});

test('one stranded song and one live song in the same catalog: only the stranded one moves', () => {
	// The mixed case separates "settles stale gates" from "settles every in-flight gate at boot", which a
	// single-row catalog cannot distinguish.
	const h = harness();
	h.mediaRepo.upsert(media('dead', { stemStatus: 'queued' }));
	jobAt(h.jobs, 'dead', 'stems', 'failed');
	h.mediaRepo.upsert(media('alive', { stemStatus: 'queued' }));
	jobAt(h.jobs, 'alive', 'stems', 'running');
	h.persisted.length = 0;

	const mediaById = h.reboot();
	expect(h.run(mediaById)).toEqual(['dead']);
	expect(mediaById.get('dead')!.stemStatus).toBe('none');
	expect(mediaById.get('alive')!.stemStatus).toBe('queued');
	expect(h.persisted).toEqual(['dead']);
});

// ── 3. a healthy row is untouched ───────────────────────────────────────────────────────────────────

test('a healthy completed song is untouched — no gate is in flight, so there is nothing to settle', () => {
	const h = harness();
	h.mediaRepo.upsert(processed('done'));
	jobAt(h.jobs, 'done', 'stems', 'ready');
	const before = h.mediaRepo.byId('done')!;
	h.persisted.length = 0;

	const mediaById = h.reboot();
	expect(h.run(mediaById), 'a finished song must never be walked backwards').toEqual([]);
	expect(mediaById.get('done')!.stemStatus).toBe('ready');
	expect(mediaById.get('done')!.lyricsStatus).toBe('ready');
	expect(readyToSing(mediaById.get('done')!)).toBe(true);
	expect(h.persisted).toEqual([]);
	expect(h.mediaRepo.byId('done')).toEqual(before);
});

test('a never-processed song is untouched, and its NULL lyrics gate is not forged into ready', () => {
	// `stem_status` 'none' with no lyrics status is a search result, or a row written before the lyrics gate existed.
	// Neither gate is in flight, so settling the lyrics gate claims an align that never ran.
	const h = harness();
	h.mediaRepo.upsert(media('fresh'));
	expect(h.mediaRepo.byId('fresh')!.lyricsStatus).toBeUndefined();

	const mediaById = h.reboot();
	expect(h.run(mediaById)).toEqual([]);
	expect(mediaById.get('fresh')!.stemStatus).toBe('none');
	expect(mediaById.get('fresh')!.lyricsStatus).toBeUndefined();
});

// ── 4. idempotent: safe to run on every boot, forever ──────────────────────────────────────────────

test('running the pass twice changes nothing the second time, and writes nothing the second time', () => {
	// The property that lets this stay wired permanently. It also covers the deployment case: a database
	// that already has the durable fix is one on which this pass has effectively already run.
	const h = harness();
	h.mediaRepo.upsert(media('m1', { stemStatus: 'queued' }));
	jobAt(h.jobs, 'm1', 'stems', 'failed');
	h.mediaRepo.upsert(processed('m2', { lyricsStatus: 'queued' }));
	jobAt(h.jobs, 'm2', 'align', 'failed');

	const first = h.reboot();
	expect(h.run(first).sort()).toEqual(['m1', 'm2']);
	const afterFirst = [h.mediaRepo.byId('m1')!, h.mediaRepo.byId('m2')!];
	h.persisted.length = 0;

	const second = h.reboot();
	expect(h.run(second), 'the second pass re-settled a gate it had already settled').toEqual([]);
	expect(h.persisted, 'the second pass wrote a row it did not change').toEqual([]);
	expect([h.mediaRepo.byId('m1')!, h.mediaRepo.byId('m2')!]).toEqual(afterFirst);

	// A third, so the property is not "the second run is special".
	const third = h.reboot();
	expect(h.run(third)).toEqual([]);
	expect([h.mediaRepo.byId('m1')!, h.mediaRepo.byId('m2')!]).toEqual(afterFirst);
});

test('the pass deletes nothing and adds nothing — it only settles the two gate columns', () => {
	// A data repair is hard to reverse, so the blast radius is PINNED: same rows, same count, and every
	// field except the settled gate byte-identical.
	const h = harness();
	h.mediaRepo.upsert(media('m1', { stemStatus: 'queued', artist: 'A-ha', thumbnail: 'https://x/y.jpg' }));
	jobAt(h.jobs, 'm1', 'stems', 'failed');
	h.mediaRepo.upsert(processed('m2'));
	const before = new Map(h.mediaRepo.all().map((m) => [m.id, m]));

	const mediaById = h.reboot();
	h.run(mediaById);

	const after = h.mediaRepo.all();
	expect(after.length, 'the pass must never remove or add a row').toBe(before.size);
	for (const row of after) {
		const was = before.get(row.id)!;
		expect(was).toBeDefined();
		expect({ ...row, stemStatus: was.stemStatus, lyricsStatus: was.lyricsStatus }).toEqual(was);
	}
	// The jobs the pass reads are evidence, never its subject: tidying the ledger destroys the record of
	// WHY each song was settled.
	expect(h.jobs.findLive('m1', 'stems')).toBeNull(); // failed → slot already freed, row still there
	expect(h.jobs.listByStatus('failed').map((j) => j.mediaId)).toEqual(['m1']);
});
