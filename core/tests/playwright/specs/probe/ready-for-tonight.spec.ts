// Proposal 39: Ready for tonight. The host's one screen of six rows, each green or red with one fix line.
//   * Nothing running: the TV and karaoke maker rows are red, with what to do.
//   * A karaoke maker whose YouTube and lyrics are broken: those rows turn red with the worker's own words. The
//     lyrics note is the one the REAL worker's check returns on this hermetic network: "lrcmux: DNS; lrclib: DNS".
//   * A TV whose sound is locked: the test sound shows the tap hint on the TV now, before guests, and the tap turns
//     the Sound row green.
//   * A lyrics check that never answers reads "Didn't answer", never green.
//   * A guest is refused the page and every route.
// Frames at 390 and 320 go to the test's output folder for the PR.
import { test, expect } from '../../world/fixtures';
import { startFakeWorker } from '../../world/workers';
import { requireActivationForPlayback } from '../../world/autoplay';
import type { Browser, Page, TestInfo } from '@playwright/test';
import type { World } from '../../world/fixtures';

// What the real worker sends when both are missing (`hardware.youtube_gap`): what is missing, never a path.
const GAP = {
	code: 'youtube-gap',
	text: 'YouTube downloads will fail without deno on PATH and --remote-components ejs:github in a yt-dlp config'
};
const LOST = {
	code: 'lyrics-unreachable',
	text: "Can't reach the lyrics service, so songs will use heard words, which are less accurate and slower.",
	detail: 'lrcmux: DNS; lrclib: DNS'
};

/** The room's TV on its own context, with its sound locked until a real tap, as a TV wall's is. */
async function lockedTv(browser: Browser, world: World): Promise<Page> {
	const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, baseURL: world.baseURL });
	await ctx.addCookies([world.tvCookie]);
	const tv = await ctx.newPage();
	await requireActivationForPlayback(tv, { gateAudioContext: true, suspendAudioContext: true });
	await tv.goto(`/tv?room=${encodeURIComponent(world.code)}`);
	await tv.locator('.status.on').waitFor({ state: 'attached', timeout: 15_000 });
	return tv;
}

const row = (page: Page, id: string) => page.locator(`[data-row="${id}"]`);
const states = (page: Page) =>
	page.locator('[data-row]').evaluateAll((els) => els.map((el) => `${el.dataset.row}:${el.dataset.state}`));

/** The screen as a phone shows it, at the top and scrolled to the end, at 390 and 320. */
async function frames(page: Page, testInfo: TestInfo, name: string) {
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: width === 390 ? 844 : 568 });
		await page.evaluate(() => scrollTo(0, 0));
		await page.screenshot({ path: testInfo.outputPath(`${name}-${width}-top.png`) });
		await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
		await page.screenshot({ path: testInfo.outputPath(`${name}-${width}-end.png`) });
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await page.evaluate(() => scrollTo(0, 0));
}

test('the host checks the room: each red row says what to do, and fixing it turns it green', async ({
	browser,
	world
}, testInfo) => {
	test.setTimeout(120_000);
	const host = await world.openPhone('Host');
	await world.becomeHost(host);

	// The door is the first row of Settings, for the host.
	await host.goto('/settings');
	await host.getByRole('link', { name: 'Ready for tonight' }).click();
	await expect(host).toHaveURL(/\/settings\/ready$/);

	// Nothing running yet.
	await expect.poll(() => states(host)).toContain('tv:red');
	expect(await states(host)).toEqual(
		expect.arrayContaining(['tv:red', 'sound:red', 'maker:red', 'youtube:red', 'lyrics:red', 'room:green'])
	);
	await expect(row(host, 'tv')).toContainText('Open the TV link on the big screen.');
	await expect(row(host, 'maker')).toContainText('Start the karaoke maker.');
	await host.getByRole('button', { name: 'Show the TV link' }).click();
	await expect(row(host, 'tv')).toContainText('/tv');
	await frames(host, testInfo, 'ready-nothing-on');

	// A karaoke maker whose YouTube and lyrics lookups are broken, and the room's TV with its sound locked.
	let worker = await startFakeWorker(world, { warnings: [GAP], lyricsNote: LOST, profile: { device: 'cpu' } });
	const tv = await lockedTv(browser, world);
	try {
		await host.getByRole('button', { name: 'Check again' }).click();
		await expect
			.poll(() => states(host), { timeout: 10_000 })
			.toEqual(['tv:green', 'sound:wait', 'maker:green', 'youtube:red', 'lyrics:red', 'room:green']);
		await expect(row(host, 'youtube')).toContainText(
			'The karaoke maker is missing deno on PATH and --remote-components ejs:github in a yt-dlp config.'
		);
		await expect(row(host, 'lyrics')).toContainText('Songs will use heard words');
		await row(host, 'lyrics').getByText('Details').click();
		await expect(row(host, 'lyrics')).toContainText('lrcmux: DNS; lrclib: DNS');

		// The test sound on a locked TV: the tap hint shows on the TV now, and the row says to tap it.
		await host.getByRole('button', { name: 'Play a test sound on the TV' }).click();
		await expect(tv.getByRole('status').filter({ hasText: 'Tap anywhere to start the music' })).toBeVisible();
		await expect(row(host, 'sound')).toHaveAttribute('data-state', 'red', { timeout: 5_000 });
		await expect(row(host, 'sound')).toContainText('Tap the TV screen once.');
		await frames(host, testInfo, 'ready-red');
		await tv.screenshot({ path: testInfo.outputPath('ready-tv-tap-hint-1920.png') });

		// One real tap on the TV plays the chime, and the row turns green on the next read.
		await tv.mouse.click(960, 540);
		await expect(tv.getByText('Tap anywhere to start the music')).toHaveCount(0);
		await host.getByRole('button', { name: 'Play a test sound on the TV' }).click();
		await expect(row(host, 'sound')).toHaveAttribute('data-state', 'green', { timeout: 5_000 });
		// Only what was checked: the TV's browser can start audio, not that its speakers are on.
		await expect(row(host, 'sound')).toContainText('The TV can play sound');
	} finally {
		await worker.stop();
	}

	// The karaoke maker fixed: every row green.
	worker = await startFakeWorker(world, { profile: { device: 'cpu' } });
	try {
		await host.waitForTimeout(5_100); // the recheck's own rate limit
		await host.getByRole('button', { name: 'Check again' }).click();
		await expect
			.poll(() => states(host), { timeout: 10_000 })
			.toEqual(['tv:green', 'sound:green', 'maker:green', 'youtube:green', 'lyrics:green', 'room:green']);
		await expect(host.locator('.fix')).toHaveCount(0);
		await frames(host, testInfo, 'ready-green');
	} finally {
		await worker.stop();
	}
});

test('a lyrics check that never answers reads "Didn\'t answer", never green', async ({ world }) => {
	const host = await world.openPhone('Host');
	await world.becomeHost(host);
	const worker = await startFakeWorker(world, { lyricsNote: 'silent' });
	try {
		await host.goto('/settings/ready');
		await expect(row(host, 'lyrics')).toHaveAttribute('data-state', 'red', { timeout: 10_000 });
		await expect(row(host, 'lyrics')).toContainText("Didn't answer");
	} finally {
		await worker.stop();
	}
});

test('a guest is refused the page and every route', async ({ world }) => {
	const guest = await world.openPhone('Bo');
	await guest.goto('/settings/ready');
	await expect(guest).toHaveURL(/\/host\?next=/);
	await guest.goto('/settings');
	await expect(guest.getByRole('link', { name: 'Ready for tonight' })).toHaveCount(0);
	expect((await guest.request.get('/api/host/ready')).status()).toBe(403);
	expect((await guest.request.post('/api/host/ready/recheck')).status()).toBe(403);
	expect((await guest.request.post('/api/host/ready/chime')).status()).toBe(403);
});
