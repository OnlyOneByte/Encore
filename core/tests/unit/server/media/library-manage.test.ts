// The host's library actions (proposal 33 PR 1): a rename that nothing overwrites, Keep, real sizes and the Undo window.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Media } from '$lib/contract';
import { mediaFromSidecar, readSidecar, sidecarFromMedia, writeSidecar } from '$lib/server/media/sidecar';
import { PendingDeletes, librarySizes, renameSong, setKeep } from '$lib/server/media/library-manage';
import { applyAnnotation } from '$lib/server/jobs/process';
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
		late.flush();
		expect(ran).toContain('d');
		expect(late.has('d')).toBe(false);
	});
});
