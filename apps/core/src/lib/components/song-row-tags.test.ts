// guard (#689): a library song's descriptive tags render as chips on the row — and ONLY on a READY
// row. Same discipline as the sparkle-sibling guard: Encore has no jsdom, so every SongRow UI
// invariant is a decidable property of the component source. This reads SongRow.svelte and pins:
//   1. the `tags` prop exists (interface + destructure),
//   2. a `showTags` gate that is TRUE only when readiness === 'ready' AND there are tags,
//   3. the chip markup is guarded by showTags and lives inside the .chips wrapper condition,
//   4. the chip is a NEUTRAL family (a `.chip.tag`), not a semantic status tint.
// Deleting any of these ships a row that never shows tags (or shows them on a raw search result,
// where a tag is noise) with the suite otherwise green.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	return src
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const src = stripComments(readFileSync(join(import.meta.dir, 'SongRow.svelte'), 'utf8'));

test('SongRow accepts a tags prop and destructures it (#689)', () => {
	expect(src).toMatch(/tags\?\s*:\s*string\[\]/); // interface member
	// destructured out of $props so the template can read it
	expect(src).toMatch(/let\s*\{[\s\S]*\btags\b[\s\S]*\}\s*:\s*Props\s*=\s*\$props\(\)/);
});

test('showTags is gated on a READY row AND a non-empty tag list (#689)', () => {
	// Both halves are load-bearing: readiness==='ready' keeps tags off raw/cooking rows (a candidate
	// upload has no library tags worth showing), and the length check keeps an empty list from
	// rendering an empty .chips row. Mutating either half reds this.
	const m = src.match(/const\s+showTags\s*=\s*\$derived\(([^;]*)\);/);
	expect(m).not.toBeNull(); // non-vacuous
	const expr = m![1];
	expect(expr).toMatch(/readiness\s*===\s*'ready'/);
	expect(expr).toMatch(/tags[\s\S]*\.length\s*>\s*0/);
});

test('the tag chips render, keyed, guarded by showTags, inside the .chips wrapper (#689)', () => {
	// the {#each} over tags, each a chip, keyed so nodes are reused
	expect(src).toMatch(
		/\{#if\s+showTags\}\{#each\s+tags!?\s+as\s+tag\s*\(tag\)\}<Badge variant="tag">\{tag\}<\/Badge>\{\/each\}\{\/if\}/
	);
	// the .chips wrapper condition must include showTags, or the whole block never renders when tags
	// are the only thing to show (a ready row with tags but no key/views/kind).
	expect(src).toMatch(/\{#if[^}]*\bshowTags\b[^}]*\}\s*\n?\s*<div class="chips">/);
});

test('the tag chip is a NEUTRAL family, not a status tint (#689)', () => {
	/*
	 * #913 S6: the tone lives in ui/badge now, as the `tag` variant's own rules. The claim is unchanged
	 * and still the point — a tag is a describing word, not a warning — so it is asserted against the
	 * rules that actually paint it rather than against a class SongRow no longer writes.
	 */
	const badge = readFileSync(join(import.meta.dir, 'ui', 'badge', 'badge.svelte'), 'utf8');
	expect(badge, 'ui/badge must define a tag tone').toMatch(/\.encore-chip-tag\s*\{/);
	const accent = badge.match(/\.encore-chip-accent\s*\{([^}]*)\}/);
	expect(accent, 'the tag tone builds on the accent wash').not.toBeNull();
	expect(accent![1], 'a tag must not borrow a status colour').not.toMatch(/var\(--ok\b|var\(--warn\b|var\(--danger\b/);
	// and the row must ask for THAT tone, not a status one.
	expect(src).toMatch(/<Badge variant="tag">/);
});
