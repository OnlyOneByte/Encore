// #1153: AN EVICTED SONG IS MADE AGAIN, NOT CALLED READY. A song is made, the host reboots with a disk cap that
// evicts its stems, and a guest picks it again. Before the fix the pick ran no job and answered `ready` over
// deleted files. Now no screen calls it ready, the pick runs the process, and the TV plays it.
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';
import { processTrack, queueReadyTrack, tapStage, TRACKS } from './audio-probe-support';

const track = TRACKS.caroline;

async function readyIds(baseURL: string): Promise<{ search: string[]; library: string[] }> {
	const search = (await fetch(`${baseURL}/api/search?q=${track.q}&source=local`).then((r) => r.json())) as {
		ready?: { id: string }[];
	};
	const library = (await fetch(`${baseURL}/api/library`).then((r) => r.json())) as { library: { id: string }[] };
	return { search: (search.ready ?? []).map((m) => m.id), library: library.library.map((m) => m.id) };
}

// A file-backed DB so the reboot keeps the job rows, and a 1-byte cap so the boot pass evicts the song.
test.use({ coreEnv: { ENCORE_EPHEMERAL: '0', ENCORE_MEDIA_MAX_GB: '0.000000001' } });

test('evict, re-pick: the song is made again and plays', async ({ world }) => {
	test.setTimeout(180_000);
	let worker = await startFakeWorker(world);
	const maya = await world.openPhone('Maya');
	let made: Awaited<ReturnType<typeof processTrack>>;
	try {
		made = await processTrack(maya, world.baseURL, track);
	} finally {
		await worker.stop();
	}
	const stems = join(world.mediaDir, ...made.instrumentalRef.split('/'));
	expect(existsSync(stems)).toBe(true);

	await world.core.restart();
	await expect
		.poll(() => world.core.log().includes('retention: evicted derived artifacts'), { timeout: 30_000 })
		.toBe(true);
	expect(existsSync(stems), 'eviction deleted the stems').toBe(false);
	// Search (the phone's Sing tab) and Library both say it needs making.
	expect(await readyIds(world.baseURL)).toEqual({ search: [], library: [] });

	worker = await startFakeWorker(world);
	try {
		const res = await maya.request.post('/api/process', { data: { mediaId: made.id } });
		const body = (await res.json()) as { alreadyReady?: boolean; job?: { status: string } };
		expect(res.status()).toBe(200);
		expect(body.alreadyReady, 'the pick called deleted stems ready').toBeFalsy();
		expect(body.job?.status, 'the pick handed back the finished job').not.toBe('ready');

		const remade = await processTrack(maya, world.baseURL, track);
		expect(existsSync(join(world.mediaDir, ...remade.instrumentalRef.split('/')))).toBe(true);

		const tv = await world.openTv();
		await tapStage(tv);
		await maya.goto('/');
		await openBrowseFromHome(maya);
		await queueReadyTrack(maya, track);
		const audio = () =>
			tv
				.locator('.slot.visible audio')
				.first()
				.evaluate((el) => ({ t: (el as HTMLAudioElement).currentTime, paused: (el as HTMLAudioElement).paused }))
				.catch(() => null);
		await expect.poll(async () => (await audio())?.paused, { timeout: 30_000 }).toBe(false);
		await expect.poll(async () => (await audio())?.t ?? 0, { timeout: 10_000 }).toBeGreaterThan(0.5);
	} finally {
		await worker.stop();
	}
});

// The fake worker writes legacy .wav stems, so the reboot's recompress pass encodes them to FLAC before eviction
// runs. A slow encoder holds that pass open, so the phone reconnects and re-reads Library while the song is
// still listed as ready, and only the eviction broadcast can take it off.
const slowFfmpeg = join(mkdtempSync(join(tmpdir(), 'enc-slow-ffmpeg-')), 'ffmpeg.sh');
writeFileSync(slowFfmpeg, '#!/bin/sh\ncase "$*" in *"-c:a flac"*) sleep 5;; esac\nexec ffmpeg "$@"\n');
chmodSync(slowFfmpeg, 0o755);

test.describe(() => {
	test.use({
		coreEnv: { ENCORE_EPHEMERAL: '0', ENCORE_MEDIA_MAX_GB: '0.000000001', FFMPEG_BIN: slowFfmpeg }
	});

	test('a phone open during eviction sees the song leave Library without reloading', async ({ world }) => {
		test.setTimeout(180_000);
		const worker = await startFakeWorker(world);
		const maya = await world.openPhone('Maya');
		try {
			await processTrack(maya, world.baseURL, track);
		} finally {
			await worker.stop();
		}
		await maya.goto('/library');
		const row = maya.locator(SEL.songRow).filter({ hasText: track.title });
		await expect(row).toHaveCount(1);

		const reread = maya.waitForResponse((r) => r.url().endsWith('/api/library'), { timeout: 30_000 });
		await world.core.restart();
		await reread;
		expect(world.core.log(), 'the phone re-read Library before eviction ran').not.toContain('retention: evicted');
		await expect(row, 'the reconnect re-read still lists the song').toHaveCount(1);

		await expect
			.poll(() => world.core.log().includes('retention: evicted derived artifacts'), { timeout: 60_000 })
			.toBe(true);
		await expect(row, 'the open phone still shows the evicted song in Library').toHaveCount(0, { timeout: 5_000 });
	});
});
