/*
 * THE FIFTH GATE — the four measurement claims, measured on real headless Chromium.
 *
 *   bun run gate:measured        # from the repo root, after `bun run build`
 *
 * Exit 0 every check passed · exit 1 anything else. THERE IS NO SKIP PATH, and that is the whole
 * point of it. Owner ruling Q1 was **A**: a fifth gate every lane runs beside `bun test`,
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
 * | 3 docked band | XR-VER-11 | `--dock-h` vs the band's real rendered height, and the safe-area term under a simulated 34px inset |
 * | 4 focus-ring form | XR-VER-12 | computed `outline-style/-width/-color` on a genuinely `:focus-visible` element |
 *
 * None of the four is decidable on the mount rung: happy-dom has no layout engine, and
 * `tests/setup/svelte-dom-preload.ts:101` now replaces `getBoundingClientRect` with a throw naming
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

/**
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {{ tag: string, type: string | null, cls: string, near: string, offscreen: boolean, boxH: number, hitH: number, occluded: number, fontSize: number }} Reading
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
			// A checkbox/radio has no accessible box of its own worth tapping — its tap target is
			// DELEGATED to the wrapping <label> (the pattern touch-targets.test.ts documents: the .check
			// label in settings carries min-height: var(--tap)). So the box we measure for a glyph input
			// is that label, and a hit anywhere on the label counts as reaching the control.
			// Without this, the sweep saw only the 18px glyph and read a 44px label as an 18px false floor.
			const type = (el.getAttribute('type') || '').toLowerCase();
			const glyph = el.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio');
			// A SWITCH IS THE SAME DELEGATION WEARING NEW MARKUP. The shadcn migration replaced the
			// checkbox input with a button carrying role=switch, inside the same label.check — and that
			// label still carries min-height: var(--tap). The Switch component's own comment says why:
			// giving the switch a 44px box would make the row 88px and put two competing targets in it.
			// The reader above was written for an input, stopped recognising the control, and so
			// re-reported an already-closed false positive as an 18.4px box with a 34px hit extent. The
			// delegation follows the CONTROL, not the tag it used to have.
			const switchBtn = el.getAttribute('role') === 'switch';
			// A SLIDER THUMB'S TARGET IS ITS TRACK. Bits UI moves the thumb to wherever the track is
			// pressed, so the thumb's own 22/28px box is not what a finger has to hit — the same
			// substitution, one level of nesting further out. If the slider ROOT is also short this still
			// fails, which is the point: it credits a real target, it does not excuse a small one.
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
			// Vertical hit extent at the CENTRE x. That is the reading the 44px floor is about: WCAG
			// 2.5.8 and Encore's own --tap are both statements about the target's box.
			/*
			 * OFF-VIEWPORT IS NOT ZERO-HEIGHT, and conflating them fabricated failures. document
			 * .elementFromPoint returns null for any point outside the viewport, so a control below the
			 * fold read hitH = 0 and occluded = 3/3 — reported as an unhittable, fully covered target.
			 * /settings' own "Start singing" button is 53px tall and sits at y=861 in an 844px viewport;
			 * it is neither short nor covered, it is simply further down the page.
			 *
			 * A hit extent is a VIEWPORT-RELATIVE reading and cannot be taken for a control whose probe
			 * point is not in the viewport. The test is on the CENTRE POINT rather than on the box, because
			 * the centre point is what is probed: a control straddling the fold intersects the viewport and
			 * still has no hittable centre, which is how the first version of this fix left the same
			 * failure standing at a taller viewport. Its declared box is still credited, so the 44px floor
			 * stays live for every control the sweep sees, and the occlusion probe — meaningless off-screen,
			 * since nothing can cover what is not being painted — is skipped.
			 * Counted in the reading's offscreen flag so the skip cannot quietly absorb a whole surface.
			 */
			const onScreen = cy >= 0 && cy < innerHeight;
			let hitH = onScreen ? 0 : Math.round(tr.height * 10) / 10;
			if (onScreen && inTarget(document.elementFromPoint(cx, cy))) {
				let top = cy, bottom = cy;
				while (top - 1 >= 0 && inTarget(document.elementFromPoint(cx, top - 1))) top--;
				while (bottom + 1 < innerHeight && inTarget(document.elementFromPoint(cx, bottom + 1))) bottom++;
				hitH = bottom - top + 1;
			}
			// Occlusion, as a SEPARATE reading along the widest row. Sweeping the vertical extent at a
			// far-edge x instead measures the chord through the control's own border-radius — Chromium
			// hit-tests the rounded shape — so every pill read 34-42px of a 44px box and the floor was
			// unmeetable by construction. Kept as an occlusion probe, which is what a far-edge reading
			// is actually good for: an overlay covering part of a control.
			let occluded = 0;
			if (onScreen) {
				for (const f of [0.25, 0.5, 0.75]) {
					const x = Math.min(Math.max(Math.round(tr.left + tr.width * f), 0), innerWidth - 1);
					if (!inTarget(document.elementFromPoint(x, cy))) occluded++;
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
		// A routable (non-loopback) public origin so the TV attract renders its REACHABLE join panel
		// (.jt-url), not the loopback .badqr notice — and a realistic long LAN address is exactly the
		// worst case the XR-TV-19 URL-break probe (CLAIM 6) needs to measure.
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


// No CDP port to re-read any more. This used to spawn its own Chromium and recover the port from the
// child's own argv, because the port was chosen with `await freePort()` and only the child knew it. The
// driver launches its own browser and takes no port, so `connect()` needs no argument and there is nothing
// to derive.

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

	// ── join once; every phone surface below is behind a session ───────────────────────────────
	// `/join` was retired (Q2-A): the join form is the unjoined state of `/`. An unjoined visitor
	// to `/` gets the name field + code entry; joining navigates back to `/` (now the joined queue).
	await page.goto(`${base}/`);
	const joinSweep = /** @type {Reading[]} */ (await page.evaluate(sweepExpr()));
	await page.fill(SEL.nameInput, `Gate${Date.now() % 1000000}`);
	await page.clickByRole('button', 'Start singing');
	// Joining lands on the QUEUE — the search box is a screen further in. `homeReady` is the
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
		 * TWO phone surfaces, not one. `/` is the queue — the hero's transport, the position
		 * card and the docked primary button, none of which existed when this gate was written and all of
		 * which are controls these claims are about. The library rows it used to measure here are a screen
		 * further in, so they get their own surface rather than being lost: measuring only `/` would have
		 * quietly stopped measuring every row action, and measuring only the browse screen would never
		 * measure the docked band.
		 */
		await surface('/', async () => {
			await page.goto(base + '/');
			await page.waitForSelector(SEL.homeReady , { timeout: 15000 });
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
	 * ── CLAIM 3 (XR-VER-11): the docked band's published height and its safe-area term ──────────
	 *
	 * WHERE THIS IS MEASURED KEEPS CHANGING, and the claim has not. It began as `--peek-h`/`.peek` on the
	 * QueueSheet; Direction A made the queue the home screen and the 2026-09-09 owner correction moved it
	 * to `--dock-h`/`.search-dock`, a SEARCH band docked at the bottom of `/`; the phone-remote rebuild
	 * moved it again, and this time to something that is no longer route-shaped at all.
	 *
	 * IT IS NOW ONE ELEMENT FOR THE WHOLE APP. `NowPlayingBand` (`SEL.homeReady`, `.band`) is the
	 * bottom-most chrome on EVERY phone surface, mounted by `src/routes/+layout.svelte` inside a `.dock`
	 * wrapper, and the LAYOUT publishes `--dock-h` from that wrapper's `bind:clientHeight`. So no route
	 * publishes the token any more, and the band is the only element in the stack carrying an
	 * `env(safe-area-inset-bottom)` term — which is what makes "published height equals the real rendered
	 * height, and the inset arrives THROUGH that token" a single contract rather than one per screen.
	 *
	 * A later change deleted the drawer surface entirely, so the second half of this section — the sheet's
	 * own cap and peek geometry, measured on `/components` where the component used to render — was
	 * removed with it, and `SHEET_CAP_FRACTION` retired from the register (its reason is recorded
	 * there). Nothing docked caps itself in a viewport fraction now; the band is sized by its content.
	 *
	 * What follows is the contract measured on `/`; the block after it measures the SAME band on `/find`,
	 * which is where search went, and compares the two readings.
	 */
	await page.viewport(390, 844);
	await page.goto(base + '/');
	await page.waitForSelector(SEL.homeReady , { timeout: 15000 });
	await sleep(600); // let the measured --dock-h write land

	const dockProbe = `(() => {
		const dock = document.querySelector(${JSON.stringify(SEL.homeReady)});
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
			innerHeight: window.innerHeight,
			mainPadBottom: parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(SEL.mainColumn)})).paddingBottom)
		};
	})()`;
	const dock = await page.evaluate(dockProbe);
	if (!dock) {
		check(
			'CLAIM 3 the docked band is rendered on the joined home, so its contract is measurable',
			false,
			`no ${SEL.homeReady} found on / — the layout mounts the band for a joined singer, so its absence is either an unjoined drive or the band itself`
		);
	} else {
		/*
		 * WHICH HEIGHT, and it matters by exactly the 1px that would have made this arm red on a correct
		 * app. `--dock-h` is `bind:clientHeight` on the `.dock` WRAPPER (src/routes/+layout.svelte), and
		 * that wrapper has no padding or border of its own, so the token is the band's OUTER box. Read off
		 * `.band` itself, `clientHeight` EXCLUDES its `border-top: 1px solid var(--line)` and so reports one
		 * pixel less than the thing that was published — a comparison that fails while nothing is wrong.
		 * `getBoundingClientRect().height` is the outer box, which is what the publisher measured.
		 *
		 * The 1px tolerance is for the INTEGER rounding `clientHeight` does to a fractional used height, not
		 * slack in the claim: the defect this arm exists to catch — a stale token, a hardcoded guess, a
		 * height published from a different element — is wrong by tens of pixels, never by one. The
		 * computed-vs-inline pair is asserted separately and exactly, because that is the half that says the
		 * value was WRITTEN by the layout's measurement rather than inherited from a stylesheet default.
		 */
		check(
			"CLAIM 3 (XR-VER-11) --dock-h equals the docked band's REAL rendered height — the contract every docked control offsets from",
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
	 * ── CLAIM 3 ON `/find`: THE SAME ONE BAND, MEASURED ON THE SECOND SURFACE ───────────────────
	 *
	 * WHAT MOVED, AND WHY THE CLAIM WIDENED RATHER THAN SHRANK. This section used to measure
	 * `.search-dock`: a SEARCH band docked at the bottom of `/`, publishing `--dock-h` itself, with its
	 * results stacking UPWARD out of it. Both halves of that are gone. Search is the `/find` ROUTE and
	 * its box (`SEL.findBox`) sits at the TOP of the column in NORMAL FLOW — not docked, not sticky —
	 * while `NowPlayingBand` (`SEL.homeReady`, `.band`) is the bottom-most chrome on EVERY phone surface
	 * and `src/routes/+layout.svelte` publishes `--dock-h` from the `.dock` wrapper's measured
	 * `clientHeight`.
	 *
	 * So the subject got SIMPLER and the assertion got WIDER, which is why this is a re-point and not a
	 * retirement. There is exactly one docked band in the app and it is the SAME element here as on `/`,
	 * so XR-VER-11 — "the published height is the real rendered height" — is now asserted on BOTH
	 * surfaces instead of only on the browse screen, and a mismatch on either is the same defect. Both
	 * are worth measuring even though one element publishes the token: the layout WRITES `--dock-h`, but
	 * each route's own `main` CONSUMES it (`calc(var(--dock-h, 0px) + 28px)` in both
	 * `src/routes/+page.svelte` and `src/routes/find/+page.svelte`), so a route that reserves the wrong
	 * thing, or a band that renders to a different height under a different route's header, is a
	 * PER-SURFACE defect a single-surface reading cannot see. And one arm exists only because there are
	 * now two readings of one element: they have to AGREE.
	 *
	 * What still cannot be settled by reading source:
	 *   - whether `--dock-h` equals the band's real rendered height on this surface too, and equals the
	 *     height the same band rendered at on `/`;
	 *   - whether reaching search still costs no regrip. The docked box was the thumb-zone control; the
	 *     band's magnifier is the entry point now, so THAT is the control the reach claim belongs to —
	 *     see the retirement note at the arm for why the find box itself must not be asserted there;
	 *   - whether any result row is occluded by the band — at rest AND with the list scrolled to its very
	 *     end, which is the case `main`'s reservation exists for and the only one where it can fail.
	 *
	 * The reflow half of the results screen (320px at 200% text) is deliberately NOT re-asserted here:
	 * `src/lib/phone-inventory.test.ts` owns XR-PH-02, and two independent geometry checks of
	 * one criterion is the duplicated-vocabulary shape the spec warns about.
	 */
	await page.viewport(390, 844);
	/*
	 * NAVIGATE, don't type. Search left home, so the old drive — type into `/` and wait out the debounce —
	 * would now be typing at a queue screen that renders no field at all. `openBrowseFromHome` taps the
	 * band's magnifier and waits for the find box, which keeps the ONE place that knows how search is
	 * reached the one place; the helper is deliberately not renamed, so its ~20 call sites (this one
	 * included) survived the move untouched.
	 */
	await openBrowseFromHome(page, { timeout: 15000 });
	await page.fill(SEL.search, 'a');
	await page
		.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length > 0`, { timeout: 15000 })
		.catch(() => {});
	await sleep(800); // the search debounce is 150ms; let the result set land and the rows paint

	// The band's magnifier, built from the contract's own accessible name rather than a second hard-coded
	// string — the same form `lib/phone.mjs` addresses it by, so it can only be reached by the name a
	// screen reader announces.
	const bandMagnifier = `${SEL.homeReady} button[aria-label="${SEL.bandSearch.name}"]`;

	const browseProbe = `(() => {
		const dock = document.querySelector(${JSON.stringify(SEL.homeReady)});
		const mag = document.querySelector(${JSON.stringify(bandMagnifier)});
		const field = document.querySelector(${JSON.stringify(SEL.search)});
		const main = document.querySelector(${JSON.stringify(SEL.mainColumn)});
		if (!dock || !mag || !field || !main) return null;
		const dr = dock.getBoundingClientRect();
		const mr = mag.getBoundingClientRect();
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
			magCentreY: mr.top + mr.height / 2,
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
			'CLAIM 3 the find surface renders the docked band, its magnifier, its field and its column, so the contract is measurable',
			false,
			`no ${SEL.homeReady} / ${bandMagnifier} / ${SEL.search} / ${SEL.mainColumn} found on /find with results showing`
		);
	} else {
		check(
			"CLAIM 3 (XR-VER-11) --dock-h on /find is the BAND's REAL rendered height — the contract every column offsets from",
			browse.dockVar !== '' &&
				browse.dockVar === browse.dockInline &&
				Math.abs(parseFloat(browse.dockVar) - browse.dockOuterHeight) <= 1,
			`--dock-h resolved "${browse.dockVar}" (inline "${browse.dockInline}") against a band whose outer box is ${browse.dockOuterHeight.toFixed(1)}px (see the height note on the / arm above)`
		);
		/*
		 * THE ARM THE NEW ARRANGEMENT ADDED, and it can only exist because there is one band on two
		 * surfaces. `--dock-h` is written once by the layout, so a per-surface disagreement means the band
		 * itself rendered to a different height here than on `/` (a route header, a font, a route-scoped
		 * rule reaching it) while each `main` went on reserving whatever the token last said. Neither
		 * single-surface reading above can see that; only the comparison can.
		 */
		check(
			'CLAIM 3 (XR-VER-11) the ONE band renders to the SAME height on / and on /find — one element, one token, no per-surface drift',
			dock !== null && Math.abs(browse.dockOuterHeight - dock.dockOuterHeight) <= 1,
			dock === null
				? 'the / reading is missing, so the two surfaces could not be compared'
				: `band outer box is ${dock.dockOuterHeight.toFixed(1)}px on / and ${browse.dockOuterHeight.toFixed(1)}px on /find`
		);
		check(
			'CLAIM 3 the band sits fully on screen on /find — no bleed below, no clip above',
			browse.dockTop >= -1 && browse.dockBottom <= browse.innerHeight + 1,
			`band occupies ${browse.dockTop.toFixed(1)}..${browse.dockBottom.toFixed(1)} of a ${browse.innerHeight}px viewport`
		);
		check(
			'CLAIM 3 the find column RESERVES the band rather than being overlapped by it (XR-PH-12)',
			browse.mainPadBottom >= browse.dockClientHeight,
			`main padding-bottom ${browse.mainPadBottom}px against a ${browse.dockClientHeight}px band`
		);
		/*
		 * RE-POINTED, NOT DROPPED: thumb reach now belongs to the band's MAGNIFIER.
		 *
		 * The retired arm read the search INPUT's centre and required it in the bottom third, because a box
		 * docked in the thumb zone was the whole point of that design. Re-pointing it at this surface's
		 * field would assert the OPPOSITE of what `/find` deliberately does — the box is at the top of the
		 * column in normal flow, and the route's own comment records why it is not even sticky. An arm that
		 * demands a design the app rejected is not a preserved claim, it is a false red.
		 *
		 * What the claim was ABOUT survives whole and moved with the control: reaching search must not cost
		 * a regrip. That control is the band's magnifier, which is permanent chrome in the thumb zone on
		 * every phone surface — so this reading also carries for `/`, which is why it is asserted once
		 * rather than on both (two geometry checks of one criterion is the shape this file warns about).
		 */
		check(
			"CLAIM 3 the search ENTRY POINT sits in the thumb zone — the band's magnifier in the bottom third of the viewport",
			browse.magCentreY > (browse.innerHeight * 2) / 3,
			`magnifier centre at y=${browse.magCentreY.toFixed(1)} of ${browse.innerHeight}px; thumb zone starts at ${((browse.innerHeight * 2) / 3).toFixed(1)} (the find field is at y=${browse.fieldCentreY.toFixed(1)}, top of the column, by design)`
		);
		// A floor, not a check: with no rows the occlusion arms would pass over nothing at all.
		check(
			'CLAIM 3 the find drive rendered a real result stack — >=1 row to measure',
			browse.rowCount >= 1,
			`${browse.rowCount} rows rendered for the query "a"`
		);
		/*
		 * RETIRED: "no result row is occluded by the band, at rest" — which required ZERO of the rendered
		 * rows to intersect the band before any scrolling. That was satisfiable only because the browse
		 * screen was BOTTOM-ANCHORED and scrolled itself to the end on every keystroke, so "at rest" and
		 * "at the end of the list" were the same position. `/find` reads downward from a header, so at rest
		 * a list longer than the viewport necessarily continues underneath the band — 2 of 28 rows did, and
		 * the arm redded on a surface that is behaving correctly. Demanding it back would mean demanding a
		 * list no longer than one screen.
		 *
		 * ITS GUARANTEE SPLITS IN TWO, and both halves are asserted rather than dropped. That no row is
		 * PERMANENTLY hidden is the reservation arm below (the last row clears the band once scrolled to
		 * the end) — that is the half that was ever load-bearing. What can still be said at rest is the
		 * half a downward list gets and an upward one never had: the TOP of the ranking, the best match,
		 * is never under the chrome. On the old screen the best match was the row nearest the thumb and
		 * this was free; here it is a real claim about where the column starts.
		 */
		check(
			'CLAIM 3 the TOP of the ranking is clear of the band at rest — the best match is never under the chrome',
			browse.firstRowBottom !== null && browse.firstRowBottom <= browse.dockTop + 1,
			`best-match row occupies ${(browse.firstRowTop ?? NaN).toFixed(1)}..${(browse.firstRowBottom ?? NaN).toFixed(1)} against a band starting at y=${browse.dockTop.toFixed(1)} (${browse.occludedRows} of ${browse.rowCount} rows sit under it further down, which is what scrolling is for)`
		);
	}

	/*
	 * ── CLAIM 3, THE RESERVATION UNDER SCROLL: the successor to the retired upward-stack arm ────
	 *
	 * RETIRED: "the stack ENDS at the dock — the top-ranked row is the one beside the thumb". It required
	 * the last row's bottom to land 0..72px above the band, and it was an assertion about TWO mechanisms
	 * `/find` does not have: a bottom-anchored column (`justify-content: flex-end`) and a scroll-to-bottom
	 * on every result set. Results flow downward from a box at the top now, in ordinary document order, so
	 * a short result set legitimately ends hundreds of pixels above the band and that arm could only red
	 * on a correct app. It is not re-pointed under its old name because the name states the dead
	 * mechanism.
	 *
	 * ITS SURVIVING HALF IS THE ONE THAT MATTERED, and it needs the scroll it used to get for free: with
	 * the list driven to its very END, the last row must still CLEAR the band. That is the only position
	 * where `main`'s `calc(var(--dock-h, 0px) + 28px)` reservation can be observed doing its job — at rest
	 * the last row of a long list is off-screen entirely, so the at-rest occlusion arm above passes over a
	 * row nobody can see. Scrolled to the end, a reservation that is missing, stale, or measured off the
	 * wrong element puts the final row under fixed chrome, which is exactly XR-PH-12's defect.
	 */
	await page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
	await sleep(400); // no smooth scrolling in this app; this is paint settle, not animation
	const endProbe = `(() => {
		const dock = document.querySelector(${JSON.stringify(SEL.homeReady)});
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
			`no ${SEL.homeReady} or no ${SEL.songRow} on /find after scrolling to the end`
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
			'CLAIM 3 (XR-PH-12) the LAST row clears the band with the list scrolled to its end — what the reservation is for',
			end.lastRowBottom <= end.dockTop + 1,
			`last row's bottom is at y=${end.lastRowBottom.toFixed(1)} against a band starting at y=${end.dockTop.toFixed(1)}`
		);
		check(
			'CLAIM 3 no result row is occluded by the band at the end of the list',
			end.occludedRows === 0,
			`${end.occludedRows} of ${end.rowCount} rows intersect the band at ${end.dockTop.toFixed(1)}..${end.dockBottom.toFixed(1)}`
		);
	}

	/*
	 * ── CLAIM 3, THE SHORT CASE: the band contract when the column cannot scroll ────────────────
	 *
	 * RETIRED: "one line of content is anchored beside the thumb, not stranded at the top". It measured
	 * `justify-content: flex-end` on the search column — one empty-state line pushed down beside the
	 * docked box — and the note above it said so outright. `/find` anchors nothing: its `main` is ordinary
	 * flow with the box at the top, so the empty line sits NEAR the top and is meant to. Asserting the old
	 * position would be asserting a design that was reversed.
	 *
	 * THE PROBE IS KEPT AND RE-AIMED, because a non-matching query is still the cheapest way to reach a
	 * genuinely different GEOMETRY — a column with nothing in it, shorter than the viewport, unable to
	 * scroll. XR-VER-11 has to hold there too: a band whose measured height only survives while content
	 * pushes against it is a band whose height is a coincidence. And the empty line, wherever it sits,
	 * must not be under the band. `.empty` is `SEL.empty` (`.encore-empty`) — the find surface renders it
	 * for a query that matched nothing.
	 */
	await page.fill(SEL.search, 'zzzzznotasongzzzzz');
	await page
		.waitForSelector(SEL.empty , { timeout: 15000 })
		.catch(() => {});
	await sleep(900);
	const shortProbe = `(() => {
		const dock = document.querySelector(${JSON.stringify(SEL.homeReady)});
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
			`no ${SEL.empty} found on /find after a non-matching query`
		);
	} else {
		check(
			'CLAIM 3 the short case really is short — the column cannot scroll, so nothing is pressing on the band',
			short.rowCount === 0 && short.scrollHeight <= short.innerHeight + 1,
			`${short.rowCount} rows, scrollHeight ${short.scrollHeight} against innerHeight ${short.innerHeight}`
		);
		check(
			"CLAIM 3 (XR-VER-11) --dock-h still equals the band's rendered height with an EMPTY column — the height is measured, not a coincidence of content",
			short.dockVar !== '' &&
				short.dockVar === short.dockInline &&
				Math.abs(parseFloat(short.dockVar) - short.dockOuterHeight) <= 1,
			`--dock-h resolved "${short.dockVar}" (inline "${short.dockInline}") against a band whose outer box is ${short.dockOuterHeight.toFixed(1)}px`
		);
		check(
			'CLAIM 3 the empty-state line is not occluded by the band (XR-PH-12 with one line of content)',
			short.emptyBottom <= short.dockTop + 1,
			`empty-state line occupies ${short.emptyTop.toFixed(1)}..${short.emptyBottom.toFixed(1)} against a band starting at y=${short.dockTop.toFixed(1)}`
		);
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

	/*
	 * ── CLAIM 5 (XR-TV-01/02): the TV type floor is ONE declaration and the ladder is rem ─
	 *
	 * This is the measured half — the source-scan half (no px literal, tokens are rem, no
	 * per-token viewport term) lives in stage-scale.test.ts and CANNOT make a computed claim. What only a
	 * render can settle: that `.tv { font-size: calc(max(2.7vh, 20px) * clamp(0.8, --ui-scale, 1.6)) }`
	 * actually RESOLVES to 29.16px at a 1920×1080 CSS viewport, that every rem tier multiplies THAT root
	 * (so the smallest rendered tier clears the 27px floor and none clears below 24px), and that pushing
	 * --ui-scale to its 0.8 bound keeps every tier >= 20px — the acceptance criteria verbatim. --ui-scale
	 * is read off the live `.tv` element and overridden in place, so this measures the real cascade, not a
	 * recomputation of the token file.
	 *
	 * Not gated on a room/session: `/tv` always mounts `.tv`, and the tier tokens live on it regardless of
	 * playback state, so the attract screen is enough to read the resolved sizes.
	 */
	await page.viewport(1920, 1080);
	await page.goto(base + '/tv');
	await page.waitForSelector(SEL.tvRoot , { timeout: 15000 });
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
		check(
			'CLAIM 5 the /tv document mounts .tv so the root floor is measurable',
			false,
			'no .tv element found on /tv'
		);
	} else {
		// Root: 2.7vh of 1080 = 29.16px, * ui-scale 1.
		check(
			'CLAIM 5 (XR-TV-01) the .tv root font-size resolves to 29.16px at 1920x1080, --ui-scale 1',
			Math.abs(tv1.rootPx - 29.16) <= 0.5,
			`.tv root computed to ${tv1.rootPx}px (expected 29.16 ± 0.5)`
		);
		const smallest1 = Math.min(...Object.values(tv1.tiers));
		check(
			'CLAIM 5 (XR-TV-01) the smallest rendered TV tier is >= 27px, and none below 24px, at --ui-scale 1',
			smallest1 >= 27 - 0.5,
			`smallest tier ${smallest1}px across ${JSON.stringify(tv1.tiers)}`
		);
		// Every tier must be an integer-ish rem multiple of the root, i.e. tracked BY the root, not free.
		const untracked = Object.entries(tv1.tiers).filter(
			([, px]) => Math.abs(px / tv1.rootPx - Math.round((px / tv1.rootPx) * 1000) / 1000) > 0.05
		);
		check(
			'CLAIM 5 (XR-TV-02) every TV tier is a rem multiple of the root — it moves when the root moves',
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
			'CLAIM 5 (XR-TV-01) at --ui-scale 0.8 no TV tier falls below 20px',
			tv08 !== null && smallest08 >= 20 - 0.5,
			`smallest tier at 0.8 = ${smallest08}px across ${JSON.stringify(tv08?.tiers)}`
		);
		// And that the root itself scaled with it (proves --ui-scale is the multiplier, not inert).
		check(
			'CLAIM 5 (XR-TV-01) --ui-scale actually scales the root — 0.8 * 29.16 ~= 23.33px',
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
			'CLAIM 5 (XR-TV-01) at a 720-tall viewport the root floors on the 20px px-term of max(2.7vh, 20px)',
			tv720 !== null && Math.abs(tv720.rootPx - 20) <= 0.5,
			`.tv root at 1280x720 computed to ${tv720?.rootPx}px (expected 20 — the px floor, since 2.7vh = 19.44px there)`
		);
		await page.viewport(1920, 1080);
	}

	/*
	 * ── CLAIM 5b (XR-TV-889): .fs-btn overlaps NO z-tier-7 chrome box, on the RENDER ─────────────────
	 *
	 * the fullscreen button and the corner chrome (join QR, lower-third, Up-next) all sit at
	 * z-tier 7. Whichever is later in the DOM paints on top at equal z, so a shared anchor is a silent
	 * occlusion a source scan cannot see. The first fix moved the button off the join QR and onto
	 * `.upnext` — a string-inequality guard on ONE anchor pair stayed green while the button still
	 * overlapped ~3000px². This measures the invariant the fix actually claims: `.fs-btn` intersects
	 * NO other z-tier-7 box, at 1080p AND 4K.
	 *
	 * WHY SYNTHETIC BOXES. `.fs-btn` and `.upnext`/`.corner`/`.lower-third` render only in the PLAYING
	 * branch, which needs live WS playback the self-hosting drive has no processed media for (same reason
	 * CLAIM 6 covers only attract/lobby). So the probe MOUNTS one element per class under the real
	 * `.tv` — the tokens (`--tv-safe-x/y`, `--tv-upnext-h`, `--z-tv-card`) resolve on `.tv` and the
	 * loaded /tv stylesheet positions each element exactly as production does. `.upnext` is given a
	 * realistic wrapped height so `--tv-upnext-h` is exercised at a non-zero value. The DOM order
	 * mirrors production (chrome first, `.fs-btn` last) so paint order is honest. Boxes are removed
	 * after measuring so nothing leaks into a later claim.
	 */
	await page.viewport(1920, 1080);
	await page.goto(base + '/tv');
	await page.waitForSelector(SEL.tvRoot , { timeout: 15000 });
	await sleep(300);

	const overlapProbe = `(() => {
		const tv = document.querySelector(${JSON.stringify(SEL.tvRoot)});
		if (!tv) return null;
		// The route's CSS is Svelte-SCOPED: rules are '.fs-btn.svelte-HASH', so a bare class="fs-btn"
		// gets NONE of the production positioning. Worse, .corner belongs to a DIFFERENT component
		// (JoinBadge) with its OWN hash. So resolve each class's own scope hash by scanning the live
		// stylesheets for the rule that positions it, and stamp THAT hash on the synthetic element.
		// Fail loudly if any class's hash cannot be found — an unscoped box measures unstyled geometry.
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
		// One element per z-tier-7 chrome class, in production DOM order (chrome first, fs-btn LAST so it
		// paints on top at equal z — the exact condition the guard must catch). .upnext gets its real
		// child classes so it renders at a production-realistic (multi-line, wrapping) height. Each box
		// carries ITS OWN component's scope hash so the scoped rules actually apply.
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

	for (const [w, h] of [[1920, 1080], [3840, 2160]]) {
		await page.viewport(w, h);
		await sleep(150);
		const o = await page.evaluate(overlapProbe);
		check(
			`CLAIM 5b (XR-TV-889) .fs-btn overlaps no z-tier-7 chrome box at ${w}x${h}`,
			o !== null && !o.noScope && o.overlaps.length === 0,
			o === null
				? 'no .tv root to mount the probe on'
				: o.noScope
					? `could not recover the Svelte scope hash for .${o.noScope} from /tv — the probe would measure an unstyled box, so it is failed rather than trusted`
					: `fs-btn ${Math.round(o.fs.w)}x${Math.round(o.fs.h)} @(${Math.round(o.fs.l)},${Math.round(o.fs.t)}) upnext-h=${o.upH} overlaps: ${JSON.stringify(o.overlaps)} — the button must clear the lower-third, Up-next and join QR entirely, not merely differ in one anchor`
		);
	}
	await page.viewport(1920, 1080);

	/*
	 * ── CLAIM 6 (XR-TV-14 / XR-TV-19): the ratified TV states measured on the render ──────
	 *
	 * The source-scan half (room-code-is-largest, the CSS-gated crossfade, the family borders) lives in
	 * routes/tv/tv-ratified-states.test.ts and CANNOT make a measured claim. What only a render settles,
	 * and what shipped green past a source scan on the first pass:
	 *   • XR-TV-19 — the join URL is one unbreakable token: `.jt-url` must not break mid-octet
	 *     (scrollWidth <= clientWidth), at the realistic long LAN address the repo documents.
	 *   • XR-TV-14 — every roster member is shown with no chip OCCLUDED by a corner control. A name
	 *     painted under .fs-btn is worse than the "+N more" it replaced, and is invisible to a source
	 *     scan. Swept with LONG-name fixtures at 6/10/12/13 guests (name length is load-bearing here).
	 *
	 * The takeover frames (next-up / processing / skipping) need live WS playback to mount and are NOT
	 * driven here — the self-hosting drive has no processed media — so their invariants stay on the
	 * source-scan guard; this gate covers attract and lobby, the two the drive can reach honestly.
	 */
	{
		// Long-name fixtures (name length is load-bearing for XR-TV-14). Colours are irrelevant to the
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

		// The lobby is where the two measured invariants are both reachable in this drive: the phone-flow
		// claims above already joined a singer, so the TV is in the LOBBY (not attract). The lobby carries
		// the same join panel (.url) and the roster, so the URL-no-break (XR-TV-19) and the
		// roster-not-occluded (XR-TV-14) invariants are measured here. The attract `.jt-url` and the three
		// takeover frames stay on the source-scan guard (the takeovers need live WS playback the
		// self-hosting drive has no processed media for).
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
			await page.waitForSelector(SEL.lobbyStripPerson , {
				timeout: 15000
			});
			await sleep(900);
			const r = await page.evaluate(lobbyProbe);
			// chipCount is a FLOOR (>=): the drive may already carry a phone-flow singer, so the point is
			// occlusion + no overflow, not an exact count.
			check(
				`CLAIM 6 (XR-TV-14) lobby at >=${count} guests renders every chip with none occluded by a control`,
				r !== null && r.chipCount >= count && r.occluded === 0 && r.intersects === 0 && r.docOverflow <= 0,
				`chips=${r?.chipCount} (>= ${count}) occluded=${r?.occluded} ${JSON.stringify(r?.hits)} intersects=${r?.intersects} docOverflow=${r?.docOverflow}`
			);
			// XR-TV-19: the typed join URL must fit one line — checked once, on the first populated sweep.
			if (!urlChecked && r && r.urlScrollW !== null) {
				urlChecked = true;
				check(
					'CLAIM 6 (XR-TV-19) the lobby join URL fits one line — no mid-token break',
					r.urlScrollW <= r.urlClientW + 1 && r.urlLines <= 1,
					`.url "${r.urlText}" scrollW=${r.urlScrollW} clientW=${r.urlClientW} lines=${r.urlLines} — an address is one unbreakable token, shrinking beats breaking`
				);
			}
		}
		if (!urlChecked)
			check(
				'CLAIM 6 (XR-TV-19) the lobby join URL was measured',
				false,
				'the .lobby .url element never rendered — the probe could not reach it'
			);
		for (const ws of heldSockets) ws.close();
		await page.viewport(1920, 1080);
	}
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
