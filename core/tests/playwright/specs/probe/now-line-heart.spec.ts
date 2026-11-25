// The now-line heart (proposal 36, PR 2): while someone else sings, one tap saves the song to your songs, the mark
// fills on that frame and the line says so for 2 s in place; on your own song the heart rests; a second tap unsaves.
import { test, expect, type World } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { queueReady, readySong } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import { DEMO_LIBRARY } from '../../world/seed';
import type { Page } from '@playwright/test';

// Ana's song has to stay on stage while Theo taps, waits out the note and reloads: the 8 s fixture is too short.
test.use({ demoLibrary: [[...DEMO_LIBRARY, { file: 'long.wav', seconds: 40, hz: [220] }], { scope: 'test' }] });

const heartOf = (page: Page) => page.locator(`${SEL.npStrip} .heart`);

async function savedIds(phone: Page): Promise<string[]> {
	const body = (await phone.request.get('/api/me/songs').then((r) => r.json())) as {
		songs: { mediaId: string | null; saved: unknown }[];
	};
	return body.songs.flatMap((s) => (s.saved && s.mediaId ? [s.mediaId] : []));
}

/** Ana sings the long song; Theo's phone is on /queue with the heart showing. */
async function stage(world: World) {
	await world.openTv();
	const ana = await world.openPhone('Ana');
	const title = await readySong(world, ana, 'long');
	const song = await world.awaitDemoTrack('long');
	await ana.goto('/');
	await queueReady(ana, 'long');
	await expect(ana.locator(SEL.npStripTitle)).toHaveText(title, { timeout: 30_000 });
	const theo = await world.openPhone('Theo');
	await theo.goto('/queue');
	await expect(heartOf(theo)).toBeVisible();
	return { ana, theo, title, song };
}

test("the heart saves someone else's song in one tap, says so in place, and rests on your own", async ({ world }) => {
	test.setTimeout(240_000);
	const worker = await startFakeWorker(world);
	try {
		await world.openTv();
		const ana = await world.openPhone('Ana');
		const title = await readySong(world, ana, 'long');
		const song = await world.awaitDemoTrack('long');
		await ana.goto('/');
		await queueReady(ana, 'long');
		await expect(ana.locator(SEL.npStripTitle)).toHaveText(title, { timeout: 30_000 });

		// Ana's own song: the heart keeps its slot, hidden and inert.
		await expect(heartOf(ana)).toBeHidden();

		const theo = await world.openPhone('Theo');
		await theo.goto('/queue');
		const heart = heartOf(theo);
		await expect(heart).toBeVisible();
		await expect(heart).toHaveAttribute('aria-pressed', 'false');
		const stripBefore = await theo.locator(SEL.npStrip).boundingBox();

		// The fill lands in the same frame as the tap, before any reply: the save is held until that frame is read.
		let release = () => {};
		const held = new Promise<void>((r) => (release = r));
		await theo.route('**/api/me/songs/*', async (route) => {
			await held;
			await route.continue();
		});
		const answered = theo.waitForResponse((r) => r.url().includes('/api/me/songs/') && r.request().method() === 'PUT');
		const sameFrame = await heart.evaluate(
			(el) =>
				new Promise<string | null>((resolve) => {
					(el as HTMLButtonElement).click();
					requestAnimationFrame(() => resolve(el.getAttribute('aria-pressed')));
				})
		);
		release();
		expect((await answered).ok()).toBe(true);
		await theo.unroute('**/api/me/songs/*');
		expect(sameFrame, 'the heart filled on the frame after the tap, with the save still in the air').toBe('true');
		await expect(theo.locator(`${SEL.npStrip} .saved-note`)).toHaveText(`${title} is in your songs`);
		expect(await theo.locator(SEL.npStrip).boundingBox(), 'the dock keeps its height and place').toEqual(stripBefore);
		await expect.poll(() => savedIds(theo)).toContain(song.id);
		// The words go back to who is singing what after 2 s.
		await expect(theo.locator(`${SEL.npStrip} .saved-note`)).toHaveCount(0, { timeout: 4_000 });
		await expect(theo.locator(SEL.npStripWho)).toHaveText('Ana');

		// A reload reads the same state from the server.
		await theo.reload();
		await expect(heartOf(theo)).toHaveAttribute('aria-pressed', 'true');

		// A second tap takes it out again, with no note.
		await heartOf(theo).click();
		await expect(heartOf(theo)).toHaveAttribute('aria-pressed', 'false');
		await expect(theo.locator(`${SEL.npStrip} .saved-note`)).toHaveCount(0);
		await expect.poll(() => savedIds(theo)).not.toContain(song.id);
	} finally {
		await worker.stop();
	}
});

test('a refused save rolls the mark back, says why, and takes the note with it', async ({ world }) => {
	test.setTimeout(240_000);
	const worker = await startFakeWorker(world);
	try {
		const { theo, song } = await stage(world);
		await theo.route('**/api/me/songs/*', (r) => r.fulfill({ status: 500, body: '{}' }));
		const tapped = Date.now();
		await heartOf(theo).click();
		await expect(heartOf(theo)).toHaveAttribute('aria-pressed', 'false');
		// Read once, not retried: a retry would outwait the note's own 2 s and pass with the note still raised.
		expect(await theo.locator(`${SEL.npStrip} .saved-note`).count(), 'the note outlived the rollback').toBe(0);
		expect(Date.now() - tapped, 'read inside the note window').toBeLessThan(2_000);
		await expect(theo.getByText("Couldn't save it to your songs.")).toBeVisible();
		await expect(theo.locator(SEL.npStripWho)).toHaveText('Ana');
		expect(await savedIds(theo)).not.toContain(song.id);
	} finally {
		await worker.stop();
	}
});

test('a double tap during a slow save ends unsaved on the server and the screen, with no error', async ({ world }) => {
	test.setTimeout(240_000);
	const worker = await startFakeWorker(world);
	try {
		const { theo, song } = await stage(world);
		const sent: string[] = [];
		let release = () => {};
		const held = new Promise<void>((r) => (release = r));
		await theo.route('**/api/me/songs/*', async (route) => {
			const method = route.request().method();
			sent.push(method);
			if (method === 'PUT') await held;
			await route.continue();
		});
		await heartOf(theo).click();
		await expect(heartOf(theo)).toHaveAttribute('aria-pressed', 'true');
		await heartOf(theo).click();
		await expect(heartOf(theo)).toHaveAttribute('aria-pressed', 'false');
		// The unsave waits behind the save in the air: nothing else has gone out yet.
		await expect.poll(() => sent).toEqual(['PUT']);
		const deleted = theo.waitForResponse(
			(r) => r.url().includes('/api/me/songs/') && r.request().method() === 'DELETE'
		);
		release();
		expect((await deleted).ok()).toBe(true);
		expect(sent).toEqual(['PUT', 'DELETE']);
		expect(await savedIds(theo)).not.toContain(song.id);
		await expect(heartOf(theo)).toHaveAttribute('aria-pressed', 'false');
		await expect(theo.getByText(/Couldn't (save|take)/)).toHaveCount(0);
	} finally {
		await worker.stop();
	}
});
