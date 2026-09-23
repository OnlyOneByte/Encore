// guard: no class selector is declared twice inside the TV page's <style> block, because the later copy
// overrides the earlier one INVISIBLY.
//
// A deleted "now singing card" design left a whole second copy of its rule block in the same <style>,
// re-declaring `.ls-name` / `.ls-song` / `.ls-artist` / `.ls-key` LATER in source than the live rules, so
// by the cascade its declarations silently won. The load-bearing one added
// `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` to `.ls-artist`, which is an INLINE
// <span>: on an inline element overflow and text-overflow are INERT while `white-space: nowrap` applies, so
// a long joined credit became one unbreakable run that overflowed `.lower-third`'s 46vw and was hard-
// clipped MID-WORD with no ellipsis.
//
// Nothing else could see it: the design-system, stage-scale and contrast guards read app.css and computed
// properties, not the shape of a component's own <style>.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

const raw = read('src/routes/tv/+page.svelte');

/** Extract every <style> block's body, comments blanked so a selector-in-prose is not counted. */
function styleBodies(src: string): string {
	const blocks = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
	expect(blocks.length).toBeGreaterThan(0); // the page has a <style> block; if not, the regex broke
	return blocks.join('\n').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Every class selector that begins a rule. Only the simple single-class rule heads the lower-third uses,
 * which is enough to catch a re-declared block while avoiding false positives on descendant or compound
 * selectors that can legitimately repeat a class name in different contexts.
 */
function ruleHeadClasses(styleSrc: string): string[] {
	return [...styleSrc.matchAll(/^\s*(\.[a-zA-Z][\w-]*)\s*\{/gm)].map((m) => m[1]!);
}

test('no class selector is declared more than once in the TV page <style>', () => {
	const heads = ruleHeadClasses(styleBodies(raw));
	const seen = new Map<string, number>();
	for (const h of heads) seen.set(h, (seen.get(h) ?? 0) + 1);
	const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([sel, n]) => `${sel} (\u00d7${n})`);
	// Red on the pre-fix tree, where each of the four appeared twice.
	expect(dupes).toEqual([]);
});

test('.ls-artist does not re-introduce inline-inert truncation (the original regression)', () => {
	// Truncation is `.ls-song`'s job (a 2-line `-webkit-line-clamp`), so the declarations that caused the
	// clip cannot come back on `.ls-artist` even if a future edit keeps the selector unique.
	const body = styleBodies(raw);
	const rule = /\.ls-artist\s*\{([^}]*)\}/.exec(body);
	expect(rule).not.toBeNull();
	const decls = rule![1]!;
	expect(decls).not.toMatch(/white-space\s*:\s*nowrap/);
	expect(decls).not.toMatch(/text-overflow\s*:/);
	expect(decls).not.toMatch(/overflow\s*:/);
});
