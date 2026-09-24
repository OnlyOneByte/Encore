// guard: fifteen driver/probe call sites waited for the search box immediately after joining, after the phone
// shell moved search off `/` behind the browse push — so every driven flow timed out at its first step while all
// four unit gates stayed green, because none of them drives a browser. The driven probes are this repo's ONLY
// rendered-behaviour guards, so a dozen unable to reach step one is a guard that never fires, at scale, silently.
// The fix was one shared helper (`e2e/lib/phone.mjs`); this stops the fifteen sites drifting apart again.
import { test, expect } from 'bun:test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { e2eDir } from '@encore/test-support';
import { SEL, HOOKS } from '$e2e/contract';

const E2E = e2eDir;

/** Every driver and probe: the .mjs files that actually drive a browser. */
function driverFiles(): string[] {
	const out: string[] = [];
	for (const dir of [E2E, join(E2E, 'probes')]) {
		for (const f of readdirSync(dir)) {
			if (!f.endsWith('.mjs')) continue;
			if (dir === join(E2E, 'lib')) continue;
			out.push(join(dir, f));
		}
	}
	return out;
}

/** The last line before `idx` that is neither blank nor a comment. */
function previousCodeLine(lines: string[], idx: number): string {
	for (let i = idx - 1; i >= 0; i--) {
		const t = lines[i]!.trim();
		if (t === '' || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
		return t;
	}
	return '';
}

test('the contract names the way to the docked search box, and homeReady resolves', () => {
	// `homeReady` is the BAND, not the search box: the layout mounts it on every phone surface, so it says "the joined
	// app has painted" rather than "this one route rendered". `openBrowse` was retired with the `+ Add a turn` button.
	expect(SEL.homeReady).toBe('.band');
	const ids = HOOKS.map((h) => h.id);
	expect(ids).toContain('homeReady');
	expect('openBrowse' in SEL).toBe(false);
	expect(ids).not.toContain('openBrowse');
});

test('the shared post-join helper reaches the docked search box with no click', () => {
	const helper = join(E2E, 'lib', 'phone.mjs');
	expect(existsSync(helper)).toBe(true);
	const src = readFileSync(helper, 'utf8');
	// Two waits, in order: home is up (the docked band), then the search box. There is no click — the box is docked
	// unconditionally, so a helper clicking a `+ Add a turn` button would time out on dead markup.
	const wait = src.indexOf('SEL.homeReady');
	const search = src.lastIndexOf('SEL.search');
	expect(wait).toBeGreaterThan(-1);
	expect(search).toBeGreaterThan(wait);
	expect(src).not.toContain('SEL.openBrowse');
	expect(src).not.toContain('page.click(SEL.openBrowse)');
	expect(src).toContain('export async function openBrowseFromHome');
});

test('no driver waits for the search box as its post-join readiness signal', () => {
	// THE DEFECT as a scan: `search` is not on `/`, so a `waitFor` on it straight after joining waits forever.
	const offenders: string[] = [];
	for (const path of driverFiles()) {
		const lines = readFileSync(path, 'utf8').split('\n');
		lines.forEach((line, i) => {
			if (!line.includes('SEL.search')) return;
			if (/waitFor\(\s*$/.test(line) || /\bwaitFor\(/.test(line)) {
				const isExistenceWait = /querySelector\((?:`|'|")?\$?\{?JSON\.stringify\(SEL\.search\)/.test(line);
				if (isExistenceWait && !line.includes('SEL.homeReady')) {
					const prev = previousCodeLine(lines, i);
					if (!prev.includes('openBrowseFromHome(')) {
						offenders.push(
							`${path.replace(E2E, 'e2e')}:${i + 1} waits for SEL.search without reaching the browse screen`
						);
					}
				}
			}
		});
	}
	expect(offenders).toEqual([]);
});

test('every driver that types into search reaches the browse screen first', () => {
	// The other half: a `fill` on a screen without the field throws on a null element. The helper is a no-op when the
	// field is already there, so calling it defensively costs one 250ms probe.
	const offenders: string[] = [];
	for (const path of driverFiles()) {
		const lines = readFileSync(path, 'utf8').split('\n');
		lines.forEach((line, i) => {
			if (!/\.fill\(SEL\.search,/.test(line)) return;
			const prev = previousCodeLine(lines, i);
			if (!prev.includes('openBrowseFromHome(')) {
				offenders.push(`${path.replace(E2E, 'e2e')}:${i + 1} fills SEL.search without reaching the browse screen`);
			}
		});
	}
	expect(offenders).toEqual([]);
});

test('the scan is non-vacuous — it is really reading the drivers', () => {
	// An empty-offenders assertion is what a working guard produces AND what one reading nothing produces.
	const files = driverFiles();
	expect(files.length).toBeGreaterThanOrEqual(15);
	const usingSearch = files.filter((f) => readFileSync(f, 'utf8').includes('SEL.search'));
	expect(usingSearch.length).toBeGreaterThanOrEqual(10);
	const usingHelper = files.filter((f) => readFileSync(f, 'utf8').includes('openBrowseFromHome'));
	expect(usingHelper.length).toBeGreaterThanOrEqual(usingSearch.length);
});
