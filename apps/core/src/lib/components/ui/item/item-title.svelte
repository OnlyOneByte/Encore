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
		 * ── ENCORE DEVIATION (#913 Phase 2): `line-clamp-1` REMOVED, because it never applied ─────────
		 * The registry ships `line-clamp-1 flex` together, and those two utilities set the SAME property
		 * to different values: `.line-clamp-1` needs `display: -webkit-box`, `.flex` sets
		 * `display: flex`. Same specificity, so source order decides — and in the built stylesheet
		 * `.flex{display:flex}` is emitted AFTER `.line-clamp-1` (measured: byte 3363 vs 3117), so the
		 * clamp lost every time and Item.Title never truncated anything.
		 *
		 * That is worse than not having it: a caller reads `line-clamp-1`, believes long content is
		 * handled, and ships a row that grows instead. Removing the dead utility makes the behaviour
		 * honest — Item.Title lays out as a flex row and does not clamp. A caller that needs truncation
		 * puts `min-width: 0` + `overflow: hidden; text-overflow: ellipsis` on the text element itself
		 * (what LyricsReselect's `.opt-src` and QueueRow's `.t` do), which works with `flex` rather than
		 * against it.
		 *
		 * NOTE the asymmetry: Item.Description carries `line-clamp-2` and NO `flex`, so ITS clamp is
		 * live. Do not "fix" that one by matching this — two callers deliberately avoided
		 * Item.Description for exactly that reason (a clamped sentence that must not truncate).
		 */
		'gap-2 text-sm leading-snug font-medium underline-offset-4 flex w-fit items-center',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>
