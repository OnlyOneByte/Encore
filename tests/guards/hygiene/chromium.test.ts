// guard: Chromium discovery must stay single-sourced.
//
// `findChromium()` was copy-pasted into 15 e2e drivers and drifted: only two validated PW_CHROMIUM,
// one hardcoded a personal home path, and the short variants dropped the /usr/bin fallback. The
// drivers are deliberately NOT wired into bun test (they need a live server + a real browser, and the
// repo has no CI), so a runtime mutation cannot red a test. This source-scan does the job that runs
// everywhere on every change: it fails the moment a driver grows its own copy again, or the personal
// home path reappears, or the canonical copy stops validating PW_CHROMIUM.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appE2e, at } from '@encore/test-support';

// Anchored on the repo root via `@encore/test-support`, not on this file's own location: the
// walk below is a statement about where `apps/core/e2e` is, and it used to be written as
// `at('apps/core/e2e')` — a statement about where the TEST was. A wrong root here is silent
// (two of the four consumers assert an EMPTY offenders array), which is what the floor below exists for.
const E2E = appE2e;
const CANON = 'lib/chromium.mjs';

/**
 * Every .mjs under e2e/, recursively, as paths relative to the e2e root.
 *
 * Non-vacuity floor (XR-VER-05). This walk had NO floor, and two of its four consumers
 * assert `offenders` EMPTY (`:40` the import rule, `:62` the personal-home-path ban) — so pointing the
 * walk at a missing directory, renaming the extension, or widening the prune list made both pass with
 * ZERO drivers examined, which is a green guard enforcing nothing. The other two tests self-anchor
 * (`:35` compares against `[CANON]`, `:56` reads CANON directly), so the floor is what the empty-set
 * pair was missing.
 *
 * The floor lives IN the walk rather than in each test, so a future consumer inherits it instead of
 * having to remember it — the way test 3 in motion.test.ts had to be retro-fitted.
 *
 * A firing floor is a FINDING, never a number to adjust — see XR-VER-06 and
 * `non-vacuity-floors.test.ts`.
 */
function e2eDrivers(): string[] {
	const out: string[] = [];
	const walk = (dir: string, rel: string) => {
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (ent.name === 'node_modules' || ent.name === 'build') continue;
			const abs = join(dir, ent.name);
			const r = rel ? `${rel}/${ent.name}` : ent.name;
			if (ent.isDirectory()) walk(abs, r);
			else if (ent.name.endsWith('.mjs')) out.push(r);
		}
	};
	walk(E2E, '');
	// 28 drivers today; pin well below. Plus the which-files sentinel: a walk that found 21 of
	// something but not the canonical module is also broken, and a count alone cannot say so.
	expect(out.length).toBeGreaterThan(20); // @nvf-floor out.length
	expect(out).toContain(CANON);
	return out;
}

// A findChromium DEFINITION, not a call/import: `function findChromium`, `const findChromium =`, etc.
const DEF = /(?:function\s+findChromium\b|(?:const|let|var)\s+findChromium\s*=)/;

test('findChromium is defined in exactly one file, and it is lib/chromium.mjs', () => {
	const definers = e2eDrivers().filter((f) => DEF.test(readFileSync(join(E2E, f), 'utf8')));
	expect(definers).toEqual([CANON]);
});

test('every e2e driver that discovers Chromium imports it from lib/chromium.mjs', () => {
	const offenders: string[] = [];
	for (const f of e2eDrivers()) {
		if (f === CANON) continue;
		const src = readFileSync(join(E2E, f), 'utf8');
		if (!src.includes('findChromium')) continue; // driver doesn't need Chromium at all
		// how many directory levels deep this file is, so we know the relative path back to lib/.
		// A top-level driver (fuzz.mjs) reaches it via ./lib, a probe (probes/p1.mjs) via ../lib.
		const depth = (f.match(/\//g) ?? []).length;
		const up = depth === 0 ? './' : '../'.repeat(depth);
		const wanted = `${up}lib/chromium.mjs`;
		if (!src.includes(`from '${wanted}'`)) offenders.push(`${f} — expected import from '${wanted}'`);
	}
	expect(offenders).toEqual([]);
});

test('the canonical findChromium validates PW_CHROMIUM with existsSync', () => {
	const canon = readFileSync(join(E2E, CANON), 'utf8');
	// the whole point of the dedup: the set-but-missing PW_CHROMIUM case is validated, not trusted
	expect(canon).toMatch(/PW_CHROMIUM.*existsSync|existsSync.*PW_CHROMIUM/);
});

test('no e2e driver hardcodes a personal home path', () => {
	const offenders: string[] = [];
	for (const f of e2eDrivers()) {
		const src = readFileSync(join(E2E, f), 'utf8');
		if (/\/(?:local\/)?home\/angryang\b/.test(src)) offenders.push(f);
	}
	expect(offenders).toEqual([]);
});
