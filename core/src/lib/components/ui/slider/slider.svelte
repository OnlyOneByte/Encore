<!-- Encore's range geometry over the Bits UI primitive. Three styling mechanisms, each forced rather than chosen: the
  ROOT is reached by data-slot in a global rule (it is a child component, so a scoped class compiles to a hash that lands
  on no element and the whole rule dies silently), the TRACK is ordinary scoped CSS because this file renders that span,
  and the FILL and THUMB are utilities because a class is the only thing that reaches a child component. Every caller
  arrives through `$lib/ui/FieldSlider.svelte` — the one wrapper that names the thumbs — so both variants are live:
  `field` on /settings' nine sliders and `guiding` on GuidingTrack's vocal-level rail. -->
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

	/* NO LAYOUT SHIFT ON LOAD (#1404). Bits' default `contain` keeps the thumb inside the rail by MEASURING the thumb and
	   rail, which the server cannot, so its render used a 0-100 scale and the thumb jumped up to half its width on mount.
	   `exact` never measures; the CSS below draws the same contained geometry from `--p`, the value's fraction. */
	const min = $derived(restProps.min ?? 0);
	const max = $derived(restProps.max ?? 100);
	const p = $derived(typeof value === 'number' && max > min ? (value - min) / (max - min) : 0);
</script>

<!-- Discriminated unions + destructuring (required for bindable) do not get along, so we shut TypeScript up by casting
  `value` to `never`. -->
<SliderPrimitive.Root
	bind:ref={ref}
	bind:value={value as never}
	data-slot="slider"
	data-variant={variant}
	orientation={orientation}
	thumbPositioning="exact"
	style="--p: {p}"
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
		/* Half the thumb's width (`size-[28px]` here, `size-[22px]` on the guiding variant). */
		--thumb-r: 14px;
	}
	:global([data-slot='slider'][data-variant='guiding']) {
		--thumb-r: 11px;
	}
	/* `contain`'s geometry, drawn from `--p`: contain puts the thumb's centre, and the range's end, at r + p(W - 2r), r the
	   thumb's half-width. The thumb's `left` is that one length, as contain's was, so it lands on the same sub-pixel;
	   the range's end is pulled back by (1 - 2p)r, within 0.1px of contain's and always under the thumb. Server and
	   client render the same box. !important because Bits writes both as inline style. */
	:global([data-slot='slider-thumb']) {
		left: calc(var(--p) * (100% - 2 * var(--thumb-r)) + var(--thumb-r)) !important;
	}
	:global([data-slot='slider-range']) {
		right: calc((1 - var(--p)) * 100% - (1 - 2 * var(--p)) * var(--thumb-r)) !important;
	}
	/* GuidingTrack's rail is thinner; its thumb inverts the palette — ink filled, accent ringed. Both heights grew by
	   2px with the ring below rather than thinning the fill: app.css sets `box-sizing: border-box` on `*`, so the
	   declared height INCLUDES the two 1px edges, and 6 keeps this rail's painted gradient at the 4px it has always
	   been while 8 keeps the field rail's 6px. */
	.encore-slider-track[data-variant='guiding'] {
		height: 6px;
		border-radius: 4px;
	}
	/* THE RAIL IS THIS CONTROL'S BOUNDARY, so it takes --control-line — and the fix is a 1px ring, not a brighter
	   --track-bg. SC 1.4.11 wants 3:1 for whatever identifies the control, and only the FILLED half of this rail had
	   it: the --accent range is 3.38:1 on --card, while --track-bg, the unfilled remainder — which is MOST of the rail
	   at a low value, and all of it at zero — measures 1.27:1 and reads as nothing. Recolouring the rail cannot fix
	   that half: 3:1 as a FILL on --card needs a #6a6a6a-class grey (the arithmetic is in app.css's --control-line
	   block), and it would repaint the five OUTPUT sites listed at --track-bg there to bound the one control.
	   The ring clears 3:1 against BOTH neighbours: 3.97:1 outside on --card — /settings' cards paint it directly. The guiding
	   rail's host is /queue's `.now` card now, which paints --card-tint: RE-MEASURED there, the ring is 3.89:1, so the
	   move costs 0.08 and clears 3:1 on both hosts. (--card2, the dimmest surface in the set, is 3.65:1 — the figure
	   app.css's --control-line block derives the token from.) Inside, 3.13:1 on --track-bg — and THAT is the figure
	   this rail makes LOAD-BEARING rather than hypothetical, because it is the tightest pair the token has to clear
	   anywhere in the app. Numbers pinned in
	   tests/unit/lib/control-boundary-contrast.test.ts, which also lists this file as a boundary site. */
	.encore-slider-track {
		height: 8px;
		border-radius: var(--radius-pill);
		border: 1px solid var(--control-line);
		background: var(--track-bg);
	}
</style>
