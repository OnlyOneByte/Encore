import { connect, sleep } from '../cdp.mjs';
import { SEL } from '../contract.ts';
import { findChromium } from '../lib/chromium.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.env.EPORT || '52639';
const base = 'http://127.0.0.1:' + PORT;
const OUT = process.argv[2] || '/tmp/shots-639';
mkdirSync(OUT, { recursive: true });
const chromium = findChromium();
if (!chromium) {
	console.error('no chromium');
	process.exit(2);
}
const CDP_PORT = 9639;
const args = [
	'--headless=new',
	'--remote-debugging-port=' + CDP_PORT,
	'--no-sandbox',
	'--hide-scrollbars',
	'--force-color-profile=srgb'
];
const proc = spawn(chromium, args, { stdio: 'ignore' });
await sleep(1200);
let code = 0;
try {
	const browser = await connect(CDP_PORT);
	const page = await browser.newPage();
	await page.viewport(900, 1100, 1);
	await page.goto(base + '/admin');
	for (let i = 0; i < 80 && (await page.count(SEL.adminSongRow)) === 0; i++) await sleep(100);
	await page.screenshot(join(OUT, '639-admin-list-eyeson.png'));
	console.log('captured list');
	await page.click(SEL.adminDelete);
	for (let i = 0; i < 40 && (await page.count(SEL.adminConfirmDelete)) === 0; i++) await sleep(100);
	await page.screenshot(join(OUT, '639-admin-confirm-eyeson.png'));
	console.log('captured confirm');
	await browser.close?.();
} catch (e) {
	console.error('probe error', e?.message || e);
	code = 1;
} finally {
	proc.kill();
}
process.exit(code);
