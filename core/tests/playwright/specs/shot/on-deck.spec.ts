// ON DECK, driven for real: three singers, a fake worker so the songs are ready, Theo singing, Maya next, Ana
// behind her. Maya sets −2 on her on-deck card before her turn; Theo skips; the TV opens on Maya's song with
// "Key −2" on the intro card. Frames go to ON_DECK_OUT (or the test's output dir), phone at 390x844 in both colour
// schemes, TV at 1920x1080.
//
// The fixture tracks are 8 seconds long, so the song before yours is ALWAYS inside the 30-second heads-up: the
// on-deck frame here is the heads-up state. The resting state is on the dev-only /components gallery.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openQueue, queueReady, readySong } from '../../world/actors';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

test('on deck: the card, the preset, and the TV key chip', async ({ world }, testInfo) => {
	const out = process.env.ON_DECK_OUT ?? testInfo.outputDir;
	mkdirSync(out, { recursive: true });
	const worker = await startFakeWorker(world);
	try {
		const theo = await world.openPhone('Theo');
		const maya = await world.openPhone('Maya', { stop: 'End' });
		const ana = await world.openPhone('Ana');
		await readySong(world, theo, 'believin');
		await readySong(world, theo, 'caroline');
		await readySong(world, theo, 'prayer');

		await queueReady(theo, 'believin');
		await expect(theo.locator(SEL.npStripTitle)).toBeAttached();
		await queueReady(maya, 'caroline');
		await queueReady(ana, 'prayer');

		await openQueue(maya);
		const deck = maya.locator('section[aria-label="On deck"]');
		await expect(deck).toBeVisible();
		await expect(deck).toContainText('Not yet — let Ana go first');
		await deck.getByRole('button', { name: 'Lower by one semitone' }).click();
		await deck.getByRole('button', { name: 'Lower by one semitone' }).click();
		await expect(deck).toContainText('Key · −2');
		await expect(deck).toContainText('You’re next');

		// The viewport, not `fullPage`: the dock is fixed, and a full-page capture paints it over the card's middle.
		await deck.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		for (const scheme of ['dark', 'light'] as const) {
			await maya.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
			await maya.screenshot({ path: join(out, `phone-on-deck-${scheme}.png`) });
		}

		// Theo's turn ends; Maya's starts in the key she set.
		await theo.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(maya.locator(SEL.npStripTitle)).toContainText(/caroline/i);
		await expect(deck).toHaveCount(0);
		await maya.screenshot({ path: join(out, 'phone-singing-after-preset.png') });

		const tv = await world.openTv();
		const intro = tv.locator(SEL.stateNext);
		await expect(intro).toBeVisible({ timeout: 30_000 });
		await expect(intro).toContainText('Key −2');
		for (const scheme of ['dark', 'light'] as const) {
			await tv.emulateMedia({ colorScheme: scheme });
			await tv.screenshot({ path: join(out, `tv-intro-key-chip-${scheme}.png`) });
		}
	} finally {
		await worker.stop();
	}
});

test('on deck: Not yet lets the next singer go first, once', async ({ world }, testInfo) => {
	const out = process.env.ON_DECK_OUT ?? testInfo.outputDir;
	mkdirSync(out, { recursive: true });
	const worker = await startFakeWorker(world);
	try {
		const theo = await world.openPhone('Theo');
		const maya = await world.openPhone('Maya', { stop: 'End' });
		const ana = await world.openPhone('Ana');
		await readySong(world, theo, 'believin');
		await readySong(world, theo, 'caroline');
		await readySong(world, theo, 'prayer');
		await queueReady(theo, 'believin');
		await expect(theo.locator(SEL.npStripTitle)).toBeAttached();
		await queueReady(maya, 'caroline');
		await queueReady(ana, 'prayer');

		await openQueue(maya);
		const deck = maya.locator('section[aria-label="On deck"]');
		await deck.getByRole('button', { name: 'Not yet — let Ana go first' }).click();
		await expect(deck).toHaveCount(0);
		await expect
			.poll(() => maya.locator(SEL.queueTitle).allInnerTexts())
			.toEqual(['livin-on-a-prayer', 'sweet-caroline']);
		await maya.emulateMedia({ reducedMotion: 'reduce' });
		await maya.screenshot({ path: join(out, 'phone-after-not-yet.png') });

		// Ana sings; Maya is on deck again, and the button is gone for good.
		await theo.getByRole(SEL.skip.role, { name: SEL.skip.name }).first().click();
		await expect(deck).toBeVisible();
		await expect(deck.getByRole('button', { name: /Not yet/ })).toHaveCount(0);
		await deck.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await maya.screenshot({ path: join(out, 'phone-on-deck-not-yet-spent.png') });
	} finally {
		await worker.stop();
	}
});
