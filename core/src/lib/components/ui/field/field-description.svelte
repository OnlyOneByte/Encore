<!--
  The registry's typography is kept; the top margin below is restored, because the registry's negative
  nth-last-2 margin is tuned for its own Field grouping and leaves a bare hint touching the control above.
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
		'text-left text-[length:var(--ph-text-md)] text-muted-foreground [[data-variant=legend]+&]:-mt-1.5 leading-normal font-normal group-has-[[data-orientation=horizontal]]/field:text-balance',
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
