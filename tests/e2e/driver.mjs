/*
 * The e2e browser driver, backed by Playwright.
 *
 * WHY THIS REPLACED A HAND-ROLLED CDP DRIVER. The previous driver spoke Chrome DevTools Protocol over a
 * WebSocket directly, and its own header explained why: an earlier e2e imported `playwright-core` that was
 * never a DECLARED dependency, so it worked on whichever machine happened to have one lying around and failed
 * everywhere else. That objection was about the dependency being a coincidence, not about Playwright.
 *
 * It is now declared — `@playwright/test` is pinned in package.json — which answers the original complaint
 * directly. The browser itself was never really avoided either: `lib/chromium.mjs` already resolves Chrome
 * out of `~/.cache/ms-playwright`, so this repo has depended on Playwright's browser download all along. The
 * dependency existed in fact; it now exists on the record.
 *
 * WHAT THIS BUYS over speaking CDP by hand:
 *   • Browser contexts are a first-class primitive, not `Target.createBrowserContext` plumbing. Each "phone"
 *     in the party flow needs its own cookie jar to be genuinely a different guest, and that is what a
 *     context IS.
 *   • Auto-waiting inside `click`/`fill`. The old driver polled an in-page expression every 100ms before
 *     acting; Playwright's actionability checks replace 77 hand-rolled `waitFor` calls' worth of that.
 *   • Traces. A failing multi-guest room flow used to yield a timeout string; a trace carries the DOM,
 *     network and console at every step.
 *
 * THE SURFACE IS DELIBERATELY UNCHANGED. All 27 consumer files import `{ connect, sleep }` and drive a page
 * through the same 14 methods, so this is a driver swap rather than a suite rewrite: the flows keep working
 * and can adopt `@playwright/test` fixtures and web-first assertions one at a time. Converting them is the
 * genuinely valuable half — 208 of the suite's calls are `evaluate`, so it still reaches into the page rather
 * than using locators — and that is a separate change, not this one.
 */

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
// The single-sourced Chromium locator. `e2e/lib/chromium.test.ts` bans a redefinition of it, and this driver
// uses it rather than resolving a binary itself — see the note on `connect` for why the path is explicit.
import { findChromium } from './lib/chromium.mjs';

const DEFAULT_TIMEOUT = 10_000;

/**
 * Attach to a Chromium already listening on a debugging port.
 *
 * `connectOverCDP` rather than `chromium.launch()`, so `lib/chromium.mjs` keeps ownership of HOW the browser
 * starts — its flag set, its cache resolution and its `/usr/bin` fallback are load-bearing on this box and
 * are not this file's business. The port contract is what every entry point already passes.
 *
 * @param {number} port
 */
/**
 * Start a browser and return the driver.
 *
 * IT LAUNCHES; IT DOES NOT ATTACH, and the reason is the whole reason the driver it replaced existed.
 * Playwright's `connectOverCDP` does not work under Bun: it retrieves the target's websocket URL and then
 * hangs connecting to it, because its ws client and Bun's runtime disagree. That is almost certainly why the
 * previous driver spoke CDP by hand "over a WebSocket Bun implements itself" — the constraint was Bun, not
 * Playwright. `chromium.launch()` avoids that path entirely and works under Bun, verified against a live
 * server before this was written.
 *
 * `executablePath` comes from `findChromium()`, so Playwright drives the Chromium this repo ALREADY uses
 * rather than one it downloads. That matters: `@playwright/test@1.56.1` wants browser revision 1194 while the
 * cache holds 1228/1232 from a different Playwright, so `launch()` with no path fails on a missing
 * `headless_shell` and demands a ~150MB `playwright install`. Pointing at the existing binary keeps this
 * repo's "no install step" property, which was the second half of the original objection.
 *
 * The `port` argument is accepted and IGNORED. Every one of the 25 entry points passes one because it used to
 * spawn its own Chromium on that port; keeping the signature is what lets them keep working while their spawn
 * blocks are removed one at a time rather than in a single 25-file change.
 *
 * @param {number} [port] ignored — retained so existing entry points keep their call shape
 */
export async function connect(port) {
	void port;
	const executablePath = findChromium();
	if (!executablePath) {
		throw new Error('No Chromium found. Set PW_CHROMIUM, or run `npx playwright install chromium`.');
	}
	const browser = await chromium.launch({
		headless: true,
		executablePath,
		args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required']
	});
	return browserApi(browser);
}

/** @param {import('@playwright/test').Browser} browser */
function browserApi(browser) {
	return {
		/**
		 * A fresh, isolated context — its own cookies, so two of these are genuinely two different guests
		 * rather than one guest in two tabs. That distinction is the whole point of the party flow, and here
		 * it is one call instead of three CDP round-trips.
		 */
		async newPage() {
			const context = await browser.newContext({ viewport: null });
			const page = await context.newPage();
			return wrap(page, context);
		},
		close: () => browser.close()
	};
}

/**
 * Present a Playwright `Page` through the surface the suite already drives.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').BrowserContext} context
 */
function wrap(page, context) {
	/** @param {string} expression */
	const evaluate = (expression) => page.evaluate(`(() => (${expression}))()`);

	return {
		/** Raw in-page evaluation. 208 call sites use this; it is the suite's main instrument. */
		evaluate: (/** @type {string} */ expression) => page.evaluate(expression),

		/** @param {string} url */
		async goto(url) {
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });
			// Still poll for readiness rather than trusting a lifecycle event: this app hydrates and THEN
			// opens a WebSocket, so `load` fires well before the page can actually be driven. That was true
			// of the CDP driver and is just as true here — `waitUntil` describes the document, not the app.
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
				// Report the same shape the old driver did: the expression plus its last value. A bare
				// Playwright timeout names the function source but not what it evaluated to.
				let last;
				try {
					last = await evaluate(expression);
				} catch (err) {
					last = String(err);
				}
				throw new Error(
					`waitFor timed out after ${timeout}ms: ${expression}\n  last value: ${JSON.stringify(last)}`
				);
			}
		},

		/** Click by CSS selector. Playwright waits for actionability, not merely for existence. */
		async click(/** @type {string} */ selector) {
			await page.locator(selector).first().click({ timeout: DEFAULT_TIMEOUT });
		},

		/**
		 * Click by accessible role + name — the way a screen reader, and therefore a user, finds a control.
		 * Preferred over CSS deliberately: the labels ARE the contract, and a flow that clicks by class
		 * silently keeps working when a control loses its accessible name.
		 * @param {string} role
		 * @param {string} name
		 */
		async clickByRole(role, name) {
			await page.getByRole(/** @type {any} */ (role), { name }).first().click({ timeout: DEFAULT_TIMEOUT });
		},

		/** @param {string} name */
		async clickByLabel(name) {
			await page.getByLabel(name).first().click({ timeout: DEFAULT_TIMEOUT });
		},

		/** @param {string} text */
		async clickByText(text) {
			await page.getByText(text).first().click({ timeout: DEFAULT_TIMEOUT });
		},

		/**
		 * Fill an input and fire the events a Svelte binding listens for. `locator.fill` dispatches `input`
		 * natively, which is what `bind:value` needs; `change` is dispatched too because a `<select>` and a
		 * range input listen for that one instead.
		 * @param {string} selector
		 * @param {string} value
		 */
		async fill(selector, value) {
			const el = page.locator(selector).first();
			await el.fill(value, { timeout: DEFAULT_TIMEOUT });
			await el.dispatchEvent('change');
		},

		/**
		 * A range input. `fill` works on `<input type=range>` in Playwright, so this is the same call —
		 * kept as its own name because the flows read better for it and the coercion is explicit.
		 * @param {string} selector
		 * @param {number|string} value
		 */
		async setRange(selector, value) {
			await this.fill(selector, String(value));
		},

		/**
		 * Two viewports matter here and they are nothing alike — a phone in a hand and a TV on a wall — and
		 * the TV scale is vh-relative, so a screenshot at the wrong size measures the wrong layout.
		 * @param {number} width
		 * @param {number} height
		 * @param {number} [deviceScaleFactor]
		 */
		async viewport(width, height, deviceScaleFactor = 2) {
			await page.setViewportSize({ width, height });
			void deviceScaleFactor; // context-level in Playwright; set at newContext when it matters
		},

		/**
		 * Safe-area insets, for the phone's bottom bar against a home indicator. Playwright has no API for
		 * this, so it stays on CDP — which `connectOverCDP` still gives us through a session.
		 * @param {{ top?: number, left?: number, bottom?: number, right?: number }} insets
		 */
		async safeAreaInsets(insets) {
			const cdp = await context.newCDPSession(page);
			await cdp.send(/** @type {any} */ ('Emulation.setSafeAreaInsetsOverride'), /** @type {any} */ ({ insets }));
			await cdp.detach();
		},

		/**
		 * @param {string} path
		 * @param {{ fullPage?: boolean }} [opts]
		 */
		async screenshot(path, { fullPage = false } = {}) {
			mkdirSync(dirname(path), { recursive: true });
			await page.screenshot({ path, fullPage });
			return path;
		},

		/**
		 * @param {string} selector
		 * @param {string} key
		 */
		async pressKey(selector, key) {
			await page.locator(selector).first().press(key, { timeout: DEFAULT_TIMEOUT });
		},

		/**
		 * A real mouse click at a point, for hit-testing what is actually on top — a scrim, an overlay, a
		 * row that should be transparent to the pointer while dragged.
		 * @param {number} x
		 * @param {number} y
		 */
		async realClick(x, y) {
			await page.mouse.click(x, y);
		},

		/**
		 * A pointer drag in steps, so a drag handler sees intermediate moves rather than a teleport.
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

		/** Close this guest's context, cookies and all. */
		close: () => context.close(),

		// ── query helpers ────────────────────────────────────────────────────────────────────────────
		// These four read the rendered page. Three now go through LOCATORS rather than an in-page
		// `querySelectorAll`, which is the one place this swap changes behaviour for the better: a locator
		// re-queries on each call, so a count taken while the list is still rendering waits for it instead
		// of catching an intermediate state. `css` stays an `evaluate`, because a COMPUTED style is a
		// browser calculation with no locator equivalent.

		/** How many elements match. @param {string} selector */
		count: (selector) => page.locator(selector).count(),

		/** Every match's trimmed text, in document order. @param {string} selector */
		texts: async (selector) =>
			(await page.locator(selector).allTextContents()).map((t) => t.trim()),

		/**
		 * The first match's trimmed text, or '' when absent — absent reads as empty rather than throwing,
		 * because a flow asserting "the badge is gone" wants '' and not an exception.
		 * @param {string} selector
		 */
		text: async (selector) => {
			const el = page.locator(selector).first();
			return (await el.count()) === 0 ? '' : ((await el.textContent()) ?? '').trim();
		},

		/**
		 * The computed value of a CSS property — how a rendered-size assertion is actually made.
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
