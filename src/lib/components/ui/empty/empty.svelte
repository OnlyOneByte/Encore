<!--
  Encore's empty state is a quiet dim LINE, not the registry's centred dashed panel: an empty queue is the
  least important thing on the screen and a panel out-weighs the hero above it. The registry's STRUCTURE
  is kept (Root / Header / Description), which is what makes the copy addressable.
-->
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

<div bind:this={ref} data-slot="empty" class={cn('encore-empty', className)} {...restProps}>
	{@render children?.()}
</div>

<style>
	.encore-empty {
		color: var(--ink-dim);
		padding: 0 var(--space-2xs);
		font-size: var(--ph-text-md);
	}
</style>
