// ON DECK, driven for real: three singers, a fake worker so the songs are ready, Theo singing, Maya next, Ana
// behind her. Maya sets −2 on her on-deck card before her turn; Theo skips; the TV opens on Maya's song with
// "Key -2" in the lower third. Frames go to ON_DECK_OUT (or the test's output dir), phone at 390x844 in both colour
// schemes, TV at 1920x1080.
//
// The fixture tracks are 8 seconds long, so the song before yours is ALWAYS inside the 30-second heads-up: the
// on-deck frame here is the heads-up state. The resting state is on the dev-only /components gallery.
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { startFakeWorker } from '../../world/workers';
import { openQueue, queueReady, readySong, transportTap } from '../../world/actors';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

test('on deck: the card, the preset, and the key on the TV', async ({ world }, testInfo) => {
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
		const deck = maya.locator('.deck:not(.up)');
		await expect(deck).toBeVisible();
		await expect(deck).toContainText('Not yet — let Ana go first');
		await deck.getByRole('button', { name: /^Lower .+ by one semitone$/ }).click();
		await deck.getByRole('button', { name: /^Lower .+ by one semitone$/ }).click();
		await expect(deck).toContainText('Key · −2');
		await expect(deck).toContainText('You’re next');
		// The key is said once on this screen: the card's "A minor → G minor", not again on Maya's queued row.
		await expect(maya.locator('.qrow', { hasText: 'sweet-caroline' })).not.toContainText('minor');
		await expect(maya.locator('.qrow', { hasText: 'livin-on-a-prayer' })).toContainText('minor');

		// The viewport, not `fullPage`: the dock is fixed, and a full-page capture paints it over the card's middle.
		await deck.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		for (const scheme of ['dark', 'light'] as const) {
			await maya.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
			await maya.screenshot({ path: join(out, `phone-on-deck-${scheme}.png`) });
		}

		// Theo's turn ends; Maya's starts in the key she set. "Not yet" had her focus, and leaves with the handoff: focus
		// goes to her card's first key, not to <body>.
		await deck.getByRole('button', { name: /^Not yet/ }).focus();
		await transportTap(theo, 'skip');
		await expect(maya.locator(SEL.npStripTitle)).toContainText(/caroline/i);
		await expect(deck).toHaveCount(0);
		await expect(maya.locator(`${SEL.queueMyCard}.up .keys button`).first()).toBeFocused();
		await maya.screenshot({ path: join(out, 'phone-singing-after-preset.png') });

		// The TV says the key ONCE: the lower third's "Key -2" (#992's words), never a second chip on the intro card.
		const tv = await world.openTv();
		const intro = tv.locator(SEL.stateNext);
		await expect(intro).toBeVisible({ timeout: 30_000 });
		await expect(tv.locator(SEL.lowerThird)).toContainText('Key -2');
		await expect(intro).not.toContainText('Key');
		for (const scheme of ['dark', 'light'] as const) {
			await tv.emulateMedia({ colorScheme: scheme });
			await tv.screenshot({ path: join(out, `tv-intro-key-${scheme}.png`) });
		}
	} finally {
		await worker.stop();
	}
});

test('on deck: no card, and no "grab the mic", while you are the one singing', async ({ world }) => {
	const worker = await startFakeWorker(world);
	try {
		const maya = await world.openPhone('Maya', { stop: 'End' });
		await readySong(world, maya, 'caroline');
		await readySong(world, maya, 'prayer');
		await queueReady(maya, 'caroline');
		await expect(maya.locator(SEL.npStripTitle)).toContainText(/caroline/i);
		await queueReady(maya, 'prayer');
		await openQueue(maya);
		await expect(maya.locator(SEL.queueNowCard).first()).toBeVisible();
		await expect(maya.locator(SEL.queueTitle)).toHaveText(['livin-on-a-prayer']);
		await expect(maya.locator('.deck:not(.up)')).toHaveCount(0);
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
		const deck = maya.locator('.deck:not(.up)');
		await deck.getByRole('button', { name: 'Not yet — let Ana go first' }).click();
		await expect(deck).toHaveCount(0);
		await expect
			.poll(() => maya.locator(SEL.queueTitle).allInnerTexts())
			.toEqual(['livin-on-a-prayer', 'sweet-caroline']);
		await maya.emulateMedia({ reducedMotion: 'reduce' });
		await maya.screenshot({ path: join(out, 'phone-after-not-yet.png') });

		// Ana sings; Maya is on deck again, and the button is gone for good.
		await transportTap(theo, 'skip');
		await expect(deck).toBeVisible();
		await expect(deck.getByRole('button', { name: /Not yet/ })).toHaveCount(0);
		await deck.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		await maya.screenshot({ path: join(out, 'phone-on-deck-not-yet-spent.png') });
	} finally {
		await worker.stop();
	}
});
