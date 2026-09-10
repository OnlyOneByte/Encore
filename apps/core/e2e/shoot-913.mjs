/*
 * SHOOT THE SURFACES #913 CHANGES, on a real render.
 *
 * Not a probe and not a gate: this exists to produce the before/after evidence a reviewer needs for a
 * visual change that was accepted deliberately. It boots the BUILT app with a cooked song, joins in a
 * phone viewport, and shoots the four surfaces whose components this PR replaced.
 *
 * Run it once per tree and diff the pairs:
 *   EPORT=5217 OUT=/tmp/after  bun apps/core/e2e/shoot-913.mjs
 *
 * Deliberately NOT added to any gate list. A screenshot cannot fail a build, and a capture script that
 * pretends to be a check is how a suite grows something nobody reads.
 */
import { spawn as spawnChild } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync } from 'node:fs';
import { readFile as readFileP } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, sleep } from './cdp.mjs';
import { SEL } from './contract.ts';
import { findChromium } from './lib/chromium.mjs';

const PORT = process.env.EPORT ?? '5217';
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = Number(process.env.CDP_PORT ?? 9361);
const CORE = join(import.meta.dirname, '..');
const SCRATCH = process.env.KIROCREW_SCRATCH ?? process.env.TMPDIR ?? '/tmp';
const RUN = join(SCRATCH, `shoot913-${process.pid}`);
const MEDIA = join(RUN, 'media');
const OUT = process.env.OUT ?? join(SCRATCH, 'shoot913-out');

/** @param {string} m @returns {never} */
const bail = (m) => {
	console.error(`ENVIRONMENT: ${m}`);
	process.exit(2);
};
/** @param {() => Promise<unknown>} fn @param {{timeout?:number,name?:string}} [o] */
async function waitFor(fn, { timeout = 30_000, name = 'condition' } = {}) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const v = await fn().catch(() => null);
		if (v) return v;
		await sleep(250);
	}
	throw new Error(`timed out after ${timeout}ms waiting for ${name}`);
}
const alive = async () =>
	await fetch(`${BASE}/health`)
		.then((r) => r.ok)
		.catch(() => false);

let COOKIE = '';
/** @param {string} p @param {RequestInit} [i] */
async function api(p, i = {}) {
	const h = new Headers(i.headers ?? {});
	if (COOKIE) h.set('cookie', COOKIE);
	if (i.body && !h.has('content-type')) h.set('content-type', 'application/json');
	const r = await fetch(`${BASE}${p}`, { ...i, headers: h });
	const sc = r.headers.get('set-cookie');
	if (sc) COOKIE = sc.split(';')[0];
	return r;
}

async function boot() {
	if (await alive()) bail(`something already listens on ${BASE}`);
	mkdirSync(MEDIA, { recursive: true });
	mkdirSync(OUT, { recursive: true });
	await new Promise((res, rej) => {
		const p = spawnChild('bun', ['run', 'e2e/seed-media.mjs'], { cwd: CORE, env: { ...process.env, MEDIA_DIR: MEDIA } });
		p.on('exit', (c) => (c === 0 ? res(null) : rej(new Error(`seed exited ${c}`))));
	});
	const log = join(RUN, 'server.log');
	const proc = spawnChild('bun', ['./server.ts'], {
		cwd: CORE,
		stdio: ['ignore', openSync(log, 'w'), openSync(log, 'a')],
		env: {
			...process.env,
			ENCORE_EPHEMERAL: '1',
			PORT,
			HOST: '127.0.0.1',
			MEDIA_DIR: MEDIA,
			ENCORE_LYRICS_BACKFILL: '0',
			ENCORE_VOCALS_BACKFILL: '0'
		}
	});
	await waitFor(alive, { timeout: 30_000, name: 'server /health' });
	return proc;
}

async function worker() {
	const log = join(RUN, 'worker.log');
	const p = spawnChild('bun', ['e2e/fake-stems-worker.mjs'], {
		cwd: CORE,
		stdio: ['ignore', openSync(log, 'w'), openSync(log, 'a')],
		env: { ...process.env, EPORT: PORT, MEDIA_DIR: MEDIA, FAKE_WORKER_ID: `shoot-${process.pid}`, FAKE_SLOW_MS: '50' }
	});
	const t0 = Date.now();
	while (Date.now() - t0 < 15_000) {
		if ((await readFileP(log, 'utf8').catch(() => '')).includes('welcomed')) return p;
		await sleep(150);
	}
	throw new Error('worker never welcomed');
}

/** @param {string} q */
async function cook(q) {
	const d = await api(`/api/search?q=${encodeURIComponent(q)}`).then((r) => r.json());
	const all = [...(d.ready ?? []), ...(d.results ?? []), ...(d.cooking ?? [])];
	const m = all.find((x) => x.source === 'local') ?? all[0];
	if (!m) throw new Error(`no song for "${q}"`);
	const r = await api('/api/make-karaoke', { method: 'POST', body: JSON.stringify({ mediaId: m.id }) });
	if (!r.ok && r.status !== 409) throw new Error(`make-karaoke ${r.status}`);
	return await waitFor(
		async () => {
			const lib = (await api('/api/library').then((x) => x.json())).library ?? [];
			return lib.find((x) => x.id === m.id && x.stemStatus === 'ready' && x.instrumentalRef);
		},
		{ timeout: 60_000, name: `"${m.title}" ready` }
	);
}

/** @type {import('node:child_process').ChildProcess|undefined} */ let server;
/** @type {import('node:child_process').ChildProcess|undefined} */ let wk;
/** @type {import('node:child_process').ChildProcess|undefined} */ let chrome;
/** @type {any} */ let browser;

/** @param {import('node:child_process').ChildProcess|undefined} p */
async function kill(p) {
	if (!p || p.exitCode !== null) return;
	p.kill('SIGTERM');
	const t0 = Date.now();
	while (p.exitCode === null && Date.now() - t0 < 3000) await sleep(100);
	if (p.exitCode === null) p.kill('SIGKILL');
}

async function main() {
	mkdirSync(RUN, { recursive: true });
	if (!existsSync(join(CORE, 'build'))) bail('apps/core/build is missing — run `bun run build` first');
	const chromium = findChromium();
	if (!chromium) bail('no Chromium found. Set PW_CHROMIUM.');

	server = await boot();
	await api('/api/join', { method: 'POST', body: JSON.stringify({ displayName: 'Api', color: '#ff5cae' }) });
	wk = await worker();
	const song = await cook('caroline');
	await cook('bohemian');
	console.log(`fixture: "${song.title}" ready`);

	chrome = spawnChild(
		chromium,
		[
			`--remote-debugging-port=${CDP_PORT}`,
			'--headless=new',
			'--no-sandbox',
			'--disable-gpu',
			'--no-first-run',
			`--user-data-dir=${join(RUN, 'chrome')}`,
			
			'--autoplay-policy=no-user-gesture-required',
			'about:blank'
		],
		{ stdio: 'ignore' }
	);
	browser = await waitFor(() => connect(CDP_PORT).catch(() => null), { timeout: 20_000, name: 'CDP' });
	const page = await browser.newPage();
	await page.setViewport?.({ width: 390, height: 1500 });

	/**
	 * Shoot the current page into OUT. `fullPage` for the tall surfaces — settings is eleven cards, and
	 * a viewport crop would hide most of what this PR changed.
	 * @param {string} name @param {{ fullPage?: boolean }} [opts]
	 */
	async function shot(name, { fullPage = true } = {}) {
		await sleep(700);
		await page.screenshot(join(OUT, `913-${name}-eyeson.png`), { fullPage });
		console.log(`  shot ${name}`);
	}

	// ── join, in the browser, so the queue op's actor is this session ──
	await page.goto(`${BASE}/`);
	await waitFor(async () => await page.evaluate(`!!document.querySelector(${JSON.stringify(SEL.nameInput)})`), {
		timeout: 15_000,
		name: 'the landing name field'
	});
	await shot('01-landing');

	await page.evaluate(`(() => {
		const el = document.querySelector(${JSON.stringify(SEL.nameInput)});
		const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
		set.call(el, 'Maya');
		el.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
	await sleep(300);
	await page.evaluate(`[...document.querySelectorAll('button')].find((b) => /sing|join|start|continue/i.test((b.textContent||'') + ' ' + (b.getAttribute('aria-label')||'')))?.click()`);
	await waitFor(async () => await page.evaluate(`!!document.querySelector(${JSON.stringify(SEL.hero)})`), {
		timeout: 20_000,
		name: 'joined home'
	});

	// ── home: search results (SongRow → Item/Badge/Progress), then the queue ──
	await page.evaluate(`(() => {
		const i = document.querySelector(${JSON.stringify(SEL.search)});
		if (!i) return;
		const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
		set.call(i, 'caroline');
		i.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
	await sleep(1800);
	await shot('02-home-search');

	await page.evaluate(`document.querySelector(${JSON.stringify(SEL.search)})?.blur()`);
	await page.evaluate(`(() => {
		const i = document.querySelector(${JSON.stringify(SEL.search)});
		if (!i) return;
		const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
		set.call(i, '');
		i.dispatchEvent(new Event('input', { bubbles: true }));
	})()`);
	await sleep(900);
	await shot('03-home-queue');

	// ── settings: the densest surface — Card, Field, NativeSelect, Slider, Checkbox, Tabs ──
	for (const [tab, name] of [
		['party', '04-settings-party'],
		['server', '05-settings-server']
	]) {
		await page.goto(`${BASE}/settings?tab=${tab}`);
		// Either tablist: `.seg` is the hand-rolled one this PR replaces, `[data-slot='tabs-list']` the
		// Bits UI one that replaces it. The script has to run on BOTH trees to produce a pair.
		await waitFor(
			async () => await page.evaluate(`!!document.querySelector("[data-slot='tabs-list'], .seg")`),
			{ timeout: 15_000, name: `settings ${tab}` }
		);
		await shot(name);
	}

	// ── stats: Card + the Trend chart's day buttons ──
	await page.goto(`${BASE}/stats`);
	await sleep(1200);
	await shot('06-stats');

	// ── metrics: Card + Table + Badge ──
	await page.goto(`${BASE}/metrics`);
	await sleep(1200);
	await shot('07-metrics');

	console.log(`\nwrote ${readdirSync(OUT).filter((f) => f.endsWith('.png')).length} shots to ${OUT}`);
}

let code = 0;
try {
	await main();
} catch (err) {
	console.error(`\nSHOOT ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
	console.error(`logs: ${RUN}`);
	code = 1;
} finally {
	try {
		await browser?.close?.();
	} catch {
		// A browser that already died closes with a throw; the children below are killed either way.
	}
	await kill(chrome);
	await kill(wk);
	await kill(server);
}
process.exit(code);
