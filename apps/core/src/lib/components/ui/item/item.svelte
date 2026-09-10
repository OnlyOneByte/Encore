<!--
  ── ENCORE DEVIATIONS (#913 S8) ───────────────────────────────────────────────────────────────────
  What this component is used for here is its GRAMMAR, not its appearance. Three list rows — QueueRow,
  SongRow and ProcessingCard — each invented their own class names for the same four parts (a leading
  indicator, a title, a subtitle, a trailing action cluster). Item names them once.

  1. The base is reduced to what the PARTS need: `group/item` plus the flex row and focus ring. The
     registry's `rounded-md border text-sm` and `flex-wrap` moved onto the tone variants, because
     Encore's rows are already surfaces — `.card` paints them, `.list-row` lays them out — and a
     second border and radius on top of that is a double, not a style.
  2. A `bare` tone and a `bare` size contribute nothing but that group context, which is what the
     Encore rows pass.
  3. `[a]:transition-colors` and `[a]:hover:bg-muted` removed. The first is a banned motion utility
     name (motion.test.ts); the second is a link-row hover Encore's rows do not have.
-->
<script lang="ts" module>
	import { tv, type VariantProps } from "tailwind-variants";

	export const itemVariants = tv({
		base: "group/item flex w-full items-center outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
		variants: {
			variant: {
				default: "rounded-md border border-transparent text-sm",
				outline: "rounded-md border border-border text-sm",
				muted: "rounded-md border border-transparent bg-muted/50 text-sm",
				/*
				 * Encore's rows already ARE surfaces: `.card` paints them and `.list-row` lays them out, so
				 * this tone contributes nothing but the `group/item` context four of the parts need. Without
				 * it the registry's border and radius would double every row's own.
				 */
				bare: "",
			},
			size: {
				default: "gap-3.5 px-4 py-3.5",
				/* `.list-row` owns the gap and padding for Encore rows (12px / 11px 12px). */
				bare: "",
				sm: "gap-2.5 px-3 py-2.5",
				xs: "gap-2 px-2.5 py-2 in-data-[slot=dropdown-menu-content]:p-0",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

	export type ItemSize = VariantProps<typeof itemVariants>["size"];
	export type ItemVariant = VariantProps<typeof itemVariants>["variant"];
</script>

<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		child,
		variant,
		size,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		child?: Snippet<[{ props: Record<string, unknown> }]>;
		variant?: ItemVariant;
		size?: ItemSize;
	} = $props();

	const mergedProps = $derived({
		class: cn(itemVariants({ variant, size }), className),
		"data-slot": "item",
		"data-variant": variant,
		"data-size": size,
		...restProps,
	});
</script>

{#if child}
	{@render child({ props: mergedProps })}
{:else}
	<div bind:this={ref} {...mergedProps}>
		{@render mergedProps.children?.()}
	</div>
{/if}

<style>
	/*
	 * ── ENCORE'S ROW GRAMMAR: LAYOUT ONLY, DELIBERATELY ───────────────────────────────────────────
	 *
	 * These rules carry POSITION and nothing else — no colour, no background, no alpha. That boundary
	 * is not tidiness, it is what keeps the app's contrast analysis working.
	 *
	 * contrast.test.ts reasons about a row by reading its rules IN THE ROW'S OWN FILE: which surface a
	 * subtree paints on, which ink it draws in, and whether anything between the glyph and the page
	 * changes its alpha. Its exclusion list names `.seq` by name — "a rule that sets BOTH a colour and
	 * a background carries its own surface (the .seq bubble)" — and a sibling arm reads the singer
	 * identity dot's own rule for its flex basis and its contrast against the card.
	 *
	 * Moving those rules in here silently changed that model and the guard fired, correctly: a
	 * descendant rule cannot follow its ancestor into a component that exposes no `child` snippet, so
	 * the ROWS keep every rule that declares a colour, and this file keeps only the box.
	 */
	:global([data-slot='item-media']) {
		flex: 0 0 auto;
	}
	/*
	 * `min-width: 0` is load-bearing rather than tidy: a flex item defaults to min-content, so without
	 * it the title's own text sets the row's minimum width and its ellipsis never engages.
	 */
	:global([data-slot='item-content']) {
		min-width: 0;
		flex: 1;
	}
	/* The trailing cluster. `margin-left: auto` is what pushes it to the row's end. */
	:global([data-slot='item-actions']) {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		flex: 0 0 auto;
	}
	/* A card whose actions sit beside a multi-line body aligns them to its first line. */
	:global([data-slot='item-actions'][data-align='start']) {
		margin-left: 0;
		align-items: flex-start;
	}
</style>
