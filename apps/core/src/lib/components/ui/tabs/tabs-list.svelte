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

  Two facts carried over verbatim, both guarded elsewhere:
    - `min-height: var(--tap)`, named rather than restated (XR-PH-01). A 38px pill would be the one
      control on this page under the 44px floor.
    - the active fill is `var(--accent)` with `var(--on-accent)` ink — the certified pair that carries
      a label at 5.09:1 (#840, XR-COL-12). The fill and its ink are set together, never separately.
    - `font-size: var(--ph-text-base)` (16px) so iOS does not auto-zoom when a tab takes focus.
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
