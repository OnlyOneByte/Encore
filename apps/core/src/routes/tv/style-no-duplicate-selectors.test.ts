// Guard: no class selector is declared twice inside this component's <style> block.
//
// NB filename: SvelteKit reserves `+`-prefixed names inside routes/, so this cannot be
// `+page.test.ts`; it colocates with the page it guards without being treated as a route.
//
// WHY THIS EXISTS. The lower-third once rendered a "now singing card" with a block-level
// artist row. That design was deleted, but a whole second copy of its rule block survived inside the
// same <style> — re-declaring `.ls-name` / `.ls-song` / `.ls-artist` / `.ls-key` LATER in source than
// the live rules, so by the cascade its declarations silently won. The load-bearing one added
// `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` to `.ls-artist`, which in today's
// markup is an INLINE <span> nested in `.ls-song`. On an inline element overflow/text-overflow are
// inert (no ellipsis ever paints) but white-space: nowrap applies — so a long joined MusicBrainz
// credit ("DJ Khaled feat. Justin Bieber, Quavo, ...") became one unbreakable run that overflowed
// `.lower-third`'s 46vw and was hard-clipped MID-WORD with no ellipsis. The stale block also carried
// prose describing a card that no longer exists.
//
// Nothing in design-system.test.ts, stage-scale.test.ts or contrast.test.ts could see a duplicate
// selector: they read app.css and computed properties, not the shape of a component's own <style>.
// A duplicate selector is a specific and cheap-to-detect hazard — the later copy overrides the
// earlier one invisibly, which is exactly how a stale block outlived the design it replaced. This
// pins the property so the next stale-copy edit fails here instead of on a real TV.
//
// SOURCE SCAN, not a rendered assertion: +page.svelte cannot be imported here (no Svelte compiler in
// bun test, and the component needs a browser). The rendered result of the #127 fix was verified
// eyes-on in a headless browser and captured in the PR.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE = join(import.meta.dir, '+page.svelte');
const raw = readFileSync(PAGE, 'utf8');

/** Extract every <style> block's body, comments blanked so a selector-in-prose is not counted. */
function styleBodies(src: string): string {
	const blocks = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
	expect(blocks.length).toBeGreaterThan(0); // the page has a <style> block; if not, the regex broke
	return blocks.join('\n').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Every class selector that begins a rule, i.e. `.foo {` at the start of a (whitespace-led) line.
 * We deliberately match only the simple single-class rule heads the lower-third uses; that is enough
 * to catch a re-declared block and avoids false positives on descendant/compound selectors that can
 * legitimately repeat a class name in different contexts.
 */
function ruleHeadClasses(styleSrc: string): string[] {
	return [...styleSrc.matchAll(/^\s*(\.[a-zA-Z][\w-]*)\s*\{/gm)].map((m) => m[1]!);
}

test('no class selector is declared more than once in the TV page <style>', () => {
	const heads = ruleHeadClasses(styleBodies(raw));
	const seen = new Map<string, number>();
	for (const h of heads) seen.set(h, (seen.get(h) ?? 0) + 1);
	const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([sel, n]) => `${sel} (\u00d7${n})`);
	// Red on the pre-#127 tree: .ls-name/.ls-song/.ls-artist/.ls-key each appeared twice.
	expect(dupes).toEqual([]);
});

test('.ls-artist does not re-introduce inline-inert truncation (the #127 regression)', () => {
	// The artist credit is an INLINE span; overflow/text-overflow are inert on it and white-space:
	// nowrap clips it mid-word. Truncation is .ls-song's job (2-line -webkit-line-clamp). This asserts
	// the specific declaration that caused #127 cannot come back on .ls-artist even if a future edit
	// keeps the selector unique.
	const body = styleBodies(raw);
	const rule = /\.ls-artist\s*\{([^}]*)\}/.exec(body);
	expect(rule).not.toBeNull();
	const decls = rule![1]!;
	expect(decls).not.toMatch(/white-space\s*:\s*nowrap/);
	expect(decls).not.toMatch(/text-overflow\s*:/);
	expect(decls).not.toMatch(/overflow\s*:/);
});
