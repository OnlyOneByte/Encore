// THE README FRAMES. One room driven end to end, so the screenshots in README.md show the app as it ships:
// a phone joining, a TV lobby with its QR, a queue with somebody on deck, and the TV after it hands over a turn.
// Run `README_SHOTS_OUT=../docs/screenshots bun run pw:shot readme.spec.ts` to refresh them, inside
// `mcr.microsoft.com/playwright:v1.56.1-noble` (docs/E2E.md): the app's system font stack changes every frame elsewhere.
// Then shrink the two TV frames to a 256-colour palette, which keeps the QR and text crisp:
// `for f in tv-lobby tv-up-next; do convert $f.png -strip -dither FloydSteinberg -colors 256 PNG8:$f.png; done`
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

	const worker = await startFakeWorker(world);
	try {
		const tv = await world.openTv();
		const theo = await world.openPhone('Theo');
		await world.becomeHost(theo);
		// The join address is a machine setting; with it set, the TV paints a QR instead of the operator notice.
		await theo.goto('/settings/server');
		await theo.locator(SEL.setting('join-origin')).fill('http://192.168.7.42:3000');
		await theo.locator(SEL.setting('join-origin')).blur();
		const ana = await world.openPhone('Ana');

		// The join pane a scanned QR lands on, filled in: Maya joining the room Theo and Ana are already in.
		const anon = await browser.newContext({ baseURL: world.baseURL, viewport: { width: 390, height: 844 } });
		const joinPage = await anon.newPage();
		await joinPage.emulateMedia({ reducedMotion: 'reduce' });
		await joinPage.goto(`/?room=${encodeURIComponent(world.code)}`);
		await expect(joinPage.getByText('Theo and Ana are here.')).toBeVisible();
		await joinPage.locator(SEL.nameInput).fill('Maya');
		await joinPage.locator(SEL.colourRing).press('End');
		await expect(joinPage.getByRole('button', { name: SEL.submit })).toBeEnabled();
		await shootPhone(joinPage, 'phone-join', SEL.nameInput);
		await anon.close();

		const maya = await world.openPhone('Maya', { stop: 'End' });
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

		// Theo's turn ends; the TV hands the stage to Maya. Shot once her card has gone: the card's scrim is clear at
		// the edges, so over it the lower third names her a second time.
		await theo.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(tv.locator(SEL.stateNext)).toBeVisible({ timeout: 30_000 });
		await expect(tv.locator(SEL.stateNext)).toHaveCount(0, { timeout: 30_000 });
		await expect(tv.locator(SEL.nowNameScoped)).toHaveText('Maya');
		await shoot(tv, 'tv-up-next');
	} finally {
		await worker.stop();
	}
});
