// guard: the two /metrics routes must not re-grow their own copy of a formatter `$lib/metrics-format.ts`
// and `$lib/clock.ts` exist to single-source. Caught: the realtime rate was open-coded at four sites while
// an `rt()` helper sat three lines below one of them, and the audit page had a THIRD mm:ss implementation
// that dropped the hour, so a >59-minute song read `62:05`. Both were template literals over a `number`, so
// `tsc` sees nothing, and no behavioural test references either route file.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';

const SRC = srcDir;
const METRICS = join(SRC, 'routes/metrics/+page.svelte');
const AUDIT = join(SRC, 'routes/metrics/[mediaId]/+page.svelte');
const FORMAT = join(SRC, 'lib/metrics-format.ts');
const CLOCK = join(SRC, 'lib/clock.ts');

/** The extraction site quotes the old form in a comment, and a banned literal in prose must not trip. */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/[^\n]*/g, '')
		.replace(/<!--[\s\S]*?-->/g, '');
}
function count(src: string, re: RegExp): number {
	return (src.match(re) ?? []).length;
}

const RATE = /Math\.round\([^)]*\*\s*100\)\}%/g; // the open-coded percent-of-song-length glyph
const MMSS = /Math\.floor\([^)]*\/\s*60\)/g; // the hour-dropping mm:ss floor-divide

test('the realtime-rate glyph is written once, in metrics-format.ts, and at neither route', () => {
	const metrics = stripComments(readFileSync(METRICS, 'utf8'));
	const audit = stripComments(readFileSync(AUDIT, 'utf8'));
	const format = stripComments(readFileSync(FORMAT, 'utf8'));
	expect(count(metrics, RATE), 'metrics/+page.svelte open-codes the rate glyph').toBe(0);
	expect(count(audit, RATE), '[mediaId]/+page.svelte open-codes the rate glyph').toBe(0);
	expect(count(format, RATE), 'metrics-format.ts should own the one rate() boundary').toBe(1);
});

test('the audit page has no home-grown mm:ss and imports formatClock from $lib/clock', () => {
	const audit = stripComments(readFileSync(AUDIT, 'utf8'));
	expect(count(audit, MMSS), '[mediaId]/+page.svelte still floor-divides seconds by 60 itself').toBe(0);
	expect(audit.includes("from '$lib/clock'"), '[mediaId]/+page.svelte must import from $lib/clock').toBe(true);
});

test('sentinels: anchors present and the audit surface still renders', () => {
	const metrics = stripComments(readFileSync(METRICS, 'utf8'));
	const audit = stripComments(readFileSync(AUDIT, 'utf8'));
	const format = readFileSync(FORMAT, 'utf8');
	const clock = readFileSync(CLOCK, 'utf8');
	expect(metrics.includes("from '$lib/metrics-format'")).toBe(true);
	expect(audit.includes("from '$lib/metrics-format'")).toBe(true);
	// The anchors the two arms key on must still exist, or they scan for a format nothing writes.
	expect(/export function dur\(/.test(format)).toBe(true);
	expect(/export function pct\(/.test(format)).toBe(true);
	expect(/export function vsClaimed\(/.test(format)).toBe(true);
	expect(/export function formatClock\(/.test(clock)).toBe(true);
	// Deleting the audit's song-length line must FAIL this guard, not satisfy ARM 2 at zero.
	expect(audit.includes(' long ·')).toBe(true);
});

test('sentinel: the comment stripper removes both banned forms so a documenting comment is safe', () => {
	const planted = [
		'/* was `${Math.round(v * 100)}%` and `Math.floor(sec / 60)` before extraction */',
		'// old rate: `${Math.round(v * 100)}%`; old mm:ss: `Math.floor(sec / 60)`'
	].join('\n');
	expect(count(planted, RATE)).toBe(2);
	expect(count(planted, MMSS)).toBe(2);
	const clean = stripComments(planted);
	expect(count(clean, RATE)).toBe(0);
	expect(count(clean, MMSS)).toBe(0);
});
