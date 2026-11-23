// A list repeats its row buttons once per row, so a name without the song is the same name N times, and a screen
// reader's list of buttons cannot tell the rows apart (batch 7 probes). Driven in the built app, by ROLE + NAME.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue, queueReady, readySong } from '../../world/actors';
import type { Locator } from '@playwright/test';

/** Every accessible name the buttons under `rows` compute to, in order. */
async function names(buttons: Locator): Promise<string[]> {
	const out: string[] = [];
	for (const b of await buttons.all()) out.push((await b.getAttribute('aria-label')) ?? (await b.innerText()));
	return out;
}

test('every Sing-tab row names its own song on its action', async ({ world }) => {
	const phone = await world.openPhone('Maya');
	const titles = await Promise.all(['believin', 'caroline', 'prayer'].map((q) => world.awaitDemoTrack(q)));
	await openBrowseFromHome(phone);
	// "in" matches all three demo tracks (Believin', Caroline, Livin'), none of them processed yet.
	await phone.locator(SEL.search).fill('in');
	for (const t of titles) {
		const row = phone.locator(SEL.songRow, { hasText: t.title });
		await expect(row.first()).toBeVisible({ timeout: 15_000 });
		// The name a voice or screen-reader user reaches THIS row's action by.
		await expect(row.getByRole('button', { name: new RegExp(`^Sing ${t.title}\\b`) })).toHaveCount(1);
	}
	const all = await names(phone.locator(SEL.songRow).getByRole('button', { name: /^Sing / }));
	expect(all.length).toBeGreaterThanOrEqual(3);
	expect(new Set(all).size, `duplicate names: ${all.join(' | ')}`).toBe(all.length);
});

test('every Queue row names its own song on remove', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const phone = await world.openPhone('Maya');
		const songs = [];
		for (const q of ['believin', 'caroline', 'bohemian']) songs.push(await readySong(world, phone, q));
		for (const q of ['believin', 'caroline', 'bohemian']) await queueReady(phone, q);
		await openQueue(phone);
		// The first may be playing, which takes no remove; the other two are mine and waiting.
		for (const title of songs.slice(1)) {
			const row = phone.locator(SEL.queueRow, { hasText: title });
			await expect(row.getByRole('button', { name: `Remove ${title} from the queue` })).toHaveCount(1);
		}
		const all = await names(phone.locator(SEL.queueRow).getByRole('button', { name: /remove/i }));
		expect(all.length).toBeGreaterThanOrEqual(2);
		expect(new Set(all).size, `duplicate names: ${all.join(' | ')}`).toBe(all.length);
	} finally {
		await worker.stop();
	}
});
