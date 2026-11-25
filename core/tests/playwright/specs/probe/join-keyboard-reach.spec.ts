// THE JOIN BUTTON STAYS IN REACH WITH THE KEYBOARD UP (redesign step 7, #1304 review). On a 320x568 phone a 260 px
// keyboard leaves a 308 px layout viewport (`interactive-widget=resizes-content`); headless Chromium has no soft
// keyboard, so the probe IS that viewport. With the name field focused and filled, Start singing must be wholly on
// screen: `.submit-slot` is sticky to the bottom of the viewport, inside the card.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';

test('320x308 (keyboard up): Start singing is fully on screen while the guest types a name', async ({
	world,
	browser
}) => {
	await world.openPhone('Theo');
	const ctx = await browser.newContext({ viewport: { width: 320, height: 308 }, baseURL: world.baseURL });
	const page = await ctx.newPage();
	try {
		await page.goto(`/?room=${encodeURIComponent(world.code)}`);
		const name = page.locator(SEL.nameInput);
		await name.focus();
		await name.fill('Maya');
		const cta = page.getByRole('button', { name: SEL.submit });
		await expect(cta).toBeEnabled();
		// The focused field is scrolled into view, as the browser does when the keyboard opens.
		await name.evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
		await page.waitForTimeout(300);
		const box = (await cta.boundingBox())!;
		const field = (await name.boundingBox())!;
		expect(field.y + field.height, 'the name field is on screen').toBeLessThanOrEqual(308);
		expect(box.y, `Start singing top ${box.y}`).toBeGreaterThanOrEqual(0);
		expect(box.y + box.height, `Start singing bottom ${box.y + box.height} of 308`).toBeLessThanOrEqual(308);
	} finally {
		await ctx.close();
	}
});
