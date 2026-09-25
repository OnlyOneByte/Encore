<!-- The pill rail only — the tap floor, the certified active pair and the 16px type belong to tabs-trigger.svelte.
  Styled by a global data-slot rule rather than utilities, because `touch-targets.test.ts` reads CSS RULES.
  `tabsListVariants` is deliberately absent rather than exported empty: with the appearance in CSS every arm returns the
  empty string, which reads like a styling hook and is not one. The `variant` PROP stays and still lands as data-variant. -->

<script lang="ts">
	import { Tabs as TabsPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		variant = 'default',
		class: className,
		...restProps
	}: TabsPrimitive.ListProps & {
		variant?: string;
	} = $props();
</script>

<TabsPrimitive.List bind:ref={ref} data-slot="tabs-list" data-variant={variant} class={cn(className)} {...restProps} />

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
