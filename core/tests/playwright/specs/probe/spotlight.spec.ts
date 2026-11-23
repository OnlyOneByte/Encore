// THE SPOTLIGHT PRIMITIVE AND THE GUIDE SEGMENTS, on their dev-only story (no screen uses them yet). Tenet 3: only
// transform and opacity animate, and reduced motion cuts. Tenet 2: no spinner for a wait under 300 ms, and one
// that shows stays 300 ms. Tenet 1: a segment tap presses in the next frame. Plus AA ink on every lit card.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { startGallery, type Gallery } from '../../world/gallery';
import { contrastRatio } from '$lib/contract/presentation/colors';
import { PENDING_GRACE_MS } from '$lib/stores/room';

let gallery: Gallery;
test.beforeAll(async () => {
	test.setTimeout(90_000);
	gallery = await startGallery();
});
test.afterAll(async () => gallery?.stop());

async function open(page: Page, reducedMotion: 'reduce' | 'no-preference' = 'no-preference') {
	await page.emulateMedia({ reducedMotion });
	await gallery.open(page, '/components/spotlight', '[data-testid="spot-on-deck"] .spotlight');
	// Past the cards' own mount entrance, so each test sees only the motion it triggers.
	await page.waitForTimeout(500);
}

/** Every property any running animation in the story moves, and the names of those animations. */
const animated = (page: Page) =>
	page.evaluate(() => {
		const props = new Set<string>();
		const names: string[] = [];
		for (const a of document.getAnimations()) {
			names.push((a as CSSAnimation).animationName ?? 'transition');
			for (const k of (a.effect as KeyframeEffect).getKeyframes())
				for (const p of Object.keys(k))
					if (!['offset', 'easing', 'composite', 'computedOffset'].includes(p)) props.add(p);
		}
		return { props: [...props].sort(), names };
	});

test('mount and handoff animate transform and opacity only; reduced motion cuts both', async ({ page }) => {
	await open(page);
	await page.getByTestId('replay').click();
	const mount = await animated(page);
	expect(mount.names.some((n) => n.endsWith('spot-in'))).toBe(true);
	expect(mount.props.filter((p) => p !== 'transform' && p !== 'opacity')).toEqual([]);

	await page.waitForTimeout(500);
	await page.getByTestId('handoff-toggle').click();
	const hand = await animated(page);
	// The pop only: the fill is already lit, and restarting it from 0 blinked the card dark.
	expect(hand.names.filter((n) => /spot-pop$/.test(n))).toHaveLength(1);
	expect(hand.names.filter((n) => /spot-in$/.test(n))).toEqual([]);
	expect(hand.props.filter((p) => p !== 'transform' && p !== 'opacity')).toEqual([]);
	await expect(page.getByTestId('spot-handoff').locator('.spotlight')).toHaveAttribute('data-moment', 'your-turn');

	await open(page, 'reduce');
	await page.getByTestId('replay').click();
	await page.getByTestId('handoff-toggle').click();
	expect((await animated(page)).names).toEqual([]);
});

/** Samples, every frame for `ms`, when the idle card's spinner is painted. Returns [firstMs, lastMs] or null. */
const spinnerWindow = (page: Page, ms: number) =>
	page.evaluate(
		(windowMs) =>
			new Promise<[number, number] | null>((resolve) => {
				const t0 = performance.now();
				let first: number | null = null;
				let last: number | null = null;
				const tick = () => {
					const t = performance.now() - t0;
					if (document.querySelector('[data-testid="spot-idle"] [data-slot="spinner"]')) {
						first ??= t;
						last = t;
					}
					if (t < windowMs) requestAnimationFrame(tick);
					else resolve(first === null ? null : [first, last!]);
				};
				tick();
			}),
		ms
	);

test('a 150 ms wait paints no spinner; a 900 ms one paints at the grace and holds', async ({ page }) => {
	await open(page);
	const short = spinnerWindow(page, 800);
	await page.getByTestId('busy-short').click();
	expect(await short).toBeNull();

	const long = spinnerWindow(page, 1_800);
	await page.getByTestId('busy-long').click();
	const seen = await long;
	expect(seen).not.toBeNull();
	const [first, last] = seen!;
	expect(first).toBeGreaterThanOrEqual(PENDING_GRACE_MS - 20);
	expect(last - first).toBeGreaterThanOrEqual(PENDING_GRACE_MS - 20);
	// It goes when the wait ends (900 ms), not a hold later.
	expect(last).toBeLessThan(900 + 200);
});

test('a Guide tap presses its segment in the next frame; a dropped send and a custom level press none', async ({
	page
}) => {
	await open(page);
	const plain = page.getByTestId('guide-plain');
	const pressed = (where: Locator) => where.locator('button[aria-pressed="true"]').allTextContents();
	expect(await pressed(plain)).toEqual(['Off']);
	const ms = await plain.getByRole('button', { name: 'Low' }).evaluate(
		(b) =>
			new Promise<number>((resolve) => {
				const t0 = performance.now();
				b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
				const tick = () =>
					b.getAttribute('aria-pressed') === 'true' ? resolve(performance.now() - t0) : requestAnimationFrame(tick);
				tick();
			})
	);
	expect(ms).toBeLessThanOrEqual(100);
	expect(await pressed(plain)).toEqual(['Low']);

	const dropped = page.getByTestId('guide-dropped');
	await dropped.getByRole('button', { name: 'Full' }).click();
	expect(await pressed(dropped)).toEqual(['Low']);
	expect(await pressed(page.getByTestId('guide-custom'))).toEqual([]);

	for (const box of await plain.locator('button').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect())))
		expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
});

test('lit, idle, error and light cards put AA ink on what they paint', async ({ page }) => {
	await open(page);
	await page.waitForTimeout(600);
	const pairs = await page.evaluate(() => {
		const rgb = (c: string) => {
			const ctx = document.createElement('canvas').getContext('2d')!;
			ctx.fillStyle = c;
			return ctx.fillStyle as string;
		};
		return [...document.querySelectorAll<HTMLElement>('.spotlight')].map((el) => {
			const lit = el.classList.contains('lit');
			const ground = getComputedStyle(lit ? el.querySelector('.fill')! : el).backgroundColor;
			return {
				card: el.closest('[data-testid]')?.getAttribute('data-testid') ?? '?',
				ink: rgb(getComputedStyle(el.querySelector('.title')!).color),
				ground: rgb(ground)
			};
		});
	});
	expect(pairs.length).toBe(5);
	const fails = pairs.filter((p) => contrastRatio(p.ink, p.ground) < 4.5);
	expect(fails).toEqual([]);
	expect(await page.getByTestId('light').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
		'rgb(247, 247, 251)'
	);
});
