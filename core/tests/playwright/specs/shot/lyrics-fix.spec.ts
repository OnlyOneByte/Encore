// THE LYRICS FIX'S SURFACES (proposal 32, PR 1): the host's song page before and after a paste, with Undo and Back to
// automatic lyrics, at 390 and 320, and the TV mid-song showing the fix. `LYRICS_SHOTS_OUT=<dir>` writes the PNGs there.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { DEMO_LIBRARY } from '../../world/seed';
import { startFakeWorker } from '../../world/workers';
import { queueReady, readySong } from '../../world/actors';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const LONG = { file: 'long-take.wav', seconds: 36, hz: [196, 246.94] };
test.use({ demoLibrary: [[...DEMO_LIBRARY, LONG], { scope: 'test' }] });

test('lyrics fix: the host song page and the TV', async ({ world }, testInfo) => {
	const out = process.env.LYRICS_SHOTS_OUT ?? testInfo.outputDir;
	mkdirSync(out, { recursive: true });
	async function shoot(page: Page, name: string): Promise<void> {
		await page.evaluate(() => document.fonts.ready.then(() => true));
		const path = join(out, `${name}.png`);
		await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
		await testInfo.attach(`${name}.png`, { path, contentType: 'image/png' });
	}
	async function songPage(page: Page, id: string, name: string): Promise<void> {
		for (const width of [390, 320]) {
			await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
			await page.goto(`/song/${id}`);
			await page.getByRole('button', { name: /Lyrics/ }).click();
			const paste = page.getByRole('button', { name: 'Paste my own' });
			await expect(paste).toBeVisible();
			// The last control in view, so the links under the list show at 320 x 568 too.
			const auto = page.getByRole('button', { name: 'Back to automatic lyrics' });
			await ((await auto.count()) ? auto : paste).scrollIntoViewIfNeeded();
			await shoot(page, `${name}-${width}`);
		}
	}

	const worker = await startFakeWorker(world, { seconds: 36 });
	try {
		const ana = await world.openPhone('Ana');
		await world.becomeHost(ana);
		await readySong(world, ana, 'long');
		const id = (await world.awaitDemoTrack('long')).id;
		await songPage(ana, id, 'song-auto');

		const rev = async () => (await (await ana.request.get(`/api/audit/${id}`)).json()).media?.lyricsEditRev ?? 0;
		const text = (i: number) => (i % 4 === 2 ? 'no escape from reality' : `line ${i}`);
		const lines = Array.from({ length: 40 }, (_, i) => ({ text: text(i) }));
		const saved = await ana.request.post('/api/lyrics-edit', { data: { mediaId: id, rev: await rev(), lines } });
		expect(saved.ok()).toBe(true);
		await expect
			.poll(async () => (await (await ana.request.get(`/api/audit/${id}`)).json()).media?.lyricsRef ?? '')
			.toContain('-edit-r1');
		await songPage(ana, id, 'song-fixed');

		const tv = await world.openTv();
		await tv.locator(SEL.tvConnected).waitFor({ state: 'attached' });
		await tv.mouse.click(960, 540);
		await ana.setViewportSize({ width: 390, height: 844 });
		await ana.goto('/');
		await queueReady(ana, 'long');
		await expect(tv.locator(SEL.lyricsRow, { hasText: 'no escape from reality' }).first()).toBeVisible({
			timeout: 30_000
		});
		await shoot(tv, 'tv-fixed-1920');

		// The Timing card, nudged 0.2 s early while the song plays.
		for (const width of [390, 320]) {
			await ana.setViewportSize({ width, height: width === 320 ? 568 : 844 });
			await ana.goto(`/song/${id}`);
			const earlier = ana.getByRole('button', { name: 'Earlier' });
			if (width === 390) for (let i = 0; i < 4; i++) await earlier.click();
			await expect(ana.getByRole('status').filter({ hasText: 'Words 0.2 s early' })).toBeVisible();
			await ana.getByText('Every line moves together').scrollIntoViewIfNeeded();
			await shoot(ana, `song-timing-${width}`);
		}
		await shoot(tv, 'tv-nudged-1920');
	} finally {
		await worker.stop();
	}
});
