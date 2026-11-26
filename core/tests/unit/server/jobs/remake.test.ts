// Make it again -> Sound (proposal 33 PR 3a) and the re-separation path it shares with `stems-upgrade`: new names,
// one swap, the old files deleted after it once no screen needs them, accepted whatever the rank.
import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migratedDb } from '$lib/server/db/test-db';
import { WorkerHub } from '$lib/server/jobs/worker-hub';
import { WorkerRegistry } from '$lib/server/jobs/registry';
import { JobRepository } from '$lib/server/jobs/repository';
import { assignParams, waitsForTurn, separatorFor } from '$lib/server/jobs/dispatch';
import { requestRemake } from '$lib/server/jobs/process';
import { instrumentalKey, isTaggedStemOf, stemOutputTag, stemTagOf } from '$lib/server/media/paths';
import { staleStemsOnDisk } from '$lib/server/media/retention';
import { queueSidecarTask } from '$lib/server/media/sidecar';
import { readyToSing, type Media, type ServerEvent, type WorkerCommand } from '$lib/contract';

const T0 = 1_700_000_000_000;
const OLD = {
	instrumentalRef: 'derived/stems/m1-instrumental.flac',
	vocalsRef: 'derived/stems/m1-vocals.flac',
	guideMixRef: 'derived/stems/m1-guidemix.flac'
};
const OLD_REFS = [OLD.instrumentalRef, OLD.vocalsRef, OLD.guideMixRef];

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

type Entry = { id: string; status: string; mediaId: string };

function harness(queue: Entry[] = [], current: { current: string | null } = { current: null }) {
	const jobs = new JobRepository(migratedDb());
	const mediaById = new Map<string, Media>([['m1', ready()]]);
	const sent: WorkerCommand[] = [];
	const broadcasts: ServerEvent[] = [];
	const deleted: string[][] = [];
	const persisted: Media[] = [];
	const order: string[] = [];
	const hub = new WorkerHub({
		jobs,
		registry: new WorkerRegistry(),
		mediaById,
		toWorker: (_w, cmd) => sent.push(cmd),
		broadcast: (e) => broadcasts.push(e),
		// As app.ts's upsert does: the sidecar write is QUEUED, and lands later.
		persistMedia: (id) => {
			persisted.push({ ...mediaById.get(id)! });
			void queueSidecarTask(id, async () => {
				await new Promise((r) => setTimeout(r, 1));
				order.push('sidecar');
			});
		},
		deleteRefs: (refs) => {
			order.push('delete');
			deleted.push(refs);
		},
		now: () => T0,
		queueEntries: () => queue,
		currentEntryId: () => current.current
	});
	const hello = (workerId = 'w1') =>
		hub.handle({
			type: 'worker:hello',
			workerId,
			// `stems` for a remake (tonight's default, demucs, which ranks BELOW the published roformer), the other
			// for an auto-upgrade.
			capabilities: ['stems', 'stems:roformer'],
			concurrency: 1,
			version: '1'
		});
	return { hub, jobs, mediaById, sent, broadcasts, deleted, persisted, order, hello };
}

/** Every delete is queued behind the song's sidecar writes. */
const drained = () => queueSidecarTask('m1', async () => {});

const assigns = (sent: WorkerCommand[]) =>
	sent.filter((c) => c.type === 'job:assign') as Extract<WorkerCommand, { type: 'job:assign' }>[];

const tagged = (tag: string) => [
	`derived/stems/m1-${tag}-instrumental.flac`,
	`derived/stems/m1-${tag}-vocals.flac`,
	`derived/stems/m1-${tag}-guidemix.flac`
];

function complete(h: ReturnType<typeof harness>, jobId: string, refs: string[], workerId = 'w1') {
	h.hub.handle({ type: 'job:accept', workerId, jobId });
	h.hub.handle({
		type: 'job:complete',
		workerId,
		jobId,
		mediaUri: 'x',
		artifacts: { stems: { instrumental: refs[0], vocals: refs[1], guideMix: refs[2] } }
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

test('a same-rank remake is swapped in by one write, the song stays ready, and the old files go after the sidecar', async () => {
	const h = harness();
	const job = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 });
	h.hello();
	const tag = assigns(h.sent)[0]!.params.outputTag!;
	expect(readyToSing(h.mediaById.get('m1')!)).toBe(true);
	complete(h, job.id, tagged(tag));

	const m = h.mediaById.get('m1')!;
	expect(m.instrumentalRef).toBe(instrumentalKey('m1', 'flac', tag));
	expect(m.vocalsRef).toBe(`derived/stems/m1-${tag}-vocals.flac`);
	expect(m.guideMixRef).toBe(`derived/stems/m1-${tag}-guidemix.flac`);
	expect(readyToSing(m)).toBe(true);
	expect(h.persisted.at(-1)!.instrumentalRef).toBe(m.instrumentalRef);
	await drained();
	expect(h.deleted).toEqual([OLD_REFS]);
	// Behind the queued sidecar write, so `meta/` never names a deleted file.
	expect(h.order).toEqual(['sidecar', 'delete']);
	// No "Making karaoke" on any phone for a song that never stopped being ready.
	expect(h.broadcasts.some((e) => e.type === 'media:status' && e.status !== 'ready')).toBe(false);
});

test('queued after dispatch: the refs swap, and the old files stay until its turn is over', async () => {
	const queue: Entry[] = [];
	const now = { current: null as string | null };
	const h = harness(queue, now);
	const job = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 });
	h.hello();
	const tag = assigns(h.sent)[0]!.params.outputTag!;
	// Someone queues it mid-remake: on deck.
	queue.push({ id: 'e1', status: 'queued', mediaId: 'm1' });
	complete(h, job.id, tagged(tag));
	expect(h.mediaById.get('m1')!.instrumentalRef).toBe(tagged(tag)[0]);
	h.hub.settle();
	await drained();
	expect(h.deleted).toEqual([]);
	// Playing it now.
	now.current = 'e1';
	h.hub.settle();
	await drained();
	expect(h.deleted).toEqual([]);
	// The turn is over.
	queue[0]!.status = 'done';
	now.current = null;
	h.hub.settle();
	await drained();
	expect(h.deleted).toEqual([OLD_REFS]);
});

test('finished while the song plays: the swap waits for the turn to end, since the TV would reload from 0', async () => {
	const queue: Entry[] = [{ id: 'e1', status: 'queued', mediaId: 'm1' }];
	const now = { current: null as string | null };
	const h = harness(queue, now);
	// An auto-upgrade does not wait for the turn, so this one is dispatched with the song queued.
	const job = h.jobs.enqueue('m1', 'stems-upgrade', 0, T0);
	h.mediaById.get('m1')!.separator = { engine: 'demucs', model: 'htdemucs' }; // below the upgrade
	h.hello();
	expect(waitsForTurn(job, queue, null)).toBe(false);
	const tag = assigns(h.sent)[0]!.params.outputTag!;
	now.current = 'e1';
	complete(h, job.id, tagged(tag));
	expect(h.jobs.byId(job.id)!.status).toBe('ready');
	expect(h.mediaById.get('m1')!.instrumentalRef).toBe(OLD.instrumentalRef);
	h.hub.settle();
	expect(h.mediaById.get('m1')!.instrumentalRef).toBe(OLD.instrumentalRef);
	queue[0]!.status = 'done';
	now.current = null;
	h.hub.settle();
	expect(h.mediaById.get('m1')!.instrumentalRef).toBe(tagged(tag)[0]);
	await drained();
	expect(h.deleted).toEqual([OLD_REFS]);
});

test('a refused upgrade keeps the playing stems and deletes only the files it wrote', async () => {
	const h = harness();
	const job = h.jobs.enqueue('m1', 'stems-upgrade', 0, T0);
	h.hello();
	const tag = assigns(h.sent)[0]!.params.outputTag!;
	complete(h, job.id, tagged(tag)); // same rank as the published separator: refused
	expect(h.mediaById.get('m1')!.instrumentalRef).toBe(OLD.instrumentalRef);
	await drained();
	expect(h.deleted.flat().sort()).toEqual(tagged(tag).sort());
});

test('core deletes no file a worker names but this job’s own output', async () => {
	const h = harness();
	h.mediaById.set('OTHER', ready({ id: 'OTHER', ...OLD }));
	const job = h.jobs.enqueue('m1', 'stems-upgrade', 0, T0);
	h.hello();
	const tag = assigns(h.sent)[0]!.params.outputTag!;
	// Refused (same rank), naming another song's stems and its unrecoverable original.
	h.hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	h.hub.handle({
		type: 'job:complete',
		workerId: 'w1',
		jobId: job.id,
		mediaUri: 'x',
		artifacts: {
			stems: {
				instrumental: 'derived/stems/OTHER-instrumental.flac',
				vocals: 'audio/OTHER.webm',
				guideMix: `derived/stems/OTHER-${tag}-guidemix.flac`
			}
		}
	});
	await queueSidecarTask('OTHER', async () => {});
	await drained();
	expect(h.deleted).toEqual([]);
});

test('a completion naming this song’s files under another job’s tag deletes none of them', async () => {
	const h = harness();
	const job = h.jobs.enqueue('m1', 'stems-upgrade', 0, T0);
	h.hello();
	complete(h, job.id, tagged('01someoneelse')); // refused (same rank): not its own names
	await drained();
	expect(h.deleted).toEqual([]);
});

test('a cancelled remake’s late completion deletes only its own new files', async () => {
	const h = harness();
	const job = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 });
	h.hello();
	const tag = assigns(h.sent)[0]!.params.outputTag!;
	h.hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	h.jobs.cancel(job.id, T0); // the song was deleted or evicted mid-run
	h.hub.handle({
		type: 'job:complete',
		workerId: 'w1',
		jobId: job.id,
		mediaUri: 'x',
		artifacts: { stems: { instrumental: tagged(tag)[0], vocals: OLD.vocalsRef, guideMix: 'audio/m1.webm' } }
	});
	expect(h.mediaById.get('m1')!.instrumentalRef).toBe(OLD.instrumentalRef);
	await drained();
	expect(h.deleted).toEqual([[tagged(tag)[0]]]);
});

test('an untagged report (a worker older than the tag) never deletes the files the song names', async () => {
	const h = harness();
	const job = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 });
	h.hello();
	complete(h, job.id, OLD_REFS);
	expect(h.mediaById.get('m1')!.instrumentalRef).toBe(OLD.instrumentalRef);
	await drained();
	expect(h.deleted).toEqual([]);
});

test('a remake waits while its song is queued or playing, and runs once the turn is over', () => {
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
	// A first separation, and an auto-upgrade, are never held.
	const queued = [{ id: 'e2', status: 'queued', mediaId: 'm1' }];
	expect(waitsForTurn({ jobType: 'stems', mediaId: 'm1' }, queued, null)).toBe(false);
	expect(waitsForTurn({ jobType: 'stems-upgrade', mediaId: 'm1' }, queued, 'e2')).toBe(false);
});

test('a second Make again while one is waiting is the same job, and a finished one can be asked again', () => {
	const h = harness();
	const first = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 });
	expect(requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 }).id).toBe(first.id);
	h.hello();
	complete(h, first.id, tagged(assigns(h.sent)[0]!.params.outputTag!));
	const again = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 + 1 });
	expect(again.id).not.toBe(first.id);
	expect(again.status).toBe('queued');
});

test('a worker older than core refuses the remake once: with no other worker it fails with a reason', () => {
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

test('an old worker’s refusal goes to a newer worker that is connected, not to a failure', () => {
	const h = harness();
	h.hello('w1');
	const job = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 });
	h.hub.dispatch();
	expect(assigns(h.sent).map((a) => a.jobId)).toEqual([job.id]);
	h.hello('w2'); // busy with nothing, but the job is already w1's
	h.hub.handle({ type: 'job:reject', workerId: 'w1', jobId: job.id, reason: 'unknown action: stems-remake' });
	expect(h.jobs.byId(job.id)!.status).toBe('assigned');
	expect(h.jobs.byId(job.id)!.workerId).toBe('w2');
	// w1 is never offered it again.
	expect(
		assigns(h.sent)
			.filter((a) => a.jobId === job.id)
			.map((a) => a.jobId)
	).toHaveLength(2);
});

test('at boot, what a restart kept from deleting is found: replaced and lost stems, never a live job’s', () => {
	const saved = process.env.MEDIA_DIR;
	const root = mkdtempSync(join(tmpdir(), 'encore-stale-'));
	process.env.MEDIA_DIR = root;
	try {
		mkdirSync(join(root, 'derived/stems'), { recursive: true });
		const files = [
			'm1-instrumental.flac', // replaced by the remake that landed
			'm1-vocals.m4a', // an older ext, replaced too
			'm1-new-instrumental.flac', // what plays
			'm1-new-vocals.flac',
			'm1-lost-guidemix.flac', // a remake that finished and lost
			'm1-live-instrumental.flac', // a remake still running
			'm2-instrumental.flac', // another song, untagged and playing
			'm2-gone-vocals.flac' // that song's lost remake
		];
		for (const f of files) writeFileSync(join(root, 'derived/stems', f), 'x');
		const m1 = ready({
			instrumentalRef: 'derived/stems/m1-new-instrumental.flac',
			vocalsRef: 'derived/stems/m1-new-vocals.flac',
			guideMixRef: undefined
		});
		const m2 = ready({ id: 'm2', instrumentalRef: 'derived/stems/m2-instrumental.flac' });
		const stale = staleStemsOnDisk([m1, m2], (id) => (id === 'm1' ? ['live'] : []));
		expect(stale.get('m1')?.sort()).toEqual(
			[
				'derived/stems/m1-instrumental.flac',
				'derived/stems/m1-lost-guidemix.flac',
				'derived/stems/m1-vocals.m4a'
			].sort()
		);
		expect(stale.get('m2')).toEqual(['derived/stems/m2-gone-vocals.flac']);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (saved === undefined) delete process.env.MEDIA_DIR;
		else process.env.MEDIA_DIR = saved;
	}
});

test('a tagged stem file is recognised for delete, and another song’s is not', () => {
	expect(isTaggedStemOf('M1', 'M1-01jx-instrumental.flac')).toBe(true);
	expect(isTaggedStemOf('M1', 'M1-01jx-guidemix.m4a')).toBe(true);
	expect(isTaggedStemOf('M1', 'M1-instrumental.flac')).toBe(false); // untagged: named by the id already
	expect(isTaggedStemOf('M1', 'M12-01jx-instrumental.flac')).toBe(false);
	expect(isTaggedStemOf('M1', 'M1-01jx-instrumental.flac.part')).toBe(false);
	expect(stemTagOf('M1', 'M1-01jx-vocals.flac')).toBe('01jx');
});

// ── 3b: Make it again, the lyrics ───────────────────────────────────────────────────────────────

const OLD_LYRICS = {
	lyricsRef: 'derived/lyrics/m1-lrclib-word.json',
	lyricsCandidates: [
		{
			ref: 'derived/lyrics/m1-lrclib-word.json',
			textSource: 'lrclib',
			textConfidence: 'high',
			timing: 'word',
			timingConfidence: 'high',
			language: 'en',
			createdAt: 1
		},
		{
			ref: 'derived/lyrics/m1-asr-vocals-word.json',
			textSource: 'asr',
			textConfidence: 'low',
			timing: 'word',
			timingConfidence: 'medium',
			language: 'en',
			createdAt: 1
		}
	] as Media['lyricsCandidates']
};

function completeAlign(h: ReturnType<typeof harness>, jobId: string, refs: string[]) {
	h.hub.handle({ type: 'job:accept', workerId: 'w1', jobId });
	h.hub.handle({
		type: 'job:complete',
		workerId: 'w1',
		jobId,
		mediaUri: '',
		artifacts: {
			lyrics: {
				uri: refs[0] ?? '',
				candidates: refs.map((ref) => ({
					ref,
					textSource: 'lrclib',
					textConfidence: 'high',
					timing: 'word',
					timingConfidence: 'high',
					language: 'en',
					createdAt: 2
				}))
			}
		}
	});
}

test('a lyrics remake searches again under its own names, with no pin, routed to any aligner', () => {
	const h = harness();
	h.mediaById.set(
		'm1',
		ready({ ...OLD_LYRICS, lyricsOverrideRef: 'derived/lyrics/m1-edit-r1.json', lyricsOverrideText: 'x' })
	);
	const job = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 }, 'align-remake');
	const params = assignParams('align-remake', h.mediaById.get('m1'), undefined, job.id);
	expect(params.outputTag).toBe(stemOutputTag(job.id));
	expect(params.pinnedRef).toBeUndefined();
	h.hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['align'], concurrency: 1, version: '1' });
	expect(assigns(h.sent).map((a) => a.jobType)).toEqual(['align-remake']);
});

test('a lyrics remake replaces the automatic set in one write and deletes the old documents after', async () => {
	const h = harness();
	h.mediaById.set('m1', ready(OLD_LYRICS));
	const job = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 }, 'align-remake');
	h.hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['align'], concurrency: 1, version: '1' });
	const tag = assigns(h.sent)[0]!.params.outputTag!;
	const fresh = `derived/lyrics/m1-${tag}-lrclib-word.json`;
	completeAlign(h, job.id, [fresh]);

	const m = h.mediaById.get('m1')!;
	expect(m.lyricsRef).toBe(fresh);
	expect(m.lyricsCandidates!.map((c) => c.ref)).toEqual([fresh]);
	expect(readyToSing(m)).toBe(true);
	expect(h.persisted.at(-1)!.lyricsRef).toBe(fresh);
	await drained();
	expect(h.deleted).toEqual([[OLD_LYRICS.lyricsRef, 'derived/lyrics/m1-asr-vocals-word.json']]);
	expect(h.order).toEqual(['sidecar', 'delete']);
	expect(h.broadcasts.some((e) => e.type === 'media:status' && e.status !== 'ready')).toBe(false);
});

test('a lyrics remake keeps the host’s fix showing, and its document', async () => {
	const h = harness();
	const fix = {
		ref: 'derived/lyrics/m1-edit-r1.json',
		textSource: 'manual',
		textConfidence: 'high',
		timing: 'word',
		timingConfidence: 'high',
		language: 'en',
		createdAt: 1
	};
	h.mediaById.set(
		'm1',
		ready({
			lyricsRef: fix.ref,
			lyricsOverrideRef: fix.ref,
			lyricsCandidates: [...OLD_LYRICS.lyricsCandidates!, fix] as Media['lyricsCandidates']
		})
	);
	const job = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 }, 'align-remake');
	h.hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['align'], concurrency: 1, version: '1' });
	const fresh = `derived/lyrics/m1-${assigns(h.sent)[0]!.params.outputTag}-lrclib-word.json`;
	completeAlign(h, job.id, [fresh]);
	const m = h.mediaById.get('m1')!;
	expect(m.lyricsRef).toBe(fix.ref);
	expect(m.lyricsCandidates!.map((c) => c.ref).sort()).toEqual([fix.ref, fresh].sort());
	await drained();
	expect(h.deleted.flat()).toContain(OLD_LYRICS.lyricsRef);
	expect(h.deleted.flat()).not.toContain(fix.ref);
});

test('a lyrics remake deletes no document a worker names but its own and the ones it replaced', async () => {
	const h = harness();
	h.mediaById.set('m1', ready(OLD_LYRICS));
	const job = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 }, 'align-remake');
	h.hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['align'], concurrency: 1, version: '1' });
	// Nothing showable (a manual text alone), so the remake's own reported refs are what would go: these are not its own.
	h.hub.handle({ type: 'job:accept', workerId: 'w1', jobId: job.id });
	h.hub.handle({
		type: 'job:complete',
		workerId: 'w1',
		jobId: job.id,
		mediaUri: '',
		artifacts: {
			lyrics: {
				uri: '',
				candidates: ['derived/lyrics/OTHER-asr-vocals-word.json', 'audio/OTHER.webm'].map((ref) => ({
					ref,
					textSource: 'manual',
					textConfidence: 'high',
					timing: 'word',
					timingConfidence: 'high',
					language: 'en',
					createdAt: 2
				}))
			}
		}
	});
	expect(h.mediaById.get('m1')!.lyricsRef).toBe(OLD_LYRICS.lyricsRef);
	await drained();
	expect(h.deleted.flat()).not.toContain('derived/lyrics/OTHER-asr-vocals-word.json');
	expect(h.deleted.flat()).not.toContain('audio/OTHER.webm');
});

test('a lyrics remake that finds nothing keeps the old lyrics', async () => {
	const h = harness();
	h.mediaById.set('m1', ready(OLD_LYRICS));
	const job = requestRemake(h.mediaById.get('m1')!, { jobs: h.jobs, now: () => T0 }, 'align-remake');
	h.hub.handle({ type: 'worker:hello', workerId: 'w1', capabilities: ['align'], concurrency: 1, version: '1' });
	completeAlign(h, job.id, []);
	const m = h.mediaById.get('m1')!;
	expect(m.lyricsRef).toBe(OLD_LYRICS.lyricsRef);
	expect(m.lyricsCandidates).toEqual(OLD_LYRICS.lyricsCandidates);
	await drained();
	expect(h.deleted).toEqual([]);
});
