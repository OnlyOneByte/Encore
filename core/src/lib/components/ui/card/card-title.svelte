<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="card-title"
	class={cn(
		'text-[length:var(--ph-text-base)] leading-normal font-medium group-data-[size=sm]/card:text-[length:var(--ph-text-md)]',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
