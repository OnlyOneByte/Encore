// Source-level guard: the visualizer must honour `prefers-reduced-motion`.
//
// Why a source scan rather than a behavioural test. This codebase already has a motion convention with
// four sites (LyricsOverlay, JoinBadge, TvProgress, app.css) and a test enforcing it — but that test
// parses CSS `@keyframes` and `transition`, and the visualizer's motion is a **JS rAF loop on a canvas**.
// It is therefore invisible to the existing guard, which means the convention would silently stop
// applying at the single largest piece of motion on the TV.
//
// A real behavioural test would need a DOM, a canvas and a fake matchMedia; the renderers themselves are
// unit-tested directly in visualizers.test.ts, so what is left to protect here is exactly one property:
// that the loop consults the preference at all, and that it draws a frame instead of nothing when the
// preference says reduce. A grep pins that cheaply and fails loudly if someone deletes the branch.
import { test, expect } from 'bun:test';
import { read, at } from '@encore/test-support';

// Was `at('apps/core/src/lib/tv/VisualizerStage.svelte')` — the scanned component was this guard's own
// SIBLING in apps/core/src/lib/tv (it is the canvas rAF loop every assertion below is about), so it is
// now named in full and anchored on the repo root.
const SRC = read('apps/core/src/lib/tv/VisualizerStage.svelte');

test('the visualizer consults prefers-reduced-motion', () => {
	expect(SRC).toContain('prefers-reduced-motion: reduce');
	expect(SRC).toMatch(/matchMedia\(/);
});

test('under reduced motion it renders a still frame rather than nothing', () => {
	// A blank stage would be a worse answer than a static one: the room chose a visualizer, and the
	// preference is about movement, not about having no background.
	const guard = SRC.slice(SRC.indexOf('prefersReducedMotion()'));
	expect(guard).toMatch(/render\(0\)/);
});

test('the loop is cancelled, not merely hidden, when the stage is not shown', () => {
	// An idle TV on the attract screen must cost nothing. `playing` false has to short-circuit before
	// requestAnimationFrame, and the effect must tear the frame down on cleanup.
	expect(SRC).toMatch(/if \(!shouldAnimate\(/);
	expect(SRC).toContain('cancelAnimationFrame');
});

test('the frame budget and the reduced backing store are both still in place', () => {
	// Both exist because this is the SECOND rAF loop on the TV — LyricsOverlay already runs one, and the
	// lyric ball has the stronger claim on the budget. Silently dropping either is a perf regression that
	// nothing else would surface.
	expect(SRC).toMatch(/const FRAME_MS = \d+/);
	expect(SRC).toMatch(/const SCALE = 0?\.\d+/);
	expect(SRC).toMatch(/frameDue\(now, last, FRAME_MS\)/);
});

test('variant and hue are read synchronously in the effect, so a room change is tracked', () => {
	// The untracked-props defect: reading these ONLY inside the rAF callback left the $effect subscribed
	// to neither, so a live visualizer/hue change was dropped until remount. They must be read in the
	// effect body itself — before requestAnimationFrame — for Svelte to track them.
	const effectBody = SRC.slice(SRC.indexOf('$effect(() => {'), SRC.indexOf('requestAnimationFrame(tick)'));
	expect(effectBody).toMatch(/=\s*variant\b/);
	expect(effectBody).toMatch(/=\s*hue\b/);
});

test('the time baseline lives outside the effect, so a re-run cannot pin t to zero', () => {
	// The static-picture defect: `start` used to be a per-effect-run local, reset to ~0 on every re-run
	// (a `playing` toggle, a tracked prop change, a remount), so `t` never accumulated. The baseline must
	// be declared at component scope, ABOVE the effect, not inside it.
	const beforeEffect = SRC.slice(0, SRC.indexOf('$effect(() => {'));
	expect(beforeEffect).toMatch(/let clockStart: number \| null = null/);
});

test('the canvas is hidden from assistive tech', () => {
	// Decoration behind the words. A screen reader announcing "canvas" mid-song is noise.
	expect(SRC).toMatch(/aria-hidden="true"/);
});
