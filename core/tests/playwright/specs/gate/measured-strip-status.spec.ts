// CLAIM 8 the strip's waiting line is read WHOLE and never runs under the transport, measured on the render.
//
// The line is a whole sentence when nothing can play ("Can't make new karaoke right now"), and at 320px it painted
// under the restart button while `.who` neither shrank nor clipped. It sits in `.status` now, which wraps to two
// lines at most inside the strip's one tap floor; this reads the RESOLVED boxes rather than the class list, so a rule
// that loses the wrap (an ellipsis cuts the sentence) or the box (the text runs under ↻) fails here.
//
// No worker is connected, so the seeded song's stems job is unservable on first sight and the strip takes the
// no-maker line within a second. The longer failure sentence is measured the same way in p21 (`stripReadsWhole`).
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { fill, openBrowse } from './measured-design-support';
import { stripReadsWhole } from './strip-measure';

test('CLAIM 8 the strip waiting line wraps whole, inside the strip, before the transport at 320 and 390px', async ({
	world
}) => {
	const track = await world.awaitDemoTrack();
	const page = await world.openPhone(`Strip${Date.now() % 1_000_000}`);
	await page.setViewportSize({ width: 320, height: 640 });
	// `local`, so the row is the seeded fixture rather than a remote hit.
	await page.goto('/?source=local');
	await openBrowse(page);
	await fill(page, SEL.search, track.title);
	await page.locator(SEL.songRow).first().locator(SEL.singAction).click({ timeout: 20_000 });
	await expect(page.locator(SEL.npStripStatus)).toHaveText("Can't make new karaoke right now", { timeout: 10_000 });

	for (const width of [320, 390]) {
		await page.setViewportSize({ width, height: 640 });
		// Evidence for a reviewer, as p21 writes its frames; never a pass condition.
		if (process.env.NDE_SHOTS) await page.screenshot({ path: `${process.env.NDE_SHOTS}/strip-${width}.png` });
		await stripReadsWhole(page, `CLAIM 8 at ${width}px`);
	}
});
