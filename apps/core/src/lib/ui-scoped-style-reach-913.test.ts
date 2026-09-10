/*
 * A SCOPED RULE IN THE VENDORED TREE MUST BE ABLE TO REACH WHAT IT STYLES (#913).
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────────────────────────
 *
 * `ui/slider/slider.svelte` put its class on `<SliderPrimitive.Root>` and styled it with an ordinary
 * scoped rule:
 *
 *     <SliderPrimitive.Root class={cn("encore-slider …")} …>
 *     <style>.encore-slider { min-height: var(--tap); }</style>
 *
 * Svelte compiles that to `.encore-slider.svelte-2rnmeq`, and puts the `svelte-2rnmeq` marker on
 * elements THIS file renders. `SliderPrimitive.Root` is a component, so the element that finally
 * carries the class belongs to Bits UI and carries no marker. The selector therefore matches nothing:
 * the rule shipped in the CSS bundle and applied to no element in the app.
 *
 * The consequence was not subtle — every settings slider lost its 44px tap floor, so the 28px thumb
 * overflowed upward and overlapped the label above it. And NOTHING in this suite could see it:
 *
 *   - `svelte-check` does not warn, because the class IS used in the file (inside a `cn()` string), so
 *     it is not an unused selector.
 *   - `touch-targets.test.ts` reads the RULE TEXT and found `min-height: var(--tap)` exactly where it
 *     expected it. It was mutation-proved and still green, because a rule that exists and a rule that
 *     applies are different claims and it only ever checked the first.
 *   - every other guard in #913's migration is a source scan, and the source was correct.
 *
 * It was found by looking at a screenshot. This file is the cheap check that should have caught it.
 *
 * ── WHAT IT ASSERTS ────────────────────────────────────────────────────────────────────────────
 *
 * In `lib/components/ui/**`, a class handed to a CHILD COMPONENT must not be the subject of a
 * non-`:global` rule in the same file. The fix is always one of two things, and both are legitimate:
 * reach the element through `:global([data-slot='…'])` — shadcn's own contract for it, stable across a
 * re-vendor — or put the class on a plain element this file renders.
 */
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(import.meta.dir, 'components', 'ui');

function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...svelteFiles(p));
		else if (name.endsWith('.svelte')) out.push(p);
	}
	return out;
}

/** The `<style>` block, or '' when the file has none. */
function styleBlock(src: string): string {
	return /<style[^>]*>([\s\S]*?)<\/style>/.exec(src)?.[1] ?? '';
}

/**
 * Every class token handed to a CHILD COMPONENT in this file's markup.
 *
 * A component is spelled with a capital or a dot (`<Button`, `<TabsPrimitive.Trigger`), which is
 * Svelte's own rule for telling a component from an element. Only static class tokens are collected —
 * an interpolated one cannot be matched against a selector anyway.
 */
function classesOnChildComponents(src: string): Set<string> {
	const out = new Set<string>();
	for (const tag of src.matchAll(/<([A-Z][\w.]*|[a-z][\w-]*\.[\w.]*)\b([^>]*)>/g)) {
		const attrs = tag[2] ?? '';
		for (const cls of attrs.matchAll(/class=(?:\{cn\(|\{)?\s*"([^"]*)"/g))
			for (const t of cls[1]!.split(/\s+/)) if (t && !t.includes('{')) out.add(t);
	}
	return out;
}

/** Rule subjects in the style block that are NOT inside `:global(...)`, with their class tokens. */
function scopedRuleClasses(css: string): Map<string, string> {
	const found = new Map<string, string>();
	// Blank every `:global(...)` interior first: a class named in there is explicitly global and fine.
	const scoped = css.replace(/:global\([^)]*\)/g, (m) => ' '.repeat(m.length));
	for (const rule of scoped.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
		const sel = rule[1]!;
		if (sel.includes('@')) continue; // an at-rule preamble, not a subject
		for (const cls of sel.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
			if (!found.has(cls[1]!)) found.set(cls[1]!, sel.trim().slice(0, 80));
		}
	}
	return found;
}

test('no scoped rule in ui/ styles a class it hands to a child component (#913)', () => {
	const files = svelteFiles(UI);
	// Non-vacuity: the vendored tree is real and this walk reached it. #913 brought in 19 components.
	expect(files.length).toBeGreaterThan(30);

	const offenders: string[] = [];
	let filesWithBoth = 0;
	for (const f of files) {
		const src = readFileSync(f, 'utf8');
		const handed = classesOnChildComponents(src);
		if (handed.size === 0) continue;
		const scoped = scopedRuleClasses(styleBlock(src));
		if (scoped.size === 0) continue;
		filesWithBoth++;
		for (const cls of handed) {
			const sel = scoped.get(cls);
			if (sel === undefined) continue;
			offenders.push(
				`${f.slice(f.indexOf('components/ui'))}: \`${sel}\` is scoped, but \`${cls}\` is handed to a ` +
					`CHILD COMPONENT — Svelte's hash lands on nothing, so the rule matches no element. Reach it ` +
					`with :global([data-slot='…']) instead, or move the class onto a plain element in this file.`
			);
		}
	}
	// A second floor: the check is only meaningful on files that have BOTH a child component carrying a
	// class and a scoped rule. If that population is ever zero the walk has stopped seeing the tree.
	expect(filesWithBoth).toBeGreaterThan(0);
	expect(offenders).toEqual([]);
});

test('the reach check actually catches the shape it was written for (#913)', () => {
	/*
	 * Mutation proof, on synthetic sources rather than by editing a component: the arm above must fire on
	 * the exact defect that shipped, and stay quiet on both legitimate fixes for it.
	 */
	const broken = `<SliderPrimitive.Root class={cn("encore-slider x")} />
<style>.encore-slider { min-height: var(--tap); }</style>`;
	expect(scopedRuleClasses(styleBlock(broken)).has('encore-slider')).toBe(true);
	expect(classesOnChildComponents(broken).has('encore-slider')).toBe(true);

	// Fix 1: reach it globally. The class is still handed over, but the rule is no longer scoped.
	const globalFix = `<SliderPrimitive.Root class={cn("encore-slider x")} />
<style>:global([data-slot='slider']) { min-height: var(--tap); }</style>`;
	expect(scopedRuleClasses(styleBlock(globalFix)).size).toBe(0);

	// Fix 2: put the class on a plain element this file renders.
	const plainFix = `<div class="encore-slider"></div>
<style>.encore-slider { min-height: var(--tap); }</style>`;
	expect(classesOnChildComponents(plainFix).has('encore-slider')).toBe(false);
	expect(scopedRuleClasses(styleBlock(plainFix)).has('encore-slider')).toBe(true);
});
