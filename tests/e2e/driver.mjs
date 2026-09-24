/*
 * The e2e browser driver, backed by Playwright. Every flow imports `{ connect, sleep }` from here.
 * See docs/E2E.md#the-driver.
 */

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { findChromium } from './lib/chromium.mjs';

const DEFAULT_TIMEOUT = 10_000;

/**
 * Start a browser and return the driver. It LAUNCHES rather than attaching, and grants no
 * `--autoplay-policy`: docs/E2E.md#the-driver and docs/E2E.md#autoplay say why neither is negotiable.
 * @param {{ args?: string[] }} [opts] extra Chromium flags, for a flow whose FLAGS ARE THE EXPERIMENT
 */
export async function connect(opts = {}) {
	const executablePath = findChromium();
	if (!executablePath) {
		throw new Error('No Chromium found. Set PW_CHROMIUM, or run `npx playwright install chromium`.');
	}
	const browser = await chromium.launch({
		headless: true,
		executablePath,
		args: ['--no-sandbox', '--disable-gpu', ...(opts.args ?? [])]
	});
	return browserApi(browser);
}

/** @param {import('@playwright/test').Browser} browser */
function browserApi(browser) {
	return {
		/**
		 * One context per guest — own cookie jar, and `initScript` runs before the app's own scripts on
		 * every navigation. See docs/E2E.md#the-driver.
		 * @param {{ initScript?: string | null }} [opts]
		 */
		async newPage({ initScript = null } = {}) {
			const context = await browser.newContext({ viewport: null });
			if (initScript) await context.addInitScript({ content: initScript });
			const page = await context.newPage();
			return wrap(page, context);
		},
		close: () => browser.close()
	};
}

/**
 * Present a Playwright `Page` through the surface the suite drives.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').BrowserContext} context
 */
function wrap(page, context) {
	/** @param {string} expression */
	const evaluate = (expression) => page.evaluate(`(() => (${expression}))()`);

	return {
		evaluate: (/** @type {string} */ expression) => page.evaluate(expression),

		/** @param {string} url */
		async goto(url) {
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });
			// `waitUntil` describes the document; the app hydrates and only THEN opens its WebSocket.
			await this.waitFor('document.readyState === "complete"');
		},

		/**
		 * Poll an in-page expression until truthy. Returns its value; throws with the source on timeout.
		 * @param {string} expression
		 * @param {{ timeout?: number, every?: number }} [opts]
		 */
		async waitFor(expression, { timeout = DEFAULT_TIMEOUT, every = 100 } = {}) {
			try {
				const handle = await page.waitForFunction(`(() => (${expression}))()`, undefined, {
					timeout,
					polling: every
				});
				return await handle.jsonValue();
			} catch {
				// A bare Playwright timeout names the function source but not what it evaluated to.
				let last;
				try {
					last = await evaluate(expression);
				} catch (err) {
					last = String(err);
				}
				throw new Error(`waitFor timed out after ${timeout}ms: ${expression}\n  last value: ${JSON.stringify(last)}`);
			}
		},

		/** Waits for ACTIONABILITY, not mere existence. */
		async click(/** @type {string} */ selector) {
			await page.locator(selector).first().click({ timeout: DEFAULT_TIMEOUT });
		},

		/**
		 * `state: 'attached'` — in the DOM, NOT necessarily visible, so this gates nothing measured or
		 * tapped. @param {string} selector @param {{ timeout?: number }} [opts]
		 */
		async waitForSelector(selector, { timeout = DEFAULT_TIMEOUT } = {}) {
			await page.locator(selector).first().waitFor({ state: 'attached', timeout });
			return true;
		},

		/** Preferred over CSS: the labels ARE the contract. @param {string} role @param {string} name */
		async clickByRole(role, name) {
			await page
				.getByRole(/** @type {any} */ (role), { name })
				.first()
				.click({ timeout: DEFAULT_TIMEOUT });
		},

		/** @param {string} name */
		async clickByLabel(name) {
			await page.getByLabel(name).first().click({ timeout: DEFAULT_TIMEOUT });
		},

		/** Misses `Label <Icon/>` buttons silently; prefer `clickByRole`. @param {string} text */
		async clickByText(text) {
			await page.getByText(text).first().click({ timeout: DEFAULT_TIMEOUT });
		},

		/**
		 * `locator.fill` dispatches `input` natively for `bind:value`; `change` goes out too because a
		 * `<select>` and a range input listen for that one instead.
		 * @param {string} selector
		 * @param {string} value
		 */
		async fill(selector, value) {
			const el = page.locator(selector).first();
			await el.fill(value, { timeout: DEFAULT_TIMEOUT });
			await el.dispatchEvent('change');
		},

		/** @param {string} selector @param {number|string} value */
		async setRange(selector, value) {
			await this.fill(selector, String(value));
		},

		/** @param {number} width @param {number} height @param {number} [deviceScaleFactor] */
		async viewport(width, height, deviceScaleFactor = 2) {
			await page.setViewportSize({ width, height });
			void deviceScaleFactor; // context-level in Playwright; set at newContext when it matters
		},

		/**
		 * Headless resolves every `env(safe-area-inset-*)` to 0, so an arm comparing a `calc()` carrying
		 * the inset term against a bare px value needs this to be real. No Playwright API, so CDP.
		 * @param {{ top?: number, left?: number, bottom?: number, right?: number }} insets
		 */
		async safeAreaInsets(insets) {
			const cdp = await context.newCDPSession(page);
			await cdp.send(/** @type {any} */ ('Emulation.setSafeAreaInsetsOverride'), /** @type {any} */ ({ insets }));
			await cdp.detach();
		},

		/** @param {string} path @param {{ fullPage?: boolean }} [opts] */
		async screenshot(path, { fullPage = false } = {}) {
			mkdirSync(dirname(path), { recursive: true });
			await page.screenshot({ path, fullPage });
			return path;
		},

		/** @param {string} selector @param {string} key */
		async pressKey(selector, key) {
			await page.locator(selector).first().press(key, { timeout: DEFAULT_TIMEOUT });
		},

		/** A real mouse click, for hit-testing what is on top. @param {number} x @param {number} y */
		async realClick(x, y) {
			await page.mouse.click(x, y);
		},

		/**
		 * A pointer drag in STEPS — a teleport is not a gesture. See docs/E2E.md#gestures.
		 * @param {number} x1
		 * @param {number} y1
		 * @param {number} x2
		 * @param {number} y2
		 * @param {{ steps?: number, settle?: number }} [opts]
		 */
		async drag(x1, y1, x2, y2, { steps = 12, settle = 16 } = {}) {
			await page.mouse.move(x1, y1);
			await page.mouse.down();
			for (let i = 1; i <= steps; i += 1) {
				await page.mouse.move(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
				await sleep(settle);
			}
			await page.mouse.up();
		},

		/** Scoped to the CONTEXT, so one guest can drop while the others stay up. @param {boolean} offline */
		async setOffline(offline) {
			await context.setOffline(offline);
		},

		/**
		 * Stop the browser serving a URL pattern from its HTTP cache. BOTH halves matter: `route.fetch()`
		 * makes a fresh request, and re-fulfilling with `no-store` keeps it out of the cache next time.
		 * @param {string} pattern a Playwright URL glob, e.g. '**\/media\/**'
		 */
		async bypassCacheFor(pattern) {
			await context.route(pattern, async (route) => {
				try {
					const response = await route.fetch();
					await route.fulfill({
						response,
						headers: { ...response.headers(), 'cache-control': 'no-store' }
					});
				} catch {
					// An un-refetchable route (aborted navigation, closed page) must not wedge the page.
					await route.fallback();
				}
			});
		},

		close: () => context.close(),

		// Query helpers. The locator-backed three re-query per call, so a count taken mid-render waits
		// for the list instead of catching it half-built. `css` stays an `evaluate`: a COMPUTED style is
		// a browser calculation with no locator equivalent.

		/** @param {string} selector */
		count: (selector) => page.locator(selector).count(),

		/** @param {string} selector */
		texts: async (selector) => (await page.locator(selector).allTextContents()).map((t) => t.trim()),

		/** '' when absent, so "the badge is gone" is an assertion and not an exception. @param {string} selector */
		text: async (selector) => {
			const el = page.locator(selector).first();
			return (await el.count()) === 0 ? '' : ((await el.textContent()) ?? '').trim();
		},

		/** @param {string} selector @param {string} prop */
		css: (selector, prop) =>
			page.evaluate(
				([sel, p]) => {
					const el = document.querySelector(/** @type {string} */ (sel));
					return el ? getComputedStyle(el).getPropertyValue(/** @type {string} */ (p)) : null;
				},
				[selector, prop]
			),

		raw: page
	};
}

export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
