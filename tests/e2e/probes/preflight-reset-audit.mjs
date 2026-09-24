// Measure the properties Tailwind's Preflight RESETS, on every element of every reachable surface, so a
// before/after answer is a diff rather than an opinion. Element identity across two runs is BY INDEX in
// document order, which holds only while the DOM is unchanged, so `tag` is recorded beside every row and
// `preflight-diff.mjs` refuses to compare runs whose tag sequence disagrees.
//
//   EPORT=5911 bun run tests/e2e/probes/preflight-reset-audit.mjs <outFile.json>

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { connect, sleep } from '../driver.mjs';
import { SEL } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';
import { openJoin } from '../lib/join.mjs';

const PORT = process.env.EPORT ?? '3000';
const base = `http://127.0.0.1:${PORT}`;
/** Distinguishes this run's singers from any other run against the same room. */
const RUN_TAG = process.env.RUN_TAG ?? 'x';
const OUT = process.argv[2];
if (!OUT) {
	console.error('usage: preflight-reset-audit.mjs <outFile.json>');
	process.exit(2);
}

const chromium = findChromium();
if (!chromium) {
	console.error('No Chromium found. Set PW_CHROMIUM and re-run.');
	process.exit(2);
}
if (!(await fetch(`${base}/health`).catch(() => null))?.ok) {
	console.error(`No Encore server on ${base}.`);
	process.exit(2);
}

// The properties Preflight writes, and nothing else — one per rule in Tailwind v4's preflight.css. A
// property NOT here is one Preflight does not touch, so a difference there is outside this probe's claim.
const PROPS = [
	'box-sizing',
	'margin-top',
	'margin-right',
	'margin-bottom',
	'margin-left',
	'padding-top',
	'padding-right',
	'padding-bottom',
	'padding-left',
	'border-top-width',
	'border-right-width',
	'border-bottom-width',
	'border-left-width',
	'border-top-style',
	'border-top-color',
	'border-radius',
	'font-size',
	'font-weight',
	'font-family',
	'line-height',
	'letter-spacing',
	'list-style-type',
	'display',
	'max-width',
	'height',
	'width',
	'color',
	'background-color',
	'appearance',
	'text-decoration-line',
	'resize',
	'vertical-align',
	'text-indent',
	'border-collapse',
	'tab-size',
	'opacity'
];

// Computed values PLUS box geometry: `box-sizing` and the margin reset do their damage as a MOVED BOX, not
// a changed declaration, so the rects are what make "no visible change" a measurement. A TreeWalker, not
// a universal query — this wants EVERY element, and a universal token has no anchor the contract can own.
const READ = `((props) => {
  const out = [];
  const els = [document.documentElement];
  const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
  while (w.nextNode()) els.push(w.currentNode);
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const row = {
      i,
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === 'string' ? el.className : '').split(/\\s+/).filter(t => t && !/^svelte-/.test(t)).join(' '),
      rect: [Math.round(r.x * 100) / 100, Math.round(r.y * 100) / 100, Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100],
      s: {}
    };
    for (const p of props) row.s[p] = cs.getPropertyValue(p);
    out.push(row);
  }
  return { count: els.length, els: out, scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight };
})(${JSON.stringify(PROPS)})`;

/** @type {readonly [number, number]} */
const PHONE = [430, 860];
/** @type {readonly [number, number]} */
const TV = [1920, 1080];

/**
 * Reachable by URL alone — no driving, no state machine — because both runs must produce the SAME
 * population, and a driven flow is where run-to-run divergence enters. `join: true` earns its one driven
 * step because `/settings` is the densest FORM surface and Preflight's form-control block is the half most
 * likely to do visible damage; its name is unique per surface AND per run, because a duplicate gets a 409
 * and leaves the flow on the join screen, measuring the wrong page.
 */
const SURFACES = [
	{ name: 'phone-home', url: '/', vp: PHONE, join: true },
	{ name: 'phone-join', url: '/', vp: PHONE },
	{ name: 'settings', url: '/settings', vp: PHONE, join: true },
	{ name: 'stats', url: '/stats', vp: PHONE },
	{ name: 'metrics', url: '/metrics', vp: PHONE },
	{ name: 'gallery', url: '/components', vp: PHONE },
	{ name: 'gallery-wide', url: '/components', vp: TV },
	{ name: 'tv', url: '/tv', vp: TV }
];

/** @type {Record<string, unknown>} */
/** @type {{ port: string, surfaces: Record<string, Record<string, unknown>> }} */
const result = { port: PORT, surfaces: {} };
let failed = 0;
let browser;

try {
	await sleep(1500);
	browser = await connect();
	for (const s of SURFACES) {
		try {
			const page = await browser.newPage();
			await page.viewport(s.vp[0], s.vp[1], 1);
			if (s.join) {
				await openJoin(page, base);
				await page.fill(SEL.nameInput, `Pf${s.name.replace(/[^a-z]/gi, '')}${RUN_TAG}`);
				await sleep(250);
				await page.clickByRole('button', 'Start singing');
				await page.waitFor(`location.pathname === '/'`);
			}
			await page.goto(base + s.url);
			// A session-gated surface must never be measured as the join landing it fell back to.
			const landed = await page.evaluate('location.pathname');
			if (s.join && landed !== s.url) throw new Error(`redirected to ${landed} — join did not take`);
			// settle: fonts, the socket's first frame, and any mount-time style write (--dock-h etc.)
			await sleep(2500);
			const data = await page.evaluate(READ);
			result.surfaces[s.name] = { url: s.url, vp: s.vp, ...data };
			console.log(`  ✓ ${s.name} — ${data.count} elements`);
		} catch (err) {
			failed++;
			result.surfaces[s.name] = { url: s.url, error: String(err).split('\n')[0] };
			console.log(`  ✗ ${s.name} — ${String(err).split('\n')[0]}`);
		}
	}
} finally {
	// In the `finally`, not the body: a throw above would leak the browser and the `writeFileSync` below
	// still has to run. `browser` is undefined when `connect()` threw, hence the chain on the object too.
	await browser?.close?.();
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, '\t'));
console.log(`\nwrote ${OUT}`);
process.exit(failed ? 1 : 0);
