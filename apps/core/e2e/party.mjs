// M6-C3 full-flow e2e: two phones + a TV. join -> search -> queue (round-robin) -> play ->
// advance. Run against a live server on $EPORT. Exits non-zero on any failed assertion.
// (Kept as a runnable script rather than a Playwright-runner suite to reuse the cached chromium;
//  CI would wire this behind `playwright test`.)
import { chromium } from 'playwright-core';

const P = process.env.EPORT;
const base = `http://localhost:${P}`;
const checks = [];
function check(name, cond) {
	checks.push({ name, ok: !!cond });
	console.log(`${cond ? '✅' : '❌'} ${name}`);
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext();

async function joinAs(name, colorHex) {
	const page = await ctx.newPage();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${base}/join`, { waitUntil: 'networkidle' });
	await page.fill('input', name);
	await page.getByRole('button', { name: `color ${colorHex}` }).click();
	await page.getByRole('button', { name: /Start singing/ }).click();
	await page.waitForURL(`${base}/`);
	await page.waitForTimeout(700);
	return page;
}

// --- two phones join ---
const maya = await joinAs('Maya', '#ff5cae');
const sam = await joinAs('Sam', '#33d6a6');
check('two phones joined', true);

// --- Maya searches the Library and queues a song ---
await maya.getByRole('button', { name: 'Library' }).click();
await maya.fill('input[placeholder^="Search"]', 'caroline');
await maya.waitForTimeout(500);
const mayaResults = await maya.locator('.result .t').count();
check('search returns Library results', mayaResults > 0);
await maya.locator('.result .add').first().click();
await maya.waitForTimeout(500);

// --- Sam queues one too ---
await sam.getByRole('button', { name: 'Library' }).click();
await sam.fill('input[placeholder^="Search"]', 'believin');
await sam.waitForTimeout(500);
await sam.locator('.result .add').first().click();
await sam.waitForTimeout(600);

// --- both phones see BOTH songs (cross-client sync) in round-robin order ---
const mayaQueue = await maya.locator('.qrow .t').allTextContents();
const samQueue = await sam.locator('.qrow .t').allTextContents();
check('Maya sees 2 queued songs', mayaQueue.length === 2);
check('Sam sees the same 2 songs (synced)', samQueue.length === 2);
check('rotation order matches across phones', JSON.stringify(mayaQueue) === JSON.stringify(samQueue));

// --- TV joins, starts playback, shows now-singing ---
const tv = await ctx.newPage();
await tv.setViewportSize({ width: 1280, height: 720 });
await tv.goto(`${base}/tv`, { waitUntil: 'networkidle' });
await tv.waitForTimeout(700);
await maya.evaluate(() => new Promise((r) => { const ws = new WebSocket(`ws://${location.host}/ws?role=phone`); ws.onopen = () => { ws.send(JSON.stringify({ type: 'player:command', command: { cmd: 'play' } })); setTimeout(r, 300); }; }));
await tv.waitForTimeout(1200);
const lt1 = await tv.locator('.lower-third').count();
const song1 = await tv.locator('.ls-song').innerText().catch(() => '');
check('TV shows now-singing lower-third on play', lt1 === 1);

// --- skip advances to the next singer's song (round-robin) ---
await maya.evaluate(() => new Promise((r) => { const ws = new WebSocket(`ws://${location.host}/ws?role=phone`); ws.onopen = () => { ws.send(JSON.stringify({ type: 'player:command', command: { cmd: 'skip' } })); setTimeout(r, 300); }; }));
await tv.waitForTimeout(1000);
const song2 = await tv.locator('.ls-song').innerText().catch(() => '');
check('skip advances to a different song', song1 && song2 && song1 !== song2);

await tv.screenshot({ path: '/tmp/encore-m6c3-party.png' });
await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
