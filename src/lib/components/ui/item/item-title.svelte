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
	data-slot="item-title"
	class={cn(
		/*
		 * `line-clamp-1` IS DELIBERATELY ABSENT: it and `flex` set `display` to different values at the same
		 * specificity, and `.flex` is emitted later in the built stylesheet, so the clamp loses every time.
		 * A caller that reads `line-clamp-1` and believes long content is handled is worse off than one that
		 * reads none — Item.Title lays out as a flex row and does not clamp, so truncation belongs on the
		 * text element itself as `min-width: 0` with overflow and text-overflow.
		 *
		 * Item.Description carries `line-clamp-2` and NO `flex`, so its clamp is live. Do not match them up.
		 */
		'gap-2 text-sm leading-snug font-medium underline-offset-4 flex w-fit items-center',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
