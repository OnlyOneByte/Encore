// guard: the TV route derives its VISUALIZER angle from the room's stored stage COLOUR with `hueOfColor` —
// NOT `nearestSingerHue`, which snaps a dark stage-tier colour to the wrong wheel stop for 15 of 24 hues —
// and feeds its SOLID stage that colour verbatim. A SOURCE SCAN: the pure functions are exercised
// behaviourally elsewhere, and the fact those cannot see is that the route actually wires them.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

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
