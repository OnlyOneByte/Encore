// The host's library actions (proposal 33 PR 1): a rename that nothing overwrites, Keep, real sizes and the Undo window.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_SONG_PROFILE, type Media, type QueueEntry } from '$lib/contract';
import { mediaFromSidecar, readSidecar, sidecarFromMedia, writeSidecar } from '$lib/server/media/sidecar';
import {
	PendingDeletes,
	bulkManage,
	inTonightsQueue,
	librarySizes,
	librarySong,
	renameSong,
	requestDelete,
	setKeep
} from '$lib/server/media/library-manage';
import { applyAnnotation, requestRemake, NO_QUEUE_PRIORITY } from '$lib/server/jobs/process';
import { JobRepository } from '$lib/server/jobs/repository';
import { waitsForTurn } from '$lib/server/jobs/dispatch';
import { migratedDb } from '$lib/server/db/test-db';
import { planEviction } from '$lib/server/media/retention';

const NOW = 1_788_400_000_000;
const song = (over: Partial<Media> = {}): Media => ({
	id: 'm1',
	source: 'local',
	sourceRef: 'library/track07.mp3',
	title: 'track07',
	durationSec: 200,
	stemStatus: 'ready',
	instrumentalRef: 'derived/stems/m1-instrumental.flac',
	...over
});

let root: string;
let savedRoot: string | undefined;
beforeEach(() => {
	savedRoot = process.env.MEDIA_DIR;
	root = mkdtempSync(join(tmpdir(), 'encore-manage-'));
	process.env.MEDIA_DIR = root;
});
afterEach(() => {
	if (savedRoot === undefined) delete process.env.MEDIA_DIR;
	else process.env.MEDIA_DIR = savedRoot;
	rmSync(root, { recursive: true, force: true });
});

/** What MediaRepository.upsert's sidecar sink does. */
async function persist(m: Media): Promise<void> {
	await writeSidecar(sidecarFromMedia(m, NOW, await readSidecar(m.id)));
}

describe('renameSong', () => {
	it('survives a later rewrite, a worker annotation and a restore', async () => {
		const m = song();
		await writeSidecar(sidecarFromMedia(m, NOW));
		await renameSong(m, { title: 'Mr. Brightside', artist: 'The Killers' }, () => {});
		await persist(m);
		expect(m.title).toBe('Mr. Brightside');
		expect(m.artistCanonical).toBe('The Killers');

		expect(
			applyAnnotation('m1', new Map([['m1', m]]), {
				source: 'musicbrainz',
				mbid: 'x',
				artist: 'Someone Else',
				title: 'Other',
				confidence: 'high'
			})
		).toBe(false);
		// A cited annotation that reached the row anyway still loses to the host's name.
		await persist({ ...m, annotation: { source: 'musicbrainz', confidence: 'high' }, artistCanonical: 'Someone' });

		const side = (await readSidecar('m1'))!;
		expect(side.canonical).toMatchObject({ title: 'Mr. Brightside', artist: 'The Killers' });
		expect(side.provenance.title?.by).toBe('manual');
		expect(side.raw.rawTitle).toBe('track07');
		const restored = mediaFromSidecar(side);
		expect(restored.title).toBe('Mr. Brightside');
		expect(restored.artistCanonical).toBe('The Killers');
		expect(restored.annotation?.source).toBe('manual');
	});
});

describe('Keep', () => {
	it('is stored in the sidecar, survives a rewrite, and comes off again', async () => {
		const m = song();
		await writeSidecar(sidecarFromMedia(m, NOW));
		expect(await setKeep('m1', true)).toBe(true);
		await persist(m);
		expect((await readSidecar('m1'))!.library.keep).toBe(true);
		expect(await setKeep('m1', false)).toBe(true);
		expect((await readSidecar('m1'))!.library.keep).toBeUndefined();
		expect(await setKeep('nope', true)).toBe(false);
	});

	it('a kept song is never planned for eviction, however far over the cap', () => {
		const candidates = [
			{ mediaId: 'kept', derivedBytes: 900, lastUsedAt: 1 },
			{ mediaId: 'old', derivedBytes: 100, lastUsedAt: 2 }
		];
		expect(planEviction(candidates, 100, new Set(['kept']))).toEqual(['old']);
	});
});

describe('librarySizes', () => {
	it('sums every file a delete frees, as the store measures it, and counts kept bytes', async () => {
		const store = {
			size: async (ref: string) =>
				ref === 'derived/stems/m1-instrumental.flac' ? 5_000_000 : ref === 'audio/m2.mp3' ? 2_000_000 : null
		};
		const sides: Record<string, unknown> = {
			m1: { library: { keep: true, playCount: 4 } },
			m2: { library: { playCount: 0 } }
		};
		const out = await librarySizes(
			[song(), song({ id: 'm2', instrumentalRef: undefined })],
			store,
			10_000_000,
			async (id) => sides[id] as never
		);
		expect(out.songs.m1).toEqual({ bytes: 5_000_000, plays: 4, kept: true });
		expect(out.songs.m2!.bytes).toBe(2_000_000);
		expect(out).toMatchObject({ totalBytes: 7_000_000, keptBytes: 5_000_000, capBytes: 10_000_000 });
	});
});

describe('what the host may manage', () => {
	it('a song playing or still queued tonight is in the queue; a finished turn is not', () => {
		const entry = (status: QueueEntry['status']) =>
			({ id: 'e', mediaId: 'm1', singerId: 's', status, rotationSeq: 0, addedAt: 0 }) as QueueEntry;
		expect(inTonightsQueue([entry('playing')], 'm1')).toBe(true);
		expect(inTonightsQueue([entry('queued')], 'm1')).toBe(true);
		expect(inTonightsQueue([entry('done')], 'm1')).toBe(false);
		expect(inTonightsQueue([entry('queued')], 'm2')).toBe(false);
	});

	it('only a ready song outside its Undo window', () => {
		const pending = new Set(['gone']);
		const ready = { lyricsStatus: 'ready', songProfile: EMPTY_SONG_PROFILE } as const;
		const app = {
			mediaById: new Map([
				['m1', song(ready)],
				['raw', song({ id: 'raw', stemStatus: 'none', instrumentalRef: undefined })],
				['gone', song({ id: 'gone', ...ready })]
			]),
			pendingDeletes: { has: (id: string) => pending.has(id) }
		};
		expect(librarySong(app, 'm1')?.id).toBe('m1');
		expect(librarySong(app, 'raw')).toBeUndefined();
		expect(librarySong(app, 'gone')).toBeUndefined();
		expect(librarySong(app, 'nope')).toBeUndefined();
	});
});

describe('requestDelete', () => {
	const ready = song({ lyricsStatus: 'ready', songProfile: EMPTY_SONG_PROFILE });
	const harness = () => {
		const scheduled: string[] = [];
		const entries: QueueEntry[] = [];
		const app = {
			mediaById: new Map([['m1', ready]]),
			pendingDeletes: { has: (id: string) => scheduled.includes(id), schedule: (id: string) => scheduled.push(id) },
			state: { entries }
		};
		return { app, scheduled, entries };
	};

	it('a turn added while Keep is being read is seen: the delete answers queued and no window starts', async () => {
		const { app, scheduled, entries } = harness();
		const slowKeepRead = async () => {
			await Bun.sleep(5);
			entries.push({ id: 'e1', mediaId: 'm1', singerId: 's', status: 'queued', rotationSeq: 0, addedAt: 0 });
			return false;
		};
		expect(await requestDelete(app, 'm1', slowKeepRead)).toEqual({ refused: 'queued' });
		expect(scheduled).toEqual([]);
	});

	it('starts the window for a ready, unkept song nobody has queued; refuses kept and unknown songs', async () => {
		const { app, scheduled } = harness();
		expect(await requestDelete(app, 'nope', async () => false)).toEqual({ refused: 'unknown' });
		expect(await requestDelete(app, 'm1', async () => true)).toEqual({ refused: 'kept' });
		expect(scheduled).toEqual([]);
		expect(await requestDelete(app, 'm1', async () => false)).toEqual({ media: ready });
		expect(scheduled).toEqual(['m1']);
	});
});

describe('bulkManage', () => {
	const ready = (id: string, over: Partial<Media> = {}) =>
		song({ id, lyricsStatus: 'ready', songProfile: EMPTY_SONG_PROFILE, ...over });
	const harness = async () => {
		const songs = [ready('m1'), ready('m2', { source: 'youtube', sourceRef: 'x' }), ready('m3'), ready('m4')];
		for (const m of songs) await writeSidecar(sidecarFromMedia(m, NOW));
		await setKeep('m3', true);
		const pendingDeletes = new PendingDeletes(() => {}, 60_000);
		const app = {
			mediaById: new Map(songs.map((m) => [m.id, m])),
			pendingDeletes,
			state: {
				entries: [
					{ id: 'e1', mediaId: 'm4', singerId: 's', status: 'queued', rotationSeq: 0, addedAt: 0 }
				] as QueueEntry[]
			}
		};
		return { app, pendingDeletes };
	};

	it('Keep and Keep off reach every song once, and an unknown id is skipped', async () => {
		const { app } = await harness();
		const out = await bulkManage(app, 'keep', ['m1', 'm2', 'm1', 'nope']);
		expect(out.done).toEqual(['m1', 'm2']);
		expect(out.skipped).toEqual([{ mediaId: 'nope', reason: 'unknown' }]);
		expect((await readSidecar('m2'))?.library.keep).toBe(true);
		await bulkManage(app, 'unkeep', ['m1', 'm2']);
		expect((await readSidecar('m1'))?.library.keep).toBeUndefined();
	});

	it('Delete refuses kept and queued songs as a single delete does, and Undo brings the rest back', async () => {
		const { app, pendingDeletes } = await harness();
		const out = await bulkManage(app, 'delete', ['m1', 'm2', 'm3', 'm4', 'nope']);
		expect(out.done).toEqual(['m1', 'm2']);
		expect(out.skipped).toEqual([
			{ mediaId: 'm3', reason: 'kept' },
			{ mediaId: 'm4', reason: 'queued' },
			{ mediaId: 'nope', reason: 'unknown' }
		]);
		expect(out.libraryFile).toBe(true); // m1 is a library-folder file
		expect(pendingDeletes.has('m1') && pendingDeletes.has('m2')).toBe(true);
		const undone = await bulkManage(app, 'undo', ['m1', 'm2', 'm3']);
		expect(undone.done).toEqual(['m1', 'm2']);
		expect(undone.skipped).toEqual([{ mediaId: 'm3', reason: 'gone' }]);
		expect(pendingDeletes.has('m1')).toBe(false);
	});

	it('Make again queues one remake per song, behind every pick, a kept or queued one included', async () => {
		const { app, pendingDeletes } = await harness();
		pendingDeletes.schedule('m2'); // waiting out a delete: not in Library
		const jobs = new JobRepository(migratedDb());
		const remake = (m: Media) => void requestRemake(m, { jobs, now: () => NOW });
		const out = await bulkManage(app, 'remake', ['m1', 'm2', 'm3', 'm4', 'm1', 'nope'], remake);
		expect(out.done).toEqual(['m1', 'm3', 'm4']);
		expect(out.skipped).toEqual([
			{ mediaId: 'm2', reason: 'unknown' },
			{ mediaId: 'nope', reason: 'unknown' }
		]);
		const queued = jobs.listByStatus('queued');
		expect(queued.map((j) => j.mediaId).sort()).toEqual(['m1', 'm3', 'm4']);
		expect(queued.every((j) => j.jobType === 'stems-remake' && j.priority === NO_QUEUE_PRIORITY)).toBe(true);
		// The queued song's remake waits for its turn, as a single one does.
		const m4 = queued.find((j) => j.mediaId === 'm4')!;
		expect(waitsForTurn(m4, app.state.entries, null)).toBe(true);
		// Asked again while they wait: the same jobs, not a second set.
		await bulkManage(app, 'remake', ['m1', 'm3'], remake);
		expect(jobs.listByStatus('queued')).toHaveLength(3);
	});

	it('Lyrics again queues one lyrics remake per song with vocals, never held for a queued song’s turn', async () => {
		const { app } = await harness();
		for (const id of ['m1', 'm2', 'm4']) app.mediaById.get(id)!.vocalsRef = `derived/stems/${id}-vocals.flac`;
		const jobs = new JobRepository(migratedDb());
		const remake = (m: Media) => void requestRemake(m, { jobs, now: () => NOW }, 'align-remake');
		const out = await bulkManage(app, 'remake-lyrics', ['m1', 'm2', 'm3', 'm4', 'nope'], remake);
		expect(out.done).toEqual(['m1', 'm2', 'm4']);
		expect(out.skipped).toEqual([
			{ mediaId: 'm3', reason: 'no-vocals' }, // nothing to align to, as the single route's 409
			{ mediaId: 'nope', reason: 'unknown' }
		]);
		const queued = jobs.listByStatus('queued');
		expect(queued.every((j) => j.jobType === 'align-remake' && j.priority === NO_QUEUE_PRIORITY)).toBe(true);
		// m4 is in tonight's queue, and its lyrics remake runs anyway: the TV swaps new lyrics in between lines.
		const m4 = queued.find((j) => j.mediaId === 'm4')!;
		expect(waitsForTurn(m4, app.state.entries, null)).toBe(false);
		await bulkManage(app, 'remake-lyrics', ['m1'], remake);
		expect(jobs.listByStatus('queued')).toHaveLength(3);
	});
});

describe('PendingDeletes', () => {
	it('deletes when the window closes, never after an Undo, and flushes the rest at shutdown', async () => {
		const ran: string[] = [];
		const pending = new PendingDeletes((id) => ran.push(id), 20);
		pending.schedule('a');
		pending.schedule('b');
		pending.schedule('c');
		expect(pending.has('a')).toBe(true);
		expect(pending.undo('b')).toBe(true);
		expect(pending.undo('b')).toBe(false);
		await Bun.sleep(40);
		expect(ran.sort()).toEqual(['a', 'c']);
		expect(pending.undo('a')).toBe(false);

		const late = new PendingDeletes((id) => ran.push(id), 60_000);
		late.schedule('d');
		const flushed = late.flush();
		expect(ran).toContain('d');
		expect(await flushed).toEqual([]);
		expect(late.has('d')).toBe(false);
	});

	it('a song stays pending while its fired delete is still finishing, so it never reads as ready again', async () => {
		let release!: () => void;
		const runs: string[] = [];
		const pending = new PendingDeletes(async (id) => {
			runs.push(id);
			await new Promise<void>((r) => (release = r));
		}, 10);
		pending.schedule('f');
		await Bun.sleep(30);
		expect(runs).toEqual(['f']); // the timer fired; the finish is awaiting its read
		expect(pending.has('f')).toBe(true);
		pending.schedule('f'); // refused while finishing: no second delete
		expect(pending.undo('f')).toBe(false); // the window has closed
		release();
		await Bun.sleep(0);
		await Promise.resolve();
		expect(pending.has('f')).toBe(false);
		expect(runs).toEqual(['f']);
	});

	it('flush waits for a delete whose timer already fired, and gives up at its limit', async () => {
		let release!: () => void;
		const finished: string[] = [];
		const pending = new PendingDeletes(async (id) => {
			await new Promise<void>((r) => (release = r));
			finished.push(id);
		}, 10);
		pending.schedule('g');
		await Bun.sleep(30);
		let flushed = false;
		const flush = pending.flush().then(() => (flushed = true));
		await Bun.sleep(10);
		expect(flushed).toBe(false);
		release();
		await flush;
		expect(finished).toEqual(['g']);

		const stalled = new PendingDeletes(() => new Promise(() => {}), 60_000);
		stalled.schedule('h');
		expect(await stalled.flush(20)).toEqual(['h']);
	});

	it('flush resolves only once an async delete has finished, so shutdown can wait for it', async () => {
		let release!: () => void;
		const finished: string[] = [];
		const pending = new PendingDeletes(async (id) => {
			await new Promise<void>((r) => (release = r));
			finished.push(id);
		}, 60_000);
		pending.schedule('e');
		let flushed = false;
		const flush = pending.flush().then(() => (flushed = true));
		await Promise.resolve();
		expect(flushed).toBe(false);
		release();
		await flush;
		expect(finished).toEqual(['e']);
	});
});
