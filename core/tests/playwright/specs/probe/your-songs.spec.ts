// Your songs under the empty Sing box (proposal 36, PR 2): a song you sang comes back in the key you finished it in,
// one + queues it in that key, a saved song is there too, a guest sees the Keep me line, someone new sees the bare box,
// and the list moves nothing on a cold load.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { openQueue, readySong, singOnce } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import type { Page } from '@playwright/test';

const YOURS = 'Your songs';

/** The /queue Key label as the server broadcast it: "Key", or "Key · −2". */
async function keyLabel(phone: Page): Promise<string> {
	return ((await phone.locator(SEL.keyLabel).first().textContent()) ?? '').trim();
}

/** Two semitones down on the song you are singing, each press waiting for the server's echo. */
async function twoKeysDown(phone: Page): Promise<void> {
	await openQueue(phone);
	for (const want of [/[−-]1/, /[−-]2/]) {
		await phone.locator(SEL.keyBtn).first().click();
		await expect.poll(() => keyLabel(phone), { timeout: 5_000 }).toMatch(want);
	}
}

type Song = { mediaId: string | null; sung: number; keyShift: number };
async function mySongs(phone: Page): Promise<Song[]> {
	return ((await phone.request.get('/api/me/songs').then((r) => r.json())) as { songs: Song[] }).songs;
}

/** Layout shifts from navigation start until the list (or its absence) has settled. */
async function coldLoadShift(phone: Page): Promise<number> {
	await phone.addInitScript(() => {
		const w = window as unknown as { __cls: number };
		w.__cls = 0;
		new PerformanceObserver((list) => {
			for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[])
				if (!e.hadRecentInput) w.__cls += e.value;
		}).observe({ type: 'layout-shift', buffered: true });
	});
	await phone.goto('/');
	await expect(phone.getByRole('heading', { name: YOURS })).toBeVisible();
	await phone.waitForTimeout(500);
	return phone.evaluate(() => (window as unknown as { __cls: number }).__cls);
}

test('a sung song comes back in its key, one + queues it there, and a saved song sits beside it', async ({ world }) => {
	test.setTimeout(240_000);
	const worker = await startFakeWorker(world);
	try {
		await world.openTv();
		const theo = await world.openPhone('Theo');
		const caroline = await readySong(world, theo, 'caroline');
		await theo.goto('/');
		// Nothing yet: the bare box, with no heading and no explainer.
		await expect(theo.locator(SEL.findBox)).toBeVisible();
		await expect(theo.getByRole('heading', { name: YOURS })).toHaveCount(0);

		await singOnce(theo, 'caroline');
		await twoKeysDown(theo);
		// Back on Sing while the 8 s fixture plays out: the list arrives when the turn ends, with no reload (T1).
		await theo.locator(SEL.tab).filter({ hasText: 'Sing' }).first().click();
		await expect(theo.locator(SEL.songRow, { hasText: caroline })).toContainText('2 keys down · sung once', {
			timeout: 60_000
		});
		expect((await mySongs(theo)).find((s) => s.sung > 0)?.keyShift).toBe(-2);

		const prayer = await world.awaitDemoTrack('prayer');
		expect((await theo.request.put(`/api/me/songs/${prayer.id}`)).ok()).toBe(true);

		// /queue also remembered −2 on this phone; forget it, as a kept person's other phone would never have had it, so
		// the key below can only come from the server's record of the finished turn.
		await theo.evaluate(() => localStorage.clear());
		await theo.goto('/');
		await expect(theo.getByRole('heading', { name: YOURS })).toBeVisible();
		const sung = theo.locator(SEL.songRow, { hasText: caroline });
		await expect(sung).toContainText('2 keys down · sung once');
		await expect(theo.locator(SEL.songRow, { hasText: prayer.title })).toContainText('saved');
		// A guest who has sung can keep themselves, and the list says where it lives.
		await expect(theo.getByRole('link', { name: 'Keep Theo' })).toHaveAttribute('href', '/settings/you');

		// One + and the turn starts in the key Theo finished it in, as the server broadcasts it back.
		await sung.locator(SEL.addAction).click();
		await openQueue(theo);
		await expect.poll(() => keyLabel(theo), { timeout: 30_000 }).toMatch(/[−-]2/);

		// Someone else's phone shows none of it.
		const ana = await world.openPhone('Ana');
		await ana.goto('/');
		await expect(ana.locator(SEL.findBox)).toBeVisible();
		await expect(ana.getByRole('heading', { name: YOURS })).toHaveCount(0);
		await expect(ana.getByText(caroline)).toHaveCount(0);

		// The list arrives under everything on the idle screen, so it moves nothing at either width.
		for (const size of [
			{ width: 390, height: 844 },
			{ width: 320, height: 568 }
		]) {
			const page = await theo.context().newPage();
			await page.setViewportSize(size);
			expect(await coldLoadShift(page), `CLS on a cold load at ${size.width}`).toBe(0);
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth
			);
			expect(overflow, `nothing past the right edge at ${size.width}`).toBeLessThanOrEqual(0);
			await page.close();
		}
	} finally {
		await worker.stop();
	}
});
