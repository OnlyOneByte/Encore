/*
 * P38: THE CHORUS IS EVERYONE'S (proposal 38, docs/FRONTEND.md#the-chorus).
 *
 * The host pastes words whose chorus comes round seven times. On the TV, "Everyone" stands over the row that opens
 * each chorus from the line before it, the chorus rows are drawn in the room's gold while the singer's colour keeps
 * the active word, and nothing on the page moves. Reduce Motion gets the cue with no fade, and the host's switch
 * turns the whole treatment off live.
 */
import { test, expect, type World } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { DEMO_LIBRARY } from '../../world/seed';
import { startFakeWorker } from '../../world/workers';
import { queueReady } from '../../world/actors';
import type { Page, TestInfo } from '@playwright/test';

test.use({
	demoLibrary: [[...DEMO_LIBRARY, { file: 'lyric-fix-song.wav', seconds: 40, hz: [220, 330] }], { scope: 'test' }]
});

const CHORUS = ['Sing it out loud', 'Everybody now', 'This one is ours'];
/** Three verse lines then the chorus, seven times, and a last verse: 45 lines on the fake worker's 0.8 s grid. */
const LINES = Array.from({ length: 45 }, (_, i) =>
	i % 6 < 3 || i >= 42 ? { text: `Verse ${Math.floor(i / 6) + 1} line ${(i % 6) + 1}` } : { text: CHORUS[(i % 6) - 3]! }
);
const GOLD = 'rgb(255, 223, 122)';
/** A computed colour as `r, g, b, a` in 0-255 and 0-1: `color-mix` serialises as `color(srgb …)`, a literal as `rgb()`. */
function rgba(css: string | null | undefined): string {
	const srgb = css?.match(/^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/);
	const n = srgb
		? [...srgb.slice(1, 4).map((v) => Math.round(Number(v) * 255)), Number(srgb[4] ?? 1)]
		: (css?.match(/[\d.]+/g)?.map(Number) ?? []);
	return [...n.slice(0, 3), n[3] ?? 1].join(', ');
}

async function audit(page: Page, mediaId: string) {
	return (await (await page.request.get(`/api/audit/${mediaId}`)).json()).media;
}

async function stage(world: World) {
	await startFakeWorker(world, { seconds: 40 });
	const phone = await world.openPhone('P38Host');
	await world.becomeHost(phone);
	const track = await world.awaitDemoTrack('lyric-fix');
	expect((await phone.request.post('/api/process', { data: { mediaId: track.id } })).ok()).toBe(true);
	await expect.poll(async () => (await audit(phone, track.id))?.lyricsRef ?? null, { timeout: 60_000 }).not.toBeNull();
	const auto = (await audit(phone, track.id)).lyricsRef;
	const rev = (await audit(phone, track.id)).lyricsEditRev ?? 0;
	const pasted = await phone.request.post('/api/lyrics-edit', { data: { mediaId: track.id, rev, lines: LINES } });
	expect(pasted.status(), await pasted.text()).toBe(200);
	await expect.poll(async () => (await audit(phone, track.id)).lyricsRef, { timeout: 30_000 }).not.toBe(auto);
	await phone.request.put('/api/settings/room', { data: { lyricsHighlight: 'word', lyricsLeadMs: 0 } });
	await queueReady(phone, track.title);
	return { phone, track };
}

async function openTv(world: World, reducedMotion: 'reduce' | 'no-preference' = 'no-preference') {
	const tv = await world.openTv();
	await tv.emulateMedia({ reducedMotion });
	await tv.locator(SEL.tvConnected).waitFor({ state: 'attached' });
	await tv.evaluate(() => {
		const w = window as unknown as { cls: number };
		w.cls = 0;
		new PerformanceObserver((list) => {
			for (const e of list.getEntries() as unknown as { value: number }[]) w.cls += e.value;
		}).observe({ type: 'layout-shift', buffered: false });
	});
	await tv.mouse.click(960, 540);
	await tv.locator(SEL.lyricsRowCurrent).waitFor({ timeout: 30_000 });
	return tv;
}

/** Index of each row matching `selector` among the reel's rows. */
const rowIndex = (tv: Page, selector: string) =>
	tv.evaluate((s) => {
		const rows = [...document.querySelectorAll('.lyrics .row')];
		return rows.findIndex((r) => r.matches(s));
	}, selector);

async function frame(tv: Page, testInfo: TestInfo, name: string): Promise<void> {
	// The frame shows the line at rest, not the reel or a colour mid-transition.
	await tv
		.locator('.lyrics .reel')
		.evaluate((el) => Promise.allSettled(el.getAnimations({ subtree: true }).map((a) => a.finished)));
	const path = testInfo.outputPath(`${name}.png`);
	await tv.screenshot({ path });
	await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('P38 · "Everyone" before each chorus, its rows in the room gold, the singer still leading, and nothing moves', async ({
	world
}, testInfo) => {
	test.setTimeout(150_000);
	await stage(world);
	const tv = await openTv(world);

	// Each step waits for the next time round: a line lasts 0.7 s and the chorus comes back every 4.8 s.
	// A verse: no cue yet, the chorus rows ahead already gold at the upcoming level.
	await expect(tv.locator(SEL.lyricsRowCurrent)).toContainText(/Verse \d line 1/, { timeout: 15_000 });
	await expect(tv.locator('.lyrics .row.chorus')).toHaveCount(21);
	await expect(tv.locator('.lyrics .everyone')).toHaveCount(7);
	await expect(tv.locator('.lyrics .everyone.on')).toHaveCount(0);
	await frame(tv, testInfo, 'tv-1920-verse');

	// The line before the chorus: the cue stands over the next row, which opens a chorus.
	await expect(tv.locator(SEL.lyricsRowCurrent)).toContainText(/Verse \d line 3/, { timeout: 15_000 });
	await expect(tv.locator('.lyrics .everyone.on')).toHaveCount(1);
	expect(await rowIndex(tv, ':has(> .everyone.on)')).toBe((await rowIndex(tv, '.current')) + 1);
	// Settled, not all: under load the next line can cancel the fade, and that frame is still the cue.
	await tv.evaluate(() =>
		Promise.allSettled(
			document
				.querySelector('.lyrics .everyone.on')
				?.getAnimations()
				.map((a) => a.finished) ?? []
		)
	);
	await frame(tv, testInfo, 'tv-1920-cue');

	// The chorus: the row's unsung words gold, the active word the singer's own colour, the cue gone.
	await expect(tv.locator(SEL.lyricsRowCurrent)).toContainText('Sing it out loud', { timeout: 15_000 });
	await expect(tv.locator('.lyrics .everyone.on')).toHaveCount(0);
	const colours = await tv.evaluate(() => {
		const row = document.querySelector('.lyrics .row.current')!;
		const active = row.querySelector('.word.active');
		const ahead = [...row.querySelectorAll('.word:not(.done):not(.active)')].at(-1);
		return {
			active: active && getComputedStyle(active).color,
			ahead: ahead && getComputedStyle(ahead).color
		};
	});
	expect(rgba(colours.ahead), 'unsung chorus words').toBe('255, 223, 122, 0.66');
	if (colours.active) expect(rgba(colours.active), 'the active word keeps the singer').not.toBe(rgba(GOLD));
	await frame(tv, testInfo, 'tv-1920-chorus');

	// The verse after: colour eases back, and the chorus behind it is past, in dim gold.
	await expect(tv.locator(SEL.lyricsRowCurrent)).toContainText(/Verse \d line 1/, { timeout: 15_000 });
	const past = tv.locator('.lyrics .row.chorus.past').last();
	await expect
		.poll(async () => rgba(await past.evaluate((el) => getComputedStyle(el).color)))
		.toBe('255, 223, 122, 0.2');
	await expect(tv.locator('.lyrics .row.current')).not.toHaveClass(/chorus/);
	await frame(tv, testInfo, 'tv-1920-after');

	expect(await tv.evaluate(() => (window as unknown as { cls: number }).cls), 'layout shift through a chorus').toBe(0);

	// The same moments on a 1280 screen.
	await tv.setViewportSize({ width: 1280, height: 720 });
	await expect(tv.locator(SEL.lyricsRowCurrent)).toContainText(/Verse \d line 3/, { timeout: 15_000 });
	await expect(tv.locator('.lyrics .everyone.on')).toHaveCount(1);
	// Settled, not all: under load the next line can cancel the fade, and that frame is still the cue.
	await tv.evaluate(() =>
		Promise.allSettled(
			document
				.querySelector('.lyrics .everyone.on')
				?.getAnimations()
				.map((a) => a.finished) ?? []
		)
	);
	await frame(tv, testInfo, 'tv-1280-cue');
	// ANY chorus row, which is up for 2.1 s: one 0.7 s line was missed by polls backed off to a second apart under load
	// (#1134).
	await expect(tv.locator('.lyrics .row.current.chorus')).toBeAttached({ timeout: 15_000 });
	await frame(tv, testInfo, 'tv-1280-chorus');
});

test('P38 · under Reduce Motion the cue appears with no fade', async ({ world }) => {
	test.setTimeout(150_000);
	await stage(world);
	const tv = await openTv(world, 'reduce');
	await expect(tv.locator('.lyrics .everyone.on')).toHaveCount(1, { timeout: 20_000 });
	const cue = tv.locator('.lyrics .everyone.on');
	expect(await cue.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
	expect(await cue.evaluate((el) => el.getAnimations().length)).toBe(0);
	expect(await cue.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
});

test("P38 · the host's switch takes the chorus off the TV live, and puts it back", async ({ world }, testInfo) => {
	test.setTimeout(150_000);
	const { phone } = await stage(world);
	const tv = await openTv(world);
	await expect(tv.locator('.lyrics .row.chorus')).toHaveCount(21);

	await phone.goto('/settings');
	const toggle = phone.getByRole('switch', { name: 'Show the chorus to the room' });
	await expect(toggle).toBeChecked();
	await toggle.scrollIntoViewIfNeeded();
	for (const width of [390, 320]) {
		await phone.setViewportSize({ width, height: 844 });
		const path = testInfo.outputPath(`phone-${width}-switch.png`);
		await phone.screenshot({ path });
		await testInfo.attach(`phone-${width}-switch`, { path, contentType: 'image/png' });
	}
	await toggle.click();
	await expect(tv.locator('.lyrics .row.chorus')).toHaveCount(0, { timeout: 5_000 });
	await expect(tv.locator('.lyrics .everyone')).toHaveCount(0);
	await frame(tv, testInfo, 'tv-1920-off');
	await toggle.click();
	await expect(tv.locator('.lyrics .row.chorus')).toHaveCount(21, { timeout: 5_000 });
});
