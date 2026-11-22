// THE ENTRY-DELETE SURFACE. Delete is irreversible and reclaims bytes, so /admin makes it two-step: a
// `Delete` button that ARMS, and a separate `Yes, delete` that commits. The probe's whole subject is that the
// arming step exists and is reached from a real list row.
//
// WHY A WORKER RUNS. /admin lists `/api/library`.library, which is `listReady()` — songs with stems on disk.
// A raw library file is not in it, so without a worker the page renders its "No processed songs" empty state
// and the row this probe clicks does not exist; a core per test has to earn its own row.
//
// The list and the armed confirm are both assertions, not screenshots: a list that stayed empty must fail,
// never be photographed empty. The frames are ATTACHMENTS: evidence for a reader, never a pass condition.
//
// IT STOPS AT ARMED. It never presses `Yes, delete`: committing the delete
// is a claim about /api/delete-media that this probe does not make.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import type { Page } from '@playwright/test';

/** The frame size. It only matters to the screenshots. */
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

		// ANONYMOUS: /admin carries no join gate and an operator arrives with no session.
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

/** What the keyboard is actually on. `<body>` is the failure this test exists for, so the tag is reported too. */
async function focused(page: Page): Promise<{ tag: string; label: string | null; connected: boolean }> {
	return page.evaluate(() => ({
		tag: document.activeElement?.tagName ?? 'NONE',
		label: document.activeElement?.getAttribute('aria-label') ?? null,
		connected: document.activeElement?.isConnected ?? false
	}));
}

/**
 * THE PROMPT'S EXITS. This one DOES press `Yes, delete`, which the test above deliberately does not — but
 * against a STUBBED /api/delete-media, so it still makes no claim about the endpoint. The subject is only
 * where the keyboard ends up, and the two failures were: Escape did nothing at all (no keydown handler exists
 * anywhere in src/), and every exit dropped focus to `<body>` because arming DESTROYS the button that was
 * clicked, so the captured reference `.focus()` ran against a detached node.
 */
test('the armed prompt is dismissible, and no exit drops focus to <body>', async ({ world, page }) => {
	const worker = await startFakeWorker(world);
	try {
		const phone = await world.openPhone('Admin-Focus');
		await processToReady(phone, 'caroline');
		await processToReady(phone, 'believin');

		await page.setViewportSize(OPERATOR_VIEWPORT);
		await page.goto('/admin');
		const arm = page.locator(SEL.adminDelete);
		const confirm = page.locator(SEL.adminConfirmDelete);
		await expect(arm, '/admin must list the two processed songs for this test to have a row 2').toHaveCount(2);

		// Nothing armed: Escape must be a no-op, not a swallowed key.
		await page.keyboard.press('Escape');
		await expect(arm).toHaveCount(2);
		await expect(confirm).toHaveCount(0);

		const secondLabel = await arm.nth(1).getAttribute('aria-label');
		const firstLabel = await arm.nth(0).getAttribute('aria-label');

		// ── Escape cancels, keyboard only ────────────────────────────────────────────────────────────────
		await arm.nth(1).focus();
		await page.keyboard.press('Enter');
		await expect(confirm, 'Enter on the row 2 Delete button must arm the prompt').toHaveCount(1);
		expect(await focused(page)).toMatchObject({ label: `Confirm delete ${secondLabel?.slice('Delete '.length)}` });
		await page.keyboard.press('Escape');
		await expect(confirm, 'Escape must cancel the armed prompt — it did nothing at all before').toHaveCount(0);
		await expect(page.locator('[role="alert"]')).toHaveCount(0);
		expect(await focused(page), 'Escape must return focus to the control that armed it, never <body>').toEqual({
			tag: 'BUTTON',
			label: secondLabel,
			connected: true
		});

		// ── Cancel, by mouse ─────────────────────────────────────────────────────────────────────────────
		await arm.nth(1).click();
		await page.locator('button[aria-label^="Cancel deleting"]').click();
		expect(await focused(page), 'Cancel must return focus to the row own Delete button, never <body>').toEqual({
			tag: 'BUTTON',
			label: secondLabel,
			connected: true
		});

		// ── A FAILED delete stays armed ──────────────────────────────────────────────────────────────────
		// Disarming on both outcomes made a failure look like a cancellation and cost the operator a re-arm.
		await page.route('**/api/delete-media', (route) =>
			route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ error: 'disk on fire' })
			})
		);
		await arm.nth(1).click();
		await confirm.click();
		await expect(page.getByText('Could not delete: disk on fire')).toBeVisible();
		await expect(confirm, 'a failed delete must leave the prompt armed so a retry costs one keypress').toHaveCount(1);
		await expect(confirm).toBeEnabled();
		expect(await focused(page), 'a failed delete must put focus back on the confirm button that failed').toMatchObject({
			tag: 'BUTTON',
			connected: true
		});
		await page.keyboard.press('Escape');
		await expect(confirm).toHaveCount(0);

		// ── Escape must NOT pretend to cancel an in-flight DELETE ────────────────────────────────────────
		// Once the request is away it cannot be called off, and both buttons are already disabled.
		await page.unroute('**/api/delete-media');
		await page.route('**/api/delete-media', () => {
			/* hangs on purpose: the prompt must stay up and armed while the request is in flight */
		});
		await arm.nth(1).click();
		await confirm.click();
		await expect(confirm).toHaveText('Deleting…');
		await page.keyboard.press('Escape');
		await expect(confirm, 'Escape must not disarm a delete that is already in flight').toHaveCount(1);
		await expect(confirm).toHaveText('Deleting…');

		// ── A SUCCESSFUL delete keeps the operator's place ───────────────────────────────────────────────
		// The row that takes the deleted one's index, so a long list does not send them back to the top.
		await page.reload();
		await page.unroute('**/api/delete-media');
		await page.route('**/api/delete-media', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ wasPlaying: false }) })
		);
		await expect(arm).toHaveCount(2);
		await arm.nth(0).click();
		await confirm.click();
		await expect(arm).toHaveCount(1);
		await expect(page.getByText(/^Deleted "/)).toBeVisible();
		expect(await focused(page), 'after a delete, focus belongs on the row that took its place').toEqual({
			tag: 'BUTTON',
			label: secondLabel,
			connected: true
		});
		expect(secondLabel, 'the two rows must be distinguishable for the claim above to mean anything').not.toBe(
			firstLabel
		);
	} finally {
		await worker.stop();
	}
});
