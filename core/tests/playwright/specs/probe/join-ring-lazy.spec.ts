// THE COLOUR RING MOUNTS ON "change", NOT WITH THE CARD (#1320): the QR's first render to the name field must not pay
// for a ring nobody has asked for. Once mounted it still opens, picks, and opens again.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';

test('the join ring is absent until "change", then opens, picks and reopens', async ({ world, browser }) => {
	await world.openPhone('Theo');
	const ctx = await browser.newContext({ baseURL: world.baseURL });
	const page = await ctx.newPage();
	try {
		await page.goto(`/?room=${encodeURIComponent(world.code)}`);
		await expect(page.locator(SEL.nameInput)).toBeVisible();
		await expect(page.locator(SEL.colourRing), 'no ring before "change"').toHaveCount(0);

		const change = page.locator(SEL.colourChange);
		const before = await change.innerText();
		await change.click();
		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		await page.locator(SEL.colourRing).press('End');
		await dialog.getByRole('button', { name: 'Done' }).click();
		await expect(dialog).toBeHidden();
		await expect(change, 'the pick reached the row').not.toHaveText(before);

		await change.click();
		await expect(dialog, 'a second "change" opens it again').toBeVisible();
	} finally {
		await ctx.close();
	}
});
