// The 404 page is styled from the server's HTML alone (#1361). With JavaScript off, a lazily imported stylesheet never
// loads, so this is the same check as the first paint: a white page here is the white flash a TV shows.
// `SHOT_DIR=<dir>` also writes the frames at 390, 1920 and 1280.
import { test, expect } from '../../world/fixtures';

const BG = 'rgb(11, 11, 18)'; // app.css --bg

for (const { path, back, width, height } of [
	{ path: '/no-such-page', back: '/', width: 390, height: 844 },
	{ path: '/tv/no-such-screen', back: '/tv', width: 1920, height: 1080 },
	{ path: '/tv/no-such-screen', back: '/tv', width: 1280, height: 720 }
]) {
	test(`${path} at ${width} is styled with JavaScript off and links back to ${back}`, async ({ world, browser }) => {
		const ctx = await browser.newContext({
			baseURL: world.baseURL,
			javaScriptEnabled: false,
			viewport: { width, height }
		});
		const page = await ctx.newPage();
		const res = await page.goto(path);
		expect(res?.status()).toBe(404);
		expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(BG);
		// The server writes the link relative (`./`), so check where it lands, not its text.
		const link = page.getByRole('link', { name: 'Back to the room' });
		expect(await link.evaluate((a) => new URL((a as HTMLAnchorElement).href).pathname)).toBe(back);
		if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/404-${width}.png` });
		await ctx.close();
	});
}

// The inline styles key on the error page's own tag (the #1365 review): a guest who names themself after the marker
// must not get them on a page that prints the name.
test('a guest named data-error-page gets no inlined error styles on their own You page', async ({ world }) => {
	const phone = await world.openPhone('data-error-page');
	const html = await (await phone.request.get('/settings/you')).text();
	expect(html, 'the page prints the name, so the marker text is in it').toContain('data-error-page');
	expect(html).not.toContain('<style>/*! tailwindcss');
	const notFound = await (await phone.request.get('/no-such-page')).text();
	expect(notFound, 'the 404 itself still gets them').toContain('<style>/*! tailwindcss');
});
