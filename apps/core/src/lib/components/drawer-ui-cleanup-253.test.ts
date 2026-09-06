// Guard for issue #253: the pull-up drawer / cooking-status UI had three redundant elements the
// owner asked to remove. Each was a pure-markup deletion, so nothing BEHAVIOURAL reds if it comes
// back — this source-scan guard is the load-bearing regression trap. It reads each component's
// source, strips comments (so the explanatory prose that NAMES the removed elements can neither
// satisfy nor trip a check), and asserts:
//   1. QueueSheet.svelte  — the redundant up/down chevron (.chev) is gone; the grip + count remain.
//   2. GuidingTrack.svelte — the out-of-place "No isolated vocals ..." line is gone; the control
//      (disabled state, slider) remains.
//   3. ProcessingCard.svelte — the per-stage status pills (.chips strip) are gone; the bar and the
//      "Making karaoke" stage line remain.
// Each removal is paired with a not-vacuous sentinel that reds if the whole component vanished.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function strip(s: string): string {
	return s
		.replace(/<!--[\s\S]*?-->/g, '') // svelte/html comments
		.replace(/\/\*[\s\S]*?\*\//g, '') // css/js block comments
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid eating http://)
}
function read(rel: string): string {
	return strip(readFileSync(join(import.meta.dir, rel), 'utf8'));
}

test('#253: QueueSheet drops the redundant up/down chevron, keeps grip + count', () => {
	const code = read('QueueSheet.svelte');
	// not-vacuous: this IS the pull-up drawer — the draggable grip and the waiting count survive.
	expect(code).toContain('class="grip"');
	expect(code).toContain('waiting');
	// the redundant carrot: no .chev element/class and no chevron icon left in the source.
	expect(code).not.toContain('class="chev"');
	expect(code).not.toMatch(/\bchev\b/); // catches .chev CSS and class:up={} on it
	expect(code).not.toContain('chevron-down');
});

test('#253: GuidingTrack drops the out-of-place "No isolated vocals" line, keeps the control', () => {
	const code = read('GuidingTrack.svelte');
	// not-vacuous: this IS the guiding-track control — its slider and disabled wiring survive.
	expect(code).toContain('class="gt-slider"');
	expect(code).toContain('disabled={!available}');
	// the out-of-place message is gone, in any casing/spelling that would re-introduce it.
	expect(code).not.toMatch(/no isolated vocals/i);
	expect(code).not.toMatch(/re-?cook it to get a guiding track/i);
	// The hint element must be CONDITIONALLY rendered, not an always-present <p> wrapping an empty
	// string: reverting the {#if hint} wrapper is behavioural (it restores ~38px of empty chrome, the
	// very space this issue reclaims) yet reds nothing behaviourally, so pin the guard here.
	expect(code).toMatch(/\{#if hint\}\s*<p class="gt-hint">\{hint\}<\/p>\s*\{\/if\}/);
});

test('#253: ProcessingCard drops the per-stage status pills, keeps bar + stage line', () => {
	const code = read('ProcessingCard.svelte');
	// not-vacuous: the progress block, bar and the "Making karaoke" stage line survive.
	expect(code).toContain('class="progress"');
	expect(code).toContain('class="bar"');
	expect(code).toContain('class="stage"');
	// the pills are gone: no .chips strip, no per-chip markup/CSS, no now-dot marker.
	expect(code).not.toContain('class="chips"');
	expect(code).not.toMatch(/\bchips\b/);
	expect(code).not.toMatch(/class="chip /); // the {#each} chip spans
	expect(code).not.toContain('now-dot');
});
