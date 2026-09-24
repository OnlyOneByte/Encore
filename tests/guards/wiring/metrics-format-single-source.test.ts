// guard: the two /metrics routes must not re-grow their own copy of a formatter `$lib/metrics-format.ts`
// and `$lib/clock.ts` exist to single-source. Caught: the realtime rate was open-coded at four sites while
// an `rt()` helper sat three lines below one of them, and the audit page had a THIRD mm:ss implementation
// that dropped the hour, so a >59-minute song read `62:05`. Both were template literals over a `number`, so
// `tsc` sees nothing, and no behavioural test references either route file.
//
// ARM 4 IS REPO-WIDE ON PURPOSE. The two-route arms above address SITES; the defect is a CLASS, and it
// recurred outside their reach — `formatClock` in clock.ts and `formatDuration` in video-kind.ts held
// byte-identical hour/minute/second blocks, which no scan of routes/metrics could ever see. They now both
// call one `formatHms`, and arm 4 keeps the h:mm:ss renderer single by banning the divide that defines it
// everywhere but its home.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { filesUnder, relative, srcDir } from '@encore/test-support';
import { stripComments } from '@encore/test-support/scan';

const SRC = srcDir;
const METRICS = join(SRC, 'routes/metrics/+page.svelte');
const AUDIT = join(SRC, 'routes/metrics/[mediaId]/+page.svelte');
const FORMAT = join(SRC, 'lib/metrics-format.ts');
const CLOCK = join(SRC, 'lib/clock.ts');

function count(src: string, re: RegExp): number {
	return (src.match(re) ?? []).length;
}

// Every read below is comment-stripped: the extraction site quotes the old form in a comment, and a banned
// literal in prose must not trip. The last arm in this file is the proof that the stripping works.
const RATE = /Math\.round\([^)]*\*\s*100\)\}%/g; // the open-coded percent-of-song-length glyph
const MMSS = /Math\.floor\([^)]*\/\s*60\)/g; // the hour-dropping mm:ss floor-divide

/**
 * The divide that DEFINES an h:mm:ss renderer. A multiply is not a match, which is what keeps
 * `(j.expires_in ?? 3600) * 1000` in spotify.ts — the only other 3600 in the tree — out of the ban.
 */
const HOUR_DIVIDE = /\/\s*3600\b/g;

test('the realtime-rate glyph is written once, in metrics-format.ts, and at neither route', () => {
	const metrics = stripComments(readFileSync(METRICS, 'utf8'), { markup: true, drop: true });
	const audit = stripComments(readFileSync(AUDIT, 'utf8'), { markup: true, drop: true });
	const format = stripComments(readFileSync(FORMAT, 'utf8'), { markup: true, drop: true });
	expect(count(metrics, RATE), 'metrics/+page.svelte open-codes the rate glyph').toBe(0);
	expect(count(audit, RATE), '[mediaId]/+page.svelte open-codes the rate glyph').toBe(0);
	expect(count(format, RATE), 'metrics-format.ts should own the one rate() boundary').toBe(1);
});

test('the audit page has no home-grown mm:ss and imports formatClock from $lib/clock', () => {
	const audit = stripComments(readFileSync(AUDIT, 'utf8'), { markup: true, drop: true });
	expect(count(audit, MMSS), '[mediaId]/+page.svelte still floor-divides seconds by 60 itself').toBe(0);
	expect(audit.includes("from '$lib/clock'"), '[mediaId]/+page.svelte must import from $lib/clock').toBe(true);
});

test('sentinels: anchors present and the audit surface still renders', () => {
	const metrics = stripComments(readFileSync(METRICS, 'utf8'), { markup: true, drop: true });
	const audit = stripComments(readFileSync(AUDIT, 'utf8'), { markup: true, drop: true });
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

test('ARM 4 — the h:mm:ss renderer is written once, in clock.ts, across the WHOLE of src/', () => {
	// REPO-WIDE, not route-scoped: the third copy of this renderer was `formatDuration` in video-kind.ts,
	// outside every earlier arm's reach. `formatHms` is now the one home, and a second divide-by-3600
	// anywhere under src/ is another renderer being born.
	const files = filesUnder('src', ['.ts', '.svelte']);
	// Non-vacuity: an empty walk reports zero offenders exactly like a single-sourced tree does. 294 files
	// at the time of writing.
	expect(files.length, 'the src walk behind the h:mm:ss single-source ban found nothing').toBeGreaterThan(200);

	// `count`, never `HOUR_DIVIDE.test()`: a /g regex carries `lastIndex` between `.test()` calls, so a
	// filter over it would skip every second candidate and report a clean tree on a dirty one.
	const owners = files.filter(
		(f) => count(stripComments(readFileSync(f, 'utf8'), { markup: true, drop: true }), HOUR_DIVIDE) > 0
	);
	expect(
		owners.map(relative).sort(),
		'a divide by 3600 outside clock.ts is a second h:mm:ss renderer — call formatHms instead'
	).toEqual(['src/lib/clock.ts']);

	// …and the home holds EXACTLY one, so clock.ts cannot quietly grow a second renderer of its own, plus the
	// anchor the whole arm rests on: without `formatHms` this scans for a shape nothing writes.
	const clock = stripComments(readFileSync(CLOCK, 'utf8'), { markup: true, drop: true });
	expect(count(clock, HOUR_DIVIDE), 'clock.ts must hold exactly one divide-by-3600').toBe(1);
	expect(/export function formatHms\(/.test(clock)).toBe(true);
});

test('sentinel: the comment stripper removes both banned forms so a documenting comment is safe', () => {
	const planted = [
		'/* was `${Math.round(v * 100)}%` and `Math.floor(sec / 60)` before extraction */',
		'// old rate: `${Math.round(v * 100)}%`; old mm:ss: `Math.floor(sec / 60)`'
	].join('\n');
	expect(count(planted, RATE)).toBe(2);
	expect(count(planted, MMSS)).toBe(2);
	const clean = stripComments(planted, { markup: true, drop: true });
	expect(count(clean, RATE)).toBe(0);
	expect(count(clean, MMSS)).toBe(0);
});
