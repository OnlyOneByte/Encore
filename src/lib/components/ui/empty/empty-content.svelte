<!--
  The width MUST stay an arbitrary value. Tailwind resolves a named `max-w-<key>` against the container
  namespace, which this app does not bridge, so it falls through to the SPACING namespace it does bridge
  with t-shirt keys — `max-w-sm` emits `max-width: var(--space-sm)`, eight pixels, and nothing but a
  screenshot sees it. `vendored-dimension-keys.test.ts` is what catches the named form.
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

<div
	bind:this={ref}
	data-slot="empty-content"
	class={cn('gap-4 text-sm flex w-full max-w-[24rem] min-w-0 flex-col items-center text-balance', className)}
	{...restProps}
>
	{@render children?.()}
</div>
