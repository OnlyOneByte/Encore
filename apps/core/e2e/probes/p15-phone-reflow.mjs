// @ts-check
/*
 * XR-PH-02 — REFLOW AT 320 CSS px AND 200% TEXT SCALE, MEASURED.
 *
 * `docs/ux/02-phone.md` XR-PH-02 asks that every phone surface reflow at a 320px viewport with the
 * guest's text size at 200%: `scrollWidth <= clientWidth` on the scrolling element, no clipping, no
 * horizontal scrollbar (SC 1.4.10 Reflow, AA). Its own Check row says the measurement is
 * "Rendered-DOM or driven-browser measurement. **Not a source scan** — both halves are geometry",
 * and defers to the rendered rung XR-PH-21. This file is that rendered rung for the reflow half.
 *
 * WHY IT HAD TO BE A DRIVEN BROWSER (issue #850). `/stats` overflowed a 320px viewport by 8px at 200%
 * while `phone-inventory.test.ts`'s XR-PH-02 arm was green, and that arm was not broken: it flags a
 * single declaration wider than 320px, and this overflow was a SUM — two grid tracks plus two cards'
 * padding, against a word that cannot wrap once type doubles. No scan over declarations can add that
 * up, because the addends are resolved lengths that only exist after layout. Read the scan arm as the
 * cheap always-on floor beneath this probe, never as proof of the row.
 *
 * WHAT IT MEASURES, and why each number is here. Per surface, at 320x480 DPR 2 with
 * `documentElement.style.fontSize = '32px'`:
 *
 *   • `documentElement.scrollWidth` vs `clientWidth` — the criterion itself. An overflow anywhere in
 *     the page raises the scroll width of the scrolling element, so this one number is the whole row.
 *   • every visible element whose `right` exceeds `clientWidth` — WHICH element, so a failure names a
 *     selector to fix instead of a page to hunt through. A bare scroll-width delta is a true failure
 *     report and a useless one.
 *
 * 32px is the faithful simulation: SC 1.4.4 concerns the guest's own text-size setting, which scales
 * `rem`/`em` and not an absolute `px`, and every phone text rule sizes in `rem` against an `html` that
 * declares no font-size. Doubling the root font-size is therefore exactly what the setting does. It is
 * NOT the same as page zoom, which scales the viewport too and cannot expose this class at all.
 *
 * SELF-HOSTING: boots its own ephemeral server and its own Chromium on ports it owns, so there is no
 * fixture to prepare. It needs no cooked song and no worker — the tiles render at zero.
 *
 *   bun apps/core/e2e/probes/p15-phone-reflow.mjs
 *
 * Exit 0 every surface reflows / 1 at least one overflows / 2 the environment could not host it.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect, sleep } from '../cdp.mjs';
import { findChromium } from '../lib/chromium.mjs';
import { SEL } from '../contract.ts';
import { openBrowseFromHome } from '../lib/phone.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * A single offending element as read in-page; every field comes from a getBoundingClientRect.
 * @typedef {{ sel: string, right: number, width: number, text: string }} Offender
 */

// The criterion's own numbers. 320 CSS px is SC 1.4.10's width; 32px is 200% of the 16px default.
const VIEWPORT_W = 320;
const VIEWPORT_H = 480;
const SCALED_ROOT_FONT_SIZE = '32px';

const PORT = Number(process.env.EPORT ?? 5244);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9455);
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.SCRATCH ?? join(process.env.KIROCREW_SCRATCH ?? '/tmp', `e2e-reflow-${PORT}`);
const CORE = resolve(new URL('../..', import.meta.url).pathname); // apps/core

/** @type {{ name: string, ok: boolean }[]} */
const checks = [];
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail) {
	checks.push({ name, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
	if (!ok && detail) console.log(detail);
}
/** @param {string} msg @returns {never} */
function bail(msg) {
	console.error(`\nENVIRONMENT: ${msg}`);
	process.exit(2);
}

// ── environment ────────────────────────────────────────────────────────────
const chromium = findChromium();
if (!chromium) bail('no Chromium found. Set PW_CHROMIUM.');
// The server serves the BUILT UI, so an unbuilt tree yields pages with no app in them — which would
// measure as a trivially-reflowing 320px and report PASS. Exit 2, loudly, rather than green.
if (!existsSync(join(CORE, 'build', 'client')))
	bail(`no built UI at ${join(CORE, 'build', 'client')}. Run: bun run build`);

/** @type {import('node:child_process').ChildProcess[]} */
const spawned = [];
function killAll() {
	for (const p of spawned) {
		try {
			if (p.pid && !p.killed) process.kill(p.pid, 'SIGKILL');
		} catch {
			// already gone — nothing to reap
		}
	}
	spawned.length = 0;
}
process.on('exit', killAll);
process.on('SIGINT', () => {
	killAll();
	process.exit(130);
});

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(join(SCRATCH, 'media'), { recursive: true });

spawned.push(
	spawn('bun', ['run', './server.ts'], {
		cwd: CORE,
		stdio: 'ignore',
		env: {
			...process.env,
			ENCORE_EPHEMERAL: '1',
			PORT: String(PORT),
			HOST: '127.0.0.1',
			MEDIA_DIR: join(SCRATCH, 'media'),
			ENCORE_LYRICS_BACKFILL: '0',
			ENCORE_VOCALS_BACKFILL: '0'
		}
	})
);
let up = false;
for (let i = 0; i < 60 && !up; i++) {
	up = !!(await fetch(`${BASE}/health`).catch(() => null))?.ok;
	if (!up) await sleep(500);
}
if (!up) bail(`the ephemeral server never became healthy on ${BASE}`);

spawned.push(
	spawn(
		chromium,
		[
			`--remote-debugging-port=${CDP_PORT}`,
			'--headless=new',
			'--no-sandbox',
			'--disable-gpu',
			// Scrollbar chrome is not content: a visible one would eat viewport width and shift every
			// measurement, and the criterion is about whether a scrollbar is NEEDED, not drawn.
			'--hide-scrollbars',
			'--no-first-run',
			`--user-data-dir=${join(SCRATCH, `prof-${process.pid}`)}`,
			'about:blank'
		],
		{ stdio: 'ignore' }
	)
);

// ── the measurement ────────────────────────────────────────────────────────
/*
 * Read in ONE pass over the live DOM so the scroll-width verdict and the offender list describe the
 * same layout. Zero-area elements are skipped: an `<svelte:head>` leftover or a collapsed wrapper has
 * no rect to overflow with, and listing them buries the element that actually does.
 *
 * The walk is a TreeWalker rather than a universal query, deliberately. `contract.test.ts` bans a
 * driver from spelling a selector out for itself, and a universal token is the one shape that cannot be
 * put in `contract.ts` instead — it has no anchor to resolve against, which is why p10's own universal
 * read sits quarantined there. A TreeWalker enumerates every element without naming a selector at all,
 * so this probe needs no quarantine entry and no exemption.
 */
const READ = `(() => {
	const de = document.documentElement;
	const out = { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, elements: 0, offenders: [] };
	const walk = document.createTreeWalker(de, NodeFilter.SHOW_ELEMENT);
	for (let el = walk.nextNode(); el; el = walk.nextNode()) {
		out.elements++;
		const r = el.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) continue;
		if (r.right <= de.clientWidth + 0.5) continue;
		const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
		out.offenders.push({
			sel: el.tagName.toLowerCase() + cls,
			right: Math.round(r.right * 100) / 100,
			width: Math.round(r.width * 100) / 100,
			text: (el.textContent ?? '').trim().slice(0, 40)
		});
	}
	return out;
})()`;

const browser = await connect(CDP_PORT);
const page = await browser.newPage();
await page.viewport(VIEWPORT_W, VIEWPORT_H, 2);

/**
 * Navigate, apply the scale, settle, and read. Returns the measurement WITHOUT asserting on it.
 * `skipNav` measures the page AS IT STANDS (already navigated and populated by the caller — e.g. the
 * browse screen after a search), because re-navigating would wipe that state back to an empty list.
 * @param {string} label @param {string} path @param {{ skipNav?: boolean }} [opts]
 */
async function measureRaw(label, path, { skipNav = false } = {}) {
	if (!skipNav) await page.goto(BASE + path);
	// The root font-size is set AFTER navigation and re-asserted on every surface, because a fresh
	// document resets it — a scale set once and assumed to persist measures the page at 100%.
	await page.evaluate(`document.documentElement.style.fontSize = ${JSON.stringify(SCALED_ROOT_FONT_SIZE)}`);
	await page.waitFor(
		`getComputedStyle(document.documentElement).fontSize === ${JSON.stringify(SCALED_ROOT_FONT_SIZE)}`
	);
	// This app hydrates and then fetches, so the tiles/rows that carry the overflow appear after
	// readyState complete. Settle before reading, or the measurement is of a loading placeholder.
	await sleep(1200);
	/** @type {{ scrollWidth: number, clientWidth: number, elements: number, offenders: Offender[] }} */
	const m = await page.evaluate(READ);
	// A page with no app in it measures as a trivially-clean 320 and would report PASS on every arm, so
	// prove the surface actually rendered before believing its width. The count comes from the same walk
	// that took the measurement, so it cannot describe a different document.
	if (m.elements < 10) bail(`${label} rendered only ${m.elements} elements — the surface is not there to measure`);
	return m;
}

/** @param {string} label @param {string} path @param {{ skipNav?: boolean }} [opts] */
async function measure(label, path, opts) {
	const m = await measureRaw(label, path, opts);
	const ok = m.scrollWidth <= m.clientWidth;
	const detail = [
		`        scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth} (over by ${m.scrollWidth - m.clientWidth}px)`,
		...m.offenders.map((o) => `        · ${o.sel}  right=${o.right} width=${o.width}  ${JSON.stringify(o.text)}`)
	].join('\n');
	check(
		`${label} reflows at ${VIEWPORT_W}px with root font-size ${SCALED_ROOT_FONT_SIZE} (scrollWidth <= clientWidth)`,
		ok,
		detail
	);
	if (ok && m.offenders.length) {
		// A clean scroll width with elements past the right edge means something is clipping the
		// overflow rather than reflowing it — content loss, which the row forbids just as plainly.
		check(`${label} has no element clipped past the right edge`, false, detail);
	}
	return m;
}

console.log(`viewport ${VIEWPORT_W}x${VIEWPORT_H} @ DPR 2, root font-size ${SCALED_ROOT_FONT_SIZE}\n`);

await measure('/', '/');
await measure('/join', '/join');
await measure('/settings', '/settings');
await measure('/stats', '/stats');

/*
 * The browse screen is `/` with a session, which is a different layout from the unjoined `/` above —
 * it adds the search dock and the queue peek, the two bottom-docked bands XR-PH-02's rationale names.
 * Joining from inside the page is what puts the cookie on this context; a fetch from the probe process
 * would authenticate the probe and leave the browser unjoined. A unique name per run: singer names are
 * unique per room and a 409 leaves the page sitting on the join screen, which measures as a pass. No
 * colour is sent: join normalizes an absent one to a default, and a hex literal here would read to
 * contract.test.ts's shape rule as a hand-written selector.
 */
await page.goto(BASE + '/join');
const joined = await page.evaluate(`(async () => {
	const res = await fetch('/api/join', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ displayName: 'Reflow' + Date.now().toString().slice(-6) })
	});
	return res.ok;
})()`);
if (!joined) bail('could not join the ephemeral room, so the browse screen could not be measured');

/*
 * MEASURE BROWSE WITH ITS REAL OFFENDER ON SCREEN (#857). The browse-screen reflow lives in SongRow's
 * control labels at doubled type, and the widest is the odd-duration chip: a whole phrase ("Longer
 * than a song") that `.chip`'s blanket `white-space: nowrap` turned into an unshrinkable ~230px box,
 * pushing the row — and the browse page — past a 320px viewport. An EMPTY joined room renders no rows
 * at all, so measuring it would be a clean 320 over a surface that never grew the label the criterion
 * is about — the XR-VER-05 vacuity #850 exists to forbid, and the reason this arm was rejected once.
 *
 * So the arm SEARCHES first. `openBrowseFromHome` is the shared post-join step (#832) — it reaches the
 * browse screen and its search box the one sanctioned way — and typing into `SEL.search` surfaces the
 * canned result set, which deterministically includes songs past the 8-minute unusual-duration
 * threshold (`isUnusualSongDuration`); every one renders the odd-duration chip. Both the browse push
 * and the query go through the contract's own hooks, so no hand-written selector enters this driver.
 * This is the discriminating measurement: it REDS on the base CSS (the chip cannot wrap → scrollWidth
 * 331 > 320) and passes on the fix (the chip wraps).
 */
await page.goto(BASE + '/');
await openBrowseFromHome(page);
await page.fill(SEL.search, 'caroline');
// The result set arrives over a debounced fetch; wait for the rows to actually land before measuring,
// or the read is of a still-empty list (a false clean 320). A room that returned no results at all is
// an environment failure, not a pass. The row count reads the contract's own `SEL.songRow`.
const rowsReady = await page
	.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length >= 1`, { timeout: 12_000 })
	.catch(() => false);
if (rowsReady === false) bail('the browse search returned no rows, so the #857 offender could not be rendered');

await measure('browse (joined /, searched)', '/?browse=1', { skipNav: true });

await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
	console.log('\nXR-PH-02 (docs/ux/02-phone.md) is not met — see docs/ux/04-verification.md for the rung.');
	process.exit(1);
}
// Exit explicitly. The spawned server and browser are live child processes, so an implicit exit never
// comes — the probe would print a verdict and then hang, which reads to a caller as a failure to run.
// killAll() is registered on 'exit' and reaps both.
process.exit(0);
