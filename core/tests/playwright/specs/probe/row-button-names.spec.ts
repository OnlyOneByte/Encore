// A list repeats its row buttons once per row, so a name without the song is the same name N times, and a screen
// reader's list of buttons cannot tell the rows apart (batch 7 probes). Driven in the built app, by ROLE + NAME.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openBrowseFromHome, openQueue, queueReady, readySong } from '../../world/actors';
import type { Locator } from '@playwright/test';

/** Every accessible name the buttons compute to, in order — read from the accessibility tree, not the attribute, so
 * a wrapper's override or an `aria-labelledby` is what gets compared. */
async function names(buttons: Locator): Promise<string[]> {
	const out: string[] = [];
	for (const b of await buttons.all()) {
		const m = /^- button "((?:[^"\\]|\\.)*)"/m.exec(await b.ariaSnapshot());
		out.push(m ? m[1] : '');
	}
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

test('every Queue row names its own song on remove, and its song and singer on the grip', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const phone = await world.openPhone('Maya');
		const theo = await world.openPhone('Theo');
		const songs = [];
		for (const q of ['believin', 'caroline', 'bohemian']) songs.push(await readySong(world, phone, q));
		for (const q of ['believin', 'caroline', 'bohemian']) await queueReady(phone, q);
		// The same song as one of Maya's waiting turns: the grip shows on everyone's rows, so its name needs the singer.
		await queueReady(theo, 'caroline');
		await openQueue(phone);
		// The first may be playing, which takes no remove; the other two are mine and waiting.
		for (const title of songs.slice(1)) {
			const row = phone.locator(SEL.queueRow, { hasText: title });
			await expect(row.getByRole('button', { name: `Remove ${title} from the queue` })).toHaveCount(1);
		}
		// Maya's own row reads "You", so her grip says "your turn".
		for (const turn of ['your turn', "Theo's turn"]) {
			const grip = `Reorder ${songs[1]}, ${turn} — drag, or use arrow keys`;
			await expect(phone.getByRole('button', { name: grip, exact: true })).toHaveCount(1);
		}
		const removes = await names(phone.locator(SEL.queueRow).getByRole('button', { name: /^Remove / }));
		expect(removes.length).toBeGreaterThanOrEqual(2);
		expect(new Set(removes).size, `duplicate names: ${removes.join(' | ')}`).toBe(removes.length);
		const grips = await names(phone.getByRole('button', { name: /^Reorder / }));
		expect(grips.length).toBeGreaterThanOrEqual(3);
		expect(new Set(grips).size, `duplicate names: ${grips.join(' | ')}`).toBe(grips.length);
	} finally {
		await worker.stop();
	}
});
