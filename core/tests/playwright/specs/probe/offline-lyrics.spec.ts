// #1221 / #1288: an align that completes ONCE with no lyrics and says why (an offline worker whose speech model isn't
// cached, or a transcript withheld as babble). The host's song page shows that reason with the paste control, and a
// pasted sheet still aligns. See docs/SERVER.md#lyrics-fixes.
import { test, expect } from '../../world/fixtures';
import { readySong } from '../../world/actors';
import { startFakeWorker } from '../../world/workers';
import type { Page, TestInfo } from '@playwright/test';
import type { LyricsNote, Media } from '$lib/contract';

interface AuditBody {
	media: Media | null;
	lyricsNote?: string | null;
	processes?: { attempts: { jobType: string; outcome: string | null }[] }[];
}

async function frame(page: Page, testInfo: TestInfo, name: string): Promise<void> {
	for (const width of [390, 320]) {
		await page.setViewportSize({ width, height: 844 });
		const path = testInfo.outputPath(`${name}-${width}.png`);
		await page.screenshot({ path, fullPage: true });
		await testInfo.attach(`${name}-${width}.png`, { path, contentType: 'image/png' });
	}
	await page.setViewportSize({ width: 390, height: 844 });
}

const CASES: { note: LyricsNote; title: string; says: string; shot: string }[] = [
	{
		note: 'asr-offline',
		title: 'offline without a speech model',
		says: 'the karaoke maker is offline',
		shot: 'no-lyrics-offline'
	},
	{
		note: 'asr-babble',
		title: 'whisper heard babble',
		says: "couldn't make out the words",
		shot: 'no-lyrics-babble'
	}
];

for (const { note: lyricsNote, title, says, shot } of CASES) {
	test(`${title}: one align, no lyrics, the song page says why and a paste still works`, async ({
		world
	}, testInfo) => {
		const worker = await startFakeWorker(world, { noLyricsNote: lyricsNote });
		try {
			const guest = await world.openPhone('Ana');
			await readySong(world, guest, 'caroline');
			const id = (await world.awaitDemoTrack('caroline')).id;

			const audit = async () => (await (await world.hostGet(`/api/audit/${id}`)).json()) as AuditBody;
			await expect.poll(async () => (await audit()).media?.lyricsStatus, { timeout: 30_000 }).toBe('ready');
			const first = await audit();
			const aligns = (first.processes ?? []).flatMap((p) => p.attempts).filter((a) => a.jobType === 'align');
			expect(
				aligns.map((a) => a.outcome),
				'one align, completed, never retried'
			).toEqual(['ready']);
			expect(first.lyricsNote).toBe(lyricsNote);
			expect(first.media?.lyricsRef ?? null).toBeNull();

			// A guest can't change lyrics, so the guest page offers nothing.
			await guest.goto(`/song/${id}`);
			await expect(guest.locator('.facts.card')).toBeVisible();
			await expect(guest.locator('.reselect-empty')).toHaveCount(0);

			const host = await world.openPhone('Host');
			await world.becomeHost(host);
			await host.goto(`/song/${id}`);
			const note = host.locator('.reselect-empty');
			await expect(note).toContainText(says);
			await expect(note).toContainText('Paste them');
			await frame(host, testInfo, shot);

			// Focus follows the disclosure: into the box on open, back to the opener on Cancel.
			const opener = host.locator('.reselect-paste-open');
			const box = host.locator('[data-slot="textarea"]');
			await opener.click();
			await expect(box).toBeFocused();
			await host.locator('[data-act="cancel"]').click();
			await expect(opener).toBeFocused();
			await opener.click();
			await box.fill('Sweet Caroline\nGood times never seemed so good');
			await frame(host, testInfo, `${shot}-pasting`);
			await host.locator('[data-act="confirm"]').click();
			await expect.poll(async () => !!(await audit()).media?.lyricsRef, { timeout: 30_000 }).toBe(true);
			await expect(host.locator('.reselect-empty')).toHaveCount(0);
			expect((await audit()).lyricsNote ?? null, 'the later align clears the reason').toBeNull();
		} finally {
			await worker.stop();
		}
	});
}
