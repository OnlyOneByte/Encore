/*
 * THE FIFTH GATE — the four measurement claims, measured on real headless Chromium (issue #823).
 *
 *   bun run gate:measured        # from the repo root, after `bun run build`
 *
 * Exit 0 every check passed · exit 1 anything else. THERE IS NO SKIP PATH, and that is the whole
 * point of it. Owner ruling on #823 Q1 was **A**: a fifth gate every lane runs beside `bun test`,
 * and "a missing browser is a red gate, not a green one". Option B — skipping when no server or
 * Chromium is present — was rejected by name, because `e2e/contract.test.ts:23` had already ruled
 * that "a permanently-skipped test is indistinguishable from the silent rot it was supposed to
 * prevent". So a missing Chromium, a build that was never run, and a server that will not boot are
 * all FAILURES here, reported with the remedy, never a green run over nothing.
 *
 * ── WHAT IS MEASURED, AND WHY IT CANNOT BE SCANNED ─────────────────────────────────────────────
 *
 * | Claim | Requirement | Read from the render |
 * |---|---|---|
 * | 1 button heights | XR-VER-09 | every control's vertical HIT EXTENT vs `--tap`, at three viewports |
 * | 2 input font size | XR-VER-10 | `getComputedStyle(field).fontSize` on real fields |
 * | 3 drawer cap | XR-VER-11 | resolved `max-height` vs `innerHeight`, `--peek-h` vs the peek's real height, and the safe-area term under a simulated 34px inset |
 * | 4 focus-ring form | XR-VER-12 | computed `outline-style/-width/-color` on a genuinely `:focus-visible` element |
 *
 * None of the four is decidable on the mount rung: happy-dom has no layout engine, and
 * `test-setup/svelte-dom-preload.ts:101` now replaces `getBoundingClientRect` with a throw naming
 * the rung, so they cannot be parked there either. The source scans that used to stand in for them
 * read a DECLARATION; three of the four defects this gate found on its first run are invisible to a
 * declaration, because the control declares no height at all.
 *
 * ── METHODOLOGY, FROM THREE RECORDED WRONG ANSWERS (XR-VER-22) ─────────────────────────────────
 *
 *  - Hit-test only after `scrollIntoView({ block: 'center' })`: `elementFromPoint` returns null
 *    outside the viewport, so an un-scrolled control measures 0 and reads as catastrophic.
 *  - Accept a hit as the control's own only when `hit === el || el.contains(hit)`. NEVER the reverse:
 *    `hit.contains(el)` counts `<body>` as a hit and inflated a 32px target to 93px.
 *  - Probe at three x positions (thumb, mid, far edge) and take the WORST. A single centre reading
 *    misses a control whose edge is overlapped.
 *  - A control behind an open modal legitimately measures 0. The drive therefore measures the home
 *    route with the sheet COLLAPSED, and measures the sheet's own geometry separately.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { connect, sleep } from '../cdp.mjs';
import { SEL } from '../contract.ts';
import { openBrowseFromHome } from '../lib/phone.mjs';
import { findChromium } from '../lib/chromium.mjs';
import {
	CONTROL_SELECTOR,
	FLOORS,
	FOCUS_VISIBLE,
	INERT_SELECTOR,
	LABEL_SELECTOR,
	MIN_FIELD_PX,
	QUARANTINE,
	SHEET_CAP_FRACTION,
	SIMULATED_BOTTOM_INSET,
	TAP,
	TEXT_INPUT_TYPES,
	VIEWPORTS
} from './measured-design-register.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {{ tag: string, type: string | null, cls: string, near: string, boxH: number, hitH: number, occluded: number, fontSize: number }} Reading
 */

const CORE = join(import.meta.dir, '..', '..');
const SCRATCH = join(process.env.KIROCREW_SCRATCH ?? process.env.TMPDIR ?? '/tmp', `measured-design-${process.pid}`);

/** @type {{ name: string, ok: boolean, detail: string }[]} */
const checks = [];
/**
 * @param {string} name
 * @param {unknown} ok
 * @param {string} [detail]
 */
function check(name, ok, detail = '') {
	checks.push({ name, ok: !!ok, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

/**
 * A precondition the gate cannot run without. NOT a skip: it records a failed check and the process
 * exits 1, so an environment that cannot host the measurement is red rather than silently green.
 * @param {string} name
 * @param {string} remedy
 * @returns {never}
 */
function unmeetable(name, remedy) {
	check(name, false, remedy);
	report();
	process.exit(1);
}

/** @returns {Promise<number>} a port nothing is listening on */
function freePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			srv.close(() => (port ? resolve(port) : reject(new Error('no port'))));
		});
	});
}

/**
 * The in-page sweep. Returns one reading per operable control, with the identity fields the
 * quarantine matches on.
 * @param {string} [scope] a CSS selector to restrict the sweep to, or undefined for the document
 */
function sweepExpr(scope) {
	const root = scope ? `document.querySelector(${JSON.stringify(scope)})` : 'document';
	return `(() => {
		const root = ${root};
		if (!root) return [];
		const out = [];
		for (const el of [...root.querySelectorAll(${JSON.stringify(CONTROL_SELECTOR)})]) {
			const cs = getComputedStyle(el);
			if (cs.visibility === 'hidden' || cs.display === 'none') continue;
			if (el.hasAttribute('disabled') || el.closest(${JSON.stringify(INERT_SELECTOR)})) continue;
			el.scrollIntoView({ block: 'center' });
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			const own = (n) => !!n && (n === el || el.contains(n));
			const cx = Math.min(Math.max(Math.round(r.left + r.width / 2), 0), innerWidth - 1);
			const cy = Math.round(r.top + r.height / 2);
			// Vertical hit extent at the CENTRE x. That is the reading the 44px floor is about: WCAG
			// 2.5.8 and Encore's own --tap are both statements about the target's box.
			let hitH = 0;
			if (own(document.elementFromPoint(cx, cy))) {
				let top = cy, bottom = cy;
				while (top - 1 >= 0 && own(document.elementFromPoint(cx, top - 1))) top--;
				while (bottom + 1 < innerHeight && own(document.elementFromPoint(cx, bottom + 1))) bottom++;
				hitH = bottom - top + 1;
			}
			// Occlusion, as a SEPARATE reading along the widest row. Sweeping the vertical extent at a
			// far-edge x instead measures the chord through the control's own border-radius — Chromium
			// hit-tests the rounded shape — so every pill read 34-42px of a 44px box and the floor was
			// unmeetable by construction. Kept as an occlusion probe, which is what a far-edge reading
			// is actually good for: an overlay covering part of a control.
			let occluded = 0;
			for (const f of [0.25, 0.5, 0.75]) {
				const x = Math.min(Math.max(Math.round(r.left + r.width * f), 0), innerWidth - 1);
				if (!own(document.elementFromPoint(x, cy))) occluded++;
			}
			const label = el.closest(${JSON.stringify(LABEL_SELECTOR)});
			const near = (el.getAttribute('aria-label') || (label ? label.textContent : '') || (el.parentElement ? el.parentElement.textContent : '') || '')
				.trim().replace(/\\s+/g, ' ').slice(0, 46);
			out.push({
				tag: el.tagName.toLowerCase(),
				type: el.getAttribute('type'),
				cls: ((el.className && el.className.toString) ? el.className.toString() : '').replace(/svelte-[\\w-]+/g, '').trim().replace(/\\s+/g, ' '),
				near,
				boxH: Math.round(r.height * 10) / 10,
				hitH,
				occluded,
				fontSize: parseFloat(cs.fontSize)
			});
		}
		return out;
	})()`;
}

/**
 * Is this reading the control a quarantine entry describes? Every field the entry names must match;
 * `near` matches as a PREFIX, because the raw value is a 46-character slice of surrounding label
 * text and a shorter, stable head of it is what makes the entry readable.
 * @param {Reading} r
 * @param {(typeof QUARANTINE)[number]} q
 */
function matches(r, q) {
	if (q.match.tag !== r.tag) return false;
	if ('type' in q.match && (q.match.type ?? null) !== r.type) return false;
	if (q.match.cls !== undefined && q.match.cls !== r.cls) return false;
	if (q.match.near !== undefined && !r.near.startsWith(q.match.near)) return false;
	return true;
}

/**
 * Does a quarantine entry's `where` cover this surface? A prefix, so one entry covers `/settings`
 * and its tabs (`/settings#party`, `/settings#server`) — the selects are the same controls on the
 * same page, and listing each tab separately would invite a partial quarantine that lets a real new
 * offender in on whichever tab was forgotten.
 * @param {string} where
 * @param {string} label
 */
function covers(where, label) {
	return label === where || label.startsWith(`${where}#`);
}

// ── PRECONDITIONS — each one red, never skipped ────────────────────────────────────────────────

const chromium = findChromium();
if (!chromium) {
	unmeetable(
		'a real Chromium is available — the layout rung needs one',
		'No Chromium found. Install the Playwright cache (~/.cache/ms-playwright/chromium-*) or set PW_CHROMIUM. ' +
			'This gate cannot fall back to the mount rung: happy-dom has no layout engine, so a skip here would ' +
			'report four unchecked claims as checked.'
	);
}
if (!existsSync(join(CORE, 'build', 'handler.js')) && !existsSync(join(CORE, 'build'))) {
	unmeetable(
		'the app has been built — the gate drives the real bundle, not the dev server',
		'apps/core/build is missing. Run `bun run build` (gate 3) before this gate; it is deliberately ordered after it.'
	);
}

// ── BOOT: a private server on a free port, with its own seeded media directory ─────────────────

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const mediaDir = join(SCRATCH, 'media');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(mediaDir, { recursive: true });

const seed = spawn('bun', ['run', join(CORE, 'e2e', 'seed-media.mjs')], {
	cwd: CORE,
	env: { ...process.env, MEDIA_DIR: mediaDir },
	stdio: 'ignore'
});
await new Promise((res) => seed.on('exit', res));

const server = spawn('bun', ['run', './server.ts'], {
	cwd: CORE,
	env: {
		...process.env,
		ENCORE_EPHEMERAL: '1',
		PORT: String(port),
		HOST: '127.0.0.1',
		MEDIA_DIR: mediaDir,
		ENCORE_LYRICS_BACKFILL: '0',
		ENCORE_VOCALS_BACKFILL: '0'
	},
	stdio: 'ignore'
});

let healthy = false;
for (let i = 0; i < 60; i++) {
	if (
		await fetch(`${base}/health`)
			.then((r) => r.ok)
			.catch(() => false)
	) {
		healthy = true;
		break;
	}
	await sleep(250);
}
if (!healthy) {
	server.kill();
	unmeetable(
		`an ephemeral Encore server boots on ${base}`,
		'The server did not answer /health within 15s. Run `bun run build` and `bun run start` by hand to see why.'
	);
}

const browserProc = spawn(
	chromium,
	[
		`--remote-debugging-port=${await freePort()}`,
		'--headless=new',
		'--no-sandbox',
		'--disable-gpu',
		'--no-first-run',
		`--user-data-dir=${join(SCRATCH, 'chrome')}`,
		'about:blank'
	],
	{ stdio: 'ignore' }
);
// The port the child was told is the one we must connect to; re-read it from the flag we passed.
const cdpPort = Number(
	(browserProc.spawnargs.find((a) => a.startsWith('--remote-debugging-port=')) ?? '=0').split('=')[1]
);

let controlsMeasured = 0;
let fieldsMeasured = 0;
/** @type {Set<string>} */
const surfacesSwept = new Set();
/** @type {string[]} */
const newOffenders = [];
/** @type {string[]} */
const worsened = [];
/** @type {string[]} */
const staleQuarantine = [];
/** @type {string[]} */
const smallFields = [];
/** @type {string[]} */
const badFocus = [];
/** @type {string[]} */
const occludedControls = [];

/** @type {Browser | undefined} */
let browser;
try {
	browser = await connect(cdpPort);
	const page = await browser.newPage();
	await page.viewport(VIEWPORTS[0].w, VIEWPORTS[0].h);

	// ── join once; every phone surface below is behind a session ───────────────────────────────
	await page.goto(`${base}/join`);
	const joinSweep = /** @type {Reading[]} */ (await page.evaluate(sweepExpr()));
	await page.fill(SEL.nameInput, `Gate${Date.now() % 1000000}`);
	await page.clickByText('Start singing');
	// Joining lands on the QUEUE since #832 — the search box is a screen further in. `homeReady` is the
	// joined-home signal, and the shared step leaves the page on the browse screen the sweep below types
	// into. Both selectors and the step come from the contract, so this does not re-spell the sequence.
	await page.waitFor(`location.pathname === '/'`, { timeout: 20000 });
	await openBrowseFromHome(page, { timeout: 20000 });
	check('the drive reaches a joined session — every phone surface below is behind one', joinSweep.length > 0);

	const browserVersion = await page.evaluate('navigator.userAgent');
	console.log(`\nbrowser: ${browserVersion}\n`);

	/**
	 * Drive one surface and fold its readings into the tallies.
	 * @param {string} label
	 * @param {() => Promise<void>} arrive
	 */
	async function surface(label, arrive) {
		await arrive();
		await sleep(400);
		const readings = /** @type {Reading[]} */ (await page.evaluate(sweepExpr()));
		if (readings.length === 0) return;
		surfacesSwept.add(label);
		controlsMeasured += readings.length;
		for (const r of readings) {
			const id = `${label} ${r.tag}${r.type ? `[${r.type}]` : ''}${r.cls ? `.${r.cls.split(' ').join('.')}` : ''} "${r.near}"`;
			const q = QUARANTINE.find((e) => covers(e.where, label) && matches(r, e));
			if (r.occluded > 0) {
				occludedControls.push(
					`${id}: something else is topmost at ${r.occluded} of 3 x positions along the control's own centre line`
				);
			}
			if (r.hitH >= TAP) {
				if (q) staleQuarantine.push(`${id}: now measures ${r.hitH}px, at or above the ${TAP}px floor`);
				continue;
			}
			if (!q) {
				newOffenders.push(`${id}: hit extent ${r.hitH}px (box ${r.boxH}px) < ${TAP}px`);
			} else if (r.hitH < q.measured - 1) {
				worsened.push(`${id}: ${q.measured}px when quarantined, now ${r.hitH}px`);
			}
		}
		// claim 2 rides the same sweep: every text-entry field's COMPUTED size, not its declaration
		for (const r of readings) {
			const isField = r.tag === 'textarea' || (r.tag === 'input' && TEXT_INPUT_TYPES.includes(r.type ?? ''));
			if (!isField) continue;
			fieldsMeasured++;
			if (r.fontSize < MIN_FIELD_PX) {
				smallFields.push(`${id(label, r)}: computed font-size ${r.fontSize}px < ${MIN_FIELD_PX}px`);
			}
		}
	}

	/**
	 * @param {string} label
	 * @param {Reading} r
	 */
	function id(label, r) {
		return `${label} ${r.tag}${r.type ? `[${r.type}]` : ''} "${r.near}"`;
	}

	for (const vp of VIEWPORTS) {
		await page.viewport(vp.w, vp.h);
		/*
		 * TWO phone surfaces since #832, not one. `/` is the queue — the hero's transport, the position
		 * card and the docked primary button, none of which existed when this gate was written and all of
		 * which are controls these claims are about. The library rows it used to measure here are a screen
		 * further in, so they get their own surface rather than being lost: measuring only `/` would have
		 * quietly stopped measuring every row action, and measuring only the browse screen would never
		 * measure the docked band.
		 */
		await surface('/', async () => {
			await page.goto(base + '/');
			await page.waitFor(`document.querySelector(${JSON.stringify(SEL.homeReady)}) !== null`, { timeout: 15000 });
		});
		await surface('/?browse=1', async () => {
			await openBrowseFromHome(page, { timeout: 15000 });
			await page.fill(SEL.search, 'caroline');
			await page
				.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`, { timeout: 15000 })
				.catch(() => {});
		});
		await surface('/settings', () => page.goto(`${base}/settings`));
		await surface('/settings#party', () => page.clickByText('Party'));
		await surface('/settings#server', () => page.clickByText('Server'));
		await surface('/metrics', () => page.goto(`${base}/metrics`));
		await surface('/stats', () => page.goto(`${base}/stats`));
	}

	check(
		`CLAIM 1 (XR-VER-09) every control's measured hit extent reaches ${TAP}px, or is quarantined at a recorded number`,
		newOffenders.length === 0,
		newOffenders.join('\n        ')
	);
	check(
		'CLAIM 1 no quarantined control got worse than the number it was quarantined at',
		worsened.length === 0,
		worsened.join('\n        ')
	);
	check(
		'CLAIM 1 no quarantine entry has gone stale — a defect that no longer reproduces is a finding',
		staleQuarantine.length === 0,
		`${staleQuarantine.join('\n        ')}\n        Re-decide the entry in measured-design-register.mjs on the record (XR-VER-07); do not adjust a number.`
	);
	check(
		'CLAIM 1 no control is occluded along its own centre line — the reason a rendered reading beats a declared one',
		occludedControls.length === 0,
		occludedControls.join('\n        ')
	);
	check(
		`CLAIM 2 (XR-VER-10) every text-entry field computes at or above ${MIN_FIELD_PX}px`,
		smallFields.length === 0,
		smallFields.join('\n        ')
	);

	/*
	 * ── CLAIM 3 (XR-VER-11): the drawer's cap, its peek contract, and its safe-area term ───────
	 *
	 * WHERE THIS IS MEASURED CHANGED WITH #832, and the claim did not. Direction A made the queue the
	 * home screen, so `/` no longer mounts QueueSheet: the docked band at the bottom of the phone is the
	 * primary button, and the "published height equals the real rendered height, and the safe-area inset
	 * arrives THROUGH that token" contract moved with it from `--peek-h`/`.peek` to `--dock-h`/`.cta-dock`.
	 *
	 * So this section measures BOTH, and drops neither:
	 *   - the LIVE contract, on `/`, against the docked band (below);
	 *   - the sheet's own cap and peek geometry, on `/components`, where the component still renders
	 *     (further down) — because the component is unchanged and its cap is still a real claim.
	 *
	 * The one sub-check that lost its subject outright is called out where it was, rather than deleted
	 * silently: see the note at `shortViewportMediaMatches`.
	 */
	await page.viewport(390, 844);
	await page.goto(base + '/');
	await page.waitFor(`document.querySelector(${JSON.stringify(SEL.homeReady)}) !== null`, { timeout: 15000 });
	await sleep(600); // let the measured --dock-h write land

	const dockProbe = `(() => {
		const dock = document.querySelector(${JSON.stringify(SEL.homeReady)});
		if (!dock) return null;
		const dr = dock.getBoundingClientRect();
		return {
			dockVar: getComputedStyle(document.documentElement).getPropertyValue('--dock-h').trim(),
			dockInline: document.documentElement.style.getPropertyValue('--dock-h').trim(),
			dockClientHeight: dock.clientHeight,
			dockTop: dr.top,
			dockBottom: dr.bottom,
			dockPadBottom: parseFloat(getComputedStyle(dock).paddingBottom),
			innerHeight: window.innerHeight,
			mainPadBottom: parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(SEL.mainColumn)})).paddingBottom)
		};
	})()`;
	const dock = await page.evaluate(dockProbe);
	if (!dock) {
		check('CLAIM 3 the docked band is rendered on the joined home, so its contract is measurable', false, 'no .cta-dock found');
	} else {
		check(
			"CLAIM 3 (XR-VER-11) --dock-h equals the docked band's REAL rendered height — the contract every docked control offsets from",
			dock.dockVar === `${dock.dockClientHeight}px` && dock.dockInline === `${dock.dockClientHeight}px`,
			`--dock-h resolved "${dock.dockVar}" (inline "${dock.dockInline}") against a rendered band of ${dock.dockClientHeight}px`
		);
		check(
			'CLAIM 3 the docked band sits fully on screen — no bleed below, no clip above',
			dock.dockTop >= -1 && dock.dockBottom <= dock.innerHeight + 1,
			`band occupies ${dock.dockTop.toFixed(1)}..${dock.dockBottom.toFixed(1)} of a ${dock.innerHeight}px viewport (1px of sub-pixel slack allowed)`
		);
		check(
			'CLAIM 3 the scrolling column RESERVES the band rather than being overlapped by it (XR-PH-12)',
			dock.mainPadBottom >= dock.dockClientHeight,
			`main padding-bottom ${dock.mainPadBottom}px against a ${dock.dockClientHeight}px band`
		);
		// The safe-area term, proven by giving the browser a non-zero inset to resolve.
		await page.safeAreaInsets({ bottom: SIMULATED_BOTTOM_INSET });
		await sleep(600);
		const dockInset = await page.evaluate(dockProbe);
		check(
			`CLAIM 3 the band's bottom padding really composes env(safe-area-inset-bottom) — +${SIMULATED_BOTTOM_INSET}px under a simulated inset`,
			dockInset !== null && Math.abs(dockInset.dockPadBottom - (dock.dockPadBottom + SIMULATED_BOTTOM_INSET)) < 1,
			`padding-bottom ${dock.dockPadBottom}px at inset 0, ${dockInset?.dockPadBottom}px at inset ${SIMULATED_BOTTOM_INSET}px`
		);
		await page.safeAreaInsets({ top: 0, right: 0, bottom: 0, left: 0 });
	}

	/*
	 * ── CLAIM 3, SECOND BAND: the browse screen's search dock (#833) ────────────────────────────
	 *
	 * Direction B docks search in the thumb zone and stacks the results UPWARD from it, so the browse
	 * screen is now a second surface carrying a docked band — and the band contract has to hold on both
	 * or the geometry has forked, which is the whole reason `--dock-h` is measured rather than written.
	 *
	 * Four of these cannot be settled by reading source, and three were open questions before this ran:
	 *   - whether `--dock-h` on `?browse=1` reads the REAL search band or a phantom left over from home's
	 *     button (the publishing effect lives on the page and tears down only on route unmount);
	 *   - whether the input really lands within thumb reach rather than merely below the list;
	 *   - whether the stack really ENDS at the dock — a bottom-anchored column plus a scroll-to-bottom is
	 *     the mechanism, and nothing about either is visible in a declaration;
	 *   - whether any result row is occluded by the band it stacks up from.
	 *
	 * The reflow half of the browse screen (320px at 200% text) is deliberately NOT re-asserted here:
	 * `src/lib/phone-inventory.test.ts` owns XR-PH-02 since #837, and two independent geometry checks of
	 * one criterion is the duplicated-vocabulary shape the spec warns about.
	 */
	await page.viewport(390, 844);
	await openBrowseFromHome(page, { timeout: 15000 });
	await page.fill(SEL.search, 'a');
	await page
		.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`, { timeout: 15000 })
		.catch(() => {});
	await sleep(800); // the search debounce is 150ms; let the result set and the scroll-to-bottom settle

	const browseProbe = `(() => {
		const dock = document.querySelector(${JSON.stringify(SEL.searchDock)});
		const field = document.querySelector(${JSON.stringify(SEL.search)});
		const main = document.querySelector(${JSON.stringify(SEL.mainColumn)});
		if (!dock || !field || !main) return null;
		const dr = dock.getBoundingClientRect();
		const fr = field.getBoundingClientRect();
		const rows = [...document.querySelectorAll(${JSON.stringify(SEL.songRow)})].map((r) => {
			const b = r.getBoundingClientRect();
			return { top: b.top, bottom: b.bottom };
		});
		return {
			dockVar: getComputedStyle(document.documentElement).getPropertyValue('--dock-h').trim(),
			dockInline: document.documentElement.style.getPropertyValue('--dock-h').trim(),
			dockClientHeight: dock.clientHeight,
			dockTop: dr.top,
			dockBottom: dr.bottom,
			fieldCentreY: fr.top + fr.height / 2,
			innerHeight: window.innerHeight,
			mainPadBottom: parseFloat(getComputedStyle(main).paddingBottom),
			rowCount: rows.length,
			lastRowBottom: rows.length ? rows[rows.length - 1].bottom : null,
			occludedRows: rows.filter((r) => r.bottom > dr.top + 1 && r.top < dr.bottom - 1).length
		};
	})()`;
	const browse = await page.evaluate(browseProbe);
	if (!browse) {
		check(
			'CLAIM 3 the browse screen renders its docked search band, so its contract is measurable',
			false,
			`no ${SEL.searchDock} / ${SEL.search} / ${SEL.mainColumn} found on ?browse=1`
		);
	} else {
		check(
			"CLAIM 3 (XR-VER-11) --dock-h on the browse screen is the SEARCH band's REAL rendered height, not a phantom from home's button",
			browse.dockVar === `${browse.dockClientHeight}px` && browse.dockInline === `${browse.dockClientHeight}px`,
			`--dock-h resolved "${browse.dockVar}" (inline "${browse.dockInline}") against a rendered band of ${browse.dockClientHeight}px`
		);
		check(
			'CLAIM 3 the search band sits fully on screen — no bleed below, no clip above',
			browse.dockTop >= -1 && browse.dockBottom <= browse.innerHeight + 1,
			`band occupies ${browse.dockTop.toFixed(1)}..${browse.dockBottom.toFixed(1)} of a ${browse.innerHeight}px viewport`
		);
		check(
			'CLAIM 3 the browse column RESERVES the search band rather than being overlapped by it (XR-PH-12)',
			browse.mainPadBottom >= browse.dockClientHeight,
			`main padding-bottom ${browse.mainPadBottom}px against a ${browse.dockClientHeight}px band`
		);
		// Thumb reach is the POINT of docking it (issue #833 acceptance 1): the bottom third of a 390x844
		// phone is the region a thumb covers without regripping. A box merely below the list fails this.
		check(
			'CLAIM 3 the search input sits in the thumb zone — the bottom third of the viewport (#833)',
			browse.fieldCentreY > (browse.innerHeight * 2) / 3,
			`input centre at y=${browse.fieldCentreY.toFixed(1)} of ${browse.innerHeight}px; thumb zone starts at ${((browse.innerHeight * 2) / 3).toFixed(1)}`
		);
		// A floor, not a check: with no rows the two arms below would pass over nothing at all.
		check(
			'CLAIM 3 the browse drive rendered a real result stack — >=1 row to measure',
			browse.rowCount >= 1,
			`${browse.rowCount} rows rendered for the query "a"`
		);
		check(
			'CLAIM 3 no result row is occluded by the band it stacks up from (#833 acceptance 3)',
			browse.occludedRows === 0,
			`${browse.occludedRows} of ${browse.rowCount} rows intersect the band at ${browse.dockTop.toFixed(1)}..${browse.dockBottom.toFixed(1)}`
		);
		// The stack GROWS UPWARD: its last member — the top-ranked one — ends just above the dock rather
		// than at the top of the column. This is the arm that fails if the bottom anchoring or the
		// scroll-to-bottom is dropped, and neither is visible in any declaration.
		const gap = browse.lastRowBottom === null ? null : browse.dockTop - browse.lastRowBottom;
		check(
			'CLAIM 3 the stack ENDS at the dock — the top-ranked row is the one beside the thumb (#833 acceptance 1)',
			gap !== null && gap >= 0 && gap <= 72,
			`last row's bottom is ${gap === null ? 'n/a' : gap.toFixed(1)}px above the band (0..72 expected: main reserves the band + 28px)`
		);
	}

	/*
	 * The BOTTOM ANCHORING, isolated from the scroll. The arm above cannot tell the two apart: a long
	 * result set overflows the column, so the scroll-to-bottom alone puts the last row beside the dock
	 * whether the column is anchored or not — measured, by reverting `justify-content: flex-end` and
	 * watching that arm stay green. What the anchoring is FOR is the short case: one line of content
	 * belongs beside the thumb, not stranded at the top of an empty screen. A query that matches nothing
	 * is the deterministic way to reach it — one `.empty` line, a column that cannot scroll, so the only
	 * thing that can put it at the bottom is the anchoring.
	 */
	await page.fill(SEL.search, 'zzzzznotasongzzzzz');
	await page.waitFor(`document.querySelector(${JSON.stringify(SEL.empty)}) !== null`, { timeout: 15000 }).catch(() => {});
	await sleep(900);
	const shortProbe = `(() => {
		const dock = document.querySelector(${JSON.stringify(SEL.searchDock)});
		const empty = document.querySelector(${JSON.stringify(SEL.empty)});
		if (!dock || !empty) return null;
		const er = empty.getBoundingClientRect();
		return {
			dockTop: dock.getBoundingClientRect().top,
			emptyBottom: er.bottom,
			rowCount: document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length,
			scrollHeight: document.documentElement.scrollHeight,
			innerHeight: window.innerHeight
		};
	})()`;
	const short = await page.evaluate(shortProbe);
	if (!short) {
		check(
			'CLAIM 3 a non-matching query leaves one empty-state line to measure the anchoring against',
			false,
			`no ${SEL.empty} found on ?browse=1 after a non-matching query`
		);
	} else {
		check(
			'CLAIM 3 the short case really is short — the column cannot scroll, so position is anchoring alone',
			short.rowCount === 0 && short.scrollHeight <= short.innerHeight + 1,
			`${short.rowCount} rows, scrollHeight ${short.scrollHeight} against innerHeight ${short.innerHeight}`
		);
		const shortGap = short.dockTop - short.emptyBottom;
		check(
			'CLAIM 3 one line of content is anchored beside the thumb, not stranded at the top (#833)',
			shortGap >= 0 && shortGap <= 72,
			`empty-state line's bottom is ${shortGap.toFixed(1)}px above the band (0..72 expected; unanchored it would be ~700px)`
		);
	}

	// The sheet's OWN geometry, measured where the component still renders.
	await page.goto(base + '/components');
	await page.waitFor(`document.querySelector(${JSON.stringify(SEL.peek)}) !== null`, { timeout: 15000 });
	await sleep(900); // the sheet's transform transition is 0.28s; measure it settled

	const sheetProbe = `(() => {
		const sheet = document.querySelector(${JSON.stringify(SEL.sheet)});
		const peek = document.querySelector(${JSON.stringify(SEL.peek)});
		if (!sheet || !peek) return null;
		const cs = getComputedStyle(sheet);
		const pr = peek.getBoundingClientRect();
		return {
			maxHeightPx: parseFloat(cs.maxHeight),
			innerHeight: window.innerHeight,
			peekVar: getComputedStyle(document.documentElement).getPropertyValue('--peek-h').trim(),
			peekInline: document.documentElement.style.getPropertyValue('--peek-h').trim(),
			peekClientHeight: peek.clientHeight,
			peekTop: pr.top,
			peekBottom: pr.bottom,
			peekPadBottom: parseFloat(getComputedStyle(peek).paddingBottom),
			shortViewportMediaMatches: window.matchMedia('(max-height: 480px)').matches
		};
	})()`;

	const tall = await page.evaluate(sheetProbe);
	if (!tall) {
		check('CLAIM 3 the sheet and its peek are rendered, so the cap is measurable', false, 'no .sheet / .peek found');
	} else {
		const fraction = tall.maxHeightPx / tall.innerHeight;
		check(
			`CLAIM 3 (XR-VER-11) the sheet's cap resolves against the visual viewport at ${SHEET_CAP_FRACTION * 100}%`,
			Math.abs(fraction - SHEET_CAP_FRACTION) < 0.005,
			`max-height resolved to ${tall.maxHeightPx}px of a ${tall.innerHeight}px viewport = ${(fraction * 100).toFixed(2)}%`
		);
		check(
			"CLAIM 3 --peek-h equals the peek's REAL rendered height — the contract every docked control offsets from",
			tall.peekVar === `${tall.peekClientHeight}px` && tall.peekInline === `${tall.peekClientHeight}px`,
			`--peek-h resolved "${tall.peekVar}" (inline "${tall.peekInline}") against a rendered peek of ${tall.peekClientHeight}px`
		);
		check(
			'CLAIM 3 the collapsed sheet leaves exactly its peek on screen — no bleed below, no clip above',
			tall.peekTop >= -1 && tall.peekBottom <= tall.innerHeight + 1,
			`peek occupies ${tall.peekTop.toFixed(1)}..${tall.peekBottom.toFixed(1)} of a ${tall.innerHeight}px viewport (1px of sub-pixel slack allowed)`
		);

		// the cap must TRACK the viewport, not be a literal that happens to match one
		await page.viewport(390, 480);
		await sleep(900);
		const short = await page.evaluate(sheetProbe);
		const shortFraction = short ? short.maxHeightPx / short.innerHeight : 0;
		check(
			'CLAIM 3 the same cap re-resolves at a 480px-tall viewport — it tracks the viewport, not a literal',
			short !== null && Math.abs(shortFraction - SHEET_CAP_FRACTION) < 0.005 && short.maxHeightPx !== tall.maxHeightPx,
			`844px viewport -> ${tall.maxHeightPx}px cap; 480px viewport -> ${short?.maxHeightPx}px cap (${(shortFraction * 100).toFixed(2)}%)`
		);
		check(
			'CLAIM 3 the short-viewport media query really matches at 480px, so the --peek-h cascade below is a real reading',
			short?.shortViewportMediaMatches === true,
			`matchMedia('(max-height: 480px)') = ${short?.shortViewportMediaMatches}`
		);
		/*
		 * The recorded do-not-regress fact: the inline write on documentElement outranks a
		 * `@media (max-height: 480px)` :root override, so a token value in the stylesheet never reaches
		 * the render while the writer is mounted.
		 *
		 * #832 DELETED THE OVERRIDE THIS MEASURED. The `--peek-h: 84px` it looked for lived in
		 * routes/+page.svelte's short-viewport block, and the phone route no longer mounts the sheet; the
		 * override was removed rather than re-pointed at --dock-h precisely BECAUSE of the fact this check
		 * records — an override there would be silently defeated by the measured inline write. So the
		 * assertion is kept and inverted onto what is now true: the inline write is still what the render
		 * resolves, and there is no competing :root literal for it to beat. The absence is asserted, not
		 * assumed, so re-introducing an override that cannot win reds this.
		 */
		check(
			'CLAIM 3 the inline --peek-h write is what the render resolves, and no :root literal competes with it',
			short !== null && short.peekVar === `${short.peekClientHeight}px` && short.peekVar !== '84px',
			`at 480px tall, --peek-h = "${short?.peekVar}" (rendered peek ${short?.peekClientHeight}px), not a stylesheet literal`
		);

		// The safe-area term, proven by giving the browser a non-zero inset to resolve.
		await page.viewport(390, 844);
		await page.safeAreaInsets({ bottom: SIMULATED_BOTTOM_INSET });
		await sleep(600);
		const inset = await page.evaluate(sheetProbe);
		check(
			`CLAIM 3 the peek's bottom padding really composes env(safe-area-inset-bottom) — +${SIMULATED_BOTTOM_INSET}px under a simulated inset`,
			inset !== null && Math.abs(inset.peekPadBottom - (tall.peekPadBottom + SIMULATED_BOTTOM_INSET)) < 1,
			`padding-bottom ${tall.peekPadBottom}px at inset 0, ${inset?.peekPadBottom}px at inset ${SIMULATED_BOTTOM_INSET}px`
		);
		await page.safeAreaInsets({ top: 0, right: 0, bottom: 0, left: 0 });
	}

	// ── CLAIM 4 (XR-VER-12): the focus indicator's FORM, on a genuinely :focus-visible element ──
	await page.viewport(390, 844);

	const focusProbe = `(() => {
		// Resolve --focus the way the cascade does, rather than re-parsing the token file.
		const probe = document.createElement('span');
		probe.style.color = 'var(--focus)';
		document.body.appendChild(probe);
		const wanted = getComputedStyle(probe).color;
		probe.remove();

		const out = [];
		for (const el of [...document.querySelectorAll(${JSON.stringify(CONTROL_SELECTOR)})]) {
			const cs0 = getComputedStyle(el);
			if (cs0.visibility === 'hidden' || cs0.display === 'none' || el.hasAttribute('disabled') || el.closest(${JSON.stringify(INERT_SELECTOR)})) continue;
			if (el.getBoundingClientRect().height === 0) continue;
			const shadowUnfocused = cs0.boxShadow;
			el.focus({ preventScroll: true });
			const visible = el.matches(${JSON.stringify(FOCUS_VISIBLE)});
			const cs = getComputedStyle(el);
			out.push({
				what: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().replace(/\\s+/g, ' ').slice(0, 34),
				tag: el.tagName.toLowerCase(),
				focusVisible: visible,
				style: cs.outlineStyle,
				width: parseFloat(cs.outlineWidth) || 0,
				color: cs.outlineColor,
				shadowChanged: cs.boxShadow !== shadowUnfocused,
				wanted
			});
			el.blur();
		}
		return out;
	})()`;

	const focusReadings =
		/** @type {{ what: string, tag: string, focusVisible: boolean, style: string, width: number, color: string, shadowChanged: boolean, wanted: string }[]} */ ([]);
	// Two surfaces, because the phone route carries seven controls and /settings carries twenty-two —
	// including every <select> and the range inputs, whose focus rings come from different rules.
	for (const where of ['/', '/settings']) {
		await page.goto(base + where);
		await sleep(600);
		focusReadings.push(...(await page.evaluate(focusProbe)));
	}
	const focusedMeasured = focusReadings.length;
	for (const f of focusReadings) {
		const who = `${f.tag} "${f.what}"`;
		// XR-VER-03: an element we could not put into :focus-visible is UNMEASURED, never satisfied.
		if (!f.focusVisible) {
			badFocus.push(`${who}: could not be driven into :focus-visible, so its indicator is UNMEASURED — not passed`);
			continue;
		}
		if (f.style === 'none' || f.width < 2) {
			badFocus.push(
				`${who}: outline is ${f.style} ${f.width}px${f.shadowChanged ? ' and the ring is drawn by box-shadow alone' : ''}`
			);
			continue;
		}
		if (f.color !== f.wanted) {
			badFocus.push(`${who}: ring drawn in ${f.color}, but --focus resolves to ${f.wanted}`);
		}
	}
	check(
		'CLAIM 4 (XR-VER-12) every focusable control draws a >=2px outline in the resolved --focus, measured on the render',
		badFocus.length === 0,
		badFocus.join('\n        ')
	);

	// ── the gate's own non-vacuity floors (XR-VER-05) ──────────────────────────────────────────
	check(
		`the drive measured a real population — >=${FLOORS.controlsMeasured} control readings`,
		controlsMeasured >= FLOORS.controlsMeasured,
		`measured ${controlsMeasured}. A firing floor is a FINDING, never a number to adjust (XR-VER-06): the drive reached fewer controls than it did when this gate landed, so something it used to sweep is no longer reachable.`
	);
	check(
		`the drive reached a real set of surfaces — >=${FLOORS.surfacesSwept}`,
		surfacesSwept.size >= FLOORS.surfacesSwept,
		`reached ${surfacesSwept.size}: ${[...surfacesSwept].join(', ')}`
	);
	check(
		`the font-size arm examined real fields — >=${FLOORS.fieldsMeasured}`,
		fieldsMeasured >= FLOORS.fieldsMeasured,
		`measured ${fieldsMeasured}`
	);
	check(
		`the focus arm examined real controls — >=${FLOORS.focusedMeasured}`,
		focusedMeasured >= FLOORS.focusedMeasured,
		`measured ${focusedMeasured}`
	);
} catch (err) {
	check('the measured-design drive ran to completion', false, String(err instanceof Error ? err.stack : err));
} finally {
	browser?.close();
	browserProc.kill();
	server.kill();
	rmSync(SCRATCH, { recursive: true, force: true });
}

report();
process.exit(checks.some((c) => !c.ok) ? 1 : 0);

function report() {
	const failed = checks.filter((c) => !c.ok);
	console.log(`\n${checks.length - failed.length}/${checks.length} measured checks passed`);
	if (failed.length) {
		console.log('failed:');
		for (const f of failed) console.log(`  - ${f.name}`);
	}
}
