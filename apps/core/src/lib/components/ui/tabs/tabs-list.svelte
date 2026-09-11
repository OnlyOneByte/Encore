<!--
  ── ENCORE DEVIATIONS (#913 S4) ───────────────────────────────────────────────────────────────────
  Encore's settings scope switcher is a PILL SEGMENTED CONTROL, not shadcn's underlined tab strip, and
  the appearance is replaced rather than layered.

  The rules are `:global([data-slot='…'])` rather than plain scoped CSS, and that is forced: this file
  renders a Bits UI COMPONENT, and Svelte's scoped CSS cannot reach an element another component
  renders. `data-slot` is shadcn's own contract for that element, so keying off it is stable across a
  re-vendor in a way an Encore class would not be. Utilities were the alternative and are worse here:
  `touch-targets.test.ts` reads CSS RULES, so a `min-h-tap` in a class attribute would make the tap
  floor invisible to the guard that exists to protect it.

  This file styles the CONTAINER only — the pill rail the triggers sit in. The tap floor, the certified
  `--accent`/`--on-accent` active pair and the 16px type all belong to `tabs-trigger.svelte`, which
  carries its own header for them. They were listed here too for one build, which sent anyone auditing
  the 44px floor to a file whose style block has no `min-height` in it at all.
-->
<script lang="ts" module>
	import { tv, type VariantProps } from "tailwind-variants";

	export const tabsListVariants = tv({
		base: "encore-seg",
		variants: {
			variant: {
				default: "",
				line: "",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	});

	export type TabsListVariant = VariantProps<typeof tabsListVariants>["variant"];
</script>

<script lang="ts">
	import { Tabs as TabsPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		variant = "default",
		class: className,
		...restProps
	}: TabsPrimitive.ListProps & {
		variant?: TabsListVariant;
	} = $props();
</script>

<TabsPrimitive.List
	bind:ref
	data-slot="tabs-list"
	data-variant={variant}
	class={cn(tabsListVariants({ variant }), className)}
	{...restProps}
/>

<style>
	:global([data-slot='tabs-list']) {
		display: flex;
		gap: var(--space-2xs);
		margin: var(--space-2xs) 0 var(--space-lg);
		padding: var(--space-2xs);
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
	}
</style>
