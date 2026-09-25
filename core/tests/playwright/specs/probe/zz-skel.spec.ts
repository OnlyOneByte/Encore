import { test, expect } from '../../world/fixtures';
test('SkeletonRows renders with its role while the library is in flight', async ({ world }) => {
	const phone = await world.openPhone('K');
	// Hold /api/library open so `libraryLoaded` stays false and the placeholder is observable.
	await phone.route('**/api/library', async (r) => {
		await new Promise((res) => setTimeout(res, 4000));
		await r.fulfill({ json: { library: [], processing: [], tags: {}, facets: { artists: [], tags: [] }, filter: null } });
	});
	await phone.setViewportSize({ width: 900, height: 800 }); // >=768px: main is a grid here
	await phone.goto(`${world.baseURL}/library`);
	const skels = phone.locator('.skels');
	await skels.waitFor({ state: 'visible', timeout: 15000 });
	const info = await skels.evaluate((el) => {
		const c = getComputedStyle(el);
		const row = el.querySelector('.skel-row') as HTMLElement | null;
		return {
			role: el.getAttribute('role'),
			label: el.getAttribute('aria-label'),
			busy: el.getAttribute('aria-busy'),
			rows: el.querySelectorAll('.skel-row').length,
			display: c.display,
			gridColumn: c.gridColumn,
			rowW: row?.getBoundingClientRect().width ?? 0
		};
	});
	console.log('SKELETONS:', JSON.stringify(info));
	expect(info.role).toBe('status');
	expect(info.rows).toBe(4);
	expect(info.rowW, 'a row must occupy real width, not collapse in the grid').toBeGreaterThan(300);
});
