<!--
  ── ENCORE DEVIATIONS (#913 S4) ───────────────────────────────────────────────────────────────────
  shadcn's TYPOGRAPHY is kept — S4 accepted the visual change. What is restored is LAYOUT, because
  losing it is a broken page rather than a different-looking one:

  `.hint` sat under its control with `margin: var(--space-xs) 0 0`. The registry's description carries
  `last:mt-0` and a negative nth-last-2 margin instead, which is tuned for its own Field grouping and
  leaves a bare hint touching the control above it.

  `:global([data-slot='…'])` because this file renders a COMPONENT (Label → Bits UI Label), and
  Svelte's scoped CSS cannot reach an element another component renders. `data-slot` is shadcn's own
  contract for it, so it survives a re-vendor where an Encore class would not.
-->
<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLParagraphElement>> = $props();
</script>

<p
	bind:this={ref}
	data-slot="field-description"
	class={cn(
		'text-left text-sm text-muted-foreground [[data-variant=legend]+&]:-mt-1.5 leading-normal font-normal group-has-[[data-orientation=horizontal]]/field:text-balance',
		'last:mt-0 nth-last-2:-mt-1',
		'[&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</p>

<style>
	:global([data-slot='field-description']) {
		margin: var(--space-xs) 0 0;
	}
</style>
