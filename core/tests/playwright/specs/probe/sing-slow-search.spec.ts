// A SLOW SEARCH ON SING. Every /api/search answers ~400 ms late, past PENDING_GRACE_MS, so the skeleton shows.
//   1. Rows appear the moment the answer lands: the skeleton never holds them back (tenet 2: no added wait).
//   2. A slow widen still hands focus to the widened results' first group heading, described by the count.
//   3. Typing, or clearing and typing the same text, never flashes "Nothing matches" for text not answered (#1192).
// Plus a report-only reading of last keystroke to first result row with no delay, against #1107's 300 ms target.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { openBrowseFromHome } from '../../world/actors';
import type { Page } from '@playwright/test';

const DELAY_MS = 400;
const WIDEN = { name: /Not it\? Search everything/ };

/** Holds every /api/search answer DELAY_MS, and stamps when each one reaches the page and when rows first show. */
async function slowSearch(page: Page, delayMs = DELAY_MS) {
	await page.route('**/api/search?*', async (r) => {
		const res = await r.fetch();
		await new Promise((done) => setTimeout(done, delayMs));
		await r.fulfill({ response: res });
	});
	await page.addInitScript(() => {
		const w = window as unknown as { stamps: { answer: number[]; rows: number[]; keys: number[] } };
		w.stamps = { answer: [], rows: [], keys: [] };
		new PerformanceObserver((list) => {
			for (const e of list.getEntries() as PerformanceResourceTiming[])
				if (e.name.includes('/api/search')) w.stamps.answer.push(e.responseEnd);
		}).observe({ type: 'resource' });
		document.addEventListener('input', () => w.stamps.keys.push(performance.now()), true);
		let had = false;
		new MutationObserver(() => {
			const has = !!document.querySelector('.row');
			if (has && !had) w.stamps.rows.push(performance.now());
			had = has;
		}).observe(document, { subtree: true, childList: true });
	});
}
const stamps = (page: Page) =>
	page.evaluate(() => (window as unknown as { stamps: { answer: number[]; rows: number[]; keys: number[] } }).stamps);

test('a slow search shows its rows the moment the answer lands', async ({ world }) => {
	const track = await world.awaitDemoTrack('caroline');
	const page = await world.openPhone('Maya');
	await slowSearch(page);
	await page.goto('/?source=local');
	await openBrowseFromHome(page);
	await page.locator(SEL.search).fill(track.title);
	await expect(page.locator(SEL.songRow).first()).toBeVisible({ timeout: 20_000 });
	await expect(page.locator('.skels'), 'the skeleton is gone once rows show').toHaveCount(0);
	const s = await stamps(page);
	const lag = s.rows[0]! - s.answer.at(-1)!;
	console.log(`slow search: rows ${Math.round(lag)} ms after the answer landed`);
	expect(lag, 'rows waited behind the skeleton').toBeLessThan(100);
});

test('a slow widen hands focus to the first group heading', async ({ world }) => {
	const track = await world.awaitDemoTrack('caroline');
	const page = await world.openPhone('Maya');
	await slowSearch(page);
	await openBrowseFromHome(page);
	await page.locator(SEL.search).fill(track.title);
	const widen = page.getByRole('button', WIDEN);
	await widen.waitFor({ timeout: 30_000 });
	await widen.click();
	await expect
		.poll(() => page.evaluate(() => document.activeElement?.matches('main h2.grouphead') ?? false), {
			timeout: 30_000
		})
		.toBe(true);
	expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-describedby'))).toBe('widen-count');
});

test('REPORTED ONLY: last keystroke to first result row, no delay', async ({ world }) => {
	const track = await world.awaitDemoTrack('caroline');
	const page = await world.openPhone('Maya');
	await slowSearch(page, 0);
	await page.goto('/?source=local');
	await openBrowseFromHome(page);
	const out: number[] = [];
	for (let i = 0; i < 5; i++) {
		if (await page.locator(SEL.clearSearch).count()) await page.locator(SEL.clearSearch).first().click();
		await expect(page.locator(SEL.songRow)).toHaveCount(0);
		await page.locator(SEL.search).pressSequentially(track.title.slice(0, 6), { delay: 40 });
		await expect(page.locator(SEL.songRow).first()).toBeVisible({ timeout: 20_000 });
		const s = await stamps(page);
		out.push(Math.round(s.rows.at(-1)! - s.keys.at(-1)!));
	}
	console.log(`keystroke to first result: ${out.join(', ')} ms (target 300)`);
});

test('typing, or clearing and typing it again, never shows "Nothing matches" for text not yet searched', async ({
	world
}) => {
	const track = await world.awaitDemoTrack('caroline');
	const page = await world.openPhone('Maya');
	await page.goto('/?source=local');
	await openBrowseFromHome(page);
	await page.evaluate((title) => {
		const w = window as unknown as { saidNothing: string[] };
		w.saidNothing = [];
		new MutationObserver(() => {
			const t = document.querySelector('main')?.textContent ?? '';
			const m = t.match(/Nothing matches “([^”]*)”/);
			if (!m) return;
			// A slow keystroke can let the debounce send a prefix, and its empty answer is true: only text no
			// search has answered yet is the flash. The title itself has rows, so for it the line is always false.
			const answered = performance
				.getEntriesByType('resource')
				.some((e) => e.name.includes('/api/search') && new URL(e.name).searchParams.get('q') === m[1]);
			if ((!answered || m[1] === title) && !w.saidNothing.includes(m[0])) w.saidNothing.push(m[0]);
		}).observe(document, { subtree: true, childList: true, characterData: true });
	}, track.title);
	await page.locator(SEL.search).pressSequentially(track.title, { delay: 60 });
	await expect(page.locator(SEL.songRow).first()).toBeVisible({ timeout: 20_000 });
	// Cleared, then the same text again: the old answer went with its rows, so the debounce wait is unanswered too.
	for (let i = 0; i < 3; i++) {
		await page.locator(SEL.clearSearch).first().click();
		await page.locator(SEL.search).fill(track.title);
		await expect(page.locator(SEL.songRow).first()).toBeVisible({ timeout: 20_000 });
	}
	const sent = await page.evaluate(() =>
		performance
			.getEntriesByType('resource')
			.filter((e) => e.name.includes('/api/search'))
			.map((e) => new URL(e.name).searchParams.get('q'))
	);
	expect(
		await page.evaluate(() => (window as unknown as { saidNothing: string[] }).saidNothing),
		`typed "${track.title}", searched ${JSON.stringify(sent)}`
	).toEqual([]);
});
