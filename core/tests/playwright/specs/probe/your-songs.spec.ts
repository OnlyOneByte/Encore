// Your songs under the empty Sing box (proposal 36, PR 2): a song you sang comes back in the key you finished it in,
// one + queues it in that key, a saved song is there too, a guest sees the Keep me line, someone new sees the bare box,
// and the list moves nothing on a cold load.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { openQueue, readySong, singOnce } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import { sendPlayerCommand, serverPlayback } from './audio-probe-support';
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

type Song = { mediaId: string | null; sung: number; keyShift: number | null; media: unknown };
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

/** The playing entry's id, once the server has one. */
async function playingEntry(baseURL: string): Promise<string> {
	let id: string | null = null;
	await expect
		.poll(async () => (id = (await serverPlayback(baseURL)).state.currentEntryId as string | null), { timeout: 30_000 })
		.toBeTruthy();
	return id!;
}

test('a sung song comes back in its key, one + queues it there, and a saved song sits beside it', async ({ world }) => {
	test.setTimeout(240_000);
	// A guide mix, so the turn can finish with a guide on and the row can carry it back.
	const worker = await startFakeWorker(world, { guideMix: true });
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
		// Theo's own socket, so the guide is the singer's: low (0.3) for the rest of the turn.
		await sendPlayerCommand(theo, { cmd: 'guide', level: 0.3, entryId: await playingEntry(world.baseURL) });
		await expect.poll(async () => (await serverPlayback(world.baseURL)).state.guideLevel).toBe(0.3);
		// Back on Sing while the 8 s fixture plays out: the list arrives when the turn ends, with no reload (T1).
		await theo.locator(SEL.tab).filter({ hasText: 'Sing' }).first().click();
		// The search that queued it comes back with its results (#1259), and Your songs waits for an empty box.
		await expect(theo.getByRole('heading', { name: YOURS })).toHaveCount(0);
		await theo.getByRole('button', { name: 'Clear the search' }).click();
		await expect(theo.locator(SEL.songRow, { hasText: caroline })).toContainText(
			'2 keys down · guide low · sung once',
			{
				timeout: 60_000
			}
		);
		expect((await mySongs(theo)).find((s) => s.sung > 0)?.keyShift).toBe(-2);

		const prayer = await world.awaitDemoTrack('prayer');
		expect((await theo.request.put(`/api/me/songs/${prayer.id}`)).ok()).toBe(true);

		// /queue also remembered −2 on this phone; forget it, as a kept person's other phone would never have had it, so
		// the key below can only come from the server's record of the finished turn.
		await theo.evaluate(() => localStorage.clear());
		await theo.goto('/');
		await expect(theo.getByRole('heading', { name: YOURS })).toBeVisible();
		const sung = theo.locator(SEL.songRow, { hasText: caroline });
		await expect(sung).toContainText('2 keys down · guide low · sung once');
		await expect(theo.locator(SEL.songRow, { hasText: prayer.title })).toContainText('saved');
		// A guest who has sung can keep themselves, and the list says where it lives.
		await expect(theo.getByRole('link', { name: 'Keep Theo' })).toHaveAttribute('href', '/settings/you');

		// Someone else's phone shows none of it.
		const ana = await world.openPhone('Ana');
		await ana.goto('/');
		await expect(ana.locator(SEL.findBox)).toBeVisible();
		await expect(ana.getByRole('heading', { name: YOURS })).toHaveCount(0);
		await expect(ana.getByText(caroline)).toHaveCount(0);

		// One + and the turn starts in the key and guide Theo finished it in, as the server broadcasts them back.
		await sung.locator(SEL.addAction).click();
		// Paused once it starts, so the 8 s turn cannot end before both phones have read it.
		await playingEntry(world.baseURL);
		await sendPlayerCommand(theo, { cmd: 'pause' });
		await expect.poll(async () => (await serverPlayback(world.baseURL)).state.isPlaying).toBe(false);
		await openQueue(theo);
		await expect.poll(() => keyLabel(theo), { timeout: 30_000 }).toMatch(/[−-]2/);
		await ana.goto('/queue');
		await expect(ana.locator(SEL.queueNowTune)).toHaveText(/Key [−-]2 · Guide 30%/);

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

		// The host deletes the saved song (made now, so it can be deleted) while it is on Theo's list: his + is refused,
		// said once, and the row goes.
		const host = await world.openPhone('Host');
		await world.becomeHost(host);
		await readySong(world, host, 'prayer');
		await theo.goto('/');
		const saved = theo.locator(SEL.songRow, { hasText: prayer.title });
		await expect(saved.locator(SEL.addAction)).toBeVisible();
		const deleted = await host.request.post('/api/library/manage/delete', { data: { mediaId: prayer.id } });
		expect(deleted.status(), await deleted.text()).toBe(200);
		await saved.locator(SEL.addAction).click();
		await expect(
			theo.locator('[data-sonner-toast]', { hasText: "That song isn't in the library any more." })
		).toBeVisible();
		await expect(saved).toHaveCount(0);
		// Inside the Undo window the server already leaves it out, so a return to Sing does not bring it back.
		expect((await mySongs(theo)).find((s) => s.mediaId === prayer.id)).toMatchObject({ media: null });
		await theo.goto('/');
		await expect(theo.locator(SEL.songRow, { hasText: caroline })).toBeVisible();
		await expect(saved).toHaveCount(0);
	} finally {
		await worker.stop();
	}
});
