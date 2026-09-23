<!--
  Used for its GRAMMAR, not its appearance: three list rows each invented their own names for the same
  four parts (leading indicator, title, subtitle, trailing action cluster) and Item names them once.
  Encore's rows pass the `bare` tone and size, which contribute nothing but the group context — the app's
  rows are already surfaces, so the registry's border and radius would double their own.
-->
<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	export const itemVariants = tv({
		base: 'group/item flex w-full items-center outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
		variants: {
			variant: {
				default: 'rounded-md border border-transparent text-sm',
				outline: 'rounded-md border border-border text-sm',
				muted: 'rounded-md border border-transparent bg-muted/50 text-sm',
				bare: ''
			},
			size: {
				default: 'gap-3.5 px-4 py-3.5',
				/* `.list-row` owns the gap and padding for Encore rows (12px / 11px 12px). */
				bare: '',
				sm: 'gap-2.5 px-3 py-2.5',
				xs: 'gap-2 px-2.5 py-2 in-data-[slot=dropdown-menu-content]:p-0'
			}
		},
		defaultVariants: {
			variant: 'default',
			size: 'default'
		}
	});

	export type ItemSize = VariantProps<typeof itemVariants>['size'];
	export type ItemVariant = VariantProps<typeof itemVariants>['variant'];
</script>

<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

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
		'data-slot': 'item',
		'data-variant': variant,
		'data-size': size,
		...restProps
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
	 * LAYOUT ONLY — no colour, no background, no alpha, and that boundary is what keeps the app's
	 * contrast analysis working: `contrast.test.ts` reasons about a row by reading the rules in THE ROW'S
	 * OWN FILE. A rule that declares a colour cannot move here, because a descendant rule cannot follow
	 * its ancestor into a component that exposes no `child` snippet.
	 */
	:global([data-slot='item-media']) {
		flex: 0 0 auto;
	}
	/* `min-width: 0` is load-bearing: a flex item defaults to min-content, so without it the title's own
	   text sets the row's minimum width and its ellipsis never engages. */
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
