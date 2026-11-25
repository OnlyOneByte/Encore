// The UI sweep's quick wins, driven in the real built app (encore sweeps, ui.md UI-05/06/07). Measured, not
// matched on source text: a refactor that keeps the strings and changes the behaviour fails here.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { queueReady, readySong, transportTap } from '../../world/actors';
import type { Page } from '@playwright/test';
import type { World } from '../../world/fixtures';

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

		await transportTap(long, 'skip');
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
 * A TV whose every play() STARTS (so the element advances) and is reported refused 1.5 s later, as a decode refusal
 * is. LOOPED, so the 8 s fixture track cannot end mid-test and move the room on by itself.
 */
async function refusedButPlayingTv(world: World): Promise<Page> {
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

// UI-06/07 asserted the "This song won't play" overlay. Proposal 11 retired it: a song that really won't play moves
// the room on (probe/wont-play.spec.ts covers its copy, the next song and the lobby). What stays is the false
// positive the overlay used to raise: a refused play() over an element that IS advancing is a song that is playing.
test('UI-06: a play() refused while the song still advances is not a failure — nobody is skipped', async ({
	world
}) => {
	const worker = await startFakeWorker(world);
	try {
		const theo = await world.openPhone('Theo');
		await readySong(world, theo, 'believin');
		await readySong(world, theo, 'caroline');
		const tv = await refusedButPlayingTv(world);
		await queueReady(theo, 'believin');
		await queueReady(theo, 'caroline');
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i, { timeout: 30_000 });
		await tv.waitForTimeout(12_000); // past the watchdog's 8 s
		await expect(theo.locator(SEL.npStripTitle)).toContainText(/believin/i);
		await expect(tv.locator(SEL.stateError)).toBeHidden();
		await expect(tv.locator(SEL.autoplayHint)).toBeHidden();
	} finally {
		await worker.stop();
	}
});

test('UI-03: a guest who moves the ring away and back keeps the start colour, even once it is taken', async ({
	world,
	browser
}) => {
	const colours = async () =>
		(await fetch(`${world.baseURL}/api/room-preview?code=${world.code}`).then((r) => r.json())) as {
			names: string[];
			colors: string[];
		};
	await world.openPhone('Maya');
	const jo = await (
		await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: world.baseURL })
	).newPage();
	await jo.goto(`/?room=${world.code}`);
	await jo.locator(SEL.nameInput).fill('Jo');
	// The ring's suggestion, read from its own accessible value before anyone else joins.
	// `.colour-ring` IS the slider (the disc carries the role); it waits behind "change".
	await jo.locator(SEL.colourChange).click();
	const ring = jo.locator(SEL.colourRing);
	const suggested = await ring.getAttribute('aria-valuenow');
	// Theo joins untouched in the meantime, and the room hands him the same free colour Jo is being shown.
	await world.openPhone('Theo');
	await ring.press('ArrowRight');
	await ring.press('ArrowLeft');
	await expect(ring).toHaveAttribute('aria-valuenow', suggested!);
	await jo.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
	await jo.getByRole('button', { name: SEL.submit }).click();
	await jo.locator(SEL.dock).waitFor({ state: 'attached' });
	const { names, colors } = await colours();
	// A deliberate choice is kept: Jo's colour is the one she was shown, which Theo now holds too.
	expect(colors[names.indexOf('Jo')]).toBe(colors[names.indexOf('Theo')]);
});
