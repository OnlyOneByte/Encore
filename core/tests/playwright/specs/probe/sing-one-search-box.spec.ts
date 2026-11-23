// THE SING TAB IS ONE SEARCH BOX (proposal 21). The Music / Everything / YouTube / Library menu under the field is
// gone: its choices returned the same rows and "Library" meant everything anyone had searched for. Six claims:
//   1. At 390x844 and 320x568 the find row is the field alone: no `<select>` in the column, and the row is one
//      control tall, so the content below it starts where the menu used to.
//   2. `Not it? Search everything` is the one way wider, and it lasts for ONE query: its tap re-runs the query
//      with `source=all`, and the next keystroke, or a clear, goes back to the route's default (no `source`).
//   3. The narrowing filter is still reachable off-screen: `/?source=local` sends `source=local`, and the widen is
//      still offered there, so a shared narrowed link is never a search with no way wider.
//   4. The widen removes the button it was tapped on, so focus moves to the widened results' first heading and
//      that heading's description carries the widened count, which goes with the next search; focus never falls
//      to <body>.
//   5. The topbar is one row at 320 and 390 with a long name: the name ellipsises, the wordmark and gear stay whole.
//      At 200% text it may wrap, but at both sizes the wordmark, name, avatar and gear never overlap.
//   6. A widen still in the air when the guest leaves the page moves no focus on the page they went to.
// Requests are read off the wire the page sends, not inferred from the rows, because the rows mostly match.
//
// `SING_BOX_SHOTS=<dir>` writes the idle screen at both widths and the results before and after the widen.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { openBrowseFromHome } from '../../world/actors';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Request } from '@playwright/test';

const SHOTS = process.env.SING_BOX_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shoot = async (page: Page, name: string) => {
	if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

const WIDEN = { name: /Not it\? Search everything/ };

/** The next /api/search the page sends for `q`, and the `source` it carries ('' for none). */
function nextSearch(page: Page, q: string): Promise<string> {
	return page
		.waitForRequest(
			(r: Request) => {
				const u = new URL(r.url());
				return u.pathname === '/api/search' && u.searchParams.get('q') === q;
			},
			{ timeout: 20_000 }
		)
		.then((r) => new URL(r.url()).searchParams.get('source') ?? '');
}

test('the find row is the search field alone at 390 and 320', async ({ world }) => {
	const page = await world.openPhone('Maya');
	for (const vp of [
		{ width: 390, height: 844 },
		{ width: 320, height: 568 }
	]) {
		await page.setViewportSize(vp);
		await page.goto('/');
		await openBrowseFromHome(page);
		await expect(page.locator('main select'), `no menu in the Sing column at ${vp.width}`).toHaveCount(0);
		await expect(page.getByRole('combobox', { name: 'Where to search' })).toHaveCount(0);
		const row = await page.locator('.find-row').boundingBox();
		const field = await page.locator(SEL.findBox).first().boundingBox();
		expect(row && field, 'find row and field both render').toBeTruthy();
		// One control tall: the menu wrapped onto its own line below 520px, which made the row 124px at 320.
		expect(Math.round(row!.height), `the row is the field's height at ${vp.width}`).toBe(Math.round(field!.height));
		expect(Math.round(field!.width), `the field spans the row at ${vp.width}`).toBe(Math.round(row!.width));
		await shoot(page, `idle-${vp.width}`);
	}
});

test('Search everything is the one way wider, and only for the query it was tapped on', async ({ world }) => {
	const track = await world.awaitDemoTrack('caroline');
	const page = await world.openPhone('Maya');
	await page.setViewportSize({ width: 390, height: 844 });
	await openBrowseFromHome(page);
	const search = page.locator(SEL.search);

	let sent = nextSearch(page, track.title);
	await search.fill(track.title);
	expect(await sent, 'a typed query asks the default set').toBe('');
	const widen = page.getByRole('button', WIDEN);
	await widen.waitFor({ timeout: 30_000 });
	await shoot(page, 'results-390');

	sent = nextSearch(page, track.title);
	await widen.click();
	expect(await sent, 'the widen re-runs the same query wider').toBe('all');
	await page.locator(SEL.songRow).first().waitFor({ timeout: 30_000 });
	await expect(widen, 'already wide: nothing wider to offer').toHaveCount(0);
	await shoot(page, 'widened-390');

	const refined = `${track.title}s`;
	sent = nextSearch(page, refined);
	await search.fill(refined);
	expect(await sent, 'the next keystroke goes back to the default').toBe('');

	await page.getByRole('button', { name: 'Clear the search' }).click();
	sent = nextSearch(page, track.title);
	await search.fill(track.title);
	expect(await sent, 'a clear goes back to the default').toBe('');
	await expect(widen, 'the widen is offered again on the default').toBeVisible({ timeout: 30_000 });
});

test('/?source= narrows off-screen, for testing one source', async ({ world }) => {
	const track = await world.awaitDemoTrack('caroline');
	const page = await world.openPhone('Maya');
	await page.goto('/?source=local');
	await openBrowseFromHome(page);
	const sent = nextSearch(page, track.title);
	await page.locator(SEL.search).fill(track.title);
	expect(await sent, 'the URL filter passes through').toBe('local');
	await expect(page.locator(SEL.songRow).first()).toBeVisible({ timeout: 20_000 });
	const widen = page.getByRole('button', WIDEN);
	await expect(widen, 'a narrowed link still offers the way wider').toBeVisible({ timeout: 20_000 });
	const wide = nextSearch(page, track.title);
	await widen.click();
	expect(await wide, 'and it widens past the URL filter').toBe('all');
});

test('the widen hands focus to the widened results and says so', async ({ world }) => {
	const track = await world.awaitDemoTrack('caroline');
	const page = await world.openPhone('Maya');
	await page.setViewportSize({ width: 390, height: 844 });
	await openBrowseFromHome(page);
	await page.locator(SEL.search).fill(track.title);
	const widen = page.getByRole('button', WIDEN);
	await widen.waitFor({ timeout: 30_000 });
	// What the focused element's description reads at the moment focus lands, not later.
	await page.evaluate(() => {
		const w = window as unknown as { described: string[] };
		w.described = [];
		document.addEventListener('focusin', (e) => {
			const id = (e.target as HTMLElement).getAttribute('aria-describedby');
			w.described.push((id && document.getElementById(id)?.textContent) || '');
		});
	});
	await widen.focus();
	await page.keyboard.press('Enter');
	const firstHead = page.locator('main h2.grouphead').first();
	await expect(firstHead, 'focus lands on the first group heading').toBeFocused({ timeout: 30_000 });
	await expect(firstHead, 'the heading carries the count').toHaveAccessibleDescription(/^Searched everything: /);
	const described = await page.evaluate(() => (window as unknown as { described: string[] }).described);
	expect(described.at(-1), 'the count is there as focus lands').toMatch(/^Searched everything: /);
	await expect(page.locator('.sr-live'), 'and is not queued as speech too').not.toHaveText(/Searched everything/);
});

test('a clear right after the widen leaves no widened count behind', async ({ world }) => {
	const track = await world.awaitDemoTrack('caroline');
	const page = await world.openPhone('Maya');
	await page.setViewportSize({ width: 390, height: 844 });
	await openBrowseFromHome(page);
	await page.locator(SEL.search).fill(track.title);
	const widen = page.getByRole('button', WIDEN);
	await widen.waitFor({ timeout: 30_000 });
	// Taps the field's clear 20 ms after focus lands on the widened heading, logging the live region throughout.
	await page.evaluate(() => {
		const w = window as unknown as { liveLog: string[] };
		w.liveLog = [];
		const live = document.querySelector('.sr-live')!;
		new MutationObserver(() => w.liveLog.push(`live ${live.textContent}`)).observe(live, {
			childList: true,
			characterData: true,
			subtree: true
		});
		document.addEventListener('focusin', (e) => {
			if (!(e.target as HTMLElement).matches('h2.grouphead') || w.liveLog.includes('CLEARED')) return;
			setTimeout(() => {
				document.querySelector<HTMLElement>('button[aria-label="Clear the search"]')?.click();
				w.liveLog.push('CLEARED');
			}, 20);
		});
	});
	await widen.click();
	await page.waitForFunction(() => (window as unknown as { liveLog: string[] }).liveLog.includes('CLEARED'));
	await expect(page.locator(SEL.search)).toHaveValue('');
	await page.waitForTimeout(500);
	const log = await page.evaluate(() => (window as unknown as { liveLog: string[] }).liveLog);
	const after = log.slice(log.indexOf('CLEARED') + 1);
	expect(
		after.filter((l) => /Searched everything/.test(l)),
		'no stale count'
	).toEqual([]);
	await expect(page.locator('#widen-count'), 'the count goes with the answer').toHaveCount(0);
});

test('a widen in the air when the guest leaves moves no focus on the next page', async ({ world }) => {
	const track = await world.awaitDemoTrack('caroline');
	const page = await world.openPhone('Maya');
	await page.setViewportSize({ width: 390, height: 844 });
	await openBrowseFromHome(page);
	await page.locator(SEL.search).fill(track.title);
	const widen = page.getByRole('button', WIDEN);
	await widen.waitFor({ timeout: 30_000 });
	// The widened search is held on the wire, so it is still in the air when the page unmounts and aborts it.
	await page.route(
		(u) => u.pathname === '/api/search' && u.searchParams.get('source') === 'all',
		() => new Promise<void>(() => {})
	);
	/* The widen's two targets, a group heading or the departed field, are logged whenever focus() is called on one.
	   /library's own group headings sit in its collapsed refine panel, so one focusable heading is planted in its
	   `main` as it mounts: the page "another route makes its headings focusable" that a stray focus() would hit. */
	await page.evaluate(() => {
		const w = window as unknown as { focusLog: string[] };
		w.focusLog = [];
		new MutationObserver(() => {
			const main = document.querySelector('main');
			if (location.pathname !== '/library' || !main || main.querySelector('[data-planted]')) return;
			main.insertAdjacentHTML('afterbegin', '<h2 class="grouphead" tabindex="-1" data-planted>Planted</h2>');
		}).observe(document.body, { childList: true, subtree: true });
		const focus = HTMLElement.prototype.focus;
		HTMLElement.prototype.focus = function (this: HTMLElement, opts?: FocusOptions) {
			if (!this.isConnected || this.matches('h2.grouphead')) w.focusLog.push(`${location.pathname} ${this.outerHTML}`);
			return focus.call(this, opts);
		};
	});
	await widen.click();
	await page.locator(SEL.libraryLink).click();
	await page.waitForURL('**/library');
	await page.waitForTimeout(500);
	const log = await page.evaluate(() => (window as unknown as { focusLog: string[] }).focusLog);
	expect(log, 'nothing is focused for the widen after the guest left').toEqual([]);
});

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) =>
	a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/* At 200% text the wordmark takes most of the line and the cluster wraps under it (p15-phone-reflow), so the one-row
   claim is 100% only. The no-overlap claim holds at both, and it is what catches `.me-cluster`'s hand-written
   `min-width` drifting below its parts: `justify-content: flex-end` overflows toward the start edge, where
   `scrollWidth` never sees it, and the dot slides under the gear instead. */
for (const width of [320, 390]) {
	for (const root of ['16px', '32px']) {
		test(`the topbar at ${width} with root ${root} and a long name`, async ({ world }) => {
			const page = await world.openPhone('Alexandria');
			await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
			await page.goto('/');
			await openBrowseFromHome(page);
			await page.evaluate((size) => document.documentElement.style.setProperty('font-size', size), root);
			await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(root);
			const box = async (sel: string) => (await page.locator(`.topbar ${sel}`).boundingBox())!;
			const brand = await box('.brand');
			const cluster = await box('.me-cluster');
			const gear = (await page.getByRole('link', { name: 'Settings' }).boundingBox())!;
			const parts: [string, Box][] = [
				['wordmark', brand],
				['name', await box('.me-name')],
				['avatar', await box('.me-dot')],
				['gear', gear]
			];
			if (root === '16px')
				expect(cluster.y, 'the name, avatar and gear stay on the wordmark row').toBeLessThan(brand.y + brand.height);
			expect(gear.x + gear.width, 'the gear stays on screen').toBeLessThanOrEqual(width);
			parts.forEach(([an, a], i) =>
				parts.slice(i + 1).forEach(([bn, b]) => expect(overlap(a, b), `the ${an} and ${bn} overlap`).toBe(false))
			);
			const name = await page.locator('.topbar .me-name').evaluate((el) => ({
				clipped: el.scrollWidth > el.clientWidth,
				ellipsis: getComputedStyle(el).textOverflow === 'ellipsis'
			}));
			if (name.clipped) expect(name.ellipsis, 'a clipped name ends in an ellipsis').toBe(true);
			const wordmark = await page.locator('.topbar .brand').evaluate((el) => el.scrollWidth <= el.clientWidth);
			expect(wordmark, 'the wordmark is never cut').toBe(true);
			await shoot(page, `topbar-${width}-${root}`);
		});
	}
}
