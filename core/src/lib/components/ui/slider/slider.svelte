<!-- Encore's range geometry over the Bits UI primitive. Three styling mechanisms, each forced rather than chosen: the
  ROOT is reached by data-slot in a global rule (it is a child component, so a scoped class compiles to a hash that lands
  on no element and the whole rule dies silently), the TRACK is ordinary scoped CSS because this file renders that span,
  and the FILL and THUMB are utilities because a class is the only thing that reaches a child component. GuidingTrack
  deliberately does NOT use this component: Bits UI's Slider reads offsetWidth, which the mount rung hardens to throw. -->
<script lang="ts">
	import { Slider as SliderPrimitive } from 'bits-ui';
	import { cn, type WithoutChildrenOrChild } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		value = $bindable(),
		orientation = 'horizontal',
		variant = 'field',
		class: className,
		...restProps
	}: WithoutChildrenOrChild<SliderPrimitive.RootProps> & {
		variant?: 'field' | 'guiding';
	} = $props();
</script>

<!-- Discriminated unions + destructuring (required for bindable) do not get along, so we shut TypeScript up by casting
  `value` to `never`. -->
<SliderPrimitive.Root
	bind:ref={ref}
	bind:value={value as never}
	data-slot="slider"
	data-variant={variant}
	orientation={orientation}
	class={cn(
		'data-disabled:cursor-not-allowed data-vertical:min-h-40 relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:w-auto data-vertical:flex-col',
		className
	)}
	{...restProps}
>
	{#snippet children({ thumbItems })}
		<span
			data-slot="slider-track"
			data-orientation={orientation}
			data-variant={variant}
			class={cn(
				'encore-slider-track rounded-full data-horizontal:w-full data-vertical:h-full relative grow overflow-hidden'
			)}
		>
			<SliderPrimitive.Range
				data-slot="slider-range"
				class={cn(
					cn(
						'absolute select-none data-horizontal:h-full data-vertical:w-full',
						variant === 'guiding' ? 'bg-linear-to-r from-[var(--accent)] to-[var(--accent2)]' : 'bg-[var(--accent)]'
					)
				)}
			/>
		</span>
		{#each thumbItems as thumb (thumb.index)}
			<SliderPrimitive.Thumb
				data-slot="slider-thumb"
				index={thumb.index}
				class={cn(
					'rounded-full block shrink-0 select-none disabled:pointer-events-none disabled:opacity-50',
					variant === 'guiding'
						? 'size-[22px] border-2 border-[var(--accent)] bg-[var(--ink)] shadow-[0_2px_8px_rgba(0,0,0,0.5)] data-disabled:border-[var(--line-strong)] data-disabled:bg-[var(--ink-dim)]'
						: 'size-[28px] border-[3px] border-[var(--ink)] bg-[var(--accent)] shadow-[0_2px_8px_rgba(0,0,0,0.5)]'
				)}
			/>
		{/each}
	{/snippet}
</SliderPrimitive.Root>

<style>
	/* `:global`, keyed on shadcn's own data-slot, because the root is a Bits UI component: a scoped class here compiles to
	   a hash that matches no element, so the rule and the 44px tap floor with it die in the build while
	   `touch-targets.test.ts` still reads the rule and passes. `ui-scoped-style-reach.test.ts` checks reach. */
	:global([data-slot='slider']) {
		min-height: var(--tap);
		width: 100%;
		cursor: pointer;
	}
	/* GuidingTrack's rail is thinner; its thumb inverts the palette — ink filled, accent ringed. */
	.encore-slider-track[data-variant='guiding'] {
		height: 4px;
		border-radius: 4px;
	}
	.encore-slider-track {
		height: 6px;
		border-radius: var(--radius-pill);
		background: var(--track-bg);
	}
</style>
