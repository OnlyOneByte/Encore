/*
 * The e2e browser driver, backed by Playwright. Every flow imports `{ connect, sleep }` from here and drives
 * a page through the surface below. See docs/E2E.md#the-driver.
 */

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
// The single-sourced Chromium locator; `tests/guards/hygiene/chromium.test.ts` bans a second copy.
import { findChromium } from './lib/chromium.mjs';

const DEFAULT_TIMEOUT = 10_000;

/**
 * Start a browser and return the driver.
 *
 * IT LAUNCHES; IT DOES NOT ATTACH. `connectOverCDP` hangs under Bun — it fetches the target's websocket URL
 * and then stalls connecting to it, because its ws client and Bun's runtime disagree.
 *
 * `executablePath` comes from `findChromium()` so Playwright drives the Chromium this repo already has: with
 * no path, `launch()` fails on a missing `headless_shell` and demands a ~150MB `playwright install`, because
 * the pinned Playwright wants a browser revision this box's cache does not hold.
 *
 * @param {{ args?: string[] }} [opts] extra Chromium flags, for a flow whose FLAGS ARE THE EXPERIMENT
 */
export async function connect(opts = {}) {
	const executablePath = findChromium();
	if (!executablePath) {
		throw new Error('No Chromium found. Set PW_CHROMIUM, or run `npx playwright install chromium`.');
	}
	// NO `--autoplay-policy` BY DEFAULT: granting it here would make the gestureless half of every
	// television experiment unrunnable while still reporting a pass. See docs/E2E.md#autoplay.
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
		 * A fresh, isolated context — its own cookies, so two of these are genuinely two different guests
		 * rather than one guest in two tabs. `initScript` runs on EVERY navigation of this context BEFORE
		 * the app's own scripts, which is the only way in early enough to wrap a WebSocket the app opens
		 * during hydration.
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
		/** Raw in-page evaluation — the suite's main instrument. */
		evaluate: (/** @type {string} */ expression) => page.evaluate(expression),

		/** @param {string} url */
		async goto(url) {
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });
			// Poll for readiness rather than trusting a lifecycle event: the app hydrates and THEN opens a
			// WebSocket, so `load` fires well before the page can be driven — `waitUntil` describes the
			// document, not the app.
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
				// Report the expression AND its last value: a bare Playwright timeout names the function
				// source but not what it evaluated to.
				let last;
				try {
					last = await evaluate(expression);
				} catch (err) {
					last = String(err);
				}
				throw new Error(`waitFor timed out after ${timeout}ms: ${expression}\n  last value: ${JSON.stringify(last)}`);
			}
		},

		/** Click by CSS selector. Playwright waits for actionability, not merely for existence. */
		async click(/** @type {string} */ selector) {
			await page.locator(selector).first().click({ timeout: DEFAULT_TIMEOUT });
		},

		/**
		 * Wait for an element to EXIST. `state: 'attached'` — present in the DOM, NOT necessarily
		 * visible, so this is no gate for anything measured or tapped.
		 * @param {string} selector
		 * @param {{ timeout?: number }} [opts]
		 */
		async waitForSelector(selector, { timeout = DEFAULT_TIMEOUT } = {}) {
			await page.locator(selector).first().waitFor({ state: 'attached', timeout });
			return true;
		},

		/**
		 * Click by accessible role + name — preferred over CSS, because the labels ARE the contract and a
		 * flow that clicks by class keeps working after a control loses its accessible name.
		 * @param {string} role
		 * @param {string} name
		 */
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

		/** Resolves the inner TEXT NODE, so it misses a button whose content is `Label <Icon/>`: the click
		 *  lands on nothing, nothing errors, and every downstream wait then times out on a selector that
		 *  is perfectly current. Prefer `clickByRole`. @param {string} text */
		async clickByText(text) {
			await page.getByText(text).first().click({ timeout: DEFAULT_TIMEOUT });
		},

		/**
		 * Fill an input and fire the events a Svelte binding listens for: `locator.fill` dispatches `input`
		 * natively for `bind:value`, and `change` too, because a `<select>` and a range input listen for
		 * that one instead.
		 * @param {string} selector
		 * @param {string} value
		 */
		async fill(selector, value) {
			const el = page.locator(selector).first();
			await el.fill(value, { timeout: DEFAULT_TIMEOUT });
			await el.dispatchEvent('change');
		},

		/**
		 * A range input — the same call as `fill`, named separately so the coercion is explicit.
		 * @param {string} selector
		 * @param {number|string} value
		 */
		async setRange(selector, value) {
			await this.fill(selector, String(value));
		},

		/**
		 * The TV's type scale is vh-relative, so a frame taken at the wrong size measures a different
		 * design: shoot the wall at 1920x1080, the phone at a phone size.
		 * @param {number} width
		 * @param {number} height
		 * @param {number} [deviceScaleFactor]
		 */
		async viewport(width, height, deviceScaleFactor = 2) {
			await page.setViewportSize({ width, height });
			void deviceScaleFactor; // context-level in Playwright; set at newContext when it matters
		},

		/**
		 * Safe-area insets, for the phone's bottom bar against a home indicator. Headless resolves every
		 * `env(safe-area-inset-*)` to 0, so without this an arm comparing a `calc()` carrying the inset
		 * term against a bare px value measures the two identically and proves nothing. No Playwright API,
		 * so it stays on CDP.
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

		/**
		 * A real mouse click at a point, for hit-testing what is actually on top — a scrim, an overlay, a
		 * row that should be transparent to the pointer while dragged. See docs/E2E.md#gestures.
		 * @param {number} x
		 * @param {number} y
		 */
		async realClick(x, y) {
			await page.mouse.click(x, y);
		},

		/**
		 * A pointer drag in STEPS, so a drag handler sees intermediate moves rather than a teleport. A
		 * synthetic click, or a single move, is not a gesture. See docs/E2E.md#gestures.
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

		/**
		 * Take this guest's context offline, and bring it back. Scoped to the CONTEXT, so one guest can
		 * drop while the others stay up — which is the whole subject of a presence probe.
		 * @param {boolean} offline
		 */
		async setOffline(offline) {
			await context.setOffline(offline);
		},

		/**
		 * Stop the browser serving a URL pattern from its HTTP cache. `/media` replies
		 * `Cache-Control: public, max-age=86400`, so a probe that overwrites an artifact and re-tests reads
		 * yesterday's copy and passes on a file that is no longer there. BOTH halves matter:
		 * `route.fetch()` makes a fresh request, and re-fulfilling with `no-store` keeps it out of the
		 * cache next time.
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
					// A route that cannot be re-fetched (aborted navigation, closed page) must not wedge the page:
					// fall through rather than leaving the request hanging.
					await route.fallback();
				}
			});
		},

		/** Close this guest's context, cookies and all. */
		close: () => context.close(),

		// Query helpers. Three go through LOCATORS, which re-query per call, so a count taken while a list
		// is still rendering waits for it instead of catching an intermediate state. `css` stays an
		// `evaluate`: a COMPUTED style is a browser calculation with no locator equivalent.

		/** How many elements match. @param {string} selector */
		count: (selector) => page.locator(selector).count(),

		/** Every match's trimmed text, in document order. @param {string} selector */
		texts: async (selector) => (await page.locator(selector).allTextContents()).map((t) => t.trim()),

		/**
		 * The first match's trimmed text, or '' when absent — a flow asserting "the badge is gone" wants ''
		 * and not an exception.
		 * @param {string} selector
		 */
		text: async (selector) => {
			const el = page.locator(selector).first();
			return (await el.count()) === 0 ? '' : ((await el.textContent()) ?? '').trim();
		},

		/**
		 * The computed value of a CSS property — how a rendered-size assertion is made.
		 * @param {string} selector
		 * @param {string} prop
		 */
		css: (selector, prop) =>
			page.evaluate(
				([sel, p]) => {
					const el = document.querySelector(/** @type {string} */ (sel));
					return el ? getComputedStyle(el).getPropertyValue(/** @type {string} */ (p)) : null;
				},
				[selector, prop]
			),

		/** The underlying Playwright page, for a flow that wants locators or a trace directly. */
		raw: page
	};
}

export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
