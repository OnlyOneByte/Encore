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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(import.meta.dir, 'VisualizerStage.svelte'), 'utf8');

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
	expect(SRC).toMatch(/if \(!playing \|\| prefersReducedMotion\(\)\)/);
	expect(SRC).toContain('cancelAnimationFrame');
});

test('the frame budget and the reduced backing store are both still in place', () => {
	// Both exist because this is the SECOND rAF loop on the TV — LyricsOverlay already runs one, and the
	// lyric ball has the stronger claim on the budget. Silently dropping either is a perf regression that
	// nothing else would surface.
	expect(SRC).toMatch(/const FRAME_MS = \d+/);
	expect(SRC).toMatch(/const SCALE = 0?\.\d+/);
	expect(SRC).toMatch(/now - last >= FRAME_MS/);
});

test('the canvas is hidden from assistive tech', () => {
	// Decoration behind the words. A screen reader announcing "canvas" mid-song is noise.
	expect(SRC).toMatch(/aria-hidden="true"/);
});
