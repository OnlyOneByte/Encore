/*
 * A SCOPED RULE IN THE VENDORED TREE MUST BE ABLE TO REACH WHAT IT STYLES.
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
 *   - every other guard in the shadcn migration is a source scan, and the source was correct.
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
import { appSrc, at } from '@encore/test-support';

// `at('apps/core/src/lib/components/ui')`, replacing `at('apps/core/src/lib/components/ui')`.
const UI = at('apps/core/src/lib/components/ui');
/*
 * The APP side is in scope too, and leaving it out let a real defect ship.
 *
 * This walked only `components/ui` on the reasoning that the vendored tree was where classes get handed
 * to Bits UI children. But after the migration every PAGE hands classes to shadcn components as well, and
 * `metrics/+page.svelte` did exactly that: `<Table.Cell class="name">`, whose rule the same change deleted
 * from the page. The suite was green because this constant stopped one directory short of it.
 *
 * Cost of widening: one offender at the time of writing, which is the defect. Anything the app side hands
 * to a component must be reached the same two ways as in `ui/` — `:global()`, or a plain element here.
 */
// The same two roots as before, named from the repo root instead of counted from this file:
// `at('apps/core/src/lib/components')` was apps/core/src/lib/components, and
// `at('apps/core/src/routes')` was apps/core/src/routes.
const APP = [at('apps/core/src/lib/components'), at('apps/core/src/routes')];

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
 *
 * THREE THINGS THIS DELIBERATELY DOES NOT DO NAIVELY, each closing a real blind spot a reviewer found
 * in the first version of this file. A guard with a known gap is what let the defect above ship, so
 * the gaps are closed and each has a mutation arm at the bottom of this file:
 *
 *   1. The tag is scanned brace-aware rather than with `[^>]*`. A `>` inside an attribute expression
 *      — `onclick={() => a > b}` — ends a naive match early, and any `class=` after it is invisible.
 *   2. Class literals are collected from EVERY string in the tag's attributes, not only the one
 *      immediately after `class=` or `class={cn(`. `cn($lib.x, "encore-foo")` puts it in second
 *      position; `class={cond ? "a" : "b"}` puts it in neither.
 *   3. `tv({ base: "…" })` bases count too. A tailwind-variants base reaches the same element by the
 *      same route, and three components in this tree style themselves that way.
 */
function tagsOfChildComponents(src: string): string[] {
	const out: string[] = [];
	for (const m of src.matchAll(/<([A-Z][\w.]*|[a-z][\w-]*\.[\w.]*)\b/g)) {
		// `<svelte:element>` renders a real DOM element and DOES carry the scope hash.
		if (m[1]!.startsWith('svelte:')) continue;
		// Walk forward to the tag's own `>`, tracking brace and quote depth so an expression cannot
		// terminate the tag early.
		let i = m.index! + m[0].length;
		let depth = 0;
		let quote: string | null = null;
		for (; i < src.length; i++) {
			const c = src[i]!;
			if (quote) {
				if (c === quote) quote = null;
				continue;
			}
			if (c === '"' || c === "'" || c === '`') quote = c;
			else if (c === '{') depth++;
			else if (c === '}') depth--;
			else if (c === '>' && depth === 0) break;
		}
		out.push(src.slice(m.index!, i));
	}
	return out;
}

/** Class tokens a file hands to a child component, from any string position in the tag. */
function classesOnChildComponents(src: string): Set<string> {
	const out = new Set<string>();
	for (const tag of tagsOfChildComponents(src)) {
		if (!/\bclass\s*=/.test(tag)) continue;
		for (const lit of tag.matchAll(/"([^"]*)"|'([^']*)'/g)) {
			for (const t of (lit[1] ?? lit[2] ?? '').split(/\s+/)) {
				if (t && !t.includes('{') && !t.includes('(')) out.add(t);
			}
		}
	}
	/*
	 * …and a `tv()` base, but ONLY when a child component is what consumes it.
	 *
	 * The unconditional version of this was wrong and said so loudly: `badge.svelte` builds its class
	 * from `badgeVariants()` and renders `<svelte:element this={href ? "a" : "span"}>`, which is a REAL
	 * element — Svelte puts the scope hash on it (verified in the SSR output), so its scoped
	 * `.encore-chip` rule applies exactly as intended. Flagging it was a false positive, and a guard
	 * that cries wolf on a correct file gets its finding waved through on the day it is right.
	 *
	 * `<svelte:element>` is therefore an element here, not a component. What matters is whether the tag
	 * that CONSUMES the variants call is a component; `tabs-list` is the case that must still be caught.
	 */
	/*
	 * Which variants functions reach a child component — resolved TRANSITIVELY, not by scanning tag text.
	 *
	 * The first version looked for `xxxVariants(` inside the component's own tag. That is a textual proxy
	 * for the real relationship, and hoisting the call one line defeats it while leaving the rendered DOM
	 * byte-identical:
	 *
	 *     const listCls = tabsListVariants({ variant });     // in <script>
	 *     <TabsPrimitive.List class={cn(listCls, className)} />
	 *
	 * That is an ordinary refactor, not an evasion, so it would have happened by accident — and with it the
	 * guard went green on the exact dead-rule defect this file exists to catch. So: collect every
	 * identifier a child component's tag mentions, then follow script-level `const`s until a `*Variants(`
	 * call is reached.
	 */
	const assignments = new Map<string, string>();
	for (const a of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_][\w]*)\s*=\s*([^;\n]+)/g)) {
		assignments.set(a[1]!, a[2]!);
	}
	const variantsConsumedByComponent = new Set<string>();
	const seen = new Set<string>();
	const follow = (ident: string, depth = 0): void => {
		if (depth > 6 || seen.has(ident)) return;
		seen.add(ident);
		if (/Variants$/.test(ident)) variantsConsumedByComponent.add(ident);
		const rhs = assignments.get(ident);
		if (!rhs) return;
		for (const ref of rhs.matchAll(/\b([A-Za-z_][\w]*)\s*\(?/g)) follow(ref[1]!, depth + 1);
	};
	for (const tag of tagsOfChildComponents(src)) {
		if (!/\bclass\s*=/.test(tag)) continue;
		for (const ident of tag.matchAll(/\b([A-Za-z_][\w]*)\b/g)) follow(ident[1]!);
	}
	/*
	 * The tv() declarations themselves, matched BRACE-BALANCED rather than by indentation.
	 *
	 * This depended on the literal `\n\t})` that prettier happens to produce, so a single-line
	 * `tv({ base: "x", variants: {} })` — perfectly ordinary code — was invisible and its base unchecked.
	 */
	for (const start of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_][\w]*Variants)\s*=\s*tv\(/g)) {
		const name = start[1]!;
		if (!variantsConsumedByComponent.has(name)) continue;
		let i = start.index! + start[0].length;
		let depth = 1;
		let quote: string | null = null;
		const from = i;
		for (; i < src.length && depth > 0; i++) {
			const c = src[i]!;
			if (quote) {
				if (c === quote) quote = null;
				continue;
			}
			if (c === '"' || c === "'" || c === '`') quote = c;
			else if (c === '(' || c === '{') depth++;
			else if (c === ')' || c === '}') depth--;
		}
		for (const lit of src.slice(from, i).matchAll(/"([^"]*)"/g)) {
			for (const t of lit[1]!.split(/\s+/)) if (t && !t.includes(':')) out.add(t);
		}
	}
	return out;
}

/** Rule subjects in the style block that are NOT inside `:global(...)`, with their class tokens. */
function scopedRuleClasses(css: string): Map<string, string> {
	const found = new Map<string, string>();
	// Blank every `:global(...)` interior first: a class named in there is explicitly global and fine.
	// COMMENTS FIRST. Without this the guard reds on its own documentation: a commented-out
	// `/* .encore-seg { … } was replaced by the data-slot rule */` is read as a live scoped rule and
	// reported as a defect. `styleOnly` in this same file already strips them, and this function did not, so
	// a guard carrying a stripper in one helper still reported a defect from a comment read by another.
	// Stripping comments first is a long-standing convention here rather than anything this branch worked
	// out — around a hundred test files on main already do it. The shadcn migration still had to add it in five places, TWICE
	// in this file, which is a fair measure of how readily a text-scanning guard criminalises its own notes.
	const css2 = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
	const scoped = css2.replace(/:global\([^)]*\)/g, (m) => ' '.repeat(m.length));
	for (const rule of scoped.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
		const sel = rule[1]!;
		if (sel.includes('@')) continue; // an at-rule preamble, not a subject
		for (const cls of sel.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
			if (!found.has(cls[1]!)) found.set(cls[1]!, sel.trim().slice(0, 80));
		}
	}
	return found;
}

test('no scoped rule styles a class it hands to a child component', () => {
	const files = [...new Set([...svelteFiles(UI), ...APP.flatMap(svelteFiles)])];
	// Non-vacuity: measured, not guessed — 62 files under ui/ (19 components), 76 under lib/components
	// including those, and 9 under routes/, deduping to 85. A walk that drops materially below that lost a
	// root, and the empty offenders array below would then mean "scanned nothing" rather than "clean".
	expect(files.length).toBeGreaterThanOrEqual(80); // @nvf-floor files.length

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

test('the reach check actually catches the shape it was written for', () => {
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

test('the reach check sees a class the naive scans missed (first-version blind spots)', () => {
	/*
	 * One arm per gap a reviewer found in this file's first version. Each source below is a shape the
	 * original `[^>]*` / `class={cn("…` matcher walked straight past, so each would have let a dead rule
	 * ship exactly the way the slider's did.
	 */

	// 1. a `>` inside an attribute expression must not end the tag early.
	const braceTrap = `<SliderPrimitive.Root onValueChange={(v) => v > 2} class="encore-x" />`;
	expect(classesOnChildComponents(braceTrap).has('encore-x')).toBe(true);

	// 2. the class literal is not always the first string in the tag.
	const secondPosition = `<TabsPrimitive.Trigger class={cn(someBase, "encore-y")} />`;
	expect(classesOnChildComponents(secondPosition).has('encore-y')).toBe(true);
	const ternary = `<ProgressPrimitive.Root class={big ? "encore-z" : "encore-w"} />`;
	expect(classesOnChildComponents(ternary).has('encore-z')).toBe(true);
	expect(classesOnChildComponents(ternary).has('encore-w')).toBe(true);

	// 3. a tailwind-variants base counts when a COMPONENT consumes it…
	const tvBase = `<script lang="ts" module>
	export const xVariants = tv({
		base: "encore-tv-base",
		variants: {}
	});
</script>
<TabsPrimitive.List class={cn(xVariants(), className)} />`;
	expect(classesOnChildComponents(tvBase).has('encore-tv-base')).toBe(true);

	// …and NOT when a real element does. `<svelte:element>` is an element: it carries the scope hash, so
	// its scoped rule applies. This is the badge.svelte shape, and flagging it was a false positive.
	const tvOnElement = `<script lang="ts" module>
	export const yVariants = tv({
		base: "encore-tv-elem",
		variants: {}
	});
</script>
<svelte:element this={href ? "a" : "span"} class={cn(yVariants(), className)} />`;
	expect(classesOnChildComponents(tvOnElement).has('encore-tv-elem')).toBe(false);

	// …and none of the above should invent a class that is not there.
	expect(classesOnChildComponents(`<div class="plain-element" />`).size).toBe(0);
});

/**
 * Every `data-slot` name this tree STYLES must be a name this tree EMITS.
 *
 * This closes the other direction, and it is the direction the shadcn migration's own fix opened. The defect at the
 * top of this file was a rule that could not reach its element; the fix moved every such rule to
 * `:global([data-slot='…'])`. Nothing then checked that the markup still carries the attribute the
 * new selector keys on — so the fix mechanism was unguarded in exactly the way the bug had been.
 *
 * It is not hypothetical. Deleting the single `data-slot="tabs-trigger"` attribute kills the 44px tap
 * floor, the active fill, the focus ring and the pill radius at once, and the suite stays FULLY GREEN:
 * `touch-targets.test.ts` matches its `/tabs-trigger/` token against the rule's SELECTOR TEXT, which is
 * still there and now applies to nothing. That is the same "correct in source, wrong on screen" shape
 * as the original, and 11 of the 12 styled slots had no anchor of any kind — only `slider` did, and
 * only incidentally, through an e2e selector.
 *
 * A source scan settles it: all 12 names are written in this tree's own markup, so there is no case
 * where the emitter is inside a dependency and out of reach.
 */
/**
 * A file's MARKUP: style blocks, script blocks and HTML comments removed.
 *
 * Every one of those three can satisfy a naive `data-slot=` scan with text that renders no attribute,
 * and the first version of the check below was defeated by TWO of them at once. The `:global([data-slot=
 * 'tabs-trigger'])` selector contains the exact substring the emitter scan was looking for, so the rule
 * VOUCHED FOR ITSELF and the mutation stayed green; and the header comment explaining the convention
 * contributed a slot literally named `…`. That is the same "text is not behaviour" mistake as the defect
 * this file exists to catch, so the scan is narrowed to the only region that can actually emit an
 * attribute.
 */
function markupOnly(src: string): string {
	return src
		.replace(/<style[\s\S]*?<\/style>/g, ' ')
		.replace(/<script[\s\S]*?<\/script>/g, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ');
}

/** A file's STYLE text with comments removed, so prose cannot register a styled slot. */
function styleOnly(src: string): string {
	const blocks = src.match(/<style[\s\S]*?<\/style>/g) ?? [];
	return blocks.join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

test('every data-slot styled via :global is emitted by markup in this tree', () => {
	const styled = new Map<string, string[]>();
	for (const f of svelteFiles(UI)) {
		const src = styleOnly(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/:global\(\[data-slot='([^']+)'\]/g)) {
			const list = styled.get(m[1]!) ?? [];
			list.push(f.slice(f.indexOf('components/ui/')));
			styled.set(m[1]!, list);
		}
	}

	// A styled slot with no anchor at all would be a silent regression waiting to happen.
	expect(styled.size).toBeGreaterThanOrEqual(12); // @nvf-floor styled.size

	// The emitter can be ANY component in the app, not only one in ui/: a compound component's parts
	// style each other's slots, and a page may spell one itself.
	const emitted = new Set<string>();
	// `appSrc` (apps/core/src), replacing `at('apps/core/src')` — the whole app tree, because a
	// styled slot's emitter can be any component or page, not only one under ui/.
	for (const f of svelteFiles(appSrc)) {
		const markup = markupOnly(readFileSync(f, 'utf8'));
		for (const m of markup.matchAll(/data-slot=["']([^"']+)["']/g)) emitted.add(m[1]!);
	}

	const unreachable = [...styled.entries()]
		.filter(([slot]) => !emitted.has(slot))
		.map(([slot, files]) => `${files.join(', ')}: styles [data-slot='${slot}'] but no markup emits it`);
	expect(unreachable).toEqual([]);
});

test('the data-slot reach check fails when the attribute is dropped', () => {
	/*
	 * Mutation proof, run against strings rather than the tree: the check must red on a rule whose slot
	 * nothing emits, and stay quiet when the emitter is present anywhere — including a DIFFERENT file,
	 * which is the normal case for a compound component whose parts style each other's slots.
	 */
	const file = `<!-- a header naming :global([data-slot='…']) as the convention -->
<div class="wrap">slot is styled but never emitted</div>
<style>:global([data-slot='ghost-slot']) { min-height: var(--tap); }</style>`;

	// The style block registers the styled slot; the prose comment must NOT register one.
	const slots = [...styleOnly(file).matchAll(/:global\(\[data-slot='([^']+)'\]/g)].map((m) => m[1]!);
	expect(slots).toEqual(['ghost-slot']);

	// The rule must not be able to vouch for itself: its own selector text contains `data-slot='…'`,
	// so scanning the whole file would find an "emitter" that renders nothing. Markup only.
	const emitted = new Set(
		[...markupOnly(file).matchAll(/data-slot=["']([^"']+)["']/g)].map((m) => m[1]!)
	);
	expect(emitted.has('ghost-slot')).toBe(false);
	expect(slots.filter((x) => !emitted.has(x))).toEqual(['ghost-slot']);

	// …and it goes quiet once real markup emits it, including from another file.
	const fixed = markupOnly(`<div data-slot="ghost-slot"></div>`);
	const nowEmitted = new Set([...fixed.matchAll(/data-slot=["']([^"']+)["']/g)].map((m) => m[1]!));
	expect(slots.filter((x) => !nowEmitted.has(x))).toEqual([]);
});

test('the tv() consumer test survives hoisting the variants call', () => {
	/*
	 * The hole this closes: moving `tabsListVariants({ variant })` out of the tag and into a script-level
	 * `const` made the base invisible to a text scan of the tag, so a scoped rule on it shipped green.
	 * Both spellings must be seen, because they render identically.
	 */
	const direct = `<script lang="ts" module>
	export const xVariants = tv({ base: "encore-direct", variants: {} });
</script>
<TabsPrimitive.List class={cn(xVariants({ variant }), className)} />`;
	expect(classesOnChildComponents(direct).has('encore-direct')).toBe(true);

	const hoisted = `<script lang="ts" module>
	export const yVariants = tv({ base: "encore-hoisted", variants: {} });
</script>
<script lang="ts">
	const listCls = yVariants({ variant });
</script>
<TabsPrimitive.List class={cn(listCls, className)} />`;
	expect(classesOnChildComponents(hoisted).has('encore-hoisted')).toBe(true);

	// …through one more hop, and still NOT when a real element consumes it.
	const twoHops = `<script lang="ts" module>
	export const zVariants = tv({ base: "encore-twohop", variants: {} });
</script>
<script lang="ts">
	const a = zVariants({ variant });
	const b = a;
</script>
<TabsPrimitive.List class={cn(b, className)} />`;
	expect(classesOnChildComponents(twoHops).has('encore-twohop')).toBe(true);

	const onElement = `<script lang="ts" module>
	export const wVariants = tv({ base: "encore-elem", variants: {} });
</script>
<script lang="ts">
	const cls = wVariants({ variant });
</script>
<svelte:element this={href ? "a" : "span"} class={cn(cls, className)} />`;
	expect(classesOnChildComponents(onElement).has('encore-elem')).toBe(false);
});

test('a commented-out rule is not read as a live scoped rule', () => {
	// The guard must not red on its own documentation, and must still see the real rule beside it.
	const commented = `<style>
	/* .encore-seg { min-height: var(--tap); } was replaced by the data-slot rule */
	.encore-real { display: flex; }
</style>`;
	const found = scopedRuleClasses(commented);
	expect(found.has('encore-seg')).toBe(false);
	expect(found.has('encore-real')).toBe(true);

	// …and a rule on the same line as a closing comment marker is still collected.
	const sameLine = `<style>/* note */ .encore-after { display: grid; }</style>`;
	expect(scopedRuleClasses(sameLine).has('encore-after')).toBe(true);
});
