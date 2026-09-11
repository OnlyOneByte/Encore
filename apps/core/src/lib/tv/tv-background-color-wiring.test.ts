// guard: the TV route feeds its VISUALIZER an ANGLE derived from the room's stored stage COLOUR, and
// feeds its SOLID stage that colour verbatim.
//
// THE CHANGE. The full-picker rewrite replaced the room's stored `tvBackgroundHue: number` with `tvBackgroundColor:
// string` (a real hex; the legibility pin moved onto the lyric reel's own stroke). Two wirings in
// tv/+page.svelte turn on that:
//   - the visualizers build their palette by hue ARITHMETIC (`stageHueToHex(hue + deg)`), so they still
//     need an angle. The route derives it with `hueOfColor(tvBackgroundColor)`, NOT `nearestSingerHue`
//     — the latter snaps a dark stage-tier colour to the wrong wheel stop for 15 of 24 hues (measured
//     in colors.test.ts), which would rotate the visualizer palette off the room's chosen colour.
//   - `stageBackgroundCss(...)` is called with `tvBackgroundColor`, not an angle, because `solid` now
//     renders the colour verbatim.
//
// WHY A SOURCE SCAN. Encore has no jsdom/happy-dom; a .svelte route's `$derived` wiring is a property of
// the component source, decidable without rendering, and reverting a markup/derived line in the
// from-root `bun test` lane only breaks the build (an undefined symbol) rather than reding a named test
// — not a proof. The pure functions this wiring composes (hueOfColor round-tripping stageHueToHex, and
// stageBackgroundCss('solid', colour) === colour) are exercised behaviourally in colors.test.ts and
// background.test.ts. This guard's job is the integration fact those cannot see: that the route actually
// derives the visualizer angle with hueOfColor and passes the colour to stageBackgroundCss — and keeps
// no reference to the retired hue field or to nearestSingerHue on this path. It reds on base, where the
// route read `settings.room.tvBackgroundHue` directly.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Blank out block, line, and HTML comments, PRESERVING newlines, so a commented-out wiring line can
// never satisfy a positive guard and a commented-out retired reference can never fail a negative one.
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + '');
}

const TV_ROUTE = join(import.meta.dir, '..', '..', 'routes', 'tv', '+page.svelte');
const tvSrc = () => stripComments(readFileSync(TV_ROUTE, 'utf8'));

test('the TV route derives the visualizer angle from the stored colour via hueOfColor', () => {
	const src = tvSrc();
	// hueOfColor is imported from the shared package…
	expect(src).toMatch(/import\s*\{[^}]*\bhueOfColor\b[^}]*\}\s*from\s*['"]@encore\/shared['"]/);
	// …and the visualizer angle is derived from the stored colour through it. This is the line whose
	// revert this guard exists to catch: `$derived(hueOfColor(tvBackgroundColor))`.
	expect(src).toMatch(/\$derived\s*\(\s*hueOfColor\s*\(\s*tvBackgroundColor\s*\)\s*\)/);
});

test('the TV route reads the stored stage COLOUR, not the retired hue angle', () => {
	const src = tvSrc();
	// the colour field is read off settings…
	expect(src).toMatch(/settings\.room\.tvBackgroundColor/);
	// …and the retired numeric field is gone from this route entirely. Reverting the migration on this
	// file (back to reading tvBackgroundHue off settings) reds here.
	expect(src).not.toMatch(/settings\.room\.tvBackgroundHue/);
});

test('the TV route passes the colour to stageBackgroundCss, and never nearestSingerHue on this path', () => {
	const src = tvSrc();
	// the stage CSS is resolved from the colour, not from an angle (solid renders it verbatim).
	expect(src).toMatch(/stageBackgroundCss\s*\(\s*resolvedBackground\s*,\s*tvBackgroundColor\s*,/);
	// nearestSingerHue must not be the angle source here — it is the discredited alternative that
	// mis-snaps a stage-tier colour. (It legitimately stays inside stageBackgroundCss's `singer` branch,
	// which lives in background.ts, not on this route.)
	expect(src).not.toMatch(/nearestSingerHue/);
});
