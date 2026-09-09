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

// Guard for issue #791: the pull-up drawer had ONE scroll container wrapping both the per-song
// controls and the queue list, so a long queue scrolled the controls (Guiding track, Key, Vocal
// range) off the top of the drawer — the whole drawer had a scrollbar. Fix: the scroll region is
// contained to the queue rows alone; the controls/heading live in a pinned pane that never scrolls.
//
// Applies to BOTH sheet variants — the incumbent QueueSheet.svelte and the #827 spike port
// QueueSheetDrawer.svelte, whose prop/markup surface is deliberately identical. The assertions are
// STRUCTURAL (positional), not class-name literals, so a rename of `.list`/`.body-head` cannot make
// this pass vacuously: what is pinned is "the rows scroll, everything above them does not".
for (const file of ['QueueSheet.svelte', 'QueueSheetDrawer.svelte']) {
	test(`#791: ${file} scrolls ONLY the queue list, with the controls/heading pinned above it`, () => {
		const code = read(file);

		// The queue rows ({@render children()}) must be wrapped in a dedicated region, and that region
		// — not the outer .body — is the scroller. We find the innermost wrapper of children() and
		// require it to carry overflow-y:auto in the stylesheet.
		const childRender = /\{@render children\(\)\}/;
		expect(code).toMatch(childRender);

		// The immediate element wrapping children() is the list. Capture its class.
		const listWrap = code.match(/<div class="([a-z0-9-]+)"[^>]*>\s*\{@render children\(\)\}\s*<\/div>/);
		expect(listWrap).not.toBeNull();
		const listClass = listWrap![1]!;

		// That list class must be the scroller: it carries overflow-y:auto AND min-height:0 (the #201
		// shape — without min-height:0 the flex child won't shrink and the list pushes the pane past
		// the cap instead of scrolling).
		const listRule = code.match(new RegExp(`\\.${listClass}\\s*\\{([\\s\\S]*?)\\}`));
		expect(listRule).not.toBeNull();
		expect(listRule![1]).toMatch(/overflow-y:\s*auto/);
		expect(listRule![1]).toMatch(/min-height:\s*0/);

		// The OUTER .body must NOT be a scroller anymore — that was the whole defect. It must not carry
		// overflow-y:auto; it clips instead (overflow:hidden) and is a flex column.
		const bodyRule = code.match(/\.body\s*\{([\s\S]*?)\}/);
		expect(bodyRule).not.toBeNull();
		expect(bodyRule![1]).not.toMatch(/overflow-y:\s*auto/);
		expect(bodyRule![1]).toMatch(/flex-direction:\s*column/);

		// A pinned pane exists for the listHeader snippet, rendered OUTSIDE (before) the scrolling list,
		// and it is flex:0 0 auto so it cannot scroll.
		expect(code).toMatch(/\{@render listHeader\(\)\}/);
		const headerBeforeList =
			code.indexOf('{@render listHeader()}') < code.indexOf('{@render children()}');
		expect(headerBeforeList).toBe(true);
		const headRule = code.match(/\.body-head\s*\{([\s\S]*?)\}/);
		expect(headRule).not.toBeNull();
		expect(headRule![1]).toMatch(/flex:\s*0\s+0\s+auto/);

		// Not vacuous: the component still renders a queue body at all.
		expect(code).toContain('class="body"');
	});
}
