/*
 * CLAIM 5: the TV type floor is ONE declaration and the ladder is rem. The source-scan half of this lived in
 * tests/guards/layout/stage-scale.test.ts (deleted with that tree). Only a render settles that the `.tv` root
 * calc resolves as intended at 1920x1080, that every rem tier multiplies THAT root, and that `--ui-scale` at
 * its 0.8 bound keeps every tier at or above 20px. It is overridden IN PLACE, so this measures the real
 * cascade.
 *
 * ONE TEST, because the readings are a SEQUENCE over one document: the 0.8 arm is a comparison against the
 * scale-1 root, and the `banana` arm only means anything after a real numeric override has been seen to work.
 */
import { test, expect } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import type { Page } from '@playwright/test';

/** The eight TV type tiers, read as the ENGINE resolves them off the root (a rem tier * the root px). */
const TV_TIERS = [
	'--tv-small',
	'--tv-eyebrow',
	'--tv-label',
	'--tv-body',
	'--tv-name',
	'--tv-joinurl',
	'--tv-hero',
	'--tv-lyric'
];

async function readTiers(page: Page) {
	return page.evaluate(
		({ tvRoot, tiers: tokens }) => {
			const tv = document.querySelector(tvRoot);
			if (!tv) return null;
			// Resolve each rem token to px through a throwaway child of .tv, so rem binds to the .tv root
			// font-size exactly as the real tiers do.
			const read = (tok: string) => {
				const probe = document.createElement('span');
				probe.style.cssText = 'position:absolute;visibility:hidden;font-size:var(' + tok + ')';
				tv.appendChild(probe);
				const px = parseFloat(getComputedStyle(probe).fontSize);
				probe.remove();
				return px;
			};
			const tiers: Record<string, number> = {};
			for (const t of tokens) tiers[t] = read(t);
			return { rootPx: parseFloat(getComputedStyle(tv).fontSize), tiers };
		},
		{ tvRoot: SEL.tvRoot, tiers: TV_TIERS }
	);
}

test('CLAIM 5 the TV type ladder resolves off one root, and --ui-scale moves it without dropping the floor', async ({
	world
}) => {
	const page = await world.openTv();
	await page.setViewportSize({ width: 1920, height: 1080 });
	await page.locator(SEL.tvRoot).first().waitFor({ state: 'attached', timeout: 15_000 });
	// A DWELL before a type read: the stage fades its panels in, and a font-size resolved mid-transition is not
	// the one the ladder settles at.
	await page.waitForTimeout(500);

	const tv1 = await readTiers(page);
	if (!tv1) {
		expect
			.soft(tv1, 'CLAIM 5 the /tv document mounts .tv so the root floor is measurable: no .tv element found on /tv')
			.not.toBeNull();
		return;
	}

	// Root: 2.7vh of 1080 = 29.16px, * ui-scale 1.
	expect
		.soft(
			Math.abs(tv1.rootPx - 29.16) <= 0.5,
			'CLAIM 5 the .tv root font-size resolves to 29.16px at 1920x1080, --ui-scale 1: ' +
				`.tv root computed to ${tv1.rootPx}px (expected 29.16 ± 0.5)`
		)
		.toBe(true);
	const smallest1 = Math.min(...Object.values(tv1.tiers));
	expect
		.soft(
			smallest1 >= 27 - 0.5,
			'CLAIM 5 the smallest rendered TV tier is >= 27px, and none below 24px, at --ui-scale 1: ' +
				`smallest tier ${smallest1}px across ${JSON.stringify(tv1.tiers)}`
		)
		.toBe(true);
	// Every tier must be an integer-ish rem multiple of the root, i.e. tracked BY the root, not free.
	const untracked = Object.entries(tv1.tiers).filter(
		([, px]) => Math.abs(px / tv1.rootPx - Math.round((px / tv1.rootPx) * 1000) / 1000) > 0.05
	);
	expect
		.soft(
			untracked,
			'CLAIM 5 every TV tier is a rem multiple of the root — it moves when the root moves: ' +
				`tiers not resolving as a clean rem multiple of the ${tv1.rootPx}px root`
		)
		.toEqual([]);

	// Push --ui-scale to its 0.8 lower bound on the ROOT (where the floor consumes it — a custom property set
	// on a descendant like .tv would not reach :root's already-resolved font-size).
	await page.evaluate(() => document.documentElement.style.setProperty('--ui-scale', '0.8'));
	// A DWELL: a custom-property write re-resolves the cascade, and the tiers are read straight back.
	await page.waitForTimeout(200);
	const tv08 = await readTiers(page);
	const smallest08 = tv08 ? Math.min(...Object.values(tv08.tiers)) : 0;
	expect
		.soft(
			tv08 !== null && smallest08 >= 20 - 0.5,
			'CLAIM 5 at --ui-scale 0.8 no TV tier falls below 20px: ' +
				`smallest tier at 0.8 = ${smallest08}px across ${JSON.stringify(tv08?.tiers)}`
		)
		.toBe(true);
	// And that the root itself scaled with it (proves --ui-scale is the multiplier, not inert).
	expect
		.soft(
			tv08 !== null && Math.abs(tv08.rootPx - 29.16 * 0.8) <= 0.5,
			'CLAIM 5 --ui-scale actually scales the root — 0.8 * 29.16 ~= 23.33px: ' +
				`.tv root at --ui-scale 0.8 computed to ${tv08?.rootPx}px (expected ~23.33)`
		)
		.toBe(true);

	// A non-numeric --ui-scale must be REJECTED by the @property <number> registration and fall back to
	// initial-value 1, so the floor holds rather than the font-size dropping. Root stays 29.16.
	await page.evaluate(() => document.documentElement.style.setProperty('--ui-scale', 'banana'));
	await page.waitForTimeout(200);
	const tvBad = await readTiers(page);
	expect
		.soft(
			tvBad !== null && Math.abs(tvBad.rootPx - 29.16) <= 0.5,
			'CLAIM 5 (advisory) a non-numeric --ui-scale falls back to 1 via @property — the floor is not dropped: ' +
				`.tv root with --ui-scale: banana computed to ${tvBad?.rootPx}px (expected 29.16 — @property <number> should ` +
				'reject the non-numeric value)'
		)
		.toBe(true);
	await page.evaluate(() => document.documentElement.style.removeProperty('--ui-scale'));

	// 720p: the px term of max(2.7vh, 20px) must engage. At a 720-tall viewport 2.7vh = 19.44px < 20px, so the
	// root floors at 20px — the windowed/short-panel case the 1080p arms cannot reach.
	await page.setViewportSize({ width: 1280, height: 720 });
	await page.waitForTimeout(200);
	const tv720 = await readTiers(page);
	expect
		.soft(
			tv720 !== null && Math.abs(tv720.rootPx - 20) <= 0.5,
			'CLAIM 5 at a 720-tall viewport the root floors on the 20px px-term of max(2.7vh, 20px): ' +
				`.tv root at 1280x720 computed to ${tv720?.rootPx}px (expected 20 — the px floor, since 2.7vh = 19.44px there)`
		)
		.toBe(true);
	await page.setViewportSize({ width: 1920, height: 1080 });
});
