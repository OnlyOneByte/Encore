// guard: the TV route derives its VISUALIZER angle from the room's stored stage COLOUR, and feeds its
// SOLID stage that colour verbatim.
//
// The room stores `tvBackgroundColor: string` (a real hex; the legibility pin lives on the lyric reel's own
// stroke). The visualizers build their palette by hue ARITHMETIC, so they still need an angle, and the
// route derives it with `hueOfColor` — NOT `nearestSingerHue`, which snaps a dark stage-tier colour to the
// wrong wheel stop for 15 of 24 hues and would rotate the visualizer palette off the room's chosen colour.
// `stageBackgroundCss` takes the colour rather than an angle, because `solid` renders it verbatim.
//
// A SOURCE SCAN because there is no DOM here: a route's `$derived` wiring is decidable without rendering,
// and reverting a derived line only breaks the build rather than reding a named test. The pure functions
// this composes are exercised behaviourally elsewhere; the integration fact those cannot see is that the
// route actually wires them, and keeps no reference to the retired hue field on this path.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

// Blank comments, preserving newlines, so a commented-out wiring line cannot satisfy a positive guard and
// a commented-out retired reference cannot fail a negative one.
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + '');
}

// `read` throws if the path is wrong, so a bad anchor cannot scan nothing and pass.
const tvSrc = () => stripComments(read('src/routes/tv/+page.svelte'));

test('the TV route derives the visualizer angle from the stored colour via hueOfColor', () => {
	const src = tvSrc();
	expect(src).toMatch(/import\s*\{[^}]*\bhueOfColor\b[^}]*\}\s*from\s*['"]\$lib\/contract['"]/);
	// The line whose revert this guard exists to catch.
	expect(src).toMatch(/\$derived\s*\(\s*hueOfColor\s*\(\s*tvBackgroundColor\s*\)\s*\)/);
});

test('the TV route reads the stored stage COLOUR, not the retired hue angle', () => {
	const src = tvSrc();
	expect(src).toMatch(/settings\.room\.tvBackgroundColor/);
	// …and the retired numeric field is gone from this route entirely.
	expect(src).not.toMatch(/settings\.room\.tvBackgroundHue/);
});

test('the TV route passes the colour to stageBackgroundCss, and never nearestSingerHue on this path', () => {
	const src = tvSrc();
	expect(src).toMatch(/stageBackgroundCss\s*\(\s*resolvedBackground\s*,\s*tvBackgroundColor\s*,/);
	// `nearestSingerHue` must not be the angle source here — it mis-snaps a stage-tier colour. It
	// legitimately stays inside `stageBackgroundCss`'s `singer` branch, which is not on this route.
	expect(src).not.toMatch(/nearestSingerHue/);
});
