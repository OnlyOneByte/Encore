// #1221: an offline worker whose speech model isn't cached. Its align completes ONCE with no lyrics and says why, the
// host's song page shows that reason with the paste control, and a pasted sheet still aligns.
// See docs/SERVER.md#lyrics-fixes.
import { test, expect } from '../../world/fixtures';
import { readySong } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import type { Page, TestInfo } from '@playwright/test';
import type { Media } from '$lib/contract';

interface AuditBody {
	media: Media | null;
	lyricsNote?: string | null;
	processes?: { attempts: { jobType: string; outcome: string | null }[] }[];
}

async function frame(page: Page, testInfo: TestInfo, name: string): Promise<void> {
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		const path = testInfo.outputPath(`${name}-${width}.png`);
		await page.screenshot({ path, fullPage: true });
		await testInfo.attach(`${name}-${width}.png`, { path, contentType: 'image/png' });
	}
	await page.setViewportSize({ width: 390, height: 844 });
}

test('offline without a speech model: one align, no lyrics, the song page says why and a paste still works', async ({
	world
}, testInfo) => {
	const worker = await startFakeWorker(world, { offlineAsr: true });
	try {
		const guest = await world.openPhone('Ana');
		await readySong(world, guest, 'caroline');
		const id = (await world.awaitDemoTrack('caroline')).id;

		const audit = async () => (await (await world.hostGet(`/api/audit/${id}`)).json()) as AuditBody;
		await expect.poll(async () => (await audit()).media?.lyricsStatus, { timeout: 30_000 }).toBe('ready');
		const first = await audit();
		const aligns = (first.processes ?? []).flatMap((p) => p.attempts).filter((a) => a.jobType === 'align');
		expect(
			aligns.map((a) => a.outcome),
			'one align, completed, never retried'
		).toEqual(['ready']);
		expect(first.lyricsNote).toBe('asr-offline');
		expect(first.media?.lyricsRef ?? null).toBeNull();

		// A guest can't change lyrics, so the guest page offers nothing.
		await guest.goto(`/song/${id}`);
		await expect(guest.locator('.facts.card')).toBeVisible();
		await expect(guest.locator('.reselect-empty')).toHaveCount(0);

		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		await host.goto(`/song/${id}`);
		const note = host.locator('.reselect-empty');
		await expect(note).toContainText('the karaoke maker is offline');
		await expect(note).toContainText('Paste them');
		await frame(host, testInfo, 'no-lyrics-offline');

		await host.locator('.reselect-paste-open').click();
		await host.locator('[data-slot="textarea"]').fill('Sweet Caroline\nGood times never seemed so good');
		await frame(host, testInfo, 'no-lyrics-pasting');
		await host.locator('[data-act="confirm"]').click();
		await expect.poll(async () => !!(await audit()).media?.lyricsRef, { timeout: 30_000 }).toBe(true);
		await expect(host.locator('.reselect-empty')).toHaveCount(0);
		expect((await audit()).lyricsNote ?? null, 'the later align clears the reason').toBeNull();
	} finally {
		await worker.stop();
	}
});
