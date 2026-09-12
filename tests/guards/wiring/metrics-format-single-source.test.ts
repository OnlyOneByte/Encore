//
// Guards the two /metrics route components against re-growing their OWN copy of a formatter that
// $lib/metrics-format.ts (and $lib/clock.ts) exists to single-source.
//
// THE DEFECT THESE BOUND. Both routes render the realtime factor (`0.29×`) by open-coding
// `${v.toFixed(2)}×` — it lived at four sites across the two files while a `rt()` helper sat in one
// of them, bypassed three lines below its own call site. And the per-song audit page had a THIRD
// mm:ss implementation, `songLength`, that dropped the hour: a >59-minute song read `62:05` there
// while every other surface reads `1:02:05` via `formatClock`. Neither is visible to `tsc` (both are
// template literals over a `number`) and zero behavioural tests reference either route file, so only
// a source scan reds on the drift. This is a RUN guard, proven to red on base and green on the fix.
//
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';

// Was `at('src')` from src/lib, which meant src. `srcDir` is that
// same directory named directly, and it is derived from the repo-root marker rather than from wherever
// this test happens to sit — the four reads below all throw on a missing file, so a wrong root is loud.
const SRC = srcDir;
const METRICS = join(SRC, 'routes/metrics/+page.svelte');
const AUDIT = join(SRC, 'routes/metrics/[mediaId]/+page.svelte');
const FORMAT = join(SRC, 'lib/metrics-format.ts');
const CLOCK = join(SRC, 'lib/clock.ts');

// The natural fix adds a comment at the extraction site quoting the old form; a comment carrying a
// banned literal must not trip the scan. So the scan reads comment-stripped source.
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/[^\n]*/g, '')
		.replace(/<!--[\s\S]*?-->/g, '');
}
function count(src: string, re: RegExp): number {
	return (src.match(re) ?? []).length;
}

const RATE = /toFixed\(2\)\}×/g; // the open-coded realtime-factor glyph
const MMSS = /Math\.floor\([^)]*\/\s*60\)/g; // the hour-dropping mm:ss floor-divide

// ---- ARM 1: the rate format is single-sourced in metrics-format.ts, not open-coded in the routes ----
test('the realtime-rate glyph is written once, in metrics-format.ts, and at neither route', () => {
	const metrics = stripComments(readFileSync(METRICS, 'utf8'));
	const audit = stripComments(readFileSync(AUDIT, 'utf8'));
	const format = stripComments(readFileSync(FORMAT, 'utf8'));
	expect(count(metrics, RATE), 'metrics/+page.svelte open-codes the rate glyph').toBe(0);
	expect(count(audit, RATE), '[mediaId]/+page.svelte open-codes the rate glyph').toBe(0);
	expect(count(format, RATE), 'metrics-format.ts should own the one rate() boundary').toBe(1);
});

// ---- ARM 2: the audit page uses clock.ts for mm:ss instead of its own hour-dropping copy ----
test('the audit page has no home-grown mm:ss and imports formatClock from $lib/clock', () => {
	const audit = stripComments(readFileSync(AUDIT, 'utf8'));
	expect(count(audit, MMSS), '[mediaId]/+page.svelte still floor-divides seconds by 60 itself').toBe(0);
	expect(audit.includes("from '$lib/clock'"), '[mediaId]/+page.svelte must import from $lib/clock').toBe(true);
});

// ---- SENTINELS: keep the scan honest — it must break if the anchors move or the feature is deleted ----
test('sentinels: anchors present and the audit surface still renders', () => {
	const metrics = stripComments(readFileSync(METRICS, 'utf8'));
	const audit = stripComments(readFileSync(AUDIT, 'utf8'));
	const format = readFileSync(FORMAT, 'utf8');
	const clock = readFileSync(CLOCK, 'utf8');
	// both routes still consume the shared module
	expect(metrics.includes("from '$lib/metrics-format'")).toBe(true);
	expect(audit.includes("from '$lib/metrics-format'")).toBe(true);
	// the anchors the arms key on still exist
	expect(/export function dur\(/.test(format)).toBe(true);
	expect(/export function rate\(/.test(format)).toBe(true);
	expect(/export function formatClock\(/.test(clock)).toBe(true);
	// deleting the audit's song-length line must FAIL this guard, not satisfy it
	expect(audit.includes(' long ·')).toBe(true);
});

test('sentinel: the comment stripper removes both banned forms so a documenting comment is safe', () => {
	const planted = [
		'/* was `${v.toFixed(2)}×` and `Math.floor(sec / 60)` before extraction */',
		'// old rate: `${v.toFixed(2)}×`; old mm:ss: `Math.floor(sec / 60)`'
	].join('\n');
	// present before stripping
	expect(count(planted, RATE)).toBe(2);
	expect(count(planted, MMSS)).toBe(2);
	// gone after
	const clean = stripComments(planted);
	expect(count(clean, RATE)).toBe(0);
	expect(count(clean, MMSS)).toBe(0);
});
