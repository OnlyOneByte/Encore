// Guard for issue #253: the processing-status UI had redundant elements the owner asked to remove. Each
// was a pure-markup deletion, so nothing BEHAVIOURAL reds if it comes
// back - this source-scan guard is the load-bearing regression trap. It reads each component source,
// strips comments (so the explanatory prose that NAMES the removed elements can neither satisfy nor
// trip a check), and asserts:
//   1. GuidingTrack.svelte - the out-of-place "No isolated vocals ..." line is gone; the control
//      (disabled state, slider) remains.
//   2. ProcessingCard.svelte - the per-stage status pills (.chips strip) are gone; the bar and the
//      "Making karaoke" stage line remain.
// Each removal is paired with a not-vacuous sentinel that reds if the whole component vanished.
//
// RETIRED IN #903: a third arm pinned QueueSheet.svelte's chevron removal, and a #791 loop pinned the
// pinned-pane/scrolling-list split on QueueSheet.svelte + QueueSheetDrawer.svelte. Both components were
// deleted with the drawer surface, so those arms had no subject left and no successor to re-point at —
// nothing else in the tree renders a pull-up sheet. The two arms that remain here are untouched, and
// they are why this file survives rather than going with them.
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

test('#253: GuidingTrack drops the out-of-place "No isolated vocals" line, keeps the control', () => {
	const code = read('GuidingTrack.svelte');
	// #913: was `class="gt-slider"`. The control is <Slider variant="guiding"> now, whose geometry
	// lives in ui/slider. This arm cares that the CONTROL is still present, not how it is spelled.
	expect(code).toContain('<Slider');
	expect(code).toContain('variant="guiding"');
	expect(code).toContain('disabled={!available}');
	expect(code).not.toMatch(/no isolated vocals/i);
	expect(code).not.toMatch(/re-?process it to get a guiding track/i);
	const derived = code.match(/const hint\s*=\s*\$derived\(([\s\S]*?)\);/);
	expect(derived).not.toBeNull();
	const body = derived![1].replace(/\s+/g, ' ').trim();
	expect(body).toMatch(/^available\s*\?\s*.+\s*:\s*(?:''|"")$/);
	expect(code).toMatch(/\{#if hint\}\s*<p class="gt-hint">/);
});

test('#253: ProcessingCard drops the per-stage status pills, keeps bar + stage line', () => {
	const code = read('ProcessingCard.svelte');
	expect(code).toContain('class="progress"');
	// #913 S6: the bar is <Progress> now — same idiom, consolidated out of two components, and it
	// finally carries role="progressbar" with aria-valuenow. The claim is unchanged.
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
