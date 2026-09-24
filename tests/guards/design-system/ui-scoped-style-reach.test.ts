/*
 * guard: a scoped rule must be able to REACH what it styles, and a `:global([data-slot='…'])` rule must
 * have an emitter. `ui/slider` put its class on `<SliderPrimitive.Root>` with an ordinary scoped rule, so
 * the `.svelte-<hash>` marker landed on no element and every settings slider lost its 44px tap floor.
 * Nothing could see it: `svelte-check` does not warn (the class IS used, inside a `cn()` string) and
 * touch-targets.test.ts read the RULE TEXT and found the declaration where it expected.
 * See docs/GUARDS.md#scoped-style-reach for the two legitimate fixes.
 */
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { at, srcDir } from '@encore/test-support';

const UI = at('src/lib/components/ui');
/*
 * The APP side is in scope too, and leaving it out let a real defect ship: `metrics/+page.svelte` handed
 * `<Table.Cell class="name">` a class whose rule the same change deleted from the page.
 */
const APP = [at('src/lib/components'), at('src/routes')];

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
 * Every tag of a CHILD COMPONENT — a capital or a dot, which is Svelte's own rule for telling one from an
 * element. Walked brace-aware, because a `>` inside an attribute expression (`onclick={() => a > b}`) ends
 * a naive match early and hides any `class=` after it.
 */
function tagsOfChildComponents(src: string): string[] {
	const out: string[] = [];
	for (const m of src.matchAll(/<([A-Z][\w.]*|[a-z][\w-]*\.[\w.]*)\b/g)) {
		// `<svelte:element>` renders a real DOM element and DOES carry the scope hash.
		if (m[1]!.startsWith('svelte:')) continue;
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
		// EVERY string in the tag: `cn($lib.x, "encore-foo")` puts the class second, and
		// `class={cond ? "a" : "b"}` puts it in neither position.
		for (const lit of tag.matchAll(/"([^"]*)"|'([^']*)'/g)) {
			for (const t of (lit[1] ?? lit[2] ?? '').split(/\s+/)) {
				if (t && !t.includes('{') && !t.includes('(')) out.add(t);
			}
		}
	}
	/*
	 * …and a `tv()` base, but ONLY when a CHILD COMPONENT consumes it: `badge.svelte` renders
	 * `<svelte:element>`, a REAL element that carries the scope hash, and a guard that cries wolf on a correct
	 * file gets its finding waved through. Resolved TRANSITIVELY, because hoisting `tabsListVariants({…})` into
	 * a script-level `const` leaves the rendered DOM byte-identical and a textual proxy would go green.
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
	// BRACE-BALANCED: depending on the literal `\n\t})` prettier happens to produce made a single-line
	// `tv({ base: "x", variants: {} })` invisible.
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
	// COMMENTS FIRST, then `:global(...)` interiors blanked (a class named there is explicitly global).
	// Without the comment strip a commented-out scoped rule reads as a live one and the guard reds on its own
	// documentation.
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
	// The check is only meaningful on files with BOTH a child component carrying a class and a scoped rule.
	expect(filesWithBoth).toBeGreaterThan(0);
	expect(offenders).toEqual([]);
});

test('the reach check actually catches the shape it was written for', () => {
	// Mutation proof on synthetic sources: fire on the exact defect that shipped, stay quiet on both fixes.
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
	// One arm per shape a `[^>]*` / `class={cn("…` matcher walked past, each of which would have let a dead
	// rule ship the way the slider's did.

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

	// …and NOT when a real element does: `<svelte:element>` carries the scope hash, so its rule applies.
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
 * A file's MARKUP: style blocks, script blocks and HTML comments removed. All three can satisfy a naive
 * `data-slot=` scan with text that renders no attribute, and the emitter check was defeated by two at once —
 * the `:global([data-slot='tabs-trigger'])` selector VOUCHED FOR ITSELF, and a comment named a slot `…`.
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
	// The other direction, which the fix mechanism above opened: nothing checked that the markup still carries
	// the attribute the new selector keys on. Deleting the single `data-slot="tabs-trigger"` kills the tap
	// floor, the active fill, the focus ring and the pill radius at once with the suite FULLY GREEN, because
	// touch-targets.test.ts matches its token against SELECTOR TEXT.
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

	// The emitter can be ANY component or page: a compound component's parts style each other's slots.
	const emitted = new Set<string>();
	for (const f of svelteFiles(srcDir)) {
		const markup = markupOnly(readFileSync(f, 'utf8'));
		for (const m of markup.matchAll(/data-slot=["']([^"']+)["']/g)) emitted.add(m[1]!);
	}

	const unreachable = [...styled.entries()]
		.filter(([slot]) => !emitted.has(slot))
		.map(([slot, files]) => `${files.join(', ')}: styles [data-slot='${slot}'] but no markup emits it`);
	expect(unreachable).toEqual([]);
});

test('the data-slot reach check fails when the attribute is dropped', () => {
	// Mutation proof against strings: red when nothing emits the slot, quiet when the emitter is present
	// anywhere — including a DIFFERENT file, the normal case for a compound component.
	const file = `<!-- a header naming :global([data-slot='…']) as the convention -->
<div class="wrap">slot is styled but never emitted</div>
<style>:global([data-slot='ghost-slot']) { min-height: var(--tap); }</style>`;

	// The style block registers the styled slot; the prose comment must NOT register one.
	const slots = [...styleOnly(file).matchAll(/:global\(\[data-slot='([^']+)'\]/g)].map((m) => m[1]!);
	expect(slots).toEqual(['ghost-slot']);

	// The rule must not be able to vouch for itself: its own selector text contains `data-slot='…'`.
	const emitted = new Set([...markupOnly(file).matchAll(/data-slot=["']([^"']+)["']/g)].map((m) => m[1]!));
	expect(emitted.has('ghost-slot')).toBe(false);
	expect(slots.filter((x) => !emitted.has(x))).toEqual(['ghost-slot']);

	// …and it goes quiet once real markup emits it, including from another file.
	const fixed = markupOnly(`<div data-slot="ghost-slot"></div>`);
	const nowEmitted = new Set([...fixed.matchAll(/data-slot=["']([^"']+)["']/g)].map((m) => m[1]!));
	expect(slots.filter((x) => !nowEmitted.has(x))).toEqual([]);
});

test('the tv() consumer test survives hoisting the variants call', () => {
	// Hoisting `tabsListVariants({ variant })` out of the tag into a script-level `const` made the base
	// invisible to a text scan of the tag, so a scoped rule on it shipped green. Both render identically.
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
