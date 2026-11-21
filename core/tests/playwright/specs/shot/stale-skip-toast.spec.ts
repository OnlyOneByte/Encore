// THE STALE-SKIP NOTICE, as a guest sees it. Ana skips Maya's song, and Theo taps skip again a moment later. His
// strip already shows the next song, Ana's (the queue runs Maya, Ana, Theo; on his OWN turn there is no notice, IN-02),
// but the settle window (`$lib/transport-target`) makes his tap name Maya's, so the server drops it and his phone says
// why. Frames go to STALE_TOAST_OUT (or the test's output dir), phone at 390x844 and 320x568 (the two widths the
// no-widow rule is checked at).
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { queueReady, readySong } from '../../world/actors';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

for (const [w, h] of [
	[390, 844],
	[320, 568]
] as const) {
	test(`stale skip at ${w}: the notice over the strip that already shows the new song`, async ({ world }, testInfo) => {
		const out = process.env.STALE_TOAST_OUT ?? testInfo.outputDir;
		mkdirSync(out, { recursive: true });
		const worker = await startFakeWorker(world);
		try {
			const maya = await world.openPhone('Maya');
			const theo = await world.openPhone('Theo');
			const ana = await world.openPhone('Ana');
			await theo.setViewportSize({ width: w, height: h });
			for (const q of ['caroline', 'believin', 'prayer']) await readySong(world, maya, q);
			await queueReady(maya, 'caroline');
			await queueReady(ana, 'prayer');
			await queueReady(theo, 'believin');
			await theo.getByRole('link', { name: 'Library' }).click();
			await expect(theo.locator(SEL.npStripTitle)).toContainText(/caroline/i);
			// Past the first song's opening second, so the next change is a real song change.
			await theo.waitForTimeout(1_500);

			await ana.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
			await expect(theo.locator(SEL.npStripTitle)).not.toContainText(/caroline/i);
			await theo.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();

			const toast = theo
				.locator('[data-sonner-toast]')
				.filter({ hasText: 'That song just ended. Tap again to skip this one.' });
			await expect(toast).toBeVisible({ timeout: 2_000 });
			await theo.emulateMedia({ reducedMotion: 'reduce' });
			await theo.waitForTimeout(500);
			await theo.screenshot({ path: join(out, `phone-stale-skip-toast-${w}x${h}.png`) });
		} finally {
			await worker.stop();
		}
	});
}
