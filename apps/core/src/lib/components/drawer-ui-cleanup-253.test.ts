// Guard for issue #253: the pull-up drawer / cooking-status UI had three redundant elements the
// owner asked to remove. Each was a pure-markup deletion, so nothing BEHAVIOURAL reds if it comes
// back - this source-scan guard is the load-bearing regression trap. It reads each component source,
// strips comments (so the explanatory prose that NAMES the removed elements can neither satisfy nor
// trip a check), and asserts:
//   1. QueueSheet.svelte  - the redundant up/down chevron (.chev) is gone; the grip + count remain.
//   2. GuidingTrack.svelte - the out-of-place "No isolated vocals ..." line is gone; the control
//      (disabled state, slider) remains.
//   3. ProcessingCard.svelte - the per-stage status pills (.chips strip) are gone; the bar and the
//      "Making karaoke" stage line remain.
// Each removal is paired with a not-vacuous sentinel that reds if the whole component vanished.
//
// #517: the original assertions decided "is the deleted thing back?" by matching the EXACT deleted
// class name or English sentence, so they red on a byte-identical revert (control C1) but pass on any
// FUNCTIONALLY-EQUIVALENT reintroduction (a rewording, a rename, or a second spelling). So each
// removal now ALSO carries a STRUCTURAL, name-independent assertion; the literal matchers are kept.

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
	expect(code).toContain('class="grip"');
	expect(code).toContain('waiting');
	expect(code).not.toContain('class="chev"');
	expect(code).not.toMatch(/\bchev\b/);
	expect(code).not.toContain('chevron-down');
	const hint = code.match(/<div class="hint">([\s\S]*?)<\/div>/);
	expect(hint).not.toBeNull();
	expect(hint![1]).not.toMatch(/<[a-zA-Z]/);
	expect(code).not.toMatch(/\.hint\s*::\s*(?:before|after)\b/);
});

test('#253: GuidingTrack drops the out-of-place "No isolated vocals" line, keeps the control', () => {
	const code = read('GuidingTrack.svelte');
	expect(code).toContain('class="gt-slider"');
	expect(code).toContain('disabled={!available}');
	expect(code).not.toMatch(/no isolated vocals/i);
	expect(code).not.toMatch(/re-?cook it to get a guiding track/i);
	const derived = code.match(/const hint\s*=\s*\$derived\(([\s\S]*?)\);/);
	expect(derived).not.toBeNull();
	const body = derived![1].replace(/\s+/g, ' ').trim();
	expect(body).toMatch(/^available\s*\?\s*.+\s*:\s*(?:''|"")$/);
	expect(code).toMatch(/\{#if hint\}\s*<p class="gt-hint">/);
});

test('#253: ProcessingCard drops the per-stage status pills, keeps bar + stage line', () => {
	const code = read('ProcessingCard.svelte');
	expect(code).toContain('class="progress"');
	expect(code).toContain('class="bar"');
	expect(code).toContain('class="stage"');
	expect(code).not.toContain('class="chips"');
	expect(code).not.toMatch(/\bchips\b/);
	expect(code).not.toMatch(/class="chip /);
	expect(code).not.toContain('now-dot');
	expect(code).not.toMatch(/\{#each\b/);
	expect(code).not.toContain('MEDIA_STAGES');
	expect(code).not.toContain('mediaStagePosition');
	expect(code).not.toContain('cookStageChipLabel');
});
