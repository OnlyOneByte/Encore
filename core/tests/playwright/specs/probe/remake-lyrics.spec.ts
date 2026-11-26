// Proposal 33 PR 3b: Make it again -> Lyrics. Remade mid-song, the TV keeps the old words up and swaps in the new
// ones with no frame of empty lyrics; the new document has a new name and the old ones are deleted.
import { test, expect } from '../../world/fixtures';
import { queueReady } from '../../world/actors';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import type { Page } from '@playwright/test';
import type { Media } from '$lib/contract';

async function libraryRow(page: Page, id: string): Promise<Media | undefined> {
	const body = (await page.request.get('/api/library').then((r) => r.json())) as { library: Media[] };
	return body.library.find((m) => m.id === id);
}

test('Lyrics again swaps them on a playing TV with no gap, and the old documents go', async ({ world }) => {
	test.setTimeout(150_000);
	const worker = await startFakeWorker(world, { seconds: 40, slowMs: 600 });
	try {
		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		const track = await world.awaitDemoTrack('caroline');
		expect((await host.request.post('/api/process', { data: { mediaId: track.id } })).ok()).toBe(true);
		await expect
			.poll(async () => (await libraryRow(host, track.id))?.lyricsRef ?? null, { timeout: 60_000 })
			.not.toBeNull();
		const before = (await libraryRow(host, track.id))!.lyricsRef!;

		await queueReady(host, track.title);
		const tv = await world.openTv();
		await tv.locator(SEL.tvConnected).waitFor({ state: 'attached' });
		await tv.mouse.click(960, 540);
		await tv.locator(SEL.lyricsRowCurrent).waitFor({ timeout: 30_000 });
		// Every 25 ms (and every frame), how many lyric rows the TV shows: a gap is a sample with none.
		await tv.evaluate((row) => {
			const w = window as unknown as { rowCounts: number[] };
			w.rowCounts = [];
			setInterval(() => w.rowCounts.push(document.querySelectorAll(row).length), 25);
		}, SEL.lyricsRow);

		const res = await host.request.post('/api/library/manage/remake', { data: { mediaId: track.id, what: 'lyrics' } });
		expect(res.ok()).toBe(true);
		await expect
			.poll(async () => (await libraryRow(host, track.id))?.lyricsRef, { timeout: 60_000 })
			.toMatch(new RegExp(`derived/lyrics/${track.id}-[0-9a-z]+\\.json$`));
		const after = (await libraryRow(host, track.id))!.lyricsRef!;
		expect(after).not.toBe(before);

		// The TV, never reloaded, now shows the remade words.
		await expect(tv.locator(SEL.lyricsRow, { hasText: 'Remade' }).first()).toBeAttached({ timeout: 20_000 });
		const counts = await tv.evaluate(() => (window as unknown as { rowCounts: number[] }).rowCounts);
		expect(counts.length, 'nothing was sampled').toBeGreaterThan(40);
		expect(counts.filter((n) => n === 0).length, 'a sample with no lyrics on the TV').toBe(0);

		// The old document is gone, the new one is served.
		expect((await host.request.get(`/media/${after}`)).status()).toBe(200);
		await expect.poll(async () => (await host.request.get(`/media/${before}`)).status()).toBe(404);
	} finally {
		await worker.stop();
	}
});
