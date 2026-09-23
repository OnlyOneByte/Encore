// The timed-child-process boundary has exactly ONE implementation (media/spawn-capture.ts), and neither
// exit of ytdlp.ts throws its failure away. Caught: `ytDlpSearch` stayed hand-rolled after the pattern was
// extracted, so two implementations of "spawn with a kill timer" shipped and the second discarded
// `timedOut`. `Bun.spawn` is a global, so tsc cannot see a bypass and a hand-rolled copy is invisible to
// behavioural tests. The availability probe's positive answer is cached for the process lifetime, so a
// behavioural test of its catch would depend on file order; this scan pins it deterministically.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { at, srcDir } from '@encore/test-support';

/** Blank comments, preserving line count, so ARM 1's reported line numbers match grep's. */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

const MEDIA_DIR = at('src/lib/server/media');
const SRC_ROOT = srcDir;
const SPAWN_CAPTURE_REL = join('lib', 'server', 'media', 'spawn-capture.ts');

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
	// Skip the PARAMETER LIST by paren balance first: a parameter default like `deps: Deps = {}` holds a
	// brace pair of its own, so taking the first `{` slices a stub no arm could ever match.
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

test('ARM 1: no production file under src calls Bun.spawn( except spawn-capture.ts', () => {
	const offenders: string[] = [];
	for (const f of PRODUCTION) {
		if (f.rel.split(sep).join(sep) === SPAWN_CAPTURE_REL) continue;
		for (const [i, line] of f.src.split('\n').entries()) {
			if (/Bun\.spawn\s*\(/.test(line)) offenders.push(`${f.rel}:${i + 1}`);
		}
	}
	expect(offenders).toEqual([]);
});

test('ARM 2: the availability probe BINDS its error and warns, rather than swallowing it', () => {
	// A BARE `catch {` is the banned shape: it discards the reason the binary could not be probed.
	expect(/catch\s*\{/.test(AVAILABLE)).toBe(false);
	expect(AVAILABLE).toMatch(/catch\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*\{[\s\S]*?console\.warn\(/);
});

test('ARM 2: the search BINDS its spawn error and warns, rather than swallowing it', () => {
	expect(/catch\s*\{/.test(SEARCH)).toBe(false);
	expect(SEARCH).toMatch(/catch\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*\{[\s\S]*?console\.warn\(/);
});

test('ARM 2: the search routes through runCapturing and reports timedOut', () => {
	// Without this, ARM 1 could be satisfied by inlining a kill timer around a non-global spawner.
	expect(SEARCH).toMatch(/await\s+runCapturing\(/);
	expect(SEARCH).toMatch(/\.timedOut/);
});

test('sentinel 1: spawn-capture.ts still exports runCapturing with a kill timer and timedOut', () => {
	// Deleting the helper would EMPTY ARM 1 rather than satisfy it.
	expect(SPAWN_CAPTURE).toMatch(/export\s+async\s+function\s+runCapturing\(/);
	expect(SPAWN_CAPTURE).toMatch(/setTimeout\(/);
	expect(SPAWN_CAPTURE).toMatch(/timedOut/);
	// It reaches the spawner through an injectable parameter DEFAULT and calls `spawn(...)`, so it holds
	// no `Bun.spawn(` of its own: ARM 1's exemption for this file is forward tolerance, and ARM 1 is today
	// an absolute zero across production.
	expect(SPAWN_CAPTURE).toMatch(/typeof\s+Bun\.spawn/);
	expect(/Bun\.spawn\s*\(/.test(SPAWN_CAPTURE)).toBe(false);
});

test('sentinel 2: at least three production files import runCapturing', () => {
	// Deleting a call site must not become a way to satisfy ARM 1.
	const importers = PRODUCTION.filter((f) => /from\s+'\.\/spawn-capture'/.test(f.src)).map((f) => f.rel);
	expect(importers.length).toBeGreaterThanOrEqual(3);
});

test('sentinel 3: both ytdlp.ts regions were actually found', () => {
	// A rename or deletion must red here rather than silently emptying ARM 2's haystack.
	expect(AVAILABLE.length).toBeGreaterThan(200);
	expect(SEARCH.length).toBeGreaterThan(200);
});

test('sentinel 4: the comment stripper removes a planted Bun.spawn( and a planted bare catch', () => {
	const planted = [
		'/* Bun.spawn( and catch { inside a block comment',
		'   spanning lines */',
		'// Bun.spawn( catch {'
	].join('\n');
	const stripped = stripComments(planted);
	expect(/Bun\.spawn\s*\(/.test(stripped)).toBe(false);
	expect(/catch\s*\{/.test(stripped)).toBe(false);
	expect(stripped.split('\n')).toHaveLength(3); // line count preserved
});

test('sentinel 5: the production file list is real and includes the file under guard', () => {
	expect(PRODUCTION.length).toBeGreaterThan(50);
	expect(PRODUCTION.map((f) => f.rel)).toContain(join('lib', 'server', 'media', 'ytdlp.ts'));
	expect(PRODUCTION.map((f) => f.rel)).toContain(SPAWN_CAPTURE_REL);
});
