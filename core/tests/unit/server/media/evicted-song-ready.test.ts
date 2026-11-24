// guard: #1153. An evicted song is not made any more: the next pick runs the process again instead of handing
// back the finished stems job and marking deleted stems ready.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPlayable, type Media } from '$lib/contract';
import { migratedDb } from '$lib/server/db/test-db';
import { JobRepository } from '$lib/server/jobs/repository';
import { AuthoritativeState } from '$lib/server/state/store';
import { instrumentalKey, processState, requestProcess, type ProcessDeps } from '$lib/server/jobs/process';
import { evictSong } from '$lib/server/media/retention';
import { readSidecar, sidecarFromMedia, writeSidecar } from '$lib/server/media/sidecar';

const T0 = 1_700_000_000_000;
let root: string;
let saved: string | undefined;

beforeEach(() => {
	saved = process.env.MEDIA_DIR;
	root = mkdtempSync(join(tmpdir(), 'encore-evict-'));
	process.env.MEDIA_DIR = root;
	mkdirSync(join(root, 'derived', 'stems'), { recursive: true });
});
afterEach(() => {
	if (saved === undefined) delete process.env.MEDIA_DIR;
	else process.env.MEDIA_DIR = saved;
	rmSync(root, { recursive: true, force: true });
});

const onDisk = (ref: string) => existsSync(join(root, ...ref.split('/')));

function deps(): ProcessDeps & { mediaById: Map<string, Media> } {
	return {
		jobs: new JobRepository(migratedDb()),
		mediaById: new Map(),
		state: new AuthoritativeState(),
		now: () => T0,
		stemsOnDisk: onDisk
	};
}

/** A local song taken through stems and align to ready, with its stems on disk and a sidecar. */
async function madeSong(d: ReturnType<typeof deps>): Promise<Media> {
	const m: Media = {
		id: 'm1',
		source: 'local',
		sourceRef: 'library/m1.flac',
		title: 'm1',
		durationSec: 200,
		stemStatus: 'none'
	};
	d.mediaById.set('m1', m);
	for (const type of ['stems', 'align'] as const) {
		const j = d.jobs.enqueue('m1', type, 0, T0);
		d.jobs.assign(j.id, 'w1', T0 + 1000, T0);
		d.jobs.accept(j.id, T0 + 2000, T0);
		d.jobs.complete(j.id, T0);
	}
	m.stemStatus = 'ready';
	m.lyricsStatus = 'ready';
	m.instrumentalRef = instrumentalKey('m1');
	m.vocalsRef = 'derived/stems/m1-vocals.flac';
	writeFileSync(join(root, 'derived/stems/m1-instrumental.flac'), Buffer.alloc(500, 1));
	writeFileSync(join(root, 'derived/stems/m1-vocals.flac'), Buffer.alloc(400, 1));
	await writeSidecar(sidecarFromMedia(m, T0));
	return m;
}

describe('eviction, then status', () => {
	it('leaves the song not made in the DB row, the sidecar and the job slots', async () => {
		const d = deps();
		const m = await madeSong(d);
		const upserted: Media[] = [];

		expect(await evictSong(m, { jobs: d.jobs, upsert: (x) => upserted.push({ ...x }) })).toBe(900);

		expect(isPlayable(m)).toBe(false);
		expect(m.lyricsStatus).toBeUndefined();
		expect(upserted[0]!.stemStatus).toBe('none');
		expect((await readSidecar('m1'))!.artifacts.instrumental).toBeNull();
		expect(d.jobs.findLive('m1', 'stems')).toBeNull();
		expect(d.jobs.findLive('m1', 'align')).toBeNull();
		expect(processState('m1', d)).toBe('processable');
	});

	it('the next pick enqueues a fresh stems job instead of marking the deleted stems ready', async () => {
		const d = deps();
		const m = await madeSong(d);
		await evictSong(m, { jobs: d.jobs, upsert: () => {} });

		const job = requestProcess('m1', d)!;
		expect(job.jobType).toBe('stems');
		expect(job.status).toBe('queued');
		expect(m.stemStatus).toBe('queued');
		expect(isPlayable(m)).toBe(false);
	});
});

describe('requestProcess when the files are missing', () => {
	it('a ready status whose instrumental is gone is not ready, and the pick makes it again', async () => {
		const d = deps();
		const m = await madeSong(d);
		rmSync(join(root, 'derived/stems/m1-instrumental.flac'));

		expect(processState('m1', d)).toBe('processable');
		const job = requestProcess('m1', d)!;
		expect(job.status).toBe('queued');
		expect(m.stemStatus).toBe('queued');
		expect(m.instrumentalRef).toBeUndefined();
	});

	it('a finished stems job left by an older eviction is not handed back as ready', async () => {
		// Evicted before the reset shipped: the row says not made, but the ready jobs still hold the slots.
		const d = deps();
		const m = await madeSong(d);
		rmSync(join(root, 'derived/stems/m1-instrumental.flac'));
		Object.assign(m, { stemStatus: 'none', instrumentalRef: undefined, lyricsStatus: 'ready' });

		const job = requestProcess('m1', d)!;
		expect(job.status).toBe('queued');
		expect(isPlayable(m)).toBe(false);
		expect(m.lyricsStatus).toBeUndefined();
	});

	it('stems on disk are still trusted: no re-make', async () => {
		const d = deps();
		await madeSong(d);
		expect(processState('m1', d)).toBe('ready');
		expect(requestProcess('m1', d)).toBeNull();
	});
});
