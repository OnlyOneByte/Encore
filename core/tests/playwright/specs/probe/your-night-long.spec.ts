// Your night on a long night (#1281 review): eight real songs with long titles, sung through the real recording path.
// At 320 every setlist row can be read: at full scroll the last row sits above the sticky footer, and Save above the
// dock, before and after scrolling.
import { test, expect } from '../../world/fixtures';
import { DEMO_LIBRARY } from '../../world/seed';
import { startFakeWorker } from '../../world/workers';
import { queueReady, transportTap } from '../../world/actors';
import { serverPlayback } from './audio-probe-support';
import type { Page, TestInfo } from '@playwright/test';
import type { World } from '../../world/fixtures';

/** The scanner reads `Artist - Title.wav`; `q` is a word each title alone has. */
const NIGHT = [
	{ q: 'Bohemian', file: 'Queen - Bohemian Rhapsody (2011 remaster extended mix).wav' },
	{ q: 'Caroline', file: 'Neil Diamond - Sweet Caroline (good times never seemed so good).wav' },
	{ q: 'Survive', file: 'Gloria Gaynor - I Will Survive (disco version).wav' },
	{ q: 'Prayer', file: 'Bon Jovi - Livin on a Prayer (the 1986 album version).wav' },
	{ q: 'Dancing', file: 'ABBA - Dancing Queen (the original 1976 single).wav' },
	{ q: 'Africa', file: 'Toto - Africa (the full album version, remastered).wav' },
	{ q: 'Somebody', file: 'Whitney Houston - I Wanna Dance with Somebody (who loves me).wav' },
	{ q: 'Girls', file: 'Cyndi Lauper - Girls Just Want to Have Fun (extended).wav' }
];

test.use({
	demoLibrary: [
		[...DEMO_LIBRARY, ...NIGHT.map((t, i) => ({ file: t.file, seconds: 8, hz: [200 + 20 * i, 300 + 20 * i] }))],
		{ scope: 'test' }
	]
});
test.setTimeout(300_000);

async function readyId(world: World, phone: Page, match: string): Promise<string> {
	const track = await world.awaitDemoTrack(match);
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

async function shot(page: Page, testInfo: TestInfo, name: string) {
	await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
	await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

test('an 8-song night at 320: every setlist row can be read, and Save stays above the dock', async ({
	world
}, testInfo) => {
	const worker = await startFakeWorker(world);
	try {
		const theo = await world.openPhone('Theo');
		const maya = await world.openPhone('Maya');
		for (const t of NIGHT) await readyId(world, theo, t.q);
		const tv = await world.openTv();
		// Lower case: queueReady reads the now-line lower-cased, while the scan's own match is the file name's case.
		for (const t of NIGHT) await queueReady(theo, t.q.toLowerCase());
		await expect.poll(() => current(world), { timeout: 30_000 }).not.toBeNull();
		await cheer(maya);
		for (let i = 0; i < NIGHT.length; i++) {
			const before = await current(world);
			await transportTap(theo, 'skip');
			await expect.poll(() => current(world), { timeout: 15_000 }).not.toBe(before);
		}
		await expect.poll(() => current(world), { timeout: 15_000 }).toBeNull();
		await tv.close();

		await theo.goto('/settings/you');
		const night = theo.locator('#nights').getByRole('link', { name: /8 songs/ });
		await expect(night).toBeVisible();
		await theo.setViewportSize({ width: 320, height: 568 });
		await night.click();
		// Pressed until the setlist shows: a key before the page hydrates does nothing, and the last slide clamps.
		await expect(async () => {
			await theo.keyboard.press('ArrowRight');
			await expect(theo.locator('[data-slide="setlist"]')).toBeVisible({ timeout: 500 });
		}).toPass({ timeout: 10_000 });
		const rows = theo.locator('[data-slide="setlist"] li');
		await expect(rows).toHaveCount(8);

		const check = async (label: string) => {
			const save = (await theo.getByRole('button', { name: 'Save picture' }).boundingBox())!;
			const dock = (await theo.locator('.dock').boundingBox())!;
			expect(save.y + save.height, `Save under the dock, ${label}`).toBeLessThanOrEqual(dock.y + 1);
			expect(save.y, `Save off the top, ${label}`).toBeGreaterThanOrEqual(0);
		};
		await check('at the top');
		await theo.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
		await check('scrolled to the end');
		// At full scroll the last row is clear of the footer and the dock. What sits over its middle is the story's own
		// transparent tap half (by design), never the footer or the dock.
		const last = (await rows.last().boundingBox())!;
		const foot = (await theo.locator('.foot').boundingBox())!;
		expect(last.y + last.height, 'the last row under the footer').toBeLessThanOrEqual(foot.y + 1);
		const cover = await theo.evaluate(
			({ x, y }) => {
				const el = document.elementFromPoint(x, y);
				return el?.closest('.foot') ? 'footer' : el?.closest('.dock') ? 'dock' : null;
			},
			{ x: last.x + last.width / 2, y: last.y + last.height / 2 }
		);
		expect(cover, 'the last row is covered').toBeNull();
		await shot(theo, testInfo, 'night-setlist-8-320');
		const overflow = await theo.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		expect(overflow, 'sideways scroll at 320').toBeLessThanOrEqual(0);
	} finally {
		await worker.stop();
	}
});
