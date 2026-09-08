// #767 — the timed-child-process BOUNDARY must have exactly one implementation, and neither exit of
// ytdlp.ts may throw its failure away.
//
// #446 extracted the pattern into media/spawn-capture.ts and migrated three call sites onto it, but
// the site it was extracted FROM — ytDlpSearch — was left hand-rolled, so the repo shipped two
// implementations of "spawn with a kill timer" and the second one discarded the one thing the shared
// one keeps (`timedOut`). Nothing forces the migration: `Bun.spawn` is a global, so tsc cannot see a
// bypass, and a future hand-rolled copy would be invisible to every behavioural test.
//
// Why a SOURCE SCAN and not only behaviour: ytdlp.test.ts covers what ytDlpSearch now reports (a
// killed search, an unspawnable binary, a non-zero exit, a genuinely empty page). The availability
// probe cannot be covered the same way — its POSITIVE answer is cached for the process lifetime by
// design (ytdlp.ts, `_available`), so a behavioural test of its catch would depend on which test file
// ran first. This scan pins that catch deterministically, and it pins the absence of a second spawn
// site, which no behavioural test can express.
//
// Comments are blanked (each block comment replaced by an equal number of newlines, so reported line
// numbers stay true) — a commented-out spawn or catch must not satisfy or violate any arm.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

// import.meta.dir === apps/core/src/server/media
const MEDIA_DIR = import.meta.dir;
const SRC_ROOT = join(MEDIA_DIR, '..', '..');
const SPAWN_CAPTURE_REL = join('server', 'media', 'spawn-capture.ts');

function productionTsFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) {
			productionTsFiles(p, out);
			continue;
		}
		if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue;
		out.push(p);
	}
	return out;
}

const PRODUCTION = productionTsFiles(SRC_ROOT).map((p) => ({
	rel: relative(SRC_ROOT, p),
	src: stripComments(readFileSync(p, 'utf8'))
}));

const YTDLP = stripComments(readFileSync(join(MEDIA_DIR, 'ytdlp.ts'), 'utf8'));
const SPAWN_CAPTURE = stripComments(readFileSync(join(MEDIA_DIR, 'spawn-capture.ts'), 'utf8'));

/** Slice one function body out by brace balance, so a match cannot come from a neighbour. */
function sliceFunction(src: string, name: string): string {
	const at = src.indexOf(`function ${name}(`);
	if (at < 0) return '';
	// Skip the PARAMETER LIST by paren balance before looking for the body's brace — a parameter
	// default like `deps: YtDlpSearchDeps = {}` contains a brace pair of its own, and taking the first
	// `{` would slice a 77-character stub that no arm could ever match. (Found by running this guard.)
	let parens = 0;
	let i = src.indexOf('(', at);
	for (; i < src.length; i++) {
		if (src[i] === '(') parens++;
		else if (src[i] === ')' && --parens === 0) break;
	}
	const open = src.indexOf('{', i);
	if (open < 0) return '';
	let depth = 0;
	for (let j = open; j < src.length; j++) {
		if (src[j] === '{') depth++;
		else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
	}
	return '';
}

const AVAILABLE = sliceFunction(YTDLP, 'ytDlpAvailable');
const SEARCH = sliceFunction(YTDLP, 'ytDlpSearch');

// ── ARM 1: one timed-spawn implementation, in the file that owns the boundary ────────────────────

test('#767 ARM 1: no production file under apps/core/src calls Bun.spawn( except spawn-capture.ts', () => {
	const offenders: string[] = [];
	for (const f of PRODUCTION) {
		if (f.rel.split(sep).join(sep) === SPAWN_CAPTURE_REL) continue;
		for (const [i, line] of f.src.split('\n').entries()) {
			if (/Bun\.spawn\s*\(/.test(line)) offenders.push(`${f.rel}:${i + 1}`);
		}
	}
	// On base this reports server/media/ytdlp.ts:92 — the hand-rolled kill timer #446 replaced.
	expect(offenders).toEqual([]);
});

// ── ARM 2: neither exit of ytdlp.ts discards its failure ────────────────────────────────────────

test('#767 ARM 2: the availability probe BINDS its error and warns, rather than swallowing it', () => {
	expect(/catch\s*\{/.test(AVAILABLE)).toBe(false); // `} catch { _available = false; }` on base
	expect(AVAILABLE).toMatch(/catch\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*\{[\s\S]*?console\.warn\(/);
});

test('#767 ARM 2: the search BINDS its spawn error and warns, rather than swallowing it', () => {
	expect(/catch\s*\{/.test(SEARCH)).toBe(false); // `} catch { return []; }` on base
	expect(SEARCH).toMatch(/catch\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*\{[\s\S]*?console\.warn\(/);
});

test('#767 ARM 2: the search routes through runCapturing and reports timedOut', () => {
	// The migration itself: the shared boundary is called, and the field the hand-rolled copy threw
	// away is read. Without this, ARM 1 could be satisfied by inlining a kill timer around a
	// non-global spawner.
	expect(SEARCH).toMatch(/await\s+runCapturing\(/);
	expect(SEARCH).toMatch(/\.timedOut/);
});

// ── Sentinels: all PASS on base, so no arm above can go green vacuously ──────────────────────────

test('#767 sentinel 1: spawn-capture.ts still exports runCapturing with a kill timer and timedOut', () => {
	// Deleting the helper would empty ARM 1 rather than satisfy it. This reds instead.
	expect(SPAWN_CAPTURE).toMatch(/export\s+async\s+function\s+runCapturing\(/);
	expect(SPAWN_CAPTURE).toMatch(/setTimeout\(/);
	expect(SPAWN_CAPTURE).toMatch(/timedOut/);
	// It reaches Bun.spawn through an injectable parameter DEFAULT (`spawn: typeof Bun.spawn =
	// Bun.spawn`) and calls `spawn(...)`, so it holds no `Bun.spawn(` call of its own — measured by
	// running this guard. ARM 1's exemption for this file is therefore forward tolerance, not a
	// present-day carve-out, and ARM 1 is today an absolute zero across production.
	expect(SPAWN_CAPTURE).toMatch(/typeof\s+Bun\.spawn/);
	expect(/Bun\.spawn\s*\(/.test(SPAWN_CAPTURE)).toBe(false);
});

test('#767 sentinel 2: at least three production files import runCapturing', () => {
	// Deleting the search feature (or the loudness/retention call sites) must not be a way to satisfy
	// ARM 1. Measured at 3: media/loudness.ts, media/retention.ts, media/ytdlp.ts.
	const importers = PRODUCTION.filter((f) => /from\s+'\.\/spawn-capture'/.test(f.src)).map((f) => f.rel);
	expect(importers.length).toBeGreaterThanOrEqual(3);
});

test('#767 sentinel 3: both ytdlp.ts regions were actually found', () => {
	// A rename or a deletion must red here rather than silently emptying ARM 2's haystack.
	expect(AVAILABLE.length).toBeGreaterThan(200);
	expect(SEARCH.length).toBeGreaterThan(200);
});

test('#767 sentinel 4: the comment stripper removes a planted Bun.spawn( and a planted bare catch', () => {
	const planted = [
		'/* Bun.spawn( and catch { inside a block comment',
		'   spanning lines */',
		'// Bun.spawn( catch {'
	].join('\n');
	const stripped = stripComments(planted);
	expect(/Bun\.spawn\s*\(/.test(stripped)).toBe(false);
	expect(/catch\s*\{/.test(stripped)).toBe(false);
	// Line count preserved, so ARM 1's reported line numbers match grep's.
	expect(stripped.split('\n')).toHaveLength(3);
});

test('#767 sentinel 5: the production file list is real and includes the file under guard', () => {
	expect(PRODUCTION.length).toBeGreaterThan(50);
	expect(PRODUCTION.map((f) => f.rel)).toContain(join('server', 'media', 'ytdlp.ts'));
	expect(PRODUCTION.map((f) => f.rel)).toContain(SPAWN_CAPTURE_REL);
});
