/*
 * A minimal Chrome DevTools Protocol driver — enough to drive a real browser, and nothing more.
 *
 * WHY NOT PLAYWRIGHT. The previous e2e imported `playwright-core`, which was never a declared
 * dependency of this package: it worked on whichever machine happened to have one lying around and
 * failed everywhere else, which is part of why nobody ran it and it was free to rot. The only
 * playwright-core on this box belongs to a separate toolbox install, and a repo reaching into another
 * tool's node_modules is not a dependency, it is a coincidence.
 *
 * CDP is spoken natively by the Chromium that is already cached for screenshots, over a WebSocket Bun
 * implements itself. So this file adds no install step, no lockfile entry, and no version to drift.
 *
 * Scope is deliberately tiny: create isolated browser contexts (each "phone" needs its own cookie jar
 * for its own session), navigate, evaluate, and poll for a condition. Everything the flow does is
 * expressible as those four.
 */

import { writeFileSync } from 'node:fs';

const DEFAULT_TIMEOUT = 10_000;

/**
 * Connect to a Chromium already listening on a debugging port.
 * @param {number} port
 */
export async function connect(port) {
	const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
	const ws = new WebSocket(version.webSocketDebuggerUrl);
	const pending = new Map();
	let nextId = 1;

	await new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', () => reject(new Error('could not open the CDP socket')), {
			once: true
		});
	});

	ws.addEventListener('message', (/** @type {MessageEvent} */ ev) => {
		const msg = JSON.parse(ev.data);
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? {})})`));
			else resolve(msg.result);
		}
	});

	/**
	 * @param {string} method
	 * @param {Record<string, unknown>} [params]
	 * @param {string} [sessionId]
	 * @returns {Promise<any>} the raw CDP result (protocol-shaped; not modelled here)
	 */
	function send(method, params = {}, sessionId) {
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
			setTimeout(() => {
				if (pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
			}, DEFAULT_TIMEOUT);
		});
	}

	return {
		/**
		 * A fresh, isolated context — its own cookies, so two of these are genuinely two different
		 * guests rather than one guest in two tabs. That distinction is the whole point of the flow.
		 */
		async newPage() {
			const { browserContextId } = await send('Target.createBrowserContext');
			const { targetId } = await send('Target.createTarget', {
				url: 'about:blank',
				browserContextId
			});
			const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
			await send('Page.enable', {}, sessionId);
			await send('Runtime.enable', {}, sessionId);
			return makePage(send, sessionId);
		},
		close: () => ws.close()
	};
}

/**
 * @param {(method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>} send
 * @param {string} sessionId
 */
function makePage(send, sessionId) {
	const evaluate = async (/** @type {string} */ expression) => {
		const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
		if (res.exceptionDetails) {
			throw new Error(`in-page error: ${res.exceptionDetails.exception?.description ?? 'unknown'}`);
		}
		return res.result?.value;
	};

	return {
		evaluate,

		/** @param {string} url */
		async goto(url) {
			await send('Page.navigate', { url }, sessionId);
			// Poll for readiness rather than trusting a lifecycle event: this app hydrates and then opens
			// a WebSocket, so "load" fires well before the page can actually be driven.
			await this.waitFor('document.readyState === "complete"');
		},

		/** Poll an in-page expression until truthy. Returns its value; throws with the source on timeout. */
		/**
		 * @param {string} expression
		 * @param {{ timeout?: number, every?: number }} [opts]
		 */
		async waitFor(expression, { timeout = DEFAULT_TIMEOUT, every = 100 } = {}) {
			const deadline = Date.now() + timeout;
			let last;
			while (Date.now() < deadline) {
				try {
					last = await evaluate(`(() => (${expression}))()`);
					if (last) return last;
				} catch (err) {
					last = String(err);
				}
				await sleep(every);
			}
			throw new Error(`waitFor timed out after ${timeout}ms: ${expression}\n  last value: ${JSON.stringify(last)}`);
		},

		/** Click by CSS selector, after waiting for it to exist. */
		/** @param {string} selector */
		async click(selector) {
			await this.waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`);
			await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
		},

		/**
		 * Click by accessible role + name — the same way a screen reader, and therefore a user, finds a
		 * control. Preferring this over CSS is deliberate: the labels ARE the contract, and a flow that
		 * clicks by class silently keeps working when a control loses its accessible name.
		 */
		/** @param {string} name */
		async clickByLabel(name) {
			const sel = `[aria-label=${JSON.stringify(name)}]`;
			await this.waitFor(`document.querySelector(${JSON.stringify(sel)}) !== null`);
			await evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
		},

		/** Click the first button whose visible text matches. */
		/** @param {string} text */
		async clickByText(text) {
			const expr = `[...document.querySelectorAll('button,a')].find(el => el.textContent.trim().includes(${JSON.stringify(text)}))`;
			await this.waitFor(`${expr} != null`);
			await evaluate(`${expr}.click()`);
		},

		/** Set a field's value the way a user would — the input event is what the framework listens to. */
		/**
		 * @param {string} selector
		 * @param {string} value
		 */
		async fill(selector, value) {
			await this.waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`);
			await evaluate(`(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				el.focus();
				el.value = ${JSON.stringify(value)};
				el.dispatchEvent(new Event('input', { bubbles: true }));
				el.dispatchEvent(new Event('change', { bubbles: true }));
			})()`);
		},

		/** Drag a range input to a value, firing the same events a real drag would. */
		/**
		 * @param {string} selector
		 * @param {number | string} value
		 */
		async setRange(selector, value) {
			await this.fill(selector, String(value));
		},

		/**
		 * Emulate a device viewport. Needed because the same build must be judged at two very different
		 * sizes — a phone in a hand and a TV on a wall — and the TV scale is vh-relative, so a screenshot
		 * taken at the wrong height is measuring the wrong design.
		 */
		/**
		 * @param {number} width
		 * @param {number} height
		 * @param {number} [deviceScaleFactor]
		 */
		async viewport(width, height, deviceScaleFactor = 2) {
			await send(
				'Emulation.setDeviceMetricsOverride',
				{ width, height, deviceScaleFactor, mobile: width < 700 },
				sessionId
			);
		},

		/** PNG to disk. Returns the path, so a caller can hand it straight to a reader. */
		/**
		 * @param {string} path
		 * @param {{ fullPage?: boolean }} [opts]
		 */
		async screenshot(path, { fullPage = false } = {}) {
			const { data } = await send(
				'Page.captureScreenshot',
				{ format: 'png', captureBeyondViewport: fullPage },
				sessionId
			);
			writeFileSync(path, Buffer.from(data, 'base64'));
			return path;
		},

		/**
		 * Dispatch a real keydown at an element. Needed for controls that are keyboard- and
		 * pointer-driven rather than click-driven: the queue sheet's peek is a div with role=button and
		 * pointer/keydown handlers, so `.click()` on it does precisely nothing and fails silently.
		 */
		/**
		 * @param {string} selector
		 * @param {string} key
		 */
		async pressKey(selector, key) {
			await this.waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`);
			await evaluate(`(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				el.focus?.();
				el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
			})()`);
		},

		/**
		 * Deliver a REAL user gesture — a trusted mousePressed/mouseReleased pair through the CDP Input
		 * domain, at raw viewport coordinates. This is not a nicety over `click()`: a scripted
		 * `HTMLElement.click()` dispatches an UNTRUSTED event and grants NO user activation, so it can
		 * never unblock autoplay. The /tv tap-to-start affordance (#64) is the only route out of a
		 * silent television, and it can only be exercised by input the browser trusts. Phone controls
		 * need no activation, so `click()` stays correct and cheaper for them; only the TV's gesture
		 * path needs this. Coordinates are viewport pixels (e.g. 960,540 = centre of a 1920×1080 TV).
		 */
		/**
		 * @param {number} x
		 * @param {number} y
		 */
		async realClick(x, y) {
			await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
			await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
		},

		count: (/** @type {string} */ selector) =>
			evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`),
		texts: (/** @type {string} */ selector) =>
			evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map(e => e.textContent.trim())`),
		text: (/** @type {string} */ selector) =>
			evaluate(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').trim()`),
		/** The computed value of a CSS property — how a rendered-size assertion is actually made. */
		css: (/** @type {string} */ selector, /** @type {string} */ prop) =>
			evaluate(`(() => {
				const el = document.querySelector(${JSON.stringify(selector)});
				return el ? getComputedStyle(el).getPropertyValue(${JSON.stringify(prop)}) : null;
			})()`)
	};
}

/**
 * @param {string} url
 * @param {number} [tries]
 */
async function fetchJson(url, tries = 40) {
	for (let i = 0; i < tries; i++) {
		try {
			const res = await fetch(url);
			if (res.ok) return await res.json();
		} catch {
			// the browser may not be listening yet
		}
		await sleep(250);
	}
	throw new Error(`no CDP endpoint at ${url} — is Chromium running with --remote-debugging-port?`);
}

export const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
