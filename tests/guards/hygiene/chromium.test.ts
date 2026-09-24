// guard: Chromium discovery must stay single-sourced. `findChromium()` was copy-pasted into 15 e2e drivers and
// drifted: only two validated PW_CHROMIUM, one hardcoded a personal home path, and the short variants dropped the
// /usr/bin fallback. The drivers are deliberately NOT wired into bun test, so only a source scan reds when a
// driver grows its own copy again.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { e2eDir } from '@encore/test-support';

// Anchored on the repo root: a wrong root is silent here, because two of the four consumers assert EMPTY.
const E2E = e2eDir;
const CANON = 'lib/chromium.mjs';

// Every .mjs under e2e/, recursively, relative to the e2e root. The non-vacuity floor lives IN the walk so every
// consumer inherits it: two of the four assert `offenders` EMPTY, so a missing directory or a widened prune list
// made them pass with ZERO drivers examined.
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
	// Plus a which-files sentinel: a walk that misses the canonical module is also broken, and a count cannot say so.
	expect(out.length).toBeGreaterThan(20); // @nvf-floor out.length
	expect(out).toContain(CANON);
	return out;
}

// Comments blanked, newlines preserved. Required: every scan below asks `src.includes('findChromium')`, so a
// driver whose COMMENT explained that discovery belongs to the shared driver read as one that discovers it.
function codeOnly(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[\s;{(])\/\/[^\n]*/g, '$1 ');
}

// A findChromium DEFINITION, not a call/import: `function findChromium`, `const findChromium =`, etc.
const DEF = /(?:function\s+findChromium\b|(?:const|let|var)\s+findChromium\s*=)/;

test('findChromium is defined in exactly one file, and it is lib/chromium.mjs', () => {
	const definers = e2eDrivers().filter((f) => DEF.test(codeOnly(readFileSync(join(E2E, f), 'utf8'))));
	expect(definers).toEqual([CANON]);
});

test('every e2e driver that discovers Chromium imports it from lib/chromium.mjs', () => {
	const offenders: string[] = [];
	for (const f of e2eDrivers()) {
		if (f === CANON) continue;
		const src = codeOnly(readFileSync(join(E2E, f), 'utf8'));
		if (!src.includes('findChromium')) continue; // driver doesn't need Chromium at all
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

test('the scan reads code, not a comment that merely names findChromium', () => {
	// The trap this closes, both directions: `shot.mjs` names `findChromium` in prose to explain why it does NOT call
	// it, and a raw-text scan read that as an undeclared discoverer. Real code must still be caught.
	expect(codeOnly("// discovery is the driver's job, via findChromium").includes('findChromium')).toBe(false);
	expect(codeOnly('/*\n * findChromium used to be copied into every driver.\n */').includes('findChromium')).toBe(
		false
	);

	expect(codeOnly("import { findChromium } from '../lib/chromium.mjs';").includes('findChromium')).toBe(true);
	expect(DEF.test(codeOnly('function findChromium() { return null; }'))).toBe(true);
	expect(DEF.test(codeOnly('const findChromium = () => null; // the copied variant'))).toBe(true);
	expect(DEF.test(codeOnly('// const findChromium = () => null;'))).toBe(false);
});
