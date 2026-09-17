/*
 * Preflight audit — measure the properties Tailwind's Preflight RESETS, on every
 * element of every reachable surface, so the before/after answer is a diff rather than an opinion.
 *
 * WHY THIS EXISTS AND NOT JUST SCREENSHOTS. Preflight is a global reset and this app carries ~4,950
 * lines of hand-written CSS. The issue's danger case is a *silent* restyle: a change small enough to
 * survive a side-by-side glance (a heading a few px lighter, a 1px border appearing, a list marker
 * gone) but wrong on every screen. A screenshot pair cannot separate "identical" from "close", and it
 * cannot say WHICH property moved. Preflight's effects, in contrast, are a closed enumerable list, so
 * the honest instrument is to read exactly those computed properties and diff them.
 *
 * Element identity across the two runs is BY INDEX in document order, which is sound here for one
 * reason: this issue adds no markup to any existing surface, so the DOM of every screen below is
 * byte-identical between runs and only the CSS cascade changes. `tag` is recorded beside every row
 * and the differ refuses to compare two runs whose tag sequence disagrees — if a future caller does
 * change markup, that check fails loudly rather than silently pairing the wrong elements.
 *
 *   EPORT=5911 CDP_PORT=9911 bun run tests/e2e/probes/preflight-reset-audit.mjs <outFile.json>
 *
 * Exit codes follow the harness contract (HARNESS.md): 0 measured, 1 a real failure, 2 the
 * environment could not host the probe.
 */
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

/*
 * The properties Preflight writes, and nothing else.
 *
 * Every entry traces to a rule in Tailwind v4's preflight.css: the universal box/margin/padding/border
 * reset; the `h1..h6 { font-size: inherit; font-weight: inherit }` rule; `ol, ul, menu { list-style:
 * none }`; the replaced-element `display: block` rule; the form-control `font: inherit` /
 * `background-color: transparent` / `border-radius: 0` / `appearance: button` block; `a { color:
 * inherit; text-decoration: inherit }`; and `textarea { resize: vertical }`. A property NOT in this
 * list is one Preflight does not touch, so a difference there would be caused by something else and
 * is out of this probe's claim.
 */
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

/*
 * Read every element's Preflight-relevant computed values, plus its box geometry.
 *
 * Geometry is included deliberately: `box-sizing` and the margin reset are the two Preflight rules
 * whose damage is a MOVED BOX rather than a changed declaration, and a computed-value diff alone would
 * report `box-sizing: content-box -> border-box` without saying whether anything actually shifted. The
 * rects answer that, and they are what makes "no visible change" a measurement.
 *
 * Enumerated with a TreeWalker rather than `querySelectorAll('*')`, and not to satisfy a lint: this
 * probe wants EVERY element, which is not a selector question, and `contract.test.ts`'s ban on drivers
 * spelling selectors out for themselves was right to flag the literal. A TreeWalker states the
 * intention directly and names no anchor that could rot, so there is nothing for the contract to own.
 */
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
 * Surfaces to measure. Each is reachable by URL alone — no driving, no state machine — because this
 * probe must produce the SAME population on both runs, and a driven flow is where run-to-run
 * divergence enters. The interactive states (sheet pulled up, hue wheel open) are covered by the
 * frame capture beside this probe; what a reset can only be caught by is the static cascade, and that
 * is what a URL reaches.
 *
 * `join: true` marks a surface behind a session — `/settings` and `/` 303 to `/join` without one. It
 * is worth the one driven step rather than dropping them, because `/settings` is the densest FORM
 * surface in the app and the form-control block (`font: inherit`, `background-color: transparent`,
 * `border-radius: 0`, `appearance: button`) is the half of Preflight most likely to do visible damage.
 * The join itself uses a per-surface unique name — singer names are unique per room (HARNESS.md), and
 * a 409 leaves the flow sitting on /join, which would silently measure the wrong page.
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
const result = { port: PORT, surfaces: {} };
let failed = 0;
// Hoisted out of the try so the `finally` below can close it even when the body throws.
let browser;

try {
	await sleep(1500);
	browser = await connect();
	for (const s of SURFACES) {
		try {
			const page = await browser.newPage();
			await page.viewport(s.vp[0], s.vp[1], 1);
			if (s.join) {
				/*
				 * The one driven step in this probe. Named per surface and per run so a re-run of the
				 * AFTER pass cannot collide with the BEFORE pass's singer (409 → still on /join).
				 */
				await openJoin(page, base);
				await page.fill(SEL.nameInput, `Pf${s.name.replace(/[^a-z]/gi, '')}${RUN_TAG}`);
				await sleep(250);
				await page.clickByRole('button', 'Start singing');
				await page.waitFor(`location.pathname === '/'`);
			}
			await page.goto(base + s.url);
			// a session-gated surface must not be measured as the join landing it fallt
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
	// In the finally, not the try body: a throw above would otherwise leak the browser process, and
	// the audit's own `writeFileSync` below still has to run. `browser` is undefined when `connect()`
	// itself threw, hence the optional chain on the object as well as the method.
	await browser?.close?.();
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(result, null, '\t'));
console.log(`\nwrote ${OUT}`);
process.exit(failed ? 1 : 0);
