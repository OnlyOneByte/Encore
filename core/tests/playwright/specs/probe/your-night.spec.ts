// Proposal 29 PR 3: Theo sings two songs, Maya cheers him, and his phone tells him his night. Only his: Maya gets a 404
// for his story and no nights of her own, and Delete my history removes it. Frames at 390 and 320, and a filmstrip for
// the flood and the slide change.
import { test, expect } from '../../world/fixtures';
import { startFakeWorker } from '../../world/workers';
import { queueReady, transportTap } from '../../world/actors';
import { serverPlayback } from './audio-probe-support';
import type { Page, TestInfo } from '@playwright/test';
import type { World } from '../../world/fixtures';

test.setTimeout(180_000);

async function readyId(world: World, phone: Page, query: string): Promise<string> {
	const track = await world.awaitDemoTrack(query);
	const res = await phone.request.post('/api/process', { data: { mediaId: track.id } });
	if (!res.ok()) throw new Error(`/api/process refused "${track.title}": ${res.status()}`);
	await expect
		.poll(
			async () => {
				const body = (await phone.request.get('/api/library').then((r) => r.json())) as {
					library: { id: string; instrumentalRef?: string | null }[];
				};
				return body.library.some((m) => m.id === track.id && !!m.instrumentalRef);
			},
			{ timeout: 60_000, message: `"${track.title}" never reached ready` }
		)
		.toBe(true);
	return track.id;
}

const current = async (world: World) => (await serverPlayback(world.baseURL)).state.currentEntryId;

/** A `room:react` on a new socket with this page's cookie, as the Cheer key sends it. */
const cheer = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const ws = new WebSocket(`ws://${location.host}/ws`);
				ws.onopen = () => {
					ws.send(JSON.stringify({ type: 'room:react', kind: 'clap' }));
					setTimeout(() => (ws.close(), resolve()), 200);
				};
				ws.onerror = () => reject(new Error('raw socket failed'));
			})
	);

/** A still once the slide's pop-in has played, so the frame shows it at rest. */
async function shot(page: Page, testInfo: TestInfo, name: string) {
	await page.waitForFunction(() =>
		document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)
	);
	await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

/** Stills from now on for the PR's GIF: `night-<n>.png`. */
async function filmstrip(page: Page, testInfo: TestInfo, ms: number, act: () => Promise<void>) {
	let i = 0;
	let on = true;
	const film = (async () => {
		while (on) await page.screenshot({ path: testInfo.outputPath(`night-${String(i++).padStart(3, '0')}.png`) });
	})();
	await act();
	await page.waitForTimeout(ms);
	on = false;
	await film;
}

test('Theo’s night: his songs and cheers, his alone, saved as a picture and deleted on his say', async ({
	world
}, testInfo) => {
	const worker = await startFakeWorker(world);
	try {
		const theo = await world.openPhone('Theo');
		const maya = await world.openPhone('Maya');
		await readyId(world, theo, 'caroline');
		await readyId(world, theo, 'believin');
		const tv = await world.openTv();
		await queueReady(theo, 'caroline');
		await queueReady(theo, 'believin');
		await expect.poll(() => current(world), { timeout: 30_000 }).not.toBeNull();
		const first = await current(world);
		for (let i = 0; i < 3; i++) await cheer(maya);
		await transportTap(theo, 'skip');
		await expect.poll(() => current(world), { timeout: 15_000 }).not.toBe(first);
		await transportTap(theo, 'skip');
		await expect.poll(() => current(world), { timeout: 15_000 }).toBeNull();
		await tv.close();

		// The You tab lists the night, counted as he sang it.
		await theo.goto('/settings/you');
		const card = theo.locator('#nights');
		const night = card.getByRole('link', { name: /2 songs/ });
		await expect(night).toBeVisible();
		await expect(card.getByRole('switch')).toBeChecked();
		await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await shot(theo, testInfo, 'you-nights-390');
		await theo.setViewportSize({ width: 320, height: 568 });
		await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await shot(theo, testInfo, 'you-nights-320');
		await theo.setViewportSize({ width: 390, height: 844 });
		await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await shot(theo, testInfo, 'you-nights-settled');

		// The story: flood, then a tap to the next slide, on the filmstrip.
		const storyUrl = await night.getAttribute('href');
		await filmstrip(theo, testInfo, 900, async () => {
			await night.click();
			await expect(theo.locator('[data-slide="cover"]')).toContainText('2 songs');
			await theo.waitForTimeout(600);
			await theo.getByRole('button', { name: 'Next slide' }).click();
		});
		const loudest = theo.locator('[data-slide="loudest"]');
		await expect(loudest).toContainText('cheer');
		await expect(loudest).toContainText(/sweet-caroline/i);
		await shot(theo, testInfo, 'night-loudest-390');
		await theo.keyboard.press('ArrowRight');
		const setlist = theo.locator('[data-slide="setlist"]');
		await expect(setlist.locator('li')).toHaveCount(2);
		await shot(theo, testInfo, 'night-setlist-390');
		await theo.keyboard.press('ArrowLeft');
		await theo.keyboard.press('ArrowLeft');
		await expect(theo.locator('[data-slide="cover"]')).toBeVisible();
		await shot(theo, testInfo, 'night-cover-390');

		// S1: a tap on Next paints the next slide within 100 ms.
		const tapMs = await theo.evaluate(
			() =>
				new Promise<number>((resolve) => {
					const t0 = performance.now();
					document.querySelector<HTMLButtonElement>('button[aria-label="Next slide"]')!.click();
					requestAnimationFrame(() =>
						resolve(document.querySelector('[data-slide="loudest"]') ? performance.now() - t0 : Infinity)
					);
				})
		);
		expect(tapMs, 'Next to the next slide painted').toBeLessThanOrEqual(100);
		await theo.keyboard.press('ArrowLeft');

		// Keyboard to the end: focus stays on Next at the last slide, which does nothing there.
		const next = theo.getByRole('button', { name: 'Next slide' });
		await next.focus();
		await theo.keyboard.press('Enter');
		await theo.keyboard.press('Enter');
		await expect(theo.locator('[data-slide="setlist"]')).toBeVisible();
		await expect(next).toBeFocused();
		await expect(next).toHaveAttribute('aria-disabled', 'true');
		await theo.keyboard.press('Enter');
		await expect(theo.locator('[data-slide="setlist"]')).toBeVisible();
		// The arrows belong to the story: from a dock control they move nothing.
		await theo.locator('.dock a').first().focus();
		await theo.keyboard.press('ArrowLeft');
		await expect(theo.locator('[data-slide="setlist"]')).toBeVisible();
		await theo.locator('.story').getByRole('button', { name: 'Previous slide' }).focus();
		await theo.keyboard.press('ArrowLeft');
		await theo.keyboard.press('ArrowLeft');
		await expect(theo.locator('[data-slide="cover"]')).toBeVisible();

		// Save picture: on a LAN http:// page, a PNG download.
		const download = theo.waitForEvent('download');
		await theo.getByRole('button', { name: 'Save picture' }).click();
		expect((await download).suggestedFilename()).toBe('my-night.png');

		// 320 wide: nothing spills sideways, and Save still sits on screen above the dock.
		await theo.setViewportSize({ width: 320, height: 568 });
		for (const step of ['cover', 'loudest', 'setlist']) {
			if (step !== 'cover') await theo.keyboard.press('ArrowRight');
			const overflow = await theo.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
			expect(overflow, `${step} at 320: sideways scroll`).toBeLessThanOrEqual(0);
			await shot(theo, testInfo, `night-${step}-320`);
		}
		// A long night is its own spec (your-night-long.spec.ts): 8 real songs.
		const save = await theo.getByRole('button', { name: 'Save picture' }).boundingBox();
		const dock = await theo.locator('.dock').boundingBox();
		expect(save!.y + save!.height, 'Save under the dock at 320').toBeLessThanOrEqual(dock!.y + 1);
		await theo.setViewportSize({ width: 390, height: 844 });

		// M2: a cold load of the story shifts nothing, every shift counted.
		await theo.addInitScript(() => {
			const w = window as unknown as { cls: number };
			w.cls = 0;
			new PerformanceObserver((l) => {
				for (const e of l.getEntries()) w.cls += (e as unknown as { value: number }).value;
			}).observe({ type: 'layout-shift', buffered: true });
		});
		await theo.goto(storyUrl!);
		await theo.waitForTimeout(1_000);
		expect(await theo.evaluate(() => (window as unknown as { cls: number }).cls)).toBe(0);

		// Maya: no nights of her own, and Theo's story is a 404 for her.
		await maya.goto('/settings/you');
		await expect(maya.locator('#nights')).toContainText('Sing a song and your night shows up here.');
		const theirs = await maya.goto(storyUrl!);
		expect(theirs?.status()).toBe(404);
		await expect(maya.locator('[data-slide]')).toHaveCount(0);

		// Keep my nights, tapped twice fast: never two PATCHes at once, and the switch and the server agree after.
		await theo.goto('/settings/you');
		let open = 0;
		let overlapped = false;
		theo.on('request', (r) => {
			if (r.method() !== 'PATCH' || !r.url().endsWith('/api/me/nights')) return;
			if (++open > 1) overlapped = true;
		});
		theo.on('requestfinished', (r) => {
			if (r.method() === 'PATCH' && r.url().endsWith('/api/me/nights')) open--;
		});
		const toggle = theo.locator('#nights').getByRole('switch');
		await toggle.click();
		await toggle.click();
		await expect(toggle).toBeChecked();
		await expect
			.poll(async () => ((await (await theo.request.get('/api/me/nights')).json()) as { recording: boolean }).recording)
			.toBe(true);
		expect(overlapped, 'two PATCHes in flight at once').toBe(false);

		// Delete my history: gone from the list, focus on the switch, and the story is a 404 for Theo too.
		await theo.locator('#nights').getByRole('button', { name: 'Delete my history' }).click();
		await theo.getByRole('button', { name: 'Yes, delete it' }).click();
		await expect(theo.locator('#nights')).toContainText('Sing a song and your night shows up here.');
		await expect(toggle).toBeFocused();
		expect((await theo.goto(storyUrl!))?.status()).toBe(404);
	} finally {
		await worker.stop();
	}
});
