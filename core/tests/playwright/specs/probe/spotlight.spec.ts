// THE SPOTLIGHT PRIMITIVE AND THE GUIDE SEGMENTS, on their dev-only story. Tenet 3: only
// transform and opacity animate, and reduced motion cuts. Tenet 2: no spinner for a wait under 300 ms, and one
// that shows stays 300 ms. Tenet 1: a segment tap presses in the next frame. Plus AA ink on every lit card, and
// the story server watches no file, so a test artifact written mid-run reloads nothing.
import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startGallery, type Gallery } from '../../world/gallery';
import { repoRoot } from '../../world/core';
import { contrastRatio } from '$lib/contract/presentation/colors';
import { PENDING_GRACE_MS } from '$lib/stores/room';

// One worker, so one `vite dev` serves the file: fullyParallel would boot one per worker.
test.describe.configure({ mode: 'serial' });

let gallery: Gallery;
test.beforeAll(async () => {
	test.setTimeout(90_000);
	gallery = await startGallery();
});
test.afterAll(async () => gallery?.stop());
test.afterEach(async ({ page }, info) => {
	if (info.status === info.expectedStatus) return;
	await info.attach('vite.log', { body: gallery?.log() ?? '' });
	await info.attach('page.txt', { body: `${page.url()}\n${await page.content().catch(() => '')}` });
});

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

test('a file written under the test artifacts mid-run reloads no page', async ({ page }) => {
	await open(page);
	let navs = 0;
	page.on('framenavigated', (f) => void (f === page.mainFrame() && navs++));
	const dir = join(repoRoot, 'tests/playwright/.artifacts/gallery-watch');
	mkdirSync(dir, { recursive: true });
	try {
		writeFileSync(join(dir, 'x.html'), '<p>trace</p>');
		await page.waitForTimeout(2_000);
		expect(navs, 'the page reloaded').toBe(0);
		expect(gallery.log()).not.toContain('page reload');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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

/** Clicks `testId` and returns every span, in ms after that click, the idle card's spinner was in the DOM, in order;
 *  a span still open at the window's end closes there. Empty if it never appeared. Every enter and exit counts, so a
 *  flicker after the grace reads as two spans, not one (#1405). Timed from the click's own event and by a
 *  MutationObserver, not from the evaluate's start on rAF: on the 2-CPU runner the click landed ~1.2 s into a 1.8 s
 *  window and the window's end cut the spinner short (#1134). */
async function spinnerAfterClick(page: Page, testId: string, ms: number): Promise<[number, number][]> {
	const seen = page.evaluate(
		({ id, windowMs }) =>
			new Promise<[number, number][]>((resolve) => {
				const spinner = '[data-testid="spot-idle"] [data-slot="spinner"]';
				let t0: number | null = null;
				const spans: [number, number][] = [];
				let open: number | null = null;
				const mo = new MutationObserver(() => {
					if (t0 === null) return;
					const t = performance.now() - t0;
					const up = !!document.querySelector(spinner);
					if (up && open === null) open = t;
					else if (!up && open !== null) {
						spans.push([open, t]);
						open = null;
					}
				});
				mo.observe(document, { subtree: true, childList: true });
				// Capture, so the clock starts before the button's own handler starts the wait.
				const onClick = (e: Event) => {
					if (!(e.target as Element).closest?.(`[data-testid="${id}"]`)) return;
					document.removeEventListener('click', onClick, true);
					t0 = performance.now();
					setTimeout(() => {
						mo.disconnect();
						if (open !== null) spans.push([open, performance.now() - t0!]);
						resolve(spans);
					}, windowMs);
				};
				document.addEventListener('click', onClick, true);
			}),
		{ id: testId, windowMs: ms }
	);
	await page.getByTestId(testId).click();
	return seen;
}

test('a 150 ms wait paints no spinner; a 900 ms one paints at the grace and holds', async ({ page }) => {
	await open(page);
	expect(await spinnerAfterClick(page, 'busy-short', 800)).toEqual([]);

	// ONE continuous span, from the grace to the wait's end: any second span is the spinner leaving and coming back.
	const seen = await spinnerAfterClick(page, 'busy-long', 1_800);
	expect(seen, 'spans the spinner was up (ms after the click)').toHaveLength(1);
	const [first, last] = seen[0]!;
	expect(first).toBeGreaterThanOrEqual(PENDING_GRACE_MS - 20);
	expect(last - first).toBeGreaterThanOrEqual(PENDING_GRACE_MS - 20);
	// It goes when the wait ends (900 ms), not a hold later.
	expect(last).toBeLessThan(900 + 200);
});

const checked = (where: Locator) => where.getByRole('radio', { checked: true }).allTextContents();
/** Which segments are in the tab order, as their labels. */
const tabStops = (where: Locator) =>
	where.getByRole('radio').evaluateAll((rs) => rs.filter((r) => r.tabIndex === 0).map((r) => r.textContent));

test('a Guide tap checks its segment in the next frame; a dropped send keeps the old one, a custom level the nearest', async ({
	page
}) => {
	await open(page);
	const plain = page.getByTestId('guide-plain');
	await expect(plain.getByRole('radiogroup', { name: 'Guide' })).toBeVisible();
	expect(await checked(plain)).toEqual(['Off']);
	const ms = await plain.getByRole('radio', { name: 'Low' }).evaluate(
		(b) =>
			new Promise<number>((resolve) => {
				const t0 = performance.now();
				b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
				const tick = () =>
					b.getAttribute('aria-checked') === 'true' ? resolve(performance.now() - t0) : requestAnimationFrame(tick);
				tick();
			})
	);
	expect(ms).toBeLessThanOrEqual(100);
	expect(await checked(plain)).toEqual(['Low']);

	const dropped = page.getByTestId('guide-dropped');
	await dropped.getByRole('radio', { name: 'Full' }).click();
	expect(await checked(dropped)).toEqual(['Low']);
	const custom = page.getByTestId('guide-custom');
	// A level between presets (60%) shows the nearest one checked, so the control never reads as unset (#1295 review),
	// and that one is the group's tab stop.
	expect(await checked(custom)).toEqual(['Low']);
	expect(await tabStops(custom)).toEqual(['Low']);

	for (const box of await plain.getByRole('radio').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect())))
		expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
});

test('the Guide radio group is one tab stop, and arrows, Home and End move and select', async ({ page }) => {
	await open(page);
	const plain = page.getByTestId('guide-plain');
	expect(await tabStops(plain)).toEqual(['Off']);
	await page.getByTestId('guide-dropped').getByRole('radio', { name: 'Low' }).focus();
	// Shift+Tab from the next group lands on this group's checked segment, never on the other two.
	await page.keyboard.press('Shift+Tab');
	await expect(plain.getByRole('radio', { name: 'Off' })).toBeFocused();
	const step = async (key: string, want: string) => {
		await page.keyboard.press(key);
		await expect(plain.getByRole('radio', { name: want })).toBeFocused();
		expect(await checked(plain)).toEqual([want]);
		expect(await tabStops(plain)).toEqual([want]);
	};
	await step('ArrowRight', 'Low');
	await step('ArrowDown', 'Full');
	await step('ArrowRight', 'Off'); // wraps
	await step('ArrowLeft', 'Full'); // wraps back
	await step('ArrowUp', 'Low');
	await step('Home', 'Off');
	await step('End', 'Full');
});

test('a pick the room leaves unchanged drops back to the truth', async ({ page }) => {
	await open(page);
	const unchanged = page.getByTestId('guide-unchanged');
	await unchanged.getByRole('radio', { name: 'Full' }).click();
	expect(await checked(unchanged)).toEqual(['Full']);
	await expect.poll(() => checked(unchanged), { timeout: 5_000 }).toEqual(['Off']);
});

test('a focused segment on a lit card rings in on_fill, keeps its pill, and clears 3:1', async ({ page }) => {
	await open(page);
	const seg = page.getByTestId('spot-on-deck').getByRole('radio', { name: 'Low' });
	await seg.focus();
	await page.keyboard.press('ArrowLeft'); // a keyboard focus, so :focus-visible matches
	const ring = await page.evaluate(() => {
		const el = document.activeElement as HTMLElement;
		const rgb = (c: string) => {
			const ctx = document.createElement('canvas').getContext('2d')!;
			ctx.fillStyle = c;
			return ctx.fillStyle as string;
		};
		const card = el.closest('.spotlight')!;
		return {
			outline: rgb(getComputedStyle(el).outlineColor),
			width: getComputedStyle(el).outlineWidth,
			fill: rgb(getComputedStyle(card.querySelector('.fill')!).backgroundColor),
			ink: rgb(getComputedStyle(card).color),
			radius: getComputedStyle(el).borderTopLeftRadius
		};
	});
	expect(ring.width).toBe('2px');
	expect(ring.outline).toBe(ring.ink);
	expect(contrastRatio(ring.outline, ring.fill)).toBeGreaterThanOrEqual(3);
	expect(ring.radius).toBe('999px');
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
