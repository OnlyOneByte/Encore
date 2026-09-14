<!--
  ── ENCORE DEVIATIONS ────────────────────────────────────────────────────────────────────────
  1. `max-w-sm` → `max-w-[24rem]`, and this was a LIVE RENDERING BUG rather than a tidy-up.
     Tailwind resolves `max-w-<key>` against the `--container-*` namespace, which this app does not
     bridge, so `--container-sm` does not exist in the build. It fell through to the SPACING namespace,
     which this app DOES bridge with t-shirt keys, and emitted `max-width: var(--space-sm)` — EIGHT
     PIXELS. Every empty state in the app had its content column capped at 8px.

     It passed eslint, svelte-check and the whole suite, because nothing in a source scan can see which
     namespace a named key resolved through. `vendored-dimension-keys.test.ts` was written after the
     same defect was found in `alert-dialog` (`max-w-xs` → 6px) and it caught this one on its first run.

     `24rem` is the value Tailwind's own `--container-sm` would have supplied, so this restores the
     registry's intent rather than inventing a width. An arbitrary value resolves nothing through a
     namespace and so cannot land in the wrong one.
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
