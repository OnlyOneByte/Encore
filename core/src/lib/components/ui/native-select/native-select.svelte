<!-- The registry's appearance is REPLACED by Encore's `.encore-field` look, in scoped CSS rather than utilities. The
  two hard floors are shared with input.svelte: min-height var(--tap), and a 16px font-size, because iOS Safari auto-zooms
  on focusing any control under 16px and never zooms back. See docs/FRONTEND.md#shared-components. -->
<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLSelectAttributes } from 'svelte/elements';

	type NativeSelectProps = Omit<WithElementRef<HTMLSelectAttributes>, 'size'> & {
		size?: 'sm' | 'default';
	};

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		size = 'default',
		children,
		...restProps
	}: NativeSelectProps = $props();
</script>

<div
	class={cn('group/native-select relative w-full has-[select:disabled]:opacity-50', className)}
	data-slot="native-select-wrapper"
	data-size={size}
>
	<select
		bind:value={value}
		bind:this={ref}
		data-slot="native-select"
		data-size={size}
		class="encore-field"
		{...restProps}
	>
		{@render children?.()}
	</select>
	<ChevronDownIcon
		class="top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none absolute select-none"
		aria-hidden
		data-slot="native-select-icon"
	/>
</div>

<style>
	.encore-field {
		width: 100%;
		box-sizing: border-box;
		appearance: none;
		/* The right padding is composed from the chevron's own inset, size and a gap, so moving the mark moves the padding
			   with it. A literal smaller than that band draws the label THROUGH the glyph. */
		padding: 9px calc(var(--space-md) + 1rem + var(--space-xs)) 9px var(--space-md);
		/* A two-up settings row at 390px gives ~106px of text box, which the longest option exceeds, so the ellipsis is the
			   fallback no padding can replace. */
		text-overflow: ellipsis;
		white-space: nowrap;
		overflow: hidden;
		border-radius: var(--radius-btn);
		/* --control-line and NOT --line: a control's identifying boundary takes SC 1.4.11's 3:1 floor. 3.65:1 on --card2. */
		border: 1px solid var(--control-line);
		background: var(--card2);
		color: var(--ink);
		min-height: var(--tap);
		font-size: var(--ph-text-base);
	}
	.encore-field:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.encore-field:disabled {
		cursor: not-allowed;
	}
</style>
