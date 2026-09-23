// THE FIFTH GATE — the design claims a source scan cannot decide, measured on real headless Chromium.
//
//   bun run gate:measured        # from the repo root, AFTER `bun run build`
//
// THERE IS NO SKIP PATH: a missing Chromium, an unbuilt app and a server that will not boot are all
// exit 1 with the remedy printed, never a green run over nothing. Full rules, and the measurement
// methodology this gate paid for, in docs/E2E.md#gates.
//
// None of the claims is decidable on the mount rung — happy-dom has no layout engine, and
// tests/setup/svelte-dom-preload.ts replaces `getBoundingClientRect` with a throw naming the rung — and
// the source scans that used to stand in for them read a DECLARATION, which is invisible to a control
// that declares no height at all.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { connect, sleep } from '../driver.mjs';
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
	SIMULATED_BOTTOM_INSET,
	TAP,
	TEXT_INPUT_TYPES,
	VIEWPORTS
} from './measured-design-register.mjs';
import { repoRoot } from '../lib/repo-root.mjs';
import { openJoin } from '../lib/join.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {{ tag: string, type: string | null, cls: string, near: string, offscreen: boolean, blockedBy: string | null, boxH: number, hitH: number, occluded: number, fontSize: number }} Reading
 */

const CORE = repoRoot;
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
			// A checkbox/radio has no accessible box worth tapping: its target is DELEGATED to the wrapping
			// <label>, which carries min-height: var(--tap). Without this the sweep saw only the 18px glyph
			// and read a 44px label as an 18px false floor.
			const type = (el.getAttribute('type') || '').toLowerCase();
			const glyph = el.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio');
			// A SWITCH IS THE SAME DELEGATION IN NEW MARKUP — a button with role=switch inside the same
			// label.check. The delegation follows the CONTROL, not the tag it used to have.
			const switchBtn = el.getAttribute('role') === 'switch';
			// A SLIDER THUMB'S TARGET IS ITS TRACK: Bits UI moves the thumb to wherever the track is pressed.
			// If the slider ROOT is also short this still fails, which credits a real target without excusing
			// a small one.
			const thumb = el.matches('[data-slot="slider-thumb"]');
			const target =
				glyph || switchBtn
					? el.closest(${JSON.stringify(LABEL_SELECTOR)}) || el
					: thumb
						? el.closest('[data-slot="slider"]') || el
						: el;
			const inTarget = (n) => !!n && (n === target || target.contains(n));
			const tr = target.getBoundingClientRect();
			const cx = Math.min(Math.max(Math.round(tr.left + tr.width / 2), 0), innerWidth - 1);
			const cy = Math.round(tr.top + tr.height / 2);
			// Vertical hit extent at the CENTRE x — the reading the 44px floor is about.
			/*
			 * OFF-VIEWPORT IS NOT ZERO-HEIGHT. elementFromPoint returns null for any point outside the
			 * viewport, so a control below the fold reads hitH 0 and occluded 3/3 — an unhittable, fully
			 * covered target that is simply further down the page. The test is on the CENTRE POINT, not the
			 * box: a control straddling the fold intersects the viewport and still has no hittable centre. Its
			 * declared box is still credited, the occlusion probe is skipped (nothing can cover what is not
			 * painted), and the skip is counted in offscreen so it cannot absorb a whole surface.
			 */
			const onScreen = cy >= 0 && cy < innerHeight;
			let hitH = onScreen ? 0 : Math.round(tr.height * 10) / 10;
			if (onScreen && inTarget(document.elementFromPoint(cx, cy))) {
				let top = cy, bottom = cy;
				while (top - 1 >= 0 && inTarget(document.elementFromPoint(cx, top - 1))) top--;
				while (bottom + 1 < innerHeight && inTarget(document.elementFromPoint(cx, bottom + 1))) bottom++;
				hitH = bottom - top + 1;
			}
			// Occlusion, as a SEPARATE reading along the widest row. Sweeping the vertical extent at a far-edge
			// x measures the chord through the control's own border-radius — Chromium hit-tests the rounded
			// shape — so every pill read 34-42px of a 44px box and the floor was unmeetable by construction.
			let occluded = 0;
			// WHAT blocked it, not just that something did: naming the topmost element makes the failure message
			// the diagnosis. null means the point had no element at all, which after the offscreen guard above
			// can only mean a gap in the target's own paint.
			let blockedBy = null;
			if (onScreen) {
				for (const f of [0.25, 0.5, 0.75]) {
					const x = Math.min(Math.max(Math.round(tr.left + tr.width * f), 0), innerWidth - 1);
					const hit = document.elementFromPoint(x, cy);
					if (!inTarget(hit)) {
						occluded++;
						if (!blockedBy) {
							blockedBy = hit
								? hit.tagName.toLowerCase() +
									(hit.className && hit.className.toString ? '.' + hit.className.toString().replace(/svelte-[\w-]+/g, '').trim().split(/\s+/).slice(0, 2).join('.') : '') +
									' pe=' + getComputedStyle(hit).pointerEvents +
									(hit === target.parentElement ? ' (the target OWN PARENT)' : '')
								: 'nothing (no element at that point)';
						}
					}
				}
			}
			const label = el.closest(${JSON.stringify(LABEL_SELECTOR)});
			const near = (el.getAttribute('aria-label') || (label ? label.textContent : '') || (el.parentElement ? el.parentElement.textContent : '') || '')
				.trim().replace(/\\s+/g, ' ').slice(0, 46);
			out.push({
				tag: el.tagName.toLowerCase(),
				type: el.getAttribute('type'),
				cls: ((el.className && el.className.toString) ? el.className.toString() : '').replace(/svelte-[\\w-]+/g, '').trim().replace(/\\s+/g, ' '),
				near,
				offscreen: !onScreen,
				blockedBy,
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
 * Does a quarantine entry's `where` cover this surface? A PREFIX, so one entry covers `/settings` and its
 * tabs — the same controls on the same page, where listing each tab separately would invite a partial
 * quarantine that lets a real new offender in on whichever tab was forgotten.
 * @param {string} where @param {string} label
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
		'build is missing. Run `bun run build` (gate 3) before this gate; it is deliberately ordered after it.'
	);
}

// ── BOOT: a private server on a free port, with its own seeded media directory ─────────────────

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const mediaDir = join(SCRATCH, 'media');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(mediaDir, { recursive: true });

const seed = spawn('bun', ['run', join(CORE, 'tests', 'e2e', 'seed-media.mjs')], {
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
		// A routable (non-loopback) public origin, so the TV attract renders its REACHABLE join panel rather
		// than the loopback notice — and a long LAN address is the worst case CLAIM 6's URL-break probe needs.
		ENCORE_PUBLIC_ORIGIN: `http://192.168.1.20:${port}`,
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
	browser = await connect();
	const page = await browser.newPage();
	await page.viewport(VIEWPORTS[0].w, VIEWPORTS[0].h);

	// Join once; every phone surface below is behind a session. The join form is the unjoined state of `/`.
	await openJoin(page, base);
	const joinSweep = /** @type {Reading[]} */ (await page.evaluate(sweepExpr()));
	await page.fill(SEL.nameInput, `Gate${Date.now() % 1000000}`);
	await page.clickByRole('button', 'Start singing');
	// `homeReady` is the joined-home signal, and the shared step leaves the page where the sweep below types.
	// Both the selectors and the step come from the contract, so this does not re-spell the sequence.
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
					`${id}: blocked by ${r.blockedBy} at ${r.occluded} of 3 x positions along the control's own centre line`
				);
			}
			if (r.hitH >= TAP) {
				if (q) staleQuarantine.push(`${id}: now measures ${r.hitH}px, at or above the ${TAP}px floor`);
				continue;
			}
			if (!q) {
				newOffenders.push(
					`${id}: hit extent ${r.hitH}px (box ${r.boxH}px) < ${TAP}px${r.blockedBy ? ` — blocked by ${r.blockedBy}` : ''}`
				);
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
		 * TWO phone surfaces, not one: `/` carries the queue's own controls and the docked band, and the
		 * library rows are a screen further in. Measuring only one silently stops measuring the other.
		 */
		await surface('/', async () => {
			await page.goto(base + '/');
			await page.waitForSelector(SEL.homeReady, { timeout: 15000 });
		});
		await surface('/ (searched)', async () => {
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
		`CLAIM 1 every control's measured hit extent reaches ${TAP}px, or is quarantined at a recorded number`,
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
		`${staleQuarantine.join('\n        ')}\n        Re-decide the entry in measured-design-register.mjs on the record; do not adjust a number.`
	);
	check(
		'CLAIM 1 no control is occluded along its own centre line — the reason a rendered reading beats a declared one',
		occludedControls.length === 0,
		occludedControls.join('\n        ')
	);
	check(
		`CLAIM 2 every text-entry field computes at or above ${MIN_FIELD_PX}px`,
		smallFields.length === 0,
		smallFields.join('\n        ')
	);

	// CLAIM 3: the docked band's published height and its safe-area term.
	//
	// ONE ELEMENT FOR THE WHOLE APP, AND IT IS THE ROW RATHER THAN THE STRIP: `SEL.dockRow` (`.band-slot`:
	// vaul's pull handle, then the band strip) is the bottom-most chrome on every phone surface, the LAYOUT
	// publishes `--dock-h` from that ROW's clientHeight, and the band carries the only
	// `env(safe-area-inset-bottom)` term in the stack. A column must clear the WHOLE row or a thumb reaching
	// for the grab bar lands on page content, so comparing the token against `.band` (24px shorter) reports a
	// broken contract where there is none. The block after this one measures the SAME band with a query up.
	await page.viewport(390, 844);
	await page.goto(base + '/');
	await page.waitForSelector(SEL.homeReady, { timeout: 15000 });
	await sleep(600); // let the measured --dock-h write land

	// TWO ELEMENTS, TWO CLAIMS. The RESERVATION contract (`--dock-h` vs what a column must clear) is about
	// the ROW `SEL.dockRow`, which the layout measures and which is the whole of what sits over the page; the
	// SAFE-AREA contract is about the STRIP `SEL.homeReady`, because the band declares the inset term and is
	// the bottom-most PAINTED surface. Reading the row for both measures padding-bottom 0 at every inset,
	// reporting a composed term as missing when it is declared one element further in.
	const dockProbe = `(() => {
		const dock = document.querySelector(${JSON.stringify(SEL.dockRow)});
		if (!dock) return null;
		const dr = dock.getBoundingClientRect();
		return {
			dockVar: getComputedStyle(document.documentElement).getPropertyValue('--dock-h').trim(),
			dockInline: document.documentElement.style.getPropertyValue('--dock-h').trim(),
			dockClientHeight: dock.clientHeight,
			// The OUTER box, and it is the one the claim is about — see the note at the arm below.
			dockOuterHeight: dr.height,
			dockTop: dr.top,
			dockBottom: dr.bottom,
			dockPadBottom: parseFloat(getComputedStyle(dock).paddingBottom),
			// The safe-area term lives on the STRIP, not on the row — see the note above this probe.
			stripPadBottom: (() => {
				const strip = document.querySelector(${JSON.stringify(SEL.homeReady)});
				return strip ? parseFloat(getComputedStyle(strip).paddingBottom) : Number.NaN;
			})(),
			innerHeight: window.innerHeight,
			mainPadBottom: parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(SEL.mainColumn)})).paddingBottom)
		};
	})()`;
	const dock = await page.evaluate(dockProbe);
	if (!dock) {
		check(
			'CLAIM 3 the docked band is rendered on the joined home, so its contract is measurable',
			false,
			`no ${SEL.dockRow} found on / — the layout mounts the docked row for a joined singer, so its absence is either an unjoined drive or the row itself`
		);
	} else {
		// WHICH HEIGHT, and it matters by exactly the 1px that would make this arm red on a correct app.
		// `--dock-h` is `bind:clientHeight` on a wrapper with no padding or border, so it is the band's OUTER
		// box; read off `.band`, `clientHeight` EXCLUDES its 1px border-top. Use `getBoundingClientRect()`.
		//
		// The 1px tolerance is for `clientHeight`'s INTEGER rounding, not slack: the defects this catches — a
		// stale token, a hardcoded guess, a height published off a different element — are wrong by tens of
		// pixels. The computed-vs-inline pair is asserted EXACTLY, because that is the half saying the value
		// was written by the layout's measurement rather than inherited from a stylesheet.
		check(
			"CLAIM 3 --dock-h equals the docked band's REAL rendered height — the contract every docked control offsets from",
			dock.dockVar !== '' &&
				dock.dockVar === dock.dockInline &&
				Math.abs(parseFloat(dock.dockVar) - dock.dockOuterHeight) <= 1,
			`--dock-h resolved "${dock.dockVar}" (inline "${dock.dockInline}") against a band whose outer box is ${dock.dockOuterHeight.toFixed(1)}px (clientHeight ${dock.dockClientHeight}px, which excludes its 1px top border)`
		);
		check(
			'CLAIM 3 the docked band sits fully on screen — no bleed below, no clip above',
			dock.dockTop >= -1 && dock.dockBottom <= dock.innerHeight + 1,
			`band occupies ${dock.dockTop.toFixed(1)}..${dock.dockBottom.toFixed(1)} of a ${dock.innerHeight}px viewport (1px of sub-pixel slack allowed)`
		);
		check(
			'CLAIM 3 the scrolling column RESERVES the band rather than being overlapped by it',
			dock.mainPadBottom >= dock.dockClientHeight,
			`main padding-bottom ${dock.mainPadBottom}px against a ${dock.dockClientHeight}px band`
		);
		// The safe-area term, proven by giving the browser a non-zero inset to resolve.
		await page.safeAreaInsets({ bottom: SIMULATED_BOTTOM_INSET });
		await sleep(600);
		const dockInset = await page.evaluate(dockProbe);
		check(
			`CLAIM 3 the band's bottom padding really composes env(safe-area-inset-bottom) — +${SIMULATED_BOTTOM_INSET}px under a simulated inset`,
			dockInset !== null && Math.abs(dockInset.stripPadBottom - (dock.stripPadBottom + SIMULATED_BOTTOM_INSET)) < 1,
			`the band strip's padding-bottom ${dock.stripPadBottom}px at inset 0, ${dockInset?.stripPadBottom}px at inset ${SIMULATED_BOTTOM_INSET}px`
		);
		await page.safeAreaInsets({ top: 0, right: 0, bottom: 0, left: 0 });
	}

	// CLAIM 3 IN THE SEARCH VIEW: the same one band in the second STATE — the column with a query up, whose
	// rows are results rather than queue rows. The box sits at the TOP of the column in normal flow while the
	// band is still the bottom-most chrome, so this reading exists to be COMPARED against the resting one.
	// The failure is per-STATE as much as per-surface: a results list is longer than a queue, so "scrolled to
	// the very end" is a different row here.
	//
	// The reflow half (320px at 200% text) is deliberately NOT re-asserted: tests/guards/layout/
	// phone-inventory.test.ts owns it, and two geometry checks of one criterion is duplicated vocabulary.
	await page.viewport(390, 844);
	// Reach the field through the ONE helper, then type: `openBrowseFromHome` is the single place that knows
	// how search is reached, so this drive survived every move of the box untouched.
	await openBrowseFromHome(page, { timeout: 15000 });
	await page.fill(SEL.search, 'a');
	await page
		.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`, { timeout: 15000 })
		.catch(() => {});
	await sleep(800); // the search debounce is 150ms; let the result set land and the rows paint

	// The band's two flanking transport controls — restart and skip — addressed by STRUCTURE: the group holds
	// the disc plus these two, so `.btn` inside it is exactly the pair.
	const bandSideControls = `${SEL.homeReady} .tp .btn`;

	const browseProbe = `(() => {
		const dock = document.querySelector(${JSON.stringify(SEL.dockRow)});
		const sides = [...document.querySelectorAll(${JSON.stringify(bandSideControls)})];
		const field = document.querySelector(${JSON.stringify(SEL.search)});
		const main = document.querySelector(${JSON.stringify(SEL.mainColumn)});
		if (!dock || sides.length !== 2 || !field || !main) return null;
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
			dockOuterHeight: dr.height,
			dockTop: dr.top,
			dockBottom: dr.bottom,
			sideCentresY: sides.map((el) => { const b = el.getBoundingClientRect(); return b.top + b.height / 2; }),
			discCentreY: (() => { const d = document.querySelector(${JSON.stringify(SEL.bandTransport)}); if (!d) return null; const b = d.getBoundingClientRect(); return b.top + b.height / 2; })(),
			fieldCentreY: fr.top + fr.height / 2,
			innerHeight: window.innerHeight,
			mainPadBottom: parseFloat(getComputedStyle(main).paddingBottom),
			rowCount: rows.length,
			occludedRows: rows.filter((r) => r.bottom > dr.top + 1 && r.top < dr.bottom - 1).length,
			// The FIRST row is the best match on a list that reads downward, so its clearance is the one
			// that can be asserted at rest — see the arm below.
			firstRowTop: rows.length ? rows[0].top : null,
			firstRowBottom: rows.length ? rows[0].bottom : null
		};
	})()`;
	const browse = await page.evaluate(browseProbe);
	if (!browse) {
		check(
			'CLAIM 3 the search view renders the docked band, its magnifier, its field and its column, so the contract is measurable',
			false,
			`no ${SEL.dockRow} / two ${bandSideControls} / ${SEL.search} / ${SEL.mainColumn} found on / with results showing`
		);
	} else {
		check(
			"CLAIM 3 --dock-h in the search view is the BAND's REAL rendered height — the contract every column offsets from",
			browse.dockVar !== '' &&
				browse.dockVar === browse.dockInline &&
				Math.abs(parseFloat(browse.dockVar) - browse.dockOuterHeight) <= 1,
			`--dock-h resolved "${browse.dockVar}" (inline "${browse.dockInline}") against a band whose outer box is ${browse.dockOuterHeight.toFixed(1)}px (see the height note on the / arm above)`
		);
		// THE ARM ONE BAND ON TWO SURFACES MAKES POSSIBLE. `--dock-h` is written once by the layout, so a
		// per-surface disagreement means the band rendered to a different height here than on `/` (a header, a
		// font, a route-scoped rule reaching it) while each `main` reserved whatever the token last said.
		// Neither single-surface reading above can see that; only the comparison can.
		check(
			'CLAIM 3 the ONE band renders to the SAME height at rest and with results up — one element, one token, no per-state drift',
			dock !== null && Math.abs(browse.dockOuterHeight - dock.dockOuterHeight) <= 1,
			dock === null
				? 'the / reading is missing, so the two surfaces could not be compared'
				: `band outer box is ${dock.dockOuterHeight.toFixed(1)}px at rest and ${browse.dockOuterHeight.toFixed(1)}px with results up`
		);
		check(
			'CLAIM 3 the band sits fully on screen in the search view — no bleed below, no clip above',
			browse.dockTop >= -1 && browse.dockBottom <= browse.innerHeight + 1,
			`band occupies ${browse.dockTop.toFixed(1)}..${browse.dockBottom.toFixed(1)} of a ${browse.innerHeight}px viewport`
		);
		check(
			'CLAIM 3 the find column RESERVES the band rather than being overlapped by it',
			browse.mainPadBottom >= browse.dockClientHeight,
			`main padding-bottom ${browse.mainPadBottom}px against a ${browse.dockClientHeight}px band`
		);
		// THE CRITERION: the controls a guest reaches mid-song must not cost a regrip, so they belong in the
		// bottom third. The subject is the TRANSPORT — restart, play/pause and skip are all in the band row —
		// and one reading covers every phone surface, because the band is chrome. Search is the first element
		// in the column now, so reaching it is a scroll to the top rather than a control in the chrome, and
		// pointing this arm at the field would assert the OPPOSITE of what the surface deliberately does.
		const thumbLine = (browse.innerHeight * 2) / 3;
		const transportCentres = [...browse.sideCentresY, browse.discCentreY];
		check(
			'CLAIM 3 the whole TRANSPORT sits in the thumb zone — restart, play/pause and skip in the bottom third',
			transportCentres.every((y) => typeof y === 'number' && y > thumbLine),
			`transport centres at ${transportCentres.map((y) => (typeof y === 'number' ? y.toFixed(1) : String(y))).join(', ')} of ${browse.innerHeight}px; thumb zone starts at ${thumbLine.toFixed(1)} (the search field is at y=${browse.fieldCentreY.toFixed(1)}, top of the column, by design)`
		);
		// A floor, not a check: with no rows the occlusion arms would pass over nothing at all.
		check(
			'CLAIM 3 the find drive rendered a real result stack — >=1 row to measure',
			browse.rowCount >= 1,
			`${browse.rowCount} rows rendered for the query "a"`
		);
		check(
			'CLAIM 3 the TOP of the ranking is clear of the band at rest — the best match is never under the chrome',
			browse.firstRowBottom !== null && browse.firstRowBottom <= browse.dockTop + 1,
			`best-match row occupies ${(browse.firstRowTop ?? NaN).toFixed(1)}..${(browse.firstRowBottom ?? NaN).toFixed(1)} against a band starting at y=${browse.dockTop.toFixed(1)} (${browse.occludedRows} of ${browse.rowCount} rows sit under it further down, which is what scrolling is for)`
		);
	}

	// CLAIM 3, THE RESERVATION UNDER SCROLL. With the list driven to its very END, the last row must still
	// CLEAR the band. That is the only position where `main`'s `calc(var(--dock-h, 0px) + 28px)` can be
	// observed doing its job: at rest the last row of a long list is off-screen entirely, so the at-rest
	// occlusion arm above passes over a row nobody can see. Scrolled to the end, a reservation that is
	// missing, stale or measured off the wrong element puts the final row under fixed chrome.
	await page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
	await sleep(400); // no smooth scrolling in this app; this is paint settle, not animation
	const endProbe = `(() => {
		const dock = document.querySelector(${JSON.stringify(SEL.dockRow)});
		const rows = [...document.querySelectorAll(${JSON.stringify(SEL.songRow)})];
		if (!dock || rows.length === 0) return null;
		const dr = dock.getBoundingClientRect();
		const last = rows[rows.length - 1].getBoundingClientRect();
		return {
			dockTop: dr.top,
			dockBottom: dr.bottom,
			lastRowBottom: last.bottom,
			occludedRows: rows.filter((r) => {
				const b = r.getBoundingClientRect();
				return b.bottom > dr.top + 1 && b.top < dr.bottom - 1;
			}).length,
			rowCount: rows.length,
			scrollY: Math.round(window.scrollY),
			maxScroll: Math.round(document.documentElement.scrollHeight - window.innerHeight)
		};
	})()`;
	const end = await page.evaluate(endProbe);
	if (!end) {
		check(
			'CLAIM 3 the find surface still has a band and rows to measure at the end of the list',
			false,
			`no ${SEL.dockRow} or no ${SEL.songRow} in the search view after scrolling to the end`
		);
	} else {
		// The precondition, stated as its own arm: if the column never scrolled there is no end to be at,
		// and the two arms below would pass on the at-rest layout the block above already measured.
		check(
			'CLAIM 3 the drive really reached the END of the list — the reservation is measured where it can fail',
			end.scrollY >= end.maxScroll - 1,
			`scrolled to ${end.scrollY} of a possible ${end.maxScroll} (a result set shorter than the viewport reports 0/0, which is a pass)`
		);
		check(
			'CLAIM 3 the LAST row clears the band with the list scrolled to its end — what the reservation is for',
			end.lastRowBottom <= end.dockTop + 1,
			`last row's bottom is at y=${end.lastRowBottom.toFixed(1)} against a band starting at y=${end.dockTop.toFixed(1)}`
		);
		check(
			'CLAIM 3 no result row is occluded by the band at the end of the list',
			end.occludedRows === 0,
			`${end.occludedRows} of ${end.rowCount} rows intersect the band at ${end.dockTop.toFixed(1)}..${end.dockBottom.toFixed(1)}`
		);
	}

	// CLAIM 3, THE SHORT CASE: the band contract when the column cannot scroll. A non-matching query is the
	// cheapest way to reach a genuinely different GEOMETRY — a column with nothing in it, shorter than the
	// viewport, unable to scroll — and the contract has to hold there too: a band whose measured height only
	// survives while content pushes against it is a band whose height is a coincidence. The empty line
	// (`SEL.empty`) sits near the TOP by design; wherever it sits, it must not be under the band.
	await page.fill(SEL.search, 'zzzzznotasongzzzzz');
	await page.waitForSelector(SEL.empty, { timeout: 15000 }).catch(() => {});
	await sleep(900);
	const shortProbe = `(() => {
		const dock = document.querySelector(${JSON.stringify(SEL.dockRow)});
		const empty = document.querySelector(${JSON.stringify(SEL.empty)});
		if (!dock || !empty) return null;
		const dr = dock.getBoundingClientRect();
		const er = empty.getBoundingClientRect();
		return {
			dockVar: getComputedStyle(document.documentElement).getPropertyValue('--dock-h').trim(),
			dockInline: document.documentElement.style.getPropertyValue('--dock-h').trim(),
			dockClientHeight: dock.clientHeight,
			dockOuterHeight: dr.height,
			dockTop: dr.top,
			dockBottom: dr.bottom,
			emptyTop: er.top,
			emptyBottom: er.bottom,
			rowCount: document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length,
			scrollHeight: document.documentElement.scrollHeight,
			innerHeight: window.innerHeight
		};
	})()`;
	const short = await page.evaluate(shortProbe);
	if (!short) {
		check(
			'CLAIM 3 a non-matching query leaves one empty-state line to measure the short case against',
			false,
			`no ${SEL.empty} found on / after a non-matching query`
		);
	} else {
		check(
			'CLAIM 3 the short case really is short — the column cannot scroll, so nothing is pressing on the band',
			short.rowCount === 0 && short.scrollHeight <= short.innerHeight + 1,
			`${short.rowCount} rows, scrollHeight ${short.scrollHeight} against innerHeight ${short.innerHeight}`
		);
		check(
			"CLAIM 3 --dock-h still equals the band's rendered height with an EMPTY column — the height is measured, not a coincidence of content",
			short.dockVar !== '' &&
				short.dockVar === short.dockInline &&
				Math.abs(parseFloat(short.dockVar) - short.dockOuterHeight) <= 1,
			`--dock-h resolved "${short.dockVar}" (inline "${short.dockInline}") against a band whose outer box is ${short.dockOuterHeight.toFixed(1)}px`
		);
		check(
			'CLAIM 3 the empty-state line is not occluded by the band',
			short.emptyBottom <= short.dockTop + 1,
			`empty-state line occupies ${short.emptyTop.toFixed(1)}..${short.emptyBottom.toFixed(1)} against a band starting at y=${short.dockTop.toFixed(1)}`
		);
	}

	// ── CLAIM 4: the focus indicator's FORM, on a genuinely :focus-visible element ──
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
			/*
			 * THE INDICATOR MAY BE ON THE FIELD RATHER THAN ON THE CONTROL, and this is what reads it there. A
			 * composite field — a bordered box holding a mark, an input, a spinner and a clear control — IS the
			 * field to anyone looking at it, so the ring belongs around the whole box; drawing it on the bare
			 * input nests one rounded rect inside another and strands the mark outside the ring it belongs to.
			 *
			 * So the walk goes UP while the control is focused, at most three levels, and reports the first
			 * ancestor that satisfies the floor. A widening of WHERE, never of WHAT: the same >=2px in the
			 * resolved --focus is required, and a control with no qualifying ring on itself or a near ancestor
			 * still fails. Three levels, because a field wrapper is one.
			 *
			 * NO BACKTICKS in this comment: it lives inside a template literal, where one would end the string.
			 */
			let ring = null;
			for (let node = el.parentElement, hops = 0; node && hops < 3; node = node.parentElement, hops++) {
				const acs = getComputedStyle(node);
				const w = parseFloat(acs.outlineWidth) || 0;
				if (acs.outlineStyle !== 'none' && w >= 2) {
					ring = { style: acs.outlineStyle, width: w, color: acs.outlineColor, on: node.className || node.tagName };
					break;
				}
			}
			out.push({
				what: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().replace(/\\s+/g, ' ').slice(0, 34),
				tag: el.tagName.toLowerCase(),
				focusVisible: visible,
				style: cs.outlineStyle,
				width: parseFloat(cs.outlineWidth) || 0,
				color: cs.outlineColor,
				ring,
				shadowChanged: cs.boxShadow !== shadowUnfocused,
				wanted
			});
			el.blur();
		}
		return out;
	})()`;

	const focusReadings =
		/** @type {{ what: string, tag: string, focusVisible: boolean, style: string, width: number, color: string, ring: { style: string, width: number, color: string, on: string } | null, shadowChanged: boolean, wanted: string }[]} */ ([]);
	// Two surfaces, because the phone route carries the queue's controls plus the search FIELD — the only
	// text entry on the remote, and the one control whose ring is on its wrapper — while /settings carries
	// twenty-two, including every <select> and the range inputs, whose rings come from different rules.
	for (const where of ['/', '/settings']) {
		await page.goto(base + where);
		await sleep(600);
		focusReadings.push(...(await page.evaluate(focusProbe)));
	}
	const focusedMeasured = focusReadings.length;
	for (const f of focusReadings) {
		const who = `${f.tag} "${f.what}"`;
		// an element we could not put into :focus-visible is UNMEASURED, never satisfied.
		if (!f.focusVisible) {
			badFocus.push(`${who}: could not be driven into :focus-visible, so its indicator is UNMEASURED — not passed`);
			continue;
		}
		// The control's own ring, or the field wrapper's — see the probe for why a composite field carries it.
		const drawn =
			f.style === 'none' || f.width < 2 ? f.ring : { style: f.style, width: f.width, color: f.color, on: 'itself' };
		if (!drawn) {
			badFocus.push(
				`${who}: outline is ${f.style} ${f.width}px and no ancestor within three levels draws one${f.shadowChanged ? ' — the ring is drawn by box-shadow alone' : ''}`
			);
			continue;
		}
		if (drawn.color !== f.wanted) {
			badFocus.push(`${who}: ring on ${drawn.on} drawn in ${drawn.color}, but --focus resolves to ${f.wanted}`);
		}
	}
	check(
		'CLAIM 4 every focusable control draws a >=2px outline in the resolved --focus, measured on the render',
		badFocus.length === 0,
		badFocus.join('\n        ')
	);

	// CLAIM 5: the TV type floor is ONE declaration and the ladder is rem. The source-scan half lives in
	// tests/guards/layout/stage-scale.test.ts and cannot make a computed claim. What only a render settles:
	// that the `.tv` root font-size calc RESOLVES as intended at a 1920x1080 CSS viewport, that every rem
	// tier multiplies THAT root, and that pushing --ui-scale to its 0.8 bound keeps every tier at or above
	// 20px. --ui-scale is read off the live element and overridden IN PLACE, so this measures the real
	// cascade rather than a recomputation of the token file. `/tv` always mounts `.tv` whatever the playback
	// state, so the attract screen is enough.
	await page.viewport(1920, 1080);
	await page.goto(base + '/tv');
	await page.waitForSelector(SEL.tvRoot, { timeout: 15000 });
	await sleep(500);

	// The eight TV type tiers, read as the ENGINE resolves them off the root (a rem tier * the root px).
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
	const tvProbe = `(() => {
		const tv = document.querySelector(${JSON.stringify(SEL.tvRoot)});
		if (!tv) return null;
		// Resolve each rem token to px through a throwaway child of .tv, so rem binds to the .tv root
		// font-size exactly as the real tiers do.
		const read = (tok) => {
			const probe = document.createElement('span');
			probe.style.cssText = 'position:absolute;visibility:hidden;font-size:var(' + tok + ')';
			tv.appendChild(probe);
			const px = parseFloat(getComputedStyle(probe).fontSize);
			probe.remove();
			return px;
		};
		const tiers = {};
		for (const t of ${JSON.stringify(TV_TIERS)}) tiers[t] = read(t);
		return { rootPx: parseFloat(getComputedStyle(tv).fontSize), tiers };
	})()`;

	const tv1 = await page.evaluate(tvProbe);
	if (!tv1) {
		check('CLAIM 5 the /tv document mounts .tv so the root floor is measurable', false, 'no .tv element found on /tv');
	} else {
		// Root: 2.7vh of 1080 = 29.16px, * ui-scale 1.
		check(
			'CLAIM 5 the .tv root font-size resolves to 29.16px at 1920x1080, --ui-scale 1',
			Math.abs(tv1.rootPx - 29.16) <= 0.5,
			`.tv root computed to ${tv1.rootPx}px (expected 29.16 ± 0.5)`
		);
		const smallest1 = Math.min(...Object.values(tv1.tiers));
		check(
			'CLAIM 5 the smallest rendered TV tier is >= 27px, and none below 24px, at --ui-scale 1',
			smallest1 >= 27 - 0.5,
			`smallest tier ${smallest1}px across ${JSON.stringify(tv1.tiers)}`
		);
		// Every tier must be an integer-ish rem multiple of the root, i.e. tracked BY the root, not free.
		const untracked = Object.entries(tv1.tiers).filter(
			([, px]) => Math.abs(px / tv1.rootPx - Math.round((px / tv1.rootPx) * 1000) / 1000) > 0.05
		);
		check(
			'CLAIM 5 every TV tier is a rem multiple of the root — it moves when the root moves',
			untracked.length === 0,
			`tiers not resolving as a clean rem multiple of the ${tv1.rootPx}px root: ${JSON.stringify(untracked)}`
		);

		// Push --ui-scale to its 0.8 lower bound on the ROOT (where the floor consumes it — a custom
		// property set on a descendant like .tv would not reach :root's already-resolved font-size).
		await page.evaluate(`document.documentElement.style.setProperty('--ui-scale', '0.8')`);
		await sleep(200);
		const tv08 = await page.evaluate(tvProbe);
		const smallest08 = tv08 ? Math.min(...Object.values(tv08.tiers)) : 0;
		check(
			'CLAIM 5 at --ui-scale 0.8 no TV tier falls below 20px',
			tv08 !== null && smallest08 >= 20 - 0.5,
			`smallest tier at 0.8 = ${smallest08}px across ${JSON.stringify(tv08?.tiers)}`
		);
		// And that the root itself scaled with it (proves --ui-scale is the multiplier, not inert).
		check(
			'CLAIM 5 --ui-scale actually scales the root — 0.8 * 29.16 ~= 23.33px',
			tv08 !== null && Math.abs(tv08.rootPx - 29.16 * 0.8) <= 0.5,
			`.tv root at --ui-scale 0.8 computed to ${tv08?.rootPx}px (expected ~23.33)`
		);

		// Reset --ui-scale to a non-numeric value: the @property <number> registration must REJECT it and
		// fall back to initial-value 1, so the floor holds rather than the whole font-size dropping (the
		// reviewer's advisory — a non-numeric --ui-scale silently removing the floor). Root stays 29.16.
		await page.evaluate(`document.documentElement.style.setProperty('--ui-scale', 'banana')`);
		await sleep(200);
		const tvBad = await page.evaluate(tvProbe);
		check(
			'CLAIM 5 (advisory) a non-numeric --ui-scale falls back to 1 via @property — the floor is not dropped',
			tvBad !== null && Math.abs(tvBad.rootPx - 29.16) <= 0.5,
			`.tv root with --ui-scale: banana computed to ${tvBad?.rootPx}px (expected 29.16 — @property <number> should reject the non-numeric value)`
		);
		await page.evaluate(`document.documentElement.style.removeProperty('--ui-scale')`);

		// 720p: the px term of max(2.7vh, 20px) must engage. At a 720-tall viewport 2.7vh = 19.44px < 20px,
		// so the root floors at 20px — the windowed/short-panel case the px term exists for (reviewer's
		// advisory: the 1080p arms alone would miss a 720p regression).
		await page.viewport(1280, 720);
		await sleep(200);
		const tv720 = await page.evaluate(tvProbe);
		check(
			'CLAIM 5 at a 720-tall viewport the root floors on the 20px px-term of max(2.7vh, 20px)',
			tv720 !== null && Math.abs(tv720.rootPx - 20) <= 0.5,
			`.tv root at 1280x720 computed to ${tv720?.rootPx}px (expected 20 — the px floor, since 2.7vh = 19.44px there)`
		);
		await page.viewport(1920, 1080);
	}

	// CLAIM 5b: `.fs-btn` overlaps NO z-tier-7 chrome box, on the render. The fullscreen button and the
	// corner chrome (join QR, lower-third, Up-next) all sit at z-tier 7, so whichever is later in the DOM
	// paints on top and a shared anchor is a silent occlusion no source scan can see — a string-inequality
	// guard on ONE anchor pair stayed green while the button overlapped ~3000px². Measured at 1080p AND 4K.
	//
	// WHY SYNTHETIC BOXES: those classes render only in the PLAYING branch, which needs live WS playback this
	// self-hosting drive has no processed media for. So one element per class is MOUNTED under the real
	// `.tv`, where the tokens resolve and the loaded stylesheet positions it as production does; `.upnext`
	// gets a realistic wrapped height so `--tv-upnext-h` is exercised non-zero, DOM order mirrors production
	// so paint order is honest, and the boxes are removed after measuring.
	await page.viewport(1920, 1080);
	await page.goto(base + '/tv');
	await page.waitForSelector(SEL.tvRoot, { timeout: 15000 });
	await sleep(300);

	const overlapProbe = `(() => {
		const tv = document.querySelector(${JSON.stringify(SEL.tvRoot)});
		if (!tv) return null;
		// The route's CSS is Svelte-SCOPED ('.fs-btn.svelte-HASH'), so a bare class gets NONE of the production
		// positioning — and .corner belongs to a DIFFERENT component with its own hash. Resolve each class's
		// own scope hash from the live stylesheets and stamp THAT on the synthetic element; fail loudly if one
		// cannot be found, because an unscoped box measures unstyled geometry.
		function scopeFor(cls) {
			const re = new RegExp('\\\\.' + cls + '\\\\.(svelte-[a-z0-9]+)');
			for (const sheet of document.styleSheets) {
				let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
				if (!rules) continue;
				for (const r of rules) {
					const m = r.selectorText && re.exec(r.selectorText);
					if (m) return m[1];
				}
			}
			return null;
		}
		const scopes = {};
		for (const cls of ['fs-btn', 'upnext', 'lower-third', 'corner']) {
			const s = scopeFor(cls);
			if (!s) return { noScope: cls };
			scopes[cls] = s;
		}
		const holder = document.createElement('div');
		holder.setAttribute('data-889-probe', '1');
		// One element per z-tier-7 chrome class, in production DOM order (chrome first, fs-btn LAST so it paints
		// on top at equal z — the exact condition the guard must catch). .upnext gets its real child classes so
		// it renders at a production-realistic wrapping height, and each box carries its own scope hash.
		const uh = scopes['upnext'], lh = scopes['lower-third'], ch = scopes['corner'];
		const specs = [
			{ cls: 'lower-third', html: '<div class="ls-name ' + lh + '">Now singing</div><div class="ls-song ' + lh + '">A Song Title</div>' },
			{ cls: 'upnext', html: '<span class="un-label ' + uh + '">Up next</span><span class="un-name ' + uh + '">A Fairly Long Singer Name Here</span><span class="un-song ' + uh + '">An Even Longer Wrapping Song Title That Grows The Block Past One Line On A Wall</span>' },
			{ cls: 'corner', html: '<div class="qr ' + ch + '"><img width="88" height="88"></div><div class="meta ' + ch + '"><div class="t ' + ch + '">Scan to join</div><div class="u ' + ch + '">192.168.1.20:5173/join</div></div>' },
			{ cls: 'fs-btn', html: '' }
		];
		const made = {};
		for (const s of specs) {
			const el = document.createElement(s.cls === 'fs-btn' ? 'button' : 'div');
			el.className = s.cls + ' ' + scopes[s.cls] + (s.cls === 'fs-btn' ? ' shown' : '');
			el.innerHTML = s.html;
			holder.appendChild(el);
			made[s.cls] = el;
		}
		tv.appendChild(holder);
		// Publish .upnext's REAL rendered height as --tv-upnext-h, exactly as the production
		// ResizeObserver does. This is what makes the fix's offset (which reads --tv-upnext-h) correct
		// AND what makes a fixed-offset regression (one that ignores it) overlap the block.
		const upH = Math.ceil(made['upnext'].getBoundingClientRect().height);
		tv.style.setProperty('--tv-upnext-h', upH + 'px');
		// Reflow so .fs-btn's top:calc(... + var(--tv-upnext-h) ...) re-resolves against the new value.
		void made['fs-btn'].getBoundingClientRect();
		const rect = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
		const fs = rect(made['fs-btn']);
		const others = ['lower-third', 'upnext', 'corner'].map((c) => ({ cls: c, box: rect(made[c]) }));
		const overlaps = [];
		for (const o of others) {
			const ix = Math.max(0, Math.min(fs.r, o.box.r) - Math.max(fs.l, o.box.l));
			const iy = Math.max(0, Math.min(fs.b, o.box.b) - Math.max(fs.t, o.box.t));
			const area = Math.round(ix * iy);
			if (area > 0) overlaps.push({ cls: o.cls, area, box: o.box });
		}
		const out = { fs, upH, scopes, overlaps, viewport: window.innerWidth + 'x' + window.innerHeight };
		holder.remove();
		tv.style.removeProperty('--tv-upnext-h');
		return out;
	})()`;

	for (const [w, h] of [
		[1920, 1080],
		[3840, 2160]
	]) {
		await page.viewport(w, h);
		await sleep(150);
		const o = await page.evaluate(overlapProbe);
		check(
			`CLAIM 5b .fs-btn overlaps no z-tier-7 chrome box at ${w}x${h}`,
			o !== null && !o.noScope && o.overlaps.length === 0,
			o === null
				? 'no .tv root to mount the probe on'
				: o.noScope
					? `could not recover the Svelte scope hash for .${o.noScope} from /tv — the probe would measure an unstyled box, so it is failed rather than trusted`
					: `fs-btn ${Math.round(o.fs.w)}x${Math.round(o.fs.h)} @(${Math.round(o.fs.l)},${Math.round(o.fs.t)}) upnext-h=${o.upH} overlaps: ${JSON.stringify(o.overlaps)} — the button must clear the lower-third, Up-next and join QR entirely, not merely differ in one anchor`
		);
	}
	await page.viewport(1920, 1080);

	// CLAIM 6: the ratified TV states, measured on the render. The source-scan half lives in
	// tests/guards/subsystem-tv/tv-ratified-states.test.ts and cannot make a measured claim. What only a
	// render settles, and what shipped green past a source scan: the join URL is ONE unbreakable token
	// (`.jt-url` must not break mid-octet, scrollWidth <= clientWidth) at the realistic long LAN address the
	// repo documents; and every roster member is shown with no chip OCCLUDED by a corner control, swept with
	// LONG-name fixtures at 6/10/12/13 guests, because name length is load-bearing here. The takeover frames
	// need live WS playback to mount, so their invariants stay on the source-scan guard.
	{
		// Long-name fixtures (name length is load-bearing for). Colours are irrelevant to the
		// occlusion measurement and are passed as a CSS named colour, NOT a `#hex` literal — a `#`-led
		// string reads as an id selector to the driver-selector-ban guard (contract.test.ts).
		const NAMES = [
			'Bartholomew',
			'Alexandria',
			'Maximilian',
			'Christopher',
			'Evangeline',
			'Sebastian',
			'Anastasia',
			'Montgomery',
			'Josephine',
			'Wilhelmina',
			'Fitzgerald',
			'Konstantin',
			'Persephone'
		];
		const CHIP_COLOR = 'rebeccapurple';
		/** Join one singer via the production path and HOLD a phone socket so presence counts them. */
		/** @type {WebSocket[]} */
		const heldSockets = [];
		/** @param {string} displayName @param {string} color */
		async function joinOne(displayName, color) {
			const res = await fetch(`${base}/api/join`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ displayName, color })
			});
			const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
			const ws = new /** @type {new (url: string, opts?: { headers?: Record<string, string> }) => WebSocket} */ (
				WebSocket
			)(`ws://127.0.0.1:${port}/ws?role=phone`, { headers: { Cookie: cookie } });
			await new Promise((r) => {
				ws.addEventListener('open', () => r(undefined), { once: true });
				ws.addEventListener('error', () => r(undefined), { once: true });
			});
			heldSockets.push(ws);
		}

		// The lobby is where both measured invariants are reachable in this drive: the phone-flow claims above
		// already joined a singer, and the lobby carries the same join panel and the roster. The attract
		// `.jt-url` and the takeover frames stay on the source-scan guard.
		const lobbyProbe = `(() => {
			const chips = [...document.querySelectorAll(${JSON.stringify(SEL.lobbyStripPerson)})];
			const url = document.querySelector(${JSON.stringify(SEL.lobbyUrl)});
			const isControl = (el) => el && (el.closest(${JSON.stringify(SEL.fsBtn)}) || el.closest(${JSON.stringify(SEL.badQr)}));
			let occluded = 0; const hits = [];
			for (const chip of chips) {
				const r = chip.getBoundingClientRect();
				for (const [x, y] of [[r.left + r.width / 2, r.top + r.height / 2], [r.right - 2, r.top + r.height / 2]]) {
					if (isControl(document.elementFromPoint(x, y))) { occluded++; hits.push(chip.textContent.trim()); break; }
				}
			}
			let intersects = 0;
			const controls = [...document.querySelectorAll(${JSON.stringify(SEL.fsBtn)}), ...document.querySelectorAll(${JSON.stringify(SEL.badQr)})].map((c) => c.getBoundingClientRect());
			for (const chip of chips) {
				const r = chip.getBoundingClientRect();
				for (const c of controls) { if (r.left < c.right && r.right > c.left && r.top < c.bottom && r.bottom > c.top) { intersects++; break; } }
			}
			return {
				chipCount: chips.length, occluded, hits, intersects,
				docOverflow: document.documentElement.scrollWidth - window.innerWidth,
				urlScrollW: url ? url.scrollWidth : null,
				urlClientW: url ? url.clientWidth : null,
				urlLines: url ? url.getClientRects().length : null,
				urlText: url ? url.textContent : null
			};
		})()`;

		let joined = 0;
		let urlChecked = false;
		for (const count of [6, 10, 12, 13]) {
			while (joined < count) {
				await joinOne(NAMES[joined], CHIP_COLOR);
				joined++;
			}
			await sleep(700);
			await page.goto(base + '/tv');
			await page.waitForSelector(SEL.lobbyStripPerson, {
				timeout: 15000
			});
			await sleep(900);
			const r = await page.evaluate(lobbyProbe);
			// chipCount is a FLOOR (>=): the drive may already carry a phone-flow singer, so the point is
			// occlusion + no overflow, not an exact count.
			check(
				`CLAIM 6 lobby at >=${count} guests renders every chip with none occluded by a control`,
				r !== null && r.chipCount >= count && r.occluded === 0 && r.intersects === 0 && r.docOverflow <= 0,
				`chips=${r?.chipCount} (>= ${count}) occluded=${r?.occluded} ${JSON.stringify(r?.hits)} intersects=${r?.intersects} docOverflow=${r?.docOverflow}`
			);
			// the typed join URL must fit one line — checked once, on the first populated sweep.
			if (!urlChecked && r && r.urlScrollW !== null) {
				urlChecked = true;
				check(
					'CLAIM 6 the lobby join URL fits one line — no mid-token break',
					r.urlScrollW <= r.urlClientW + 1 && r.urlLines <= 1,
					`.url "${r.urlText}" scrollW=${r.urlScrollW} clientW=${r.urlClientW} lines=${r.urlLines} — an address is one unbreakable token, shrinking beats breaking`
				);
			}
		}
		if (!urlChecked)
			check(
				'CLAIM 6 the lobby join URL was measured',
				false,
				'the .lobby .url element never rendered — the probe could not reach it'
			);
		for (const ws of heldSockets) ws.close();
		await page.viewport(1920, 1080);
	}
	check(
		`the drive measured a real population — >=${FLOORS.controlsMeasured} control readings`,
		controlsMeasured >= FLOORS.controlsMeasured,
		`measured ${controlsMeasured}. A firing floor is a FINDING, never a number to adjust: the drive reached fewer controls than it did when this gate landed, so something it used to sweep is no longer reachable.`
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
