// guard: the visualizer honours `prefers-reduced-motion`. motion.test.ts parses CSS `@keyframes` and
// `transition`, and the visualizer's motion is a JS rAF loop on a canvas — invisible to it, so the motion
// policy would silently stop applying at the single largest piece of motion on the TV. The renderers are
// unit-tested directly, so what is left is that the loop consults the preference at all and draws one still
// frame rather than nothing. See docs/GUARDS.md#motion.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

const SRC = read('src/lib/tv/VisualizerStage.svelte');

test('the visualizer consults prefers-reduced-motion', () => {
	expect(SRC).toContain('prefers-reduced-motion: reduce');
	expect(SRC).toMatch(/matchMedia\(/);
});

test('under reduced motion it renders a still frame rather than nothing', () => {
	// A blank stage is a worse answer than a static one: the room chose a visualizer, and the preference is
	// about movement rather than about having no background.
	const guard = SRC.slice(SRC.indexOf('prefersReducedMotion()'));
	expect(guard).toMatch(/render\(0\)/);
});

test('the loop is cancelled, not merely hidden, when the stage is not shown', () => {
	// An idle TV on the attract screen must cost nothing, so `playing` false short-circuits before
	// requestAnimationFrame and the effect tears the frame down on cleanup.
	expect(SRC).toMatch(/if \(!shouldAnimate\(/);
	expect(SRC).toContain('cancelAnimationFrame');
});

test('the frame budget and the reduced backing store are both still in place', () => {
	// This is the SECOND rAF loop on the TV and the lyric ball has the stronger claim on the budget, so
	// dropping either is a perf regression nothing else would surface.
	expect(SRC).toMatch(/const FRAME_MS = \d+/);
	expect(SRC).toMatch(/const SCALE = 0?\.\d+/);
	expect(SRC).toMatch(/frameDue\(now, last, FRAME_MS\)/);
});

test('variant and hue are read synchronously in the effect, so a room change is tracked', () => {
	// Reading these ONLY inside the rAF callback left the $effect subscribed to neither, so a live
	// visualizer or hue change was dropped until remount: Svelte tracks a read in the effect BODY.
	const effectBody = SRC.slice(SRC.indexOf('$effect(() => {'), SRC.indexOf('requestAnimationFrame(tick)'));
	expect(effectBody).toMatch(/=\s*variant\b/);
	expect(effectBody).toMatch(/=\s*hue\b/);
});

test('the time baseline lives outside the effect, so a re-run cannot pin t to zero', () => {
	// A per-effect-run local resets to ~0 on every re-run (a `playing` toggle, a tracked prop change, a
	// remount), so `t` never accumulates and the picture is static.
	const beforeEffect = SRC.slice(0, SRC.indexOf('$effect(() => {'));
	expect(beforeEffect).toMatch(/let clockStart: number \| null = null/);
});

test('the canvas is hidden from assistive tech', () => {
	// Decoration behind the words: a screen reader announcing "canvas" mid-song is noise.
	expect(SRC).toMatch(/aria-hidden="true"/);
});
