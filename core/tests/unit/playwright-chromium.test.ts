// TL-04: the Playwright Chromium resolver against cache layouts current Playwright actually writes. Each
// case runs in a child bun with a fake HOME, because the resolver reads `~/.cache/ms-playwright`, the real
// one varies per box, and bun caches homedir() for the life of a process.
import { test, expect, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'pw-home-'));
const cache = join(home, '.cache', 'ms-playwright');
const RESOLVER = join(import.meta.dir, '../playwright/world/chromium.ts');

const PINNED = JSON.parse(
	readFileSync(join(import.meta.dir, '../../node_modules/playwright-core/browsers.json'), 'utf8')
).browsers.find((b: { name: string }) => b.name === 'chromium').revision as string;

function put(rel: string): string {
	const p = join(cache, rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, '');
	return p;
}

function resolved(): string {
	const env: Record<string, string | undefined> = { ...process.env, HOME: home };
	delete env.PW_CHROMIUM;
	const run = Bun.spawnSync(
		[process.execPath, '-e', `import(${JSON.stringify(RESOLVER)}).then((m) => console.log(m.resolveChromium()))`],
		{ env, cwd: join(import.meta.dir, '../..') }
	);
	return run.stdout.toString().trim();
}

afterAll(() => rmSync(home, { recursive: true, force: true }));

test('finds the per-arch Linux layout a current `playwright install` writes', () => {
	const shell = put('chromium_headless_shell-9001/chrome-headless-shell-linux-arm64/chrome-headless-shell');
	expect(resolved()).toBe(shell);
	const full = put('chromium-9001/chrome-linux-arm64/chrome');
	expect(resolved()).toBe(full); // full Chromium before the headless shell of the same build
});

test('prefers the build the installed @playwright/test pins over a newer one', () => {
	put('chromium-9002/chrome-linux/chrome'); // newer, in a layout every version of the resolver knows
	const pinned = put(`chromium-${PINNED}/chrome-linux/chrome`);
	expect(resolved()).toBe(pinned);
});
