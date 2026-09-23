// guard: a library song's descriptive tags render as chips on the row — and ONLY on a READY row. No jsdom,
// so every SongRow UI invariant is a decidable property of the component source. Deleting any of the four
// pins below ships a row that never shows tags, or shows them on a raw search result where a tag is noise,
// with the suite otherwise green.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';

function stripComments(src: string): string {
	return src
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const src = stripComments(readFileSync(at('src/lib/components/SongRow.svelte'), 'utf8'));

test('SongRow accepts a tags prop and destructures it', () => {
	expect(src).toMatch(/tags\?\s*:\s*string\[\]/); // interface member
	// destructured out of $props so the template can read it
	expect(src).toMatch(/let\s*\{[\s\S]*\btags\b[\s\S]*\}\s*:\s*Props\s*=\s*\$props\(\)/);
});

test('showTags is gated on a READY row AND a non-empty tag list', () => {
	// Both halves are load-bearing: readiness==='ready' keeps tags off raw/processing rows (a candidate upload
	// has no library tags worth showing), and the length check keeps an empty list from rendering an empty row.
	const m = src.match(/const\s+showTags\s*=\s*\$derived\(([^;]*)\);/);
	expect(m).not.toBeNull(); // non-vacuous
	const expr = m![1];
	expect(expr).toMatch(/readiness\s*===\s*'ready'/);
	expect(expr).toMatch(/tags[\s\S]*\.length\s*>\s*0/);
});

test('the tag chips render, keyed, guarded by showTags, inside the .chips wrapper', () => {
	// the {#each} over tags, each a chip, keyed so nodes are reused
	expect(src).toMatch(
		/\{#if\s+showTags\}\{#each\s+tags!?\s+as\s+tag\s*\(tag\)\}<Badge variant="tag">\{tag\}<\/Badge>\{\/each\}\{\/if\}/
	);
	// the .chips wrapper condition must include showTags, or a ready row whose only chip is a tag never renders.
	expect(src).toMatch(/\{#if[^}]*\bshowTags\b[^}]*\}\s*\n?\s*<div class="chips">/);
});

test('the tag chip is a NEUTRAL family, not a status tint', () => {
	// The tone lives in ui/badge now, as the `tag` variant's own rules, so the claim is asserted against the
	// rules that actually paint it: a tag is a describing word, not a warning.
	const badge = readFileSync(at('src/lib/components/ui/badge/badge.svelte'), 'utf8');
	expect(badge, 'ui/badge must define a tag tone').toMatch(/\.encore-chip-tag\s*\{/);
	const accent = badge.match(/\.encore-chip-accent\s*\{([^}]*)\}/);
	expect(accent, 'the tag tone builds on the accent wash').not.toBeNull();
	expect(accent![1], 'a tag must not borrow a status colour').not.toMatch(/var\(--ok\b|var\(--warn\b|var\(--danger\b/);
	// and the row must ask for THAT tone, not a status one.
	expect(src).toMatch(/<Badge variant="tag">/);
});
