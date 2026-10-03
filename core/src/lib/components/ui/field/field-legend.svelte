<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		variant = 'legend',
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLLegendElement>> & {
		variant?: 'legend' | 'label';
	} = $props();
</script>

<legend
	bind:this={ref}
	data-slot="field-legend"
	data-variant={variant}
	class={cn(
		'mb-3 leading-app-normal font-medium data-[variant=label]:text-[length:var(--ph-text-md)] data-[variant=legend]:text-[length:var(--ph-text-base)]',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</legend>
