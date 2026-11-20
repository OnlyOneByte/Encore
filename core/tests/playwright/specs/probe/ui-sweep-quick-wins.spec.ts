// The UI sweep's quick wins, driven in the real built app (encore sweeps, ui.md UI-05/06/07). Measured, not
// matched on source text: a refactor that keeps the strings and changes the behaviour fails here.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome } from '../../world/actors';
import type { Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

/** Process a demo track to READY before anyone queues it, so a queued turn starts at once. */
async function readySong(world: World, phone: Page, query: string): Promise<void> {
	const track = await world.awaitDemoTrack(query);
	await phone.request.post('/api/process', { data: { mediaId: track.id } });
	await expect
		.poll(
			async () => {
				const body = (await phone.request.get('/api/library').then((r) => r.json())) as {
					library: { id: string; instrumentalRef?: string | null }[];
				};
				return body.library.some((m) => m.id === track.id && !!m.instrumentalRef);
			},
			{ timeout: 60_000, message: `"${query}" never became ready — is the fake worker connected?` }
		)
		.toBe(true);
}

async function queueReady(phone: Page, query: string): Promise<void> {
	await openBrowseFromHome(phone);
	await phone.locator(SEL.search).fill(query);
	await phone.locator(SEL.addTurn).first().click();
}

/** The strip's two text boxes, as laid out. */
async function stripBoxes(page: Page) {
	return page.evaluate(() => {
		const box = (s: string) => {
			const el = document.querySelector(`.dock .strip ${s}`) as HTMLElement;
			return {
				w: el.getBoundingClientRect().width,
				scrollW: el.scrollWidth,
				chW: el.scrollWidth / (el.textContent?.length || 1)
			};
		};
		return { meta: box('.meta'), who: box('.who'), song: box('.song') };
	});
}

// The fixture tracks are named by slug, so the TITLE is lengthened in the DOM; the names are real joins.
const LONG_TITLE = 'Don’t Stop Believin’ (2024 Remaster) [Official HD Video]';

test('UI-05: a short name shows whole beside a long title, and a long name leaves the title some room', async ({
	world
}) => {
	const worker = await startFakeWorker(world);
	try {
		const long = await world.openPhone('Bartholomew-Alexander Fitzgerald');
		const bo = await world.openPhone('Bo');
		await readySong(world, long, 'believin');
		await readySong(world, long, 'caroline');
		await queueReady(long, 'believin');
		await queueReady(bo, 'caroline');
		await expect(long.locator(SEL.npStripWho)).toHaveText(/^Bartholomew/);

		for (const width of [320, 390]) {
			await long.setViewportSize({ width, height: 844 });
			await long.locator(SEL.npStripTitle).evaluate((el, t) => (el.textContent = t), LONG_TITLE);
			const { meta, who, song } = await stripBoxes(long);
			expect(who.w, `${width}px: the long name is not capped`).toBeLessThanOrEqual(meta.w * 0.6 + 1);
			expect(song.w, `${width}px: the long name took the title away`).toBeGreaterThanOrEqual(3 * song.chW);
		}

		await long.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(long.locator(SEL.npStripWho)).toHaveText('Bo');
		for (const width of [320, 390]) {
			await long.setViewportSize({ width, height: 844 });
			await long.locator(SEL.npStripTitle).evaluate((el, t) => (el.textContent = t), LONG_TITLE);
			const { who } = await stripBoxes(long);
			// Whole: the box is as wide as its text, so nothing is clipped.
			expect(who.w, `${width}px: "Bo" was clipped`).toBeGreaterThanOrEqual(who.scrollW - 0.5);
		}
	} finally {
		await worker.stop();
	}
});

/**
 * A TV whose every play() STARTS (so the element is not paused) and is reported refused 1.5 s later, as a decode
 * refusal is: TvPlayer's "the room is silent" arm. Late, because an immediate rejection is wiped by the slot's own
 * `onready`. LOOPED, so the 8 s fixture track cannot end mid-test and move the room on by itself.
 */
async function failingTv(world: World): Promise<Page> {
	const tv = await world.openTv();
	await tv.evaluate(() => {
		const orig = HTMLMediaElement.prototype.play;
		HTMLMediaElement.prototype.play = function () {
			this.loop = true;
			void orig.call(this).catch(() => {});
			return new Promise((_, reject) =>
				setTimeout(() => reject(new DOMException('no supported sources', 'NotSupportedError')), 1500)
			);
		};
	});
	return tv;
}

const skip = (phone: Page) => phone.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();

test('UI-06/07: the won’t-play overlay names no browser error, and the next song does not open under it', async ({
	world
}) => {
	const worker = await startFakeWorker(world);
	try {
		const theo = await world.openPhone('Theo');
		const maya = await world.openPhone('Maya');
		await readySong(world, theo, 'believin');
		await readySong(world, theo, 'caroline');
		const tv = await failingTv(world);
		await queueReady(theo, 'believin');

		const overlay = tv.locator('.silent-room');
		await expect(overlay).toBeVisible({ timeout: 30_000 });
		await expect(overlay).toHaveText(/won’t play/);
		await expect(overlay).not.toContainText('Error');

		// The next song's audio never arrives, so its slot never reports ready: only the change of song can clear the
		// failure. Hung from before Maya queues, so the hidden slot cannot pre-warm it either.
		await tv.route('**/*', (route) => (route.request().resourceType() === 'media' ? undefined : route.fallback()));
		await queueReady(maya, 'caroline');
		await expect(theo.locator(SEL.npStripWho)).toHaveText('Theo');
		await skip(theo);
		await expect(theo.locator(SEL.npStripWho)).toHaveText('Maya');
		await expect(tv.locator(SEL.lobby)).toBeHidden();
		await expect(overlay).toBeHidden();
	} finally {
		await worker.stop();
	}
});

test('UI-06: a failure on the last song never sits over the lobby’s join QR', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya');
		await readySong(world, maya, 'believin');
		const tv = await failingTv(world);
		await queueReady(maya, 'believin');
		const overlay = tv.locator('.silent-room');
		await expect(overlay).toBeVisible({ timeout: 30_000 });
		await skip(maya);
		await expect(tv.locator(SEL.lobby)).toBeVisible({ timeout: 30_000 });
		await expect(overlay).toBeHidden();
	} finally {
		await worker.stop();
	}
});
