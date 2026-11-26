// CLAIM 9 cold loads in budget, 11 CLS 0 on loads, 12 no flash on loads, 13 gzipped CSS/JS per route.
// Method: docs/E2E.md#speed-gate.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Browser, BrowserContext, Cookie } from '@playwright/test';
import { test, expect, type World } from '../../world/fixtures';
import { SEL } from '../../world/selectors';
import { repoRoot } from '../../world/core';
import { best, flashes, instrumentScript, readState, report, throttle } from './speed-measure';

const PHONE = { width: 390, height: 844 };
const TV = { width: 1920, height: 1080 };

interface LoadRow {
	name: string;
	url: (w: World) => string;
	ready: string;
	viewport: { width: number; height: number };
	cpu: number;
	budgetMs: number;
	reps: number;
	cookies?: 'tv' | 'joined';
	/** This row's CLAIM 12 is gated in its own test, named for the issue that fixed it, so a regression says which. */
	flashGate?: string;
}

const ROWS: LoadRow[] = [
	{
		name: 'open / cold, code box ready',
		url: () => '/',
		ready: '.join-card input',
		viewport: PHONE,
		cpu: 1,
		budgetMs: 1000,
		reps: 5
	},
	{
		name: 'open / cold, code box ready, CPU 4x',
		url: () => '/',
		ready: '.join-card input',
		viewport: PHONE,
		cpu: 4,
		budgetMs: 1000,
		reps: 3
	},
	{
		name: 'open the QR (/?room=CODE) cold, name field ready',
		url: (w) => `/?room=${w.code}`,
		ready: SEL.nameInput,
		viewport: PHONE,
		cpu: 1,
		budgetMs: 1000,
		reps: 5,
		flashGate: '"Finding the room…" on the QR link, #1089'
	},
	{
		name: 'open the QR (/?room=CODE) cold, name field ready, CPU 4x',
		url: (w) => `/?room=${w.code}`,
		ready: SEL.nameInput,
		viewport: PHONE,
		cpu: 4,
		budgetMs: 1000,
		reps: 3,
		flashGate: 'gated on the 1x row, #1089'
	},
	{
		name: 'TV /tv cold, room code ready',
		url: () => '/tv',
		ready: SEL.attractCode,
		viewport: TV,
		cpu: 1,
		budgetMs: 1000,
		reps: 5,
		cookies: 'tv'
	},
	{
		name: 'a joined phone opens /, Sing box ready',
		url: () => '/',
		ready: SEL.search,
		viewport: PHONE,
		cpu: 1,
		budgetMs: 500,
		reps: 5,
		cookies: 'joined'
	},
	{
		name: 'a joined phone opens /queue, heading ready',
		url: () => '/queue',
		ready: SEL.pageHeading,
		viewport: PHONE,
		cpu: 1,
		budgetMs: 500,
		reps: 5,
		cookies: 'joined',
		flashGate: '"Loading the queue…" on a cold /queue, #1090'
	}
];

/** Stamps, from document start, the frame at which `sel` is visible (and not disabled). */
function readyStamp(sel: string) {
	const w = window as unknown as { __readyAt?: number };
	const tick = () => {
		const up = [...document.querySelectorAll<HTMLInputElement>(sel)].some((el) => {
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.height > 0 && el.checkVisibility({ opacityProperty: true }) && !el.disabled;
		});
		if (up) {
			requestAnimationFrame(() => void (w.__readyAt ??= performance.now()));
			return;
		}
		setTimeout(tick, 8);
	};
	tick();
}

async function freshContext(
	browser: Browser,
	world: World,
	row: Pick<LoadRow, 'viewport' | 'cookies'>,
	joined: Cookie[]
) {
	const ctx = await browser.newContext({ viewport: row.viewport, baseURL: world.baseURL });
	if (row.cookies === 'tv') await ctx.addCookies([world.tvCookie]);
	if (row.cookies === 'joined') await ctx.addCookies(joined);
	await ctx.addInitScript(instrumentScript.fn, instrumentScript.arg);
	return ctx;
}

async function coldLoad(browser: Browser, world: World, row: LoadRow, joined: Cookie[]) {
	const ctx: BrowserContext = await freshContext(browser, world, row, joined);
	try {
		await ctx.addInitScript(readyStamp, row.ready);
		const page = await ctx.newPage();
		if (row.cpu > 1) await throttle(page, row.cpu);
		await page.goto(row.url(world), { waitUntil: 'commit' });
		await page
			.waitForFunction(() => (window as unknown as { __readyAt?: number }).__readyAt !== undefined, null, {
				timeout: 20_000
			})
			.catch((e) => {
				throw new Error(`${row.name}: ${row.ready} never became visible on ${page.url()}: ${e}`);
			});
		const readyAt = await page.evaluate(() => (window as unknown as { __readyAt: number }).__readyAt);
		// Room for a late shift or indicator after the control is up.
		await page.waitForTimeout(600);
		const s = await readState(page);
		// In the DOM before the first frame is presented is not yet seen.
		return { ready: Math.max(readyAt, s.fcp ?? 0), cls: s.cls, shifts: s.shifts, flashes: flashes(s.indicators) };
	} finally {
		await ctx.close();
	}
}

async function joinedCookies(browser: Browser, world: World): Promise<Cookie[]> {
	const ctx = await browser.newContext({ viewport: PHONE, baseURL: world.baseURL });
	const page = await ctx.newPage();
	await world.joinAs(page, `Load${Date.now() % 100_000}`);
	const cookies = await ctx.cookies();
	await ctx.close();
	return cookies;
}

// TV first: its room code shows only while the room is empty.
test('CLAIM 9 / 11 / 12 cold loads: primary action within budget, CLS 0, no indicator flash', async ({
	world,
	browser
}) => {
	test.setTimeout(300_000);
	const tvFirst = [...ROWS].sort((a, b) => Number(b.cookies === 'tv') - Number(a.cookies === 'tv'));
	let joined: Cookie[] = [];
	const lines: string[] = [];
	for (const row of tvFirst) {
		if (row.cookies === 'joined' && joined.length === 0) joined = await joinedCookies(browser, world);
		const ready: number[] = [];
		for (let i = 0; i < row.reps; i++) {
			const r = await coldLoad(browser, world, row, joined);
			ready.push(r.ready);
			expect.soft(r.cls, `CLAIM 11 ${row.name}: layout shifts ${JSON.stringify(r.shifts)}`).toBe(0);
			if (row.flashGate) continue; // gated on its own, below
			expect.soft(r.flashes, `CLAIM 12 ${row.name}: an indicator flashed for under 300 ms`).toEqual([]);
		}
		// Reported only: a throttled load swings 2-3x between runs on a loaded host.
		if (row.cpu > 1) {
			lines.push(report(`CLAIM 9 REPORTED ONLY ${row.name}`, ready, row.budgetMs));
			continue;
		}
		lines.push(report(`CLAIM 9 ${row.name}`, ready, row.budgetMs));
		expect
			.soft(best(ready), `CLAIM 9 ${row.name}: the best of ${ready.map(Math.round).join(', ')} ms`)
			.toBeLessThanOrEqual(row.budgetMs);
	}
	console.log(lines.join('\n'));
	await test.info().attach('speed-loads.txt', { body: lines.join('\n'), contentType: 'text/plain' });
});

for (const row of ROWS.filter((r) => r.flashGate && r.cpu === 1)) {
	test(`CLAIM 12 no indicator flash: ${row.flashGate}`, async ({ world, browser }) => {
		const joined = row.cookies === 'joined' ? await joinedCookies(browser, world) : [];
		const seen: unknown[] = [];
		for (let i = 0; i < 3; i++) seen.push(...(await coldLoad(browser, world, { ...row, cpu: 1 }, joined)).flashes);
		expect(seen, `CLAIM 12 ${row.name}: an indicator flashed for under 300 ms`).toEqual([]);
	});
}

// Ceilings on the gzipped bytes, not a margin: headroom differs per route (from about 0.1% to 3%). Only ratchet
// down; raising one needs the owner's ruling.
const BYTES_BUDGET: Record<string, { css: number; js: number }> = {
	// js lowered by 3,000 for #1364: server route resolution dropped the client's manifest of every page. Both lowered
	// again by what #1143 freed, rounded down to 100: the /components stories left the build.
	'/': { css: 19_500, js: 122_500 },
	'/queue': { css: 19_000, js: 129_900 },
	'/tv': { css: 16_100, js: 91_500 }
};

test('CLAIM 13 the CSS and JS each route ships stay under budget', async ({ world, browser }) => {
	test.setTimeout(180_000);
	const routes: [string, 'tv' | 'joined'][] = [
		['/tv', 'tv'],
		['/', 'joined'],
		['/queue', 'joined']
	];
	let joined: Cookie[] = [];
	const lines: string[] = [];
	for (const [path, cookies] of routes) {
		if (cookies === 'joined' && joined.length === 0) joined = await joinedCookies(browser, world);
		const ctx = await freshContext(browser, world, { viewport: path === '/tv' ? TV : PHONE, cookies }, joined);
		const bytes = { css: 0, js: 0 };
		const pending: Promise<void>[] = [];
		const page = await ctx.newPage();
		page.on('response', (r) => {
			const t = r.request().resourceType();
			if (t !== 'stylesheet' && t !== 'script') return;
			if (!r.url().startsWith(world.baseURL)) return;
			pending.push(
				r
					.body()
					.then((b) => void (bytes[t === 'stylesheet' ? 'css' : 'js'] += gzipSync(b).length))
					.catch(() => {})
			);
		});
		await page.goto(path, { waitUntil: 'networkidle' });
		await Promise.all(pending);
		await ctx.close();
		const budget = BYTES_BUDGET[path]!;
		lines.push(
			`CLAIM 13 ${path}: css ${bytes.css} B gz (budget ${budget.css}), js ${bytes.js} B gz (budget ${budget.js})`
		);
		expect.soft(bytes.css, `CLAIM 13 ${path}: gzipped CSS bytes`).toBeLessThanOrEqual(budget.css);
		expect.soft(bytes.js, `CLAIM 13 ${path}: gzipped JS bytes`).toBeLessThanOrEqual(budget.js);
	}
	console.log(lines.join('\n'));
});

// Every route in the build adds server and client bytes, so the dev-only /components stories must not be one (#1143).
test('CLAIM 13 the build carries no /components route', async ({ world, request }) => {
	const manifest = readFileSync(join(repoRoot, 'build/server/manifest.js'), 'utf8');
	expect(manifest, 'CLAIM 13: a /components route is in the built server manifest').not.toContain('/components');
	expect((await request.get(`${world.baseURL}/components/spotlight`)).status()).toBe(404);
});
