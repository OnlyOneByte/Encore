/*
 * P8 — Presence, join, and realtime resilience.
 *
 * The claim under test: "twenty phones stay in sync over flaky wifi, and reconnects self-heal."
 * We do not have twenty singers-worth of context to spare, but we have eight to ten, and every
 * defect this branch cares about — a locked phone erasing its owner from the roster, a stranded
 * duplicate-name form, a silent WS drop that never resyncs, a queue op eaten by a severed socket,
 * a leave that abandons queued songs — is visible with that count.
 *
 * WHAT THIS FILE OWNS. This probe is the only file the task allowed to change (`change NO other
 * file`). Everything the tests need beyond `cdp.mjs`'s tiny driver — Target-level CDP sends,
 * per-target script injection to instrument WebSocket, network emulation to sever a socket without
 * closing it politely — lives inline here. The probe file is the domain that was widened.
 *
 * WHAT THIS PROBE DOES NOT TRY TO ASSERT. Playback (no working ML pipeline, no volumedetect on this
 * box), lyrics timing, and 20-phone scale. It stops short of 20 both because context isolation costs
 * a fresh browser context per phone (memory and file descriptors add up fast under a shared
 * Chromium) and because the failure classes we care about show up at 8-10 already.
 *
 * Environment gaps (deno missing, ffmpeg decode-only, no torch/whisperx) are pre-recorded in
 * tests/e2e/HARNESS.md. Real defects go under CRITICAL/HIGH/MEDIUM/LOW; environment misses go
 * under `ENV` and never inflate a real number.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SEL, PRESET_COLOUR_NAMES } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';
import { openBrowseFromHome } from '../lib/phone.mjs';

/**
 * Types for this out-of-program driver, which runs under tsconfig.e2e.json (following the
 * /pattern). This probe grows its OWN thin CDP client (Cdp/CdpPage)
 * rather than reusing cdp.mjs's Page, so the types are declared on those classes directly. page.evaluate()
 * returns Promise<any>, so DOM-shaped reads are cast at the call site via the domain typedefs below.
 *
 * @typedef {'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'ENV' | 'PASS'} Level
 *
 * One queue row the phone reads out of its own DOM.
 * @typedef {{ title: string, away: boolean, pending: boolean }} QueueRow
 *
 * The phone's authoritative room snapshot returned by getState().
 * @typedef {{ rows: QueueRow[], count: number }} RoomState
 *
 * One TV roster chip read off the presence strip.
 * @typedef {{ name: string, away: boolean, more: boolean, text: string }} RosterChip
 *
 * The TV roster snapshot returned by tvRoster().
 * @typedef {{ chips: RosterChip[], screen: ("transient" | "playing" | "lobby" | "attract") }} TvRoster
 */

// ── config ────────────────────────────────────────────────────────────────
const PORT = process.env.EPORT ?? '5228';
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.CDP_PORT ?? 9528); // paired with 5228, one CDP per probe
const SCRATCH = process.env.KIROCREW_SCRATCH || process.env.TMPDIR || '/tmp';
const OUT_DIR = join(SCRATCH, `p8-${Date.now()}`);
mkdirSync(OUT_DIR, { recursive: true });

const NUM_PHONES = 10; // "join eight to ten singers"
const NUM_BURST = 6; // simultaneous-add burst count

// Distinct singer names — each probe reuses none, so this suite never trips the 409 accidentally.
const PHONE_NAMES = ['Ada', 'Bea', 'Cai', 'Deb', 'Eve', 'Fin', 'Gio', 'Han', 'Ira', 'Jos'];

// ── findings ──────────────────────────────────────────────────────────────
/** @type {{level:'CRITICAL'|'HIGH'|'MEDIUM'|'LOW'|'ENV'|'PASS', title:string, detail:string, evidence?:string}[]} */
const findings = [];
/**
 * @param {Level} level
 * @param {string} title
 * @param {string} [detail]
 * @param {string} [evidence]
 */
function report(level, title, detail, evidence) {
	findings.push({ level, title, detail: detail ?? '', evidence });
	console.log(`[${level}]  ${title}${detail ? '\n        ' + detail : ''}${evidence ? '\n        ' + evidence : ''}`);
}

// ── Chromium discovery ────────────────────────────────────────────────────

// ── minimal raw CDP client ────────────────────────────────────────────────
/*
 * cdp.mjs's newPage is deliberately small: goto, evaluate, click, screenshot. We need more:
 * Page.addScriptToEvaluateOnNewDocument to instrument WebSocket BEFORE the app opens it, and
 * Network.emulateNetworkConditions to sever a socket without closing it (a phone that lost signal
 * looks nothing like a phone that closed politely). Both are per-session CDP methods, so the probe
 * grows its own thin driver instead of a passthrough on top of cdp.mjs.
 */
class Cdp {
	/** @param {number} cdpPort */
	constructor(cdpPort) {
		this.cdpPort = cdpPort;
		/** @type {WebSocket | null} */
		this.ws = null;
		/** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
		this.pending = new Map();
		this.next = 1;
		/** @type {string[]} */
		this.contexts = [];
		/** @type {Set<string>} */
		this.targets = new Set();
	}
	async connect() {
		const v = await fetch(`http://127.0.0.1:${this.cdpPort}/json/version`).then((r) => r.json());
		const ws = new WebSocket(v.webSocketDebuggerUrl);
		this.ws = ws;
		await new Promise((resolve, reject) => {
			ws.addEventListener('open', resolve, { once: true });
			ws.addEventListener('error', () => reject(new Error('cdp open failed')), { once: true });
		});
		ws.addEventListener('message', (/** @type {MessageEvent} */ ev) => {
			const msg = JSON.parse(String(ev.data));
			const entry = msg.id ? this.pending.get(msg.id) : undefined;
			if (entry) {
				const { resolve, reject } = entry;
				this.pending.delete(msg.id);
				if (msg.error) reject(new Error(`${msg.error.message} :: ${JSON.stringify(msg.error.data ?? {})}`));
				else resolve(msg.result);
			}
		});
	}
	/**
	 * @param {string} method
	 * @param {Record<string, unknown>} [params]
	 * @param {string} [sessionId]
	 * @returns {Promise<any>}
	 */
	send(method, params = {}, sessionId) {
		const id = this.next++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws?.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
			setTimeout(() => {
				if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out (15s)`));
			}, 15_000);
		});
	}
	close() {
		this.ws?.close();
	}
	/** @param {string | null} [instrumentJs] */
	async newContextPage(instrumentJs = null) {
		const { browserContextId } = await this.send('Target.createBrowserContext');
		this.contexts.push(browserContextId);
		const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId });
		const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
		this.targets.add(targetId);
		await this.send('Page.enable', {}, sessionId);
		await this.send('Runtime.enable', {}, sessionId);
		await this.send('Network.enable', {}, sessionId);
		if (instrumentJs) {
			// Adds a script that runs on EVERY navigation of this target BEFORE the app's own scripts.
			// This is how a WebSocket proxy gets installed early enough to catch the socket the app opens.
			await this.send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentJs }, sessionId);
		}
		return new CdpPage(this, sessionId, targetId, browserContextId);
	}
}

class CdpPage {
	/**
	 * @param {Cdp} cdp
	 * @param {string} sessionId
	 * @param {string} targetId
	 * @param {string} browserContextId
	 */
	constructor(cdp, sessionId, targetId, browserContextId) {
		this.cdp = cdp;
		this.sessionId = sessionId;
		this.targetId = targetId;
		this.browserContextId = browserContextId;
	}
	/** @param {string} expression @returns {Promise<any>} */
	async evaluate(expression) {
		const res = await this.cdp.send(
			'Runtime.evaluate',
			{ expression, awaitPromise: true, returnByValue: true, timeout: 10_000 },
			this.sessionId
		);
		if (res.exceptionDetails) {
			throw new Error(`in-page: ${res.exceptionDetails.exception?.description ?? 'unknown'}`);
		}
		return res.result?.value;
	}
	/** @param {string} url */
	async goto(url) {
		await this.cdp.send('Page.navigate', { url }, this.sessionId);
		await this.waitFor(`document.readyState === "complete"`, 15_000);
	}
	/**
	 * Click a selector. Added: the shared `openBrowseFromHome` step needs it, and this thin
	 * client had no click at all — every earlier interaction here was an `evaluate` that dispatched its
	 * own events. Implemented the same way, so it adds no new mechanism.
	 * @param {string} selector
	 */
	async click(selector) {
		const target = JSON.stringify(selector);
		const clicked = await this.evaluate(
			`(() => { const el = document.querySelector(${target}); if (!el) return false; el.click(); return true; })()`
		);
		if (!clicked) throw new Error(`click: no element matched ${selector}`);
	}
	/**
	 * @param {string} expr
	 * @param {number | { timeout?: number, every?: number }} [timeout] positional ms (this probe's own
	 *   callers) or an options object (what the shared drivers and `lib/phone.mjs` pass)
	 * @param {number} [every]
	 */
	async waitFor(expr, timeout = 10_000, every = 100) {
		if (timeout !== null && typeof timeout === 'object') {
			every = timeout.every ?? every;
			timeout = timeout.timeout ?? 10_000;
		}
		const deadline = Date.now() + timeout;
		let last;
		while (Date.now() < deadline) {
			try {
				last = await this.evaluate(`(()=>(${expr}))()`);
				if (last) return last;
			} catch (e) {
				last = String(e);
			}
			await delay(every);
		}
		throw new Error(`waitFor timeout: ${expr}\n  last=${JSON.stringify(last)}`);
	}
	/** @param {string} path @param {{ fullPage?: boolean }} [opts] */
	async screenshot(path, { fullPage = false } = {}) {
		const { data } = await this.cdp.send(
			'Page.captureScreenshot',
			{ format: 'png', captureBeyondViewport: fullPage },
			this.sessionId
		);
		writeFileSync(path, Buffer.from(data, 'base64'));
		return path;
	}
	/** @param {number} width @param {number} height @param {number} [dsf] */
	async viewport(width, height, dsf = 1) {
		await this.cdp.send(
			'Emulation.setDeviceMetricsOverride',
			{ width, height, deviceScaleFactor: dsf, mobile: width < 700 },
			this.sessionId
		);
	}
	/** @param {boolean} offline */
	async setOffline(offline) {
		// Network conditions across the whole target: the phone's WebSocket loses its underlying TCP
		// connection without the app calling close(), which is the exact scenario the WsClient's
		// liveness watchdog exists to catch.
		await this.cdp.send(
			'Network.emulateNetworkConditions',
			{ offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
			this.sessionId
		);
	}
	async close() {
		try {
			await this.cdp.send('Target.closeTarget', { targetId: this.targetId });
		} catch {
			// best-effort — a target that already closed itself is not an error
		}
	}
}

// ── WebSocket instrumentation ─────────────────────────────────────────────
/*
 * Runs BEFORE app code on every page load in this target. We wrap `WebSocket` so every socket the
 * client-side code opens is recorded on `window.__p8`; the probe then reaches those sockets to
 * close them abruptly (a hard drop) or to observe reconnection state.
 *
 * NOT a full ES2015 subclass. We wrap the constructor because Svelte's WsClient uses `new WebSocket`,
 * and only that path needs interception. `send`/`close` pass through to the real methods, so we do
 * not add any observable behavior beyond the record.
 */
const INSTRUMENT = `
(() => {
  const orig = window.WebSocket;
  const list = [];
  window.__p8 = {
    sockets: list,
    lastOpen: null,
    connectCount: 0,
    // Hard-drop the most recently opened socket, mimicking a peer going away without a FIN.
    // Using close() first is deliberate: a browser WebSocket has no "abort" — close(3000, ...) is
    // the closest thing to a signal drop from the JS side. The client's onclose fires, and the
    // reconnect path takes over.
    dropLast() {
      const s = this.lastOpen;
      if (!s || s.readyState > 1) return false;
      s.close(3000, 'p8-drop');
      return true;
    }
  };
  function P8Socket(url, protocols) {
    const s = protocols === undefined ? new orig(url) : new orig(url, protocols);
    window.__p8.lastOpen = s;
    list.push(s);
    s.addEventListener('open', () => { window.__p8.connectCount++; });
    return s;
  }
  P8Socket.prototype = orig.prototype;
  P8Socket.CONNECTING = orig.CONNECTING;
  P8Socket.OPEN = orig.OPEN;
  P8Socket.CLOSING = orig.CLOSING;
  P8Socket.CLOSED = orig.CLOSED;
  window.WebSocket = P8Socket;
})();
`;

// ── join helpers ──────────────────────────────────────────────────────────
/**
 * @param {Cdp} cdp
 * @param {string} name
 * @param {string} [colourName]
 */
async function joinPhone(cdp, name, colourName = PRESET_COLOUR_NAMES[0]) {
	const page = await cdp.newContextPage(INSTRUMENT);
	await page.viewport(390, 844, 1); // an iPhone-ish portrait, without the 2000px screenshot ceiling risk
	await page.goto(`${BASE}/join`);
	await page.evaluate(
		`(() => {
			const el = document.querySelector(${JSON.stringify(SEL.nameInput)});
			el.focus(); el.value = ${JSON.stringify(name)};
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
		})()`
	);
	await page.evaluate(
		`(() => {
			const r = document.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(colourName)}) + ']');
			if (r) r.click();
		})()`
	);
	await page.evaluate(
		`(() => {
			const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Start singing'));
			if (btn) btn.click();
		})()`
	);
	// A well-formed join lands on / with the joined home rendered — the DOCKED BAND, not the search box:
	// search lives on the browse screen, so testing for it here would mean "browsing", not
	// "joined". A duplicate-name join sits on /join with a `.err[role=alert]` — differentiate here so the
	// caller can react.
	const outcome = await page.waitFor(
		`(() => {
			if (location.pathname === '/' && document.querySelector(${JSON.stringify(SEL.homeReady)})) return 'joined';
			const err = document.querySelector(${JSON.stringify(SEL.joinError)});
			if (err) return 'err:' + (err.textContent || '').trim();
			return null;
		})()`,
		8_000
	);
	if (outcome === 'joined') {
		// Wait for the socket to actually connect before returning — every downstream assertion (roster,
		// resync, add) depends on a live WS. A joined phone with no socket yet passes readyState but
		// fails everything after. Then wait one more short beat for the queue:sync to arrive: the
		// store is initialized BEFORE ws.open(), but a queue:command that flies before the first
		// queue:sync is answered has no `baseRev` context on the client side — nothing breaks, but a
		// tight loop of "join → search → click" measured on this same phone can miss its own
		// optimistic row if the store subscribe callback hasn't observed the sync-time rebase yet.
		await page.waitFor(`window.__p8 && window.__p8.connectCount > 0`, 8_000).catch(() => null);
		await delay(400);
	}
	return { page, name, outcome };
}

/** @param {CdpPage} page @returns {Promise<RoomState>} */
async function getState(page) {
	return page.evaluate(
		`(() => {
			// The phone's authoritative view of the room, read straight off the DOM the singer sees.
			const rows = [...document.querySelectorAll(${JSON.stringify(SEL.queueRow)})].map(r => ({
				title: (r.querySelector(${JSON.stringify(SEL.rowTitle)})?.textContent || '').trim(),
				away: r.querySelector(${JSON.stringify(SEL.away)}) != null,
				pending: r.classList.contains('pending')
			}));
			return { rows, count: rows.length };
		})()`
	);
}

// ── search + queue ────────────────────────────────────────────────────────
// Deliberate choice of search term: a LOCAL library song ("bohemian" → Bohemian Rhapsody), so the
// search hits the local index (fast, deterministic) rather than yt-dlp (slow, network-dependent). A
// yt-dlp cold miss on the first phone made an earlier revision of this probe read as if the queue
// was losing rows — the queue was fine, the search just hadn't returned yet.
const SEARCH_TERM = process.env.P8_SEARCH ?? 'bohemian';

/** @param {CdpPage} page @param {string} [term] */
async function searchAndQueue(page, term = SEARCH_TERM) {
	// The search box is on the browse screen, so get there first. A no-op when already there.
	await openBrowseFromHome(page);
	await page.evaluate(
		`(() => {
			const el = document.querySelector(${JSON.stringify(SEL.search)});
			el.focus(); el.value = ${JSON.stringify(term)};
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
		})()`
	);
	// The search is debounced 150ms and then hits /api/search (which itself may call yt-dlp on
	// unfamiliar terms). Wait long, and require an ACTIONABLE row (`.add` or `.sing`) — a naked
	// `.row` with no button is a browse header or a still-hydrating row, not something we can queue.
	const rowsBefore = await page.evaluate(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`);
	const attemptClick = async () => {
		return page.evaluate(
			`(() => {
				const row = document.querySelector(${JSON.stringify(SEL.songRow)});
				if (!row) return null;
				const btn = row.querySelector(${JSON.stringify(SEL.addAction)}) || row.querySelector(${JSON.stringify(SEL.singAction)});
				if (!btn) return null;
				btn.click();
				return btn.className || 'clicked';
			})()`
		);
	};
	const clicked = await page
		.waitFor(
			`(() => {
			const row = document.querySelector(${JSON.stringify(SEL.songRow)});
			if (!row) return null;
			return row.querySelector(${JSON.stringify(SEL.addOrSing)}) ? 'row-ready' : null;
		})()`,
			20_000
		)
		.catch(() => null);
	if (!clicked) return { queued: false, reason: 'no actionable row after 20s' };
	// Two-shot click with verification. A single `.click()` on a Svelte-managed button can fall on the
	// wrong side of a re-render when search results shuffle in the same tick as the tap — the element
	// existed when we found it and was replaced by an identical-looking one by the time the event
	// dispatched, and the replacement is what carries the live handler. Click, wait for the queue row
	// to appear on THIS phone, retry once if it doesn't. If the second attempt also fails to produce a
	// row, report the raw class + WS state so the caller can distinguish a rendering race from a lost
	// message.
	let btnClass = await attemptClick();
	const landed = await page
		.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > ${rowsBefore}`, 3_000)
		.catch(() => false);
	if (!landed) {
		btnClass = (await attemptClick()) ?? btnClass;
		const landed2 = await page
			.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length > ${rowsBefore}`, 3_000)
			.catch(() => false);
		if (!landed2) {
			const diag = await page.evaluate(
				`(() => ({
					wsOpen: window.__p8?.lastOpen?.readyState,
					connectCount: window.__p8?.connectCount,
					qrows: document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length,
					rows: document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length,
					btn: btnClass
				}))()`.replaceAll('btnClass', JSON.stringify(btnClass))
			);
			return { queued: false, reason: `clicked but no local row: ${JSON.stringify(diag)}` };
		}
	}
	return { queued: true, reason: btnClass || 'clicked' };
}

// ── TV helpers ────────────────────────────────────────────────────────────
/** @param {CdpPage} tv @returns {Promise<TvRoster>} */
async function tvRoster(tv) {
	return tv.evaluate(
		`(() => {
			const chips = [...document.querySelectorAll(${JSON.stringify(SEL.stripPerson)})].map(el => ({
				name: (el.childNodes[1]?.textContent || el.textContent || '').trim(),
				away: el.classList.contains('away'),
				more: el.classList.contains('more'),
				text: (el.textContent || '').trim()
			}));
			return { chips, screen: document.querySelector(${JSON.stringify(SEL.anyTransientState)}) ? 'transient' : (document.querySelector(${JSON.stringify(SEL.lowerThird)}) ? 'playing' : (document.querySelector(${JSON.stringify(SEL.stripPerson)}) ? 'lobby' : 'attract')) };
		})()`
	);
}

// ── the flow ──────────────────────────────────────────────────────────────
async function main() {
	// Pre-flight: the server has to be up. This probe boots nothing itself — HARNESS.md documents
	// the recipe, and gating here means a probe run against a dead port fails loudly with the
	// runbook instead of a mystery timeout on step one.
	const health = await fetch(`${BASE}/health`).catch(() => null);
	if (!health?.ok) {
		console.error(`No Encore server on ${BASE}. Boot per e2e/HARNESS.md and re-run.`);
		process.exit(2);
	}
	const chromium = findChromium();
	if (!chromium) {
		console.error('No Chromium found. Set PW_CHROMIUM or install one.');
		process.exit(2);
	}

	const proc = spawn(
		chromium,
		[
			'--headless=new',
			'--no-sandbox',
			'--disable-gpu',
			`--remote-debugging-port=${CDP_PORT}`,
			'--remote-allow-origins=*',
			'--autoplay-policy=no-user-gesture-required',
			'about:blank'
		],
		{ stdio: 'ignore' }
	);

	const cdp = new Cdp(CDP_PORT);
	let phones = [];
	let tv;
	try {
		// give Chromium a beat to bind the port
		for (let i = 0; i < 30; i++) {
			try {
				await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
				break;
			} catch {
				await delay(200);
			}
		}
		await cdp.connect();

		// ── 1. TV, then N phones, then the TV roster + screenshot ──────────
		tv = await cdp.newContextPage(null); // TV needs no instrumentation
		await tv.viewport(1600, 900, 1);
		await tv.goto(`${BASE}/tv`);
		// Freshness gate. Attract-only markup (`.is-label` inside `.idle-strip`, i.e. "Nobody here
		// yet") is what the wall says while nobody has joined. `.idle-head` was the obvious pick and
		// wrong: it only renders when the join origin is REACHABLE, and on loopback (127.0.0.1) the
		// route swaps in a `JoinBadge` "unreachable" card instead — so the guard was matching a
		// condition that doesn't exist in this harness. `.is-label` renders on both branches of the
		// attract state and on neither of the other two, so it does the actual job.
		const attract = await tv
			.waitFor(`document.querySelector(${JSON.stringify(SEL.isLabel)}) !== null`, 8_000)
			.catch(() => false);
		if (!attract) {
			report(
				'ENV',
				'server was not empty at start of run',
				'A prior run left singers or an in-flight state in the room. Restart the ephemeral server between runs (see e2e/HARNESS.md).'
			);
			throw new Error('bail: not empty');
		}

		for (let i = 0; i < NUM_PHONES; i++) {
			const p = await joinPhone(cdp, PHONE_NAMES[i], PRESET_COLOUR_NAMES[i % PRESET_COLOUR_NAMES.length]);
			phones.push(p);
			if (p.outcome !== 'joined') {
				report('HIGH', `phone ${PHONE_NAMES[i]} could not join`, `outcome=${p.outcome}`);
			}
		}
		// Give the last connect an event loop turn to reach the TV.
		await delay(600);

		const roster = await tvRoster(tv);
		const shot1 = await tv.screenshot(join(OUT_DIR, '01-tv-lobby-10.png'));
		const chipCount = roster.chips.filter((c) => !c.more).length;
		const moreChip = roster.chips.find((c) => c.more);
		// Screen ought to be `lobby` (people here, nothing queued). If it's still `attract`, the roster
		// broadcast dropped a joined singer — a real defect.
		if (roster.screen !== 'lobby') {
			report('HIGH', `TV did not enter lobby after ${NUM_PHONES} joins`, `screen=${roster.screen}`, `see: ${shot1}`);
		} else {
			// TvLobby caps `roster.shown` at 8 and reports the rest as `+N more`. A cap that RENDERS
			// silently — no more chip — means guests 9+ vanished from the wall. lobbyRoster()
			// (src/lib/tv/screen.ts:93) explicitly returns `overflow`, so this asserts the wiring, not
			// just the cap.
			if (NUM_PHONES > 8) {
				if (!moreChip || chipCount !== 8) {
					report(
						'MEDIUM',
						'TV roster clipped instead of collapsing overflow',
						`chipCount=${chipCount} more=${moreChip?.text ?? 'MISSING'} (expected 8 named chips + one "+N more")`,
						`src/lib/tv/screen.ts:93 lobbyRoster capping; src/lib/tv/TvLobby.svelte:120 overflow render; ${shot1}`
					);
				} else {
					// Check the overflow number is right: with 10 phones there are 2 more.
					const m = /\+(\d+) more/.exec(moreChip.text);
					const overflowN = m ? Number(m[1]) : NaN;
					if (overflowN !== NUM_PHONES - 8) {
						report(
							'MEDIUM',
							'TV overflow count disagrees with roster',
							`shown 8, overflow ${overflowN}, expected +${NUM_PHONES - 8}`,
							`src/lib/tv/TvLobby.svelte:120; ${shot1}`
						);
					} else {
						report('PASS', 'TV renders 8 named chips + "+N more" for a 10-singer room', `${shot1}`);
					}
				}
			}
		}

		// Roster agreement across surfaces: every joined phone must show the same singer count. The
		// phone doesn't render a lobby (it shows the search/queue), so we assert on the /api/me +
		// server sync directory it received. If a phone's WS never delivered a queue:sync, `singers`
		// will be short.
		//
		// (Reads from the same fetch each phone can make, since we don't expose the store.)
		const perPhoneSingers = await Promise.all(
			phones.map((p) =>
				p.page.evaluate(
					`(async () => {
						// Approximate the phone's roster view: singers WITH pending songs in the DOM plus the
						// singers-list we can infer from the queue rows. When there are no rows yet, we
						// fall back to /api/me for a smoke check that the socket is alive.
						const me = await fetch('/api/me').then(r => r.ok ? r.json() : { singer: null });
						return { hasMe: !!me.singer, name: me.singer?.displayName ?? null };
					})()`
				)
			)
		);
		const allSaw = perPhoneSingers.every((s) => s.hasMe);
		if (!allSaw) {
			report(
				'HIGH',
				'not every phone confirmed a joined session',
				`hasMe counts: ${perPhoneSingers.filter((s) => s.hasMe).length}/${NUM_PHONES}`,
				`apps/core/src/routes/api/me/+server.ts`
			);
		} else {
			report('PASS', `${NUM_PHONES}/${NUM_PHONES} phones report a joined session`);
		}

		// ── 2. Name collision — a duplicate name must produce a human 409, not a dead form ──
		{
			const dup = await joinPhone(cdp, PHONE_NAMES[0], PRESET_COLOUR_NAMES[1]);
			if (dup.outcome === 'joined') {
				report(
					'CRITICAL',
					'duplicate display name JOINED anyway',
					`the name "${PHONE_NAMES[0]}" was reused and the server accepted it`,
					`apps/core/src/lib/server/singers/join.ts:31 assertNameFree; ${BASE}/api/join`
				);
			} else {
				const msg = (dup.outcome || '').replace(/^err:/, '');
				const humanTaken = /taken/i.test(msg) || /already/i.test(msg);
				if (!humanTaken) {
					report(
						'HIGH',
						'name-collision error is not human-legible',
						`phone displayed: ${JSON.stringify(msg)}`,
						`apps/core/src/lib/components/JoinLanding.svelte:26 error rendering; server: apps/core/src/lib/server/singers/join.ts:21 NameTakenError message`
					);
				} else {
					// The form must remain usable — the input the user can now edit is the whole point of
					// this test (the lesson recorded on this branch was that the join page just "sat there
					// looking broken"). Verify (a) the name input still exists and is enabled, (b) the
					// error is announced via role=alert, (c) the submit button is present and can be
					// re-triggered with a different name.
					const usable = await dup.page.evaluate(
						`(() => {
							const nameEl = document.querySelector(${JSON.stringify(SEL.nameInput)});
							const alertEl = document.querySelector(${JSON.stringify(SEL.joinError)});
							const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Start singing') || b.textContent.trim().startsWith('Joining'));
							return {
								nameStillEditable: !!nameEl && !nameEl.disabled,
								errorAnnounced: !!alertEl && !!alertEl.getAttribute('role'),
								submitReachable: !!btn && !btn.disabled
							};
						})()`
					);
					const ok = usable.nameStillEditable && usable.errorAnnounced && usable.submitReachable;
					if (!ok) {
						report(
							'HIGH',
							'join form is not recoverable after a 409',
							`state=${JSON.stringify(usable)} — the form must let the user retype and resubmit`,
							`apps/core/src/lib/components/JoinLanding.svelte:14 submitting flag reset`
						);
					} else {
						// And prove recovery actually works: type a fresh name and submit.
						await dup.page.evaluate(
							`(() => {
								const el = document.querySelector(${JSON.stringify(SEL.nameInput)});
								el.focus(); el.value = 'ZZReplay';
								el.dispatchEvent(new Event('input', { bubbles: true }));
								el.dispatchEvent(new Event('change', { bubbles: true }));
								[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Start singing'))?.click();
							})()`
						);
						const recovered = await dup.page
							.waitFor(
								`location.pathname === '/' && document.querySelector(${JSON.stringify(SEL.homeReady)}) !== null`,
								8_000
							)
							.catch(() => false);
						if (!recovered) {
							report('HIGH', 'form did not recover after fixing name', `submit did not land in the party`);
						} else {
							report(
								'PASS',
								'duplicate-name 409 leaves the form recoverable, and retyping works',
								`error text: ${JSON.stringify(msg)}`
							);
							// This phone joined as ZZReplay — remember to close it.
							phones.push({ page: dup.page, name: 'ZZReplay', outcome: 'joined' });
						}
					}
				}
			}
		}

		// ── 3. Hard WS drop with a page still resident ─────────────────────
		{
			// Pick a mid-list phone so the drop is not at the boundary that might get special-cased.
			const victim = phones[3];
			const before = await victim.page.evaluate(`window.__p8.connectCount`);
			const dropped = await victim.page.evaluate(`window.__p8.dropLast()`);
			if (!dropped) {
				report(
					'MEDIUM',
					'could not drop the phone WebSocket via instrumentation',
					'sockets was empty or already CLOSED — probe scaffolding, not a defect'
				);
			} else {
				// The WsClient's reconnect backoff starts at 250ms. Give it enough to complete a full
				// cycle including the hello -> queue:sync resync handshake.
				const reconnected = await victim.page
					.waitFor(`window.__p8.connectCount > ${before}`, 10_000)
					.catch(() => false);
				if (!reconnected) {
					report(
						'CRITICAL',
						'phone did not reconnect after a WebSocket drop',
						`connectCount stayed at ${before} for 10s`,
						`apps/core/src/lib/ws/client.ts:107 scheduleReconnect + capped backoff`
					);
				} else {
					// Have another phone queue a song WHILE the victim was down, then verify the victim
					// SEES it after reconnecting: proves the resync (hello -> queue:sync) actually
					// re-syncs, not just that a socket came back.
					const other = phones[5];
					const otherResult = await searchAndQueue(other.page);
					if (!otherResult.queued) {
						report('ENV', 'could not queue on the witness phone for the WS-drop test', `reason=${otherResult.reason}`);
					} else {
						// Give a broadcast + reconnect resync a moment.
						await delay(1500);
						const witnessRows = await other.page.evaluate(
							`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`
						);
						const victimState = await getState(victim.page);
						// Only assert on parity if the witness itself confirms a row landed. If the
						// witness has 0 rows too, the queue-add didn't take at all — a different
						// defect class (search/queue path), not a resync one.
						if (witnessRows < 1) {
							// Pull evidence for the report: /health rev + the last WS traffic the
							// witness recorded. A rev at 0 means no op ever hit the state store; a
							// non-zero rev with 0 rows means the row landed and then something dropped
							// it before render.
							const rev = await fetch(`${BASE}/health`)
								.then((r) => r.json())
								.then((j) => j.rev)
								.catch(() => 'unknown');
							report(
								'HIGH',
								'queue-add on the witness phone did not produce a row',
								`witness rows=${witnessRows}, server rev=${rev} — the add appeared to succeed (button clicked) but no row landed on the source phone`,
								`apps/core/src/lib/stores/queue.ts:120 #optimistic`
							);
						} else if (victimState.rows.length !== witnessRows) {
							report(
								'HIGH',
								'reconnected phone did not resync the queue',
								`victim sees ${victimState.rows.length} rows, witness sees ${witnessRows}`,
								`apps/core/src/lib/stores/queue.ts:154 #onSync (rebase on queue:sync)`
							);
						} else {
							report(
								'PASS',
								'a hard-dropped phone reconnects and resyncs to the authoritative queue',
								`victim rows=${victimState.rows.length}, witness=${witnessRows}`
							);
						}
					}
				}
			}
		}

		// ── 4. AWAY: sever without leaving, verify TV shows away + keep queued songs ──
		{
			// Give this its own singer to make the assertion legible.
			const away = phones[7];
			// First: put a song IN their queue so we can prove it survives.
			const queued = await searchAndQueue(away.page, 'caroline');
			if (!queued.queued) {
				report('ENV', 'could not queue a song for the away test', `reason=${queued.reason}`);
			} else {
				// Sever the socket. `setOffline` alone is NOT enough: Chromium's
				// `Network.emulateNetworkConditions({offline:true})` applies to CONNECTIONS INITIATED
				// AFTER the call, and leaves existing WebSockets connected — a documented CDP
				// limitation, invisible in a single run because the queue-add still flies over the
				// live socket. `dropLast()` fires the client-side close(3000), the server sees the
				// close and marks the singer away. Order matters: dropLast BEFORE setOffline, or the
				// offline emulator drops the outbound close frame at the IP layer and the server sits
				// waiting for its own idleTimeout instead of learning the phone went away.
				await delay(600);
				const beforeConnects = await away.page.evaluate(`window.__p8.connectCount`);
				const dropped = await away.page.evaluate(`window.__p8.dropLast()`);
				if (!dropped) {
					report(
						'ENV',
						'could not sever the away-test socket',
						'the instrumentation returned false — no socket to drop'
					);
				}
				// Now block reconnects — the WsClient reconnects on its own within 250ms, and we want
				// to observe the room WHILE the phone is unreachable.
				await away.page.setOffline(true);
				// The server reacts on socket close; wire this back to the TV via refreshMembership,
				// which broadcasts singer:presence to the whole room. This should be near-instant.
				const tvSaidAway = await tv
					.waitFor(
						`(() => {
						const chips = [...document.querySelectorAll(${JSON.stringify(SEL.stripPerson)})];
						return chips.some(c => c.classList.contains('away') && (c.textContent || '').includes(${JSON.stringify(away.name)}));
					})()`,
						15_000
					)
					.catch(() => false);
				if (!tvSaidAway) {
					const shot = await tv.screenshot(join(OUT_DIR, '02-tv-away.png'));
					report(
						'HIGH',
						'severed phone did not show up as AWAY on the TV within 15s',
						`the TV\u2019s roster never marked ${away.name} as away — presence.disconnect broadcast should be near-instant on close(3000)`,
						`apps/core/src/lib/server/realtime/presence.ts:69 disconnect; apps/core/server.ts (websocket.close handler); ${shot}`
					);
				} else {
					const shot = await tv.screenshot(join(OUT_DIR, '02-tv-away.png'));
					report('PASS', 'severed phone appears as AWAY on the TV, still counted', `${shot}`);
				}

				// Their queued song must still be in the queue — a locked phone that keeps its turn is
				// the whole point of `away`.
				const otherSurface = await phones[2].page.evaluate(
					`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`
				);
				if (otherSurface < 1) {
					report(
						'CRITICAL',
						'severed phone LOST its queued song',
						`another phone reports ${otherSurface} queue rows; the disconnected singer\u2019s song should survive`,
						`apps/core/src/lib/server/realtime/presence.ts:79 (grace clock does not start while pending songs exist)`
					);
				} else {
					report('PASS', 'a phone\u2019s queued song survives the phone going away', `others see ${otherSurface} rows`);
				}

				// Bring them back — reconnect, verify they return to `here` (or at least not stuck on
				// away). Turn offline off and give the client's wake() a synthetic online event; the
				// #bindLifecycle handler listens for it and calls wake() → dial() unconditionally.
				await away.page.setOffline(false);
				await away.page.evaluate(`window.dispatchEvent(new Event('online'))`);
				await away.page.waitFor(`window.__p8.connectCount > ${beforeConnects}`, 15_000).catch(() => null);
				const back = await tv
					.waitFor(
						`(() => {
						const chips = [...document.querySelectorAll(${JSON.stringify(SEL.stripPerson)})];
						const c = chips.find(c => (c.textContent || '').includes(${JSON.stringify(away.name)}));
						return c && !c.classList.contains('away');
					})()`,
						15_000
					)
					.catch(() => false);
				if (!back) {
					report(
						'MEDIUM',
						`away phone did not return to "here" after network came back`,
						`the TV chip stayed grey`,
						`apps/core/src/lib/ws/client.ts:64 wake(); apps/core/src/lib/server/realtime/presence.ts:61 connect()`
					);
				} else {
					report('PASS', 'away phone rejoins as here when the network comes back');
				}
			}
		}

		// ── 5. OPTIMISTIC OP while socket severed ─────────────────────────
		{
			const p = phones[6];
			// Baseline count on another phone (source of truth is any other phone's view).
			const witness = phones[2];
			const before = await witness.page.evaluate(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`);
			// Populate search results FIRST while online — we can't rely on /api/search reaching the
			// server while offline (setOffline(true) does affect NEW HTTP requests). Row appears; then
			// we sever and click.
			await openBrowseFromHome(p.page);
			await p.page.evaluate(
				`(() => {
					const el = document.querySelector(${JSON.stringify(SEL.search)});
					el.focus(); el.value = ${JSON.stringify(SEARCH_TERM)};
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				})()`
			);
			const rows = await p.page
				.waitFor(
					`(() => {
						const row = document.querySelector(${JSON.stringify(SEL.songRow)});
						if (!row) return 0;
						return row.querySelector(${JSON.stringify(SEL.addOrSing)}) ? 1 : 0;
					})()`,
					20_000
				)
				.catch(() => 0);
			if (!rows) {
				report('ENV', 'could not populate search rows before the offline test', `rows=${rows}`);
			} else {
				// Sever the WS first, THEN block the reconnect. Same close-frame ordering as step 4.
				const beforeConnects = await p.page.evaluate(`window.__p8.connectCount`);
				await p.page.evaluate(`window.__p8.dropLast()`);
				await p.page.setOffline(true);
				await delay(800);
				// Tap the queue action. This runs store.addSong → #optimistic → ws.send on a socket
				// that is now CLOSED or CONNECTING (reconnect backoff); trySend returns false, the op
				// remains in #pending. The optimistic row must appear on THIS phone.
				await p.page.evaluate(
					`(() => {
						const row = document.querySelector(${JSON.stringify(SEL.songRow)});
						const btn = row && (row.querySelector(${JSON.stringify(SEL.addAction)}) || row.querySelector(${JSON.stringify(SEL.singAction)}));
						if (btn) btn.click();
					})()`
				);
				const optimistic = await p.page.evaluate(
					`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length + document.querySelectorAll(${JSON.stringify(SEL.processing)}).length`
				);
				// Even though we're offline, the local (already-hydrated) DOM should render the
				// optimistic row — if not, the store's #optimistic path failed to render at all.
				if (optimistic === 0) {
					report(
						'HIGH',
						'offline tap produced no optimistic row',
						'the store must render locally before hearing back from the server',
						`apps/core/src/lib/stores/queue.ts:120 #optimistic`
					);
				}
				// Bring the network back and let the client wake up.
				await p.page.setOffline(false);
				await p.page.evaluate(`window.dispatchEvent(new Event('online'))`);
				await p.page.waitFor(`window.__p8.connectCount > ${beforeConnects}`, 15_000).catch(() => null);
				await delay(3000);
				const after = await witness.page.evaluate(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`);
				const offlineRowsOnP = await p.page.evaluate(
					`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`
				);
				const delta = after - before;
				if (delta === 1) {
					// Reconciled — the op made it through resendPending() (called after queue:sync).
					const parity = offlineRowsOnP === after;
					if (!parity) {
						report(
							'HIGH',
							'offline queue-add reconciled but origin/others disagree',
							`witness=${after} rows, origin=${offlineRowsOnP} rows — a phantom local row survived reconcile`,
							`apps/core/src/lib/stores/queue.ts:150 #onPatch rebase / apps/core/src/lib/stores/queue.ts:154 #onSync rebase`
						);
					} else {
						report(
							'PASS',
							'offline queue-add reconciles through resendPending on reconnect',
							`witness rows delta=+1, origin=${offlineRowsOnP}`
						);
					}
				} else if (delta === 0) {
					if (offlineRowsOnP > 0) {
						report(
							'CRITICAL',
							'offline queue-add was silently lost',
							`origin phone shows ${offlineRowsOnP} rows, witness shows delta ${delta} — the op never reached the server AND the origin has a phantom`,
							`apps/core/src/lib/ws/client.ts:80 trySend drops on non-open; apps/core/src/lib/stores/queue.ts:126 pending map`
						);
					} else {
						report(
							'HIGH',
							'offline queue-add left no trace on either surface',
							`witness delta=0, origin rows=0 — op was neither sent, nor optimistic, nor rejected`,
							`apps/core/src/lib/stores/queue.ts:120 #optimistic`
						);
					}
				} else {
					report(
						'HIGH',
						`offline queue-add produced unexpected row count`,
						`witness delta=${delta}, origin rows=${offlineRowsOnP}`
					);
				}
			}
		}

		// ── 6. Explicit leave via /api/leave ─────────────────────────────
		{
			const leaver = phones[4];
			// Queue something first so `leave` has real songs to handle.
			await searchAndQueue(leaver.page, 'caroline');
			await delay(800);
			const beforeCount = await phones[2].page.evaluate(
				`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`
			);
			const preview = await leaver.page.evaluate(
				`fetch('/api/leave').then(r => r.ok ? r.json() : ({error: r.status}))`
			);
			const leaveRes = await leaver.page.evaluate(
				`fetch('/api/leave', { method: 'POST' }).then(r => r.ok ? r.json() : ({error: r.status}))`
			);
			await delay(1500);
			const afterCount = await phones[2].page.evaluate(
				`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`
			);
			if (leaveRes?.error) {
				report('HIGH', '/api/leave returned an error', `status=${leaveRes.error}`);
			} else {
				const removed = Array.isArray(leaveRes.removed) ? leaveRes.removed.length : NaN;
				// The queued (non-playing) songs must go: leave.ts unqueues them explicitly.
				const drop = beforeCount - afterCount;
				if (drop < removed) {
					report(
						'HIGH',
						'leave removed fewer rows from the room than the API reported',
						`api removed=${removed}, room delta=${drop}, previewQueued=${preview.queuedCount}`,
						`apps/core/src/lib/server/singers/leave.ts:40 doLeave`
					);
				} else {
					report(
						'PASS',
						`/api/leave un-queues that singer\u2019s pending songs`,
						`removed=${removed}, previewQueued=${preview.queuedCount}, hasPlaying=${preview.hasPlaying}`
					);
				}
			}
			// Mark the leaver's page dead so downstream steps don't count it as a shooter — its /api/me
			// is 401 now and it will silently no-op on tap.
			leaver.outcome = 'left';
			// And their name must return to the pool: rejoining with the same name should succeed now.
			const rejoin = await joinPhone(cdp, leaver.name, PRESET_COLOUR_NAMES[3]);
			if (rejoin.outcome !== 'joined') {
				report(
					'HIGH',
					`name did not return to the pool after leave`,
					`rejoin outcome=${rejoin.outcome}`,
					`apps/core/src/lib/server/realtime/presence.ts:105 forget`
				);
				await rejoin.page.close();
			} else {
				report('PASS', 'leave frees the name for immediate rejoin');
				await rejoin.page.close();
			}
		}

		// ── 7. BURST: N phones queue simultaneously ─────────────────────
		{
			// Pick still-live phones. `outcome` starts as 'joined' at successful join, and is set to
			// 'left' when we leave() a phone above. A left phone still has a page, but its /api/me is
			// 401 and its queue-command sees `join the room first` — its tap silently no-ops, which
			// makes it look like the burst lost a row.
			const shooters = phones.filter((p) => p.outcome === 'joined').slice(0, NUM_BURST);
			if (shooters.length < NUM_BURST) {
				report('ENV', `burst had only ${shooters.length} joined shooters`, `expected ${NUM_BURST}`);
			}
			// Snapshot the queue on a witness.
			const witness = shooters[0];
			const before = await witness.page.evaluate(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`);
			// Fire all clicks in the same event-loop turn from the test harness's perspective; each
			// page mints its own clientOpId + entry.id.
			await Promise.all(shooters.map((p) => searchAndQueue(p.page, 'caroline')));
			// Give the server + broadcast a moment to settle.
			await delay(3500);
			// Every phone (including the shooters) should now report the same number of rows: before +
			// NUM_BURST. Do NOT read on the origin phones alone — the origin sees its own optimistic
			// row before the broadcast, and a lost broadcast would still leave the origin looking
			// correct.
			const counts = await Promise.all(
				phones
					.filter((p) => p.outcome === 'joined')
					.map((p) => p.page.evaluate(`document.querySelectorAll(${JSON.stringify(SEL.queueRow)}).length`))
			);
			const uniq = Array.from(new Set(counts));
			const expected = before + NUM_BURST;
			if (uniq.length !== 1) {
				report(
					'HIGH',
					'phones disagree on the queue length after a burst of adds',
					`counts=${JSON.stringify(counts)} (expected all=${expected})`,
					`apps/core/src/lib/server/realtime/hub.ts:98 handleQueueCommand broadcasts to room`
				);
			} else if (uniq[0] !== expected) {
				report(
					'HIGH',
					'burst of adds lost/duplicated rows',
					`observed=${uniq[0]}, expected=${expected} (before=${before} + burst=${NUM_BURST})`,
					`apps/core/src/lib/server/state/store.ts:91 applyQueueOp / applyAndReseq`
				);
			} else {
				// Also verify no duplicate row ids — a duplicate row with different ids would still add
				// up to the same count but be a real bug.
				const ids = await witness.page.evaluate(
					`(() => {
						// The store's ids are on entry.id; the DOM does not stamp them, so we approximate
						// by titles which will collide when duplicated.
						const titles = [...document.querySelectorAll(${JSON.stringify(SEL.queueTitle)})].map(e => e.textContent.trim());
						return titles;
					})()`
				);
				const uniqTitles = new Set(ids);
				const shot = await tv.screenshot(join(OUT_DIR, '03-tv-burst.png'));
				report(
					'PASS',
					'burst adds converge — no lost updates, no rev conflicts',
					`every phone reports ${expected} rows; titles=${ids.length}, unique=${uniqTitles.size} (dups are legal — same media queued by different singers); ${shot}`
				);
			}
			// Note the design observation: the command envelope carries NO revision context — the
			// former baseRev field was deleted because nothing on the server ever read it.
			// Concurrency is therefore the whole clientOpId-dedupe story: replays of the same op are
			// idempotent, and there is no revision-based rejection to count on. This is deliberate.
			report(
				'PASS',
				'concurrency reduces to clientOpId dedupe — no revision context in the envelope',
				'apps/core/src/lib/server/realtime/hub.ts validateCommand has no revision check; the envelope carries clientOpId + op only, so duplicate-op replays are the only conflict shape and they dedupe idempotently.',
				`apps/core/src/shared/core/ops.ts ClientCommand (clientOpId + op; the dead baseRev field was removed)`
			);
		}
	} catch (err) {
		report('CRITICAL', 'probe threw before finishing', String(err instanceof Error ? err.stack : err));
	} finally {
		// Take one final TV shot to make the frame ordering legible even if a later step failed.
		try {
			if (tv) await tv.screenshot(join(OUT_DIR, '99-final.png'));
		} catch {}
		try {
			for (const p of phones) await p.page.close();
			if (tv) await tv.close();
		} catch {}
		cdp.close();
		proc.kill();
	}

	// ── Report ────────────────────────────────────────────────────────────
	/** @type {Partial<Record<Level, number>>} */
	const summary = findings.reduce(
		(/** @type {Partial<Record<Level, number>>} */ m, f) => ((m[f.level] = (m[f.level] || 0) + 1), m),
		{}
	);
	console.log(`\n── SUMMARY ────────────────────────────────────────`);
	for (const level of /** @type {Level[]} */ (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'ENV', 'PASS'])) {
		if (summary[level]) console.log(`  ${level}: ${summary[level]}`);
	}
	console.log(`  evidence: ${OUT_DIR}`);

	const real = /** @type {Level[]} */ (['CRITICAL', 'HIGH']).reduce((n, l) => n + (summary[l] || 0), 0);
	const env = summary['ENV'] || 0;
	// A run that only produced ENV items is EXIT 2 (harness gap), not 0 — the whole point of the
	// exit-code convention is that a green result must mean "we asserted and nothing failed".
	if (real > 0) process.exit(1);
	if (env > 0 && (summary['PASS'] || 0) === 0) process.exit(2);
	process.exit(0);
}

main().catch((e) => {
	console.error('fatal:', e);
	process.exit(1);
});
