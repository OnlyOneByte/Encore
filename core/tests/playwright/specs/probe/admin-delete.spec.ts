// THE ENTRY-DELETE SURFACE. Delete is irreversible and reclaims bytes, so /admin makes it two-step: a
// `Delete` button that ARMS, and a separate `Yes, delete` that commits. The probe's whole subject is that the
// arming step exists and is reached from a real list row.
//
// WHY A WORKER RUNS. /admin lists `/api/library`.library, which is `listReady()` — songs with stems on disk.
// A raw library file is not in it, so without a worker the page renders its "No processed songs" empty state
// and the row this probe clicks does not exist. The old probe ran against a shared server somebody had
// already processed songs on; a core per test has to earn its own row.
//
// Ported from tests/e2e/probes/admin-delete.mjs, which was a SCREENSHOT tool: two `for (…) await sleep(100)`
// count-polls and two frames. Those polls never failed — a list that stayed empty was photographed empty and
// the tool printed "captured list" — so its only real assertion was implicit, in `page.click(SEL.adminDelete)`
// throwing when there was no button to click. Both halves are assertions here. The frames survive as
// ATTACHMENTS: evidence for a reader, never a pass condition.
//
// IT STOPS AT ARMED. The old probe never pressed `Yes, delete`, so neither does this: committing the delete
// is a claim about /api/delete-media that this probe never made.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import type { Page } from '@playwright/test';

/** The old probe's frame size. It only ever mattered to the screenshots, and it still only matters to them. */
const OPERATOR_VIEWPORT = { width: 900, height: 1100 };

interface SongRow {
	id: string;
	title: string;
	source: string;
}
interface SearchBody {
	ready: SongRow[];
	processing: SongRow[];
	results: SongRow[];
}

/**
 * Put one local library song on disk as stems, so `listReady()` has something to list. Requests go through
 * the PAGE's context so they carry that phone's singer cookie — `/api/process` refuses an anonymous caller.
 */
async function processToReady(page: Page, query: string): Promise<SongRow> {
	const search = async (): Promise<SearchBody> =>
		(await page.request.get(`/api/search?q=${encodeURIComponent(query)}`).then((r) => r.json())) as SearchBody;
	const found = await search();
	const row = [...found.ready, ...found.processing, ...found.results].find((x) => x.source === 'local');
	if (!row) throw new Error(`no local library song matching "${query}" — the demo fixture did not index`);
	const res = await page.request.post('/api/process', { data: { mediaId: row.id } });
	if (!res.ok()) throw new Error(`/api/process refused "${query}": ${res.status()} ${await res.text()}`);
	await expect
		.poll(async () => (await search()).ready.some((r) => r.id === row.id), {
			timeout: 60_000,
			message: `"${row.title}" never reached ready, so /admin would have nothing to list`
		})
		.toBe(true);
	return row;
}

test('the admin list offers a Delete that arms a confirm', async ({ world, page }, testInfo) => {
	const worker = await startFakeWorker(world);
	try {
		const phone = await world.openPhone('Admin-Probe');
		const song = await processToReady(phone, 'caroline');

		// ANONYMOUS, as the old probe was: /admin carries no join gate and an operator arrives with no session.
		await page.setViewportSize(OPERATOR_VIEWPORT);
		await page.goto('/admin');

		const rows = page.locator(SEL.adminSongRow);
		await expect(
			rows,
			`/admin listed no song rows for "${song.title}" (${song.id}), which is processed and in /api/library`
		).not.toHaveCount(0);

		const listFrame = testInfo.outputPath('admin-list.png');
		await page.screenshot({ path: listFrame, fullPage: true });
		await testInfo.attach('admin-list.png', { path: listFrame, contentType: 'image/png' });

		// REAL INPUT. A synthetic `el.click()` grants no user activation and is untrusted; this is the same
		// press an operator makes.
		await page.locator(SEL.adminDelete).first().click();
		await expect(
			page.locator(SEL.adminConfirmDelete).first(),
			`pressing ${SEL.adminDelete} did not arm ${SEL.adminConfirmDelete}, so the two-step confirm is unreachable`
		).toBeVisible();

		const confirmFrame = testInfo.outputPath('admin-confirm.png');
		await page.screenshot({ path: confirmFrame, fullPage: true });
		await testInfo.attach('admin-confirm.png', { path: confirmFrame, contentType: 'image/png' });
	} finally {
		await worker.stop();
	}
});
