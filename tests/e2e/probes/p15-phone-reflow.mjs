// @ts-check
// SC 1.4.10 REFLOW at 320 CSS px and 200% text scale, per surface: `scrollWidth <= clientWidth`, plus
// WHICH element overflowed. Only a driven browser can see it — an overflow here is a SUM of resolved
// lengths that exist after layout, which no scan over declarations can add up; treat
// `tests/guards/layout/phone-inventory.test.ts` as the always-on floor beneath this, not proof of it.
// Doubling the ROOT FONT-SIZE faithfully simulates the guest's text-size setting; page ZOOM does not,
// because it scales the viewport too and cannot expose this class at all.
//
//   bun tests/e2e/probes/p15-phone-reflow.mjs        # self-hosting

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep } from '../driver.mjs';
import { findChromium } from '../lib/chromium.mjs';
import { SEL } from '../contract.ts';
import { openBrowseFromHome } from '../lib/phone.mjs';
import { repoRoot } from '../lib/repo-root.mjs';

/**
 * @typedef {Awaited<ReturnType<typeof connect>>} Browser
 * @typedef {Awaited<ReturnType<Browser['newPage']>>} Page
 * @typedef {{ sel: string, right: number, width: number, text: string }} Offender one overflowing element
 */

const VIEWPORT_W = 320;
const VIEWPORT_H = 480;
const SCALED_ROOT_FONT_SIZE = '32px';

const PORT = Number(process.env.EPORT ?? 5244);
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.SCRATCH ?? join(process.env.KIROCREW_SCRATCH ?? '/tmp', `e2e-reflow-${PORT}`);

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

const chromium = findChromium();
if (!chromium) bail('no Chromium found. Set PW_CHROMIUM.');
// An unbuilt tree serves pages with no app in them, which measure as a clean 320px: a false PASS.
if (!existsSync(join(repoRoot, 'build', 'client')))
	bail(`no built UI at ${join(repoRoot, 'build', 'client')}. Run: bun run build`);

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
		cwd: repoRoot,
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

// ONE pass, so the verdict and the offender list describe the same layout; zero-area elements cannot
// overflow and listing them buries the one that does. A TreeWalker, not a universal query: a driver may
// not spell a selector out for itself, and a universal token has no anchor to put in `contract.ts`.
const READ = `(() => {
	const de = document.documentElement;
	const out = { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, elements: 0, offenders: [] };
	const walk = document.createTreeWalker(de, NodeFilter.SHOW_ELEMENT);
	for (let el = walk.nextNode(); el; el = walk.nextNode()) {
		out.elements++;
		const r = el.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) continue;
		if (r.right <= de.clientWidth + 0.5) continue;
		const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.'): '';
		out.offenders.push({
			sel: el.tagName.toLowerCase() + cls,
			right: Math.round(r.right * 100) / 100,
			width: Math.round(r.width * 100) / 100,
			text: (el.textContent ?? '').trim().slice(0, 40)
		});
	}
	return out;
})()`;

const browser = await connect();
const page = await browser.newPage();
await page.viewport(VIEWPORT_W, VIEWPORT_H, 2);

/** Navigate, scale, settle and read, WITHOUT asserting. `skipNav` measures the page as the caller left it
 *  — re-navigating would wipe that state back to an empty list.
 *  @param {string} label @param {string} path @param {{ skipNav?: boolean }} [opts] */
async function measureRaw(label, path, { skipNav = false } = {}) {
	if (!skipNav) await page.goto(BASE + path);
	// Re-asserted on EVERY surface: a fresh document resets it, so a scale set once measures at 100%.
	await page.evaluate(`document.documentElement.style.fontSize = ${JSON.stringify(SCALED_ROOT_FONT_SIZE)}`);
	await page.waitFor(
		`getComputedStyle(document.documentElement).fontSize === ${JSON.stringify(SCALED_ROOT_FONT_SIZE)}`
	);
	// The app hydrates and THEN fetches, so without this settle the measurement is of a placeholder.
	await sleep(1200);
	/** @type {{ scrollWidth: number, clientWidth: number, elements: number, offenders: Offender[] }} */
	const m = await page.evaluate(READ);
	// Non-vacuity, off the same walk: a page with no app in it measures a clean 320 and PASSES every arm.
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
		// Clean scroll width WITH elements past the right edge means the overflow is CLIPPED, not reflowed.
		check(`${label} has no element clipped past the right edge`, false, detail);
	}
	return m;
}

console.log(`viewport ${VIEWPORT_W}x${VIEWPORT_H} @ DPR 2, root font-size ${SCALED_ROOT_FONT_SIZE}\n`);

// The unjoined `/` IS the join surface, and its six-box code entry is the widest fixed row on it.
await measure('/', '/');
await measure('/settings', '/settings');
await measure('/stats', '/stats');

// Join from INSIDE the page: that is what puts the cookie on this browser CONTEXT, where a fetch from the
// probe process would authenticate the probe instead. Unique name per run, because a duplicate gets a 409
// and leaves the page on the join screen, which measures as a pass. No colour — a hex literal here would
// read to the no-hand-written-selector rule as a selector.
await page.goto(BASE + '/');
const joined = await page.evaluate(`(async () => {
	const res = await fetch('/api/join', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ displayName: 'Reflow' + Date.now().toString().slice(-6) })
	});
	return res.ok;
})()`);
if (!joined) bail('could not join the ephemeral room, so the browse screen could not be measured');

// SEARCH FIRST, so the real offender is on screen: an EMPTY joined room renders no rows, which measures
// a clean 320 over a surface that never grew the label — vacuous, not a pass. The canned result set
// deterministically includes songs past the unusual-duration threshold, so every row carries the chip.
await page.goto(BASE + '/');
await openBrowseFromHome(page);
await page.fill(SEL.search, 'caroline');
// DEBOUNCED fetch: without this wait the read is of a still-empty list, a false clean 320.
const rowsReady = await page
	.waitFor(`document.querySelectorAll(${JSON.stringify(SEL.songRow)}).length >= 1`, { timeout: 12_000 })
	.catch(() => false);
if (rowsReady === false) bail('the browse search returned no rows, so the offender could not be rendered');

await measure('browse (joined /, searched)', '/', { skipNav: true });

await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
	console.log('\nThe 320px reflow requirement is not met.');
	process.exit(1);
}
// Exit EXPLICITLY: the spawned server is a live child, so an implicit exit never comes and this hangs.
process.exit(0);
