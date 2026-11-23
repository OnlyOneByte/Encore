// THE README FRAMES. One room driven end to end, so the screenshots in README.md show the app as it ships:
// a phone joining, a TV lobby with its QR, a queue with somebody on deck, and the TV handing over a turn.
// Run `README_SHOTS_OUT=../docs/screenshots bun run pw:shot readme.spec.ts` to refresh them.
//
// EVERY VALUE ON SCREEN IS A FIXTURE: the room code is minted per run, the join address is the same LAN-shaped
// one `frames.spec.ts` uses, the singers are the names the other shot specs use, and the songs are TheFatRat's
// (see CREDITS.md). The tracks are 8-second tones with a fake worker behind them, so no real stems are needed.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openQueue, queueReady, readySong } from '../../world/actors';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SONGS = ['Fly Away', 'Mayday', 'The Chosen'];

test.use({
	demoLibrary: [
		SONGS.map((title, i) => ({ file: `TheFatRat - ${title}.wav`, seconds: 8, hz: [220 + i * 40, 330 + i * 40] })),
		{ scope: 'test' }
	]
});

test('readme: phone and TV frames', async ({ browser, world }, testInfo) => {
	const out = process.env.README_SHOTS_OUT ?? testInfo.outputDir;
	mkdirSync(out, { recursive: true });

	async function shoot(page: Page, name: string): Promise<void> {
		await page.evaluate(() => document.fonts.ready.then(() => true));
		await page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled', caret: 'hide' });
	}

	/** A phone frame at 390 and again at 320, the narrowest phone the layout supports. */
	async function shootPhone(page: Page, name: string, ready: string): Promise<void> {
		for (const width of [390, 320]) {
			await page.setViewportSize({ width, height: 844 });
			await expect(page.locator(ready).first()).toBeInViewport();
			await shoot(page, `${name}-${width}`);
		}
	}

	// The join pane a scanned QR lands on, filled in.
	const anon = await browser.newContext({ baseURL: world.baseURL, viewport: { width: 390, height: 844 } });
	const join_ = await anon.newPage();
	await join_.emulateMedia({ reducedMotion: 'reduce' });
	await join_.goto(`/?room=${encodeURIComponent(world.code)}`);
	await join_.locator(SEL.nameInput).fill('Maya');
	await join_.locator(SEL.colourRing).press('End');
	await expect(join_.getByRole('button', { name: SEL.submit })).toBeEnabled();
	await shootPhone(join_, 'phone-join', SEL.nameInput);
	await anon.close();

	const worker = await startFakeWorker(world);
	try {
		const tv = await world.openTv();
		const theo = await world.openPhone('Theo');
		// The join address is a machine setting; with it set, the TV paints a QR instead of the operator notice.
		await theo.goto('/settings/server');
		await theo.locator(SEL.setting('join-origin')).fill('http://192.168.7.42:3000');
		await theo.locator(SEL.setting('join-origin')).blur();
		const maya = await world.openPhone('Maya', { stop: 'End' });
		const ana = await world.openPhone('Ana');
		await expect(tv.locator(SEL.lobby)).toBeVisible();
		await expect(tv.locator(SEL.qrImage)).toBeVisible();
		await expect(tv.locator(SEL.lobbyStripPerson)).toHaveCount(3);
		await shoot(tv, 'tv-lobby');

		for (const song of SONGS) await readySong(world, theo, song);
		await theo.goto('/');
		// Lower case: queueReady matches its query against the lower-cased now-playing strip.
		await queueReady(theo, 'fly away');
		await expect(theo.locator(SEL.npStripTitle)).toBeAttached();
		await queueReady(maya, 'mayday');
		await queueReady(ana, 'the chosen');

		// Maya's queue: Theo singing, Maya on deck, Ana behind her.
		await maya.emulateMedia({ reducedMotion: 'reduce' });
		await openQueue(maya);
		const deck = maya.locator('section[aria-label="On deck"]');
		await expect(deck).toBeVisible();
		await shootPhone(maya, 'phone-queue', SEL.queueNowCard);

		// Theo's turn ends; the TV hands the stage to Maya.
		await theo.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(tv.locator(SEL.stateNext)).toBeVisible({ timeout: 30_000 });
		await shoot(tv, 'tv-up-next');
	} finally {
		await worker.stop();
	}
});
