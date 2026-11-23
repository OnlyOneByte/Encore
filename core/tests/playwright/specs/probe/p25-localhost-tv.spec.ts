// P25: the README's TV path. On the machine plugged into the TV, open http://localhost:<port>/tv: the QR and the "Go to"
// line name the box's home-network address (never Docker's bridge), the "Phones can't open this address" warning does
// not show, the startup line names the same address, and Settings -> This machine, opened on that machine, offers every
// address as a one-tap choice that moves the QR. This core binds 127.0.0.1 and has no LAN, so ENCORE_TEST_INTERFACES
// stands in for the interface list: what this proves is the pick and its surfaces, not that a phone reaches the box.
// `SHOT_DIR=<dir>` also writes the TV lobby at 1920x1080 and Settings at 390 and 320.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { UNREACHABLE_JOIN } from '../../../../src/lib/tv/join-address';
import type { Page } from '@playwright/test';

const ipv4 = (address: string) => ({ address, family: 'IPv4', internal: false, netmask: '255.255.255.0' });
test.use({
	coreEnv: {
		ENCORE_TEST_INTERFACES: JSON.stringify({
			lo: [{ ...ipv4('127.0.0.1'), internal: true }],
			docker0: [ipv4('192.168.99.1')],
			eth0: [ipv4('172.17.0.5')],
			wlan0: [ipv4('192.168.1.20')],
			usb0: [ipv4('192.168.1.21')]
		})
	}
});

const shot = async (page: Page, name: string) => {
	if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/${name}.png` });
};

test('a TV opened at localhost advertises the home-network address, and Settings offers each one', async ({
	world,
	browser
}) => {
	test.setTimeout(120_000);
	const port = new URL(world.baseURL).port;
	const lan = `192.168.1.20:${port}`;

	// The startup line names the address phones should open, not 0.0.0.0 or 127.0.0.1. Soft, like the TV checks below,
	// so a regression reports every surface that is wrong rather than only the first.
	expect.soft(world.core.log()).toContain(`Encore on http://${lan} (open /tv on the TV)`);

	for (const host of ['localhost', '127.0.0.1']) {
		const origin = `http://${host}:${port}`;
		const ctx = await browser.newContext({ baseURL: origin, viewport: { width: 1920, height: 1080 } });
		await ctx.addCookies([{ ...world.tvCookie, url: origin }]);
		const tv = await ctx.newPage();
		await tv.goto(`/tv?room=${world.code}`);
		await expect.soft(tv.locator(SEL.joinAddress).first()).toHaveText(lan);
		await expect.soft(tv.getByText(UNREACHABLE_JOIN)).toHaveCount(0);
		// The QR is a server-rendered image of `joinUrl`; the same value rides in the page data.
		expect.soft(await tv.content()).toContain(`http://${lan}/?room=${world.code}`);
		await shot(tv, `tv-attract-${host}-1920`);
		await ctx.close();
	}

	// The host, at the TV machine's keyboard: join at localhost, then open Settings -> This machine there.
	const origin = `http://localhost:${port}`;
	const host = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 } });
	const phone = await host.newPage();
	await world.joinAs(phone, 'Host');
	// Somebody joined, so the TV shows its lobby, which names the address too.
	const lobby = await browser.newContext({ baseURL: origin, viewport: { width: 1920, height: 1080 } });
	await lobby.addCookies([{ ...world.tvCookie, url: origin }]);
	const tv = await lobby.newPage();
	await tv.goto(`/tv?room=${world.code}`);
	await expect(tv.locator(SEL.lobbyAddress).first()).toContainText(lan);
	await expect(tv.getByText(UNREACHABLE_JOIN)).toHaveCount(0);
	await shot(tv, 'tv-lobby-1920');

	await phone.goto('/settings/server');
	await expect(phone).toHaveURL(/\/settings\/server$/);
	const use20 = phone.getByRole('button', { name: `Use ${lan}` });
	const use21 = phone.getByRole('button', { name: `Use 192.168.1.21:${port}` });
	await expect(use20).toBeVisible();
	await expect(use21).toBeVisible();
	// Docker's bridge and the 172.x NAT address are never offered.
	await expect(phone.getByRole('button', { name: /^Use 192\.168\.99\.|^Use 172\./ })).toHaveCount(0);
	await expect(phone.locator('#join-origin-hint')).toContainText(`http://${lan}`);
	await expect(phone.getByText(UNREACHABLE_JOIN)).toHaveCount(0);
	await phone.locator('#joining').scrollIntoViewIfNeeded();
	await shot(phone, 'settings-server-390');
	await phone.setViewportSize({ width: 320, height: 844 });
	await phone.locator('#joining').scrollIntoViewIfNeeded();
	await shot(phone, 'settings-server-320');
	await phone.setViewportSize({ width: 390, height: 844 });

	// One tap saves it: the field shows it, its own button goes, and the TV's QR follows.
	await use21.click();
	await expect(phone.locator('#join-origin')).toHaveValue(`http://192.168.1.21:${port}`);
	await expect(use21).toHaveCount(0);
	await expect
		.poll(async () => {
			await tv.goto(`/tv?room=${world.code}`);
			return tv.locator(SEL.lobbyAddress).first().innerText();
		})
		.toContain(`192.168.1.21:${port}`);
	await lobby.close();
	await host.close();
});
