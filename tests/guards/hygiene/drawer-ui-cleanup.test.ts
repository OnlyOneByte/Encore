// Guard: the processing-status UI had redundant elements removed. Each was a pure-markup deletion, so nothing
// BEHAVIOURAL reds if one comes back. It strips comments (so prose NAMING the removed elements neither satisfies
// nor trips a check) and pins two removals: GuidingTrack's out-of-place "No isolated vocals …" line, and
// ProcessingCard's per-stage status pills. Each is paired with a sentinel that reds if the whole component
// vanished, and with a STRUCTURAL, name-independent assertion — a literal matcher alone passes on any rewording.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';

function strip(s: string): string {
	return s
		.replace(/<!--[\s\S]*?-->/g, '') // svelte/html comments
		.replace(/\/\*[\s\S]*?\*\//g, '') // css/js block comments
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (avoid eating http://)
}
function read(rel: string): string {
	return strip(readFileSync(at(rel), 'utf8'));
}

test('GuidingTrack drops the out-of-place "No isolated vocals" line, keeps the control', () => {
	const code = read('src/lib/components/GuidingTrack.svelte');
	expect(code).toContain('<Slider');
	expect(code).toContain('variant="guiding"');
	expect(code).toContain('disabled={!available}');
	expect(code).not.toMatch(/no isolated vocals/i);
	expect(code).not.toMatch(/re-?process it to get a guiding track/i);
	expect(code).not.toMatch(/gt-hint/);
});

test('ProcessingCard drops the per-stage status pills, keeps bar + stage line', () => {
	const code = read('src/lib/components/ProcessingCard.svelte');
	expect(code).toContain('class="progress"');
	expect(code).toContain('<Progress');
	expect(code).toContain('class="stage"');
	expect(code).not.toContain('class="chips"');
	expect(code).not.toMatch(/\bchips\b/);
	expect(code).not.toMatch(/class="chip /);
	expect(code).not.toContain('now-dot');
	expect(code).not.toMatch(/\{#each\b/);
	expect(code).not.toContain('MEDIA_STAGES');
	expect(code).not.toContain('mediaStagePosition');
	expect(code).not.toContain('processStageChipLabel');
});
