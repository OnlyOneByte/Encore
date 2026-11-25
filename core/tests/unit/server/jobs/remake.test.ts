// Make it again -> Sound (proposal 33 PR 3a) and the re-separation path it shares with `stems-upgrade`: new names,
// one swap, the old files deleted after it, accepted whatever the rank, and held while the song is queued or playing.
import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { WorkerHub } from '$lib/server/jobs/worker-hub';
import { WorkerRegistry } from '$lib/server/jobs/registry';
import { JobRepository } from '$lib/server/jobs/repository';
import { assignParams, waitsForTurn, separatorFor } from '$lib/server/jobs/dispatch';
import { requestRemake } from '$lib/server/jobs/process';
import { instrumentalKey, isTaggedStemOf, stemOutputTag } from '$lib/server/media/paths';
import { readyToSing, type Media, type ServerEvent, type WorkerCommand } from '$lib/contract';

const T0 = 1_700_000_000_000;
const OLD = {
	instrumentalRef: 'derived/stems/m1-instrumental.flac',
	vocalsRef: 'derived/stems/m1-vocals.flac',
	guideMixRef: 'derived/stems/m1-guidemix.flac'
};

const ready = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'youtube',
	sourceRef: 'vid-m1',
	title: 'm1',
	durationSec: 200,
	stemStatus: 'ready',
	lyricsStatus: 'ready',
	lyricsRef: 'derived/lyrics/m1.json',
	songProfile: { keyTonic: 0, keyMode: 'major', keyConfidence: 1, histogram: [] } as unknown as Media['songProfile'],
	separator: { engine: 'roformer', model: 'bs-roformer-1297' }, // the top rung: a same-model remake does not outrank it
	...OLD,
	...over
});

function harness(queue: { id: string; status: string; mediaId: string }[] = [], current: string | null = null) {
	const jobs = new JobRepository(migratedDb());
	const mediaById = new Map<string, Media>([['m1', ready()]]);
	const sent: WorkerCommand[] = [];
	const broadcasts: ServerEvent[] = [];
	const deleted: string[][] = [];
	const persisted: Media[] = [];
	const hub = new WorkerHub({
		jobs,
		registry: new WorkerRegistry(),
		mediaById,
		toWorker: (_w, cmd) => sent.push(cmd),
		broadcast: (e) => broadcasts.push(e),
		persistMedia: (id) => persisted.push({ ...mediaById.get(id)! }),
		deleteRefs: (refs) => deleted.push(refs),
		now: () => T0,
		queueEntries: () => queue,
		currentEntryId: () => current
	});
	const hello = () =>
		hub.handle({
			type: 'worker:hello',
			workerId: 'w1',
			// `stems` for a remake (tonight's default, demucs, which ranks BELOW the published roformer), the other
			// for an auto-upgrade.
			capabilities: ['stems', 'stems:roformer'],
			concurrency: 1,
			version: '1'
		});
	return { hub, jobs, mediaById, sent, broadcasts, deleted, persisted, hello };
}

const assigns = (sent: WorkerCommand[]) =>
	sent.filter((c) => c.type === 'job:assign') as Extract<WorkerCommand, { type: 'job:assign' }>[];

function complete(h: ReturnType<typeof harness>, jobId: string, tag: string) {
	h.hub.handle({ type: 'job:accept', workerId: 'w1', jobId });
	h.hub.handle({
		type: 'job:complete',
		workerId: 'w1',
		jobId,
		mediaUri: 'x',
		artifacts: {
			stems: {
				instrumental: `derived/stems/m1-${tag}-instrumental.flac`,
				vocals: `derived/stems/m1-${tag}-vocals.flac`,
				guideMix: `derived/stems/m1-${tag}-guidemix.flac`
			}
		}
	});
}

test('a remake is dispatched with its own output tag and tonight’s separator', () => {
	const h = harness();
	const job = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 });
	h.hello();
	const assign = assigns(h.sent)[0]!;
	expect(assign.jobType).toBe('stems-remake');
	expect(assign.params.outputTag).toBe(stemOutputTag(job.id));
	expect(separatorFor('stems-remake')).toEqual(separatorFor('stems'));
	// A first separation is never tagged.
	expect(assignParams('stems', h.mediaById.get('m1'), undefined, 'J1').outputTag).toBeUndefined();
	expect(assignParams('stems-upgrade', h.mediaById.get('m1'), undefined, 'J1').outputTag).toBe('j1');
});

test('a same-rank remake is swapped in by one write, the song stays ready, and the old files go after', () => {
	const h = harness();
	const job = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 });
	h.hello();
	const tag = assigns(h.sent)[0]!.params.outputTag!;
	expect(readyToSing(h.mediaById.get('m1')!)).toBe(true);
	complete(h, job.id, tag);

	const m = h.mediaById.get('m1')!;
	expect(m.instrumentalRef).toBe(instrumentalKey('m1', 'flac', tag));
	expect(m.vocalsRef).toBe(`derived/stems/m1-${tag}-vocals.flac`);
	expect(m.guideMixRef).toBe(`derived/stems/m1-${tag}-guidemix.flac`);
	expect(readyToSing(m)).toBe(true);
	// Persisted with the new refs BEFORE the old files are deleted.
	expect(h.persisted.at(-1)!.instrumentalRef).toBe(m.instrumentalRef);
	expect(h.deleted).toEqual([[OLD.instrumentalRef, OLD.vocalsRef, OLD.guideMixRef]]);
	// No "Making karaoke" on any phone for a song that never stopped being ready.
	expect(h.broadcasts.some((e) => e.type === 'media:status' && e.status !== 'ready')).toBe(false);
});

test('a refused upgrade keeps the playing stems and deletes only the files it wrote', () => {
	const h = harness();
	const job = h.jobs.enqueue('m1', 'stems-upgrade', 0, T0);
	h.hello();
	const tag = assigns(h.sent)[0]!.params.outputTag!;
	complete(h, job.id, tag); // same rank as the published separator: refused
	const m = h.mediaById.get('m1')!;
	expect(m.instrumentalRef).toBe(OLD.instrumentalRef);
	expect(h.deleted).toEqual([
		[
			`derived/stems/m1-${tag}-instrumental.flac`,
			`derived/stems/m1-${tag}-vocals.flac`,
			`derived/stems/m1-${tag}-guidemix.flac`
		]
	]);
});

test('an untagged report (a worker older than the tag) never deletes the files the song names', () => {
	const h = harness();
	const job = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 });
	h.hello();
	h.hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	h.hub.handle({
		type: 'job:complete',
		workerId: 'w1',
		jobId: job.id,
		mediaUri: 'x',
		artifacts: { stems: { instrumental: OLD.instrumentalRef, vocals: OLD.vocalsRef, guideMix: OLD.guideMixRef } }
	});
	expect(h.mediaById.get('m1')!.instrumentalRef).toBe(OLD.instrumentalRef);
	expect(h.deleted).toEqual([]);
});

test('a re-separation waits while its song is queued or playing, and runs once the turn is over', () => {
	const queue = [{ id: 'e1', status: 'queued', mediaId: 'm1' }];
	const h = harness(queue);
	requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 });
	h.hello();
	expect(assigns(h.sent)).toHaveLength(0);
	queue[0]!.status = 'playing';
	expect(waitsForTurn({ jobType: 'stems-remake', mediaId: 'm1' }, queue, 'e1')).toBe(true);
	queue[0]!.status = 'done';
	h.hub.dispatch();
	expect(assigns(h.sent)).toHaveLength(1);
	// A first separation is never held: it IS the song's turn.
	expect(waitsForTurn({ jobType: 'stems', mediaId: 'm1' }, [{ id: 'e2', status: 'queued', mediaId: 'm1' }], null)).toBe(
		false
	);
});

test('a second Make again while one is waiting is the same job, and a finished one can be asked again', () => {
	const h = harness();
	const first = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 });
	expect(requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 }).id).toBe(first.id);
	h.hello();
	complete(h, first.id, assigns(h.sent)[0]!.params.outputTag!);
	const again = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 + 1 });
	expect(again.id).not.toBe(first.id);
	expect(again.status).toBe('queued');
});

test('a worker older than core refuses the remake once: it fails with a reason, the song stays ready', () => {
	const h = harness();
	const job = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 });
	h.hello();
	h.hub.handle({ type: 'job:reject', workerId: 'w1', jobId: job.id, reason: 'unknown action: stems-remake' });
	const after = h.jobs.byId(job.id)!;
	expect(after.status).toBe('failed');
	expect(after.error).toContain('update the worker');
	h.hub.dispatch();
	expect(assigns(h.sent)).toHaveLength(1); // never offered again
	expect(readyToSing(h.mediaById.get('m1')!)).toBe(true);
	expect(h.mediaById.get('m1')!.instrumentalRef).toBe(OLD.instrumentalRef);
});

test('a tagged stem file is recognised for delete, and another song’s is not', () => {
	expect(isTaggedStemOf('M1', 'M1-01jx-instrumental.flac')).toBe(true);
	expect(isTaggedStemOf('M1', 'M1-01jx-guidemix.m4a')).toBe(true);
	expect(isTaggedStemOf('M1', 'M1-instrumental.flac')).toBe(false); // untagged: named by the id already
	expect(isTaggedStemOf('M1', 'M12-01jx-instrumental.flac')).toBe(false);
	expect(isTaggedStemOf('M1', 'M1-01jx-instrumental.flac.part')).toBe(false);
});
