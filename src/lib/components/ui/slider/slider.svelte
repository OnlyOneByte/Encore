<!--
  ── ENCORE DEVIATIONS (S3) ───────────────────────────────────────────────────────────────────
  Encore's range geometry, replacing the registry's. The incumbent was a hand-styled
  `input[type='range']` with per-engine `::-webkit-slider-*` and `::-moz-range-*` rules; Bits UI builds
  the same control out of real elements, so those two parallel rule sets collapse into one.

  1. The thumb is 28px on a 6px track, not `size-4` on `h-1.5`. Those numbers are the incumbent's, and
     the old CSS carried a comment about WebKit anchoring a 28px thumb to the track top — a bug that
     stops existing here, because the thumb is a positioned element rather than a pseudo-element.
  2. The root keeps `min-height: var(--tap)`. A 6px track is not a 44px target; the old rule got there
     with `height: var(--tap)` on the input and this does the same, which is what touch-targets.test.ts
     reads. `touch-none` stays: #836's drag must not be re-read as a page scroll.
  3. The fill is `var(--accent)`. This is the ONE deliberate visible change in the slice — a native
     range draws no filled portion, so the settings sliders gain one. It is not invention: GuidingTrack
     already shows a fill and drove it with a `--fill` custom property, which this replaces with the
     Range element Bits UI provides for exactly that purpose.
  4. GUIDINGTRACK IS NOT ON THIS COMPONENT, and the reason is a hard conflict rather than a preference.
     Bits UI's Slider reads `offsetWidth` to place its thumb. Encore's mount rung deliberately hardens
     `offsetWidth` to THROW (XR-VER-03), because happy-dom fabricates a zero and a fabricated zero is
     worse than no answer. So a Bits UI Slider cannot be MOUNTED in this harness at all — and
     `hero-live-controls-835.test.ts` mounts GuidingTrack seven times to hold XR-PH-15, XR-PH-03 and
     The settings sliders are unaffected because every settings test is a source scan; nothing
     mounts that page. Migrating GuidingTrack means moving those seven renders to the LAYOUT rung, which
     skips wherever Chromium is absent — a coverage trade that is the owner's call, not this commit's.
  5. Three different mechanisms, and each one is forced rather than chosen:
       - the ROOT is `:global([data-slot='slider'])`. It was a scoped class for one build, and the rule
         matched nothing — the root is a Bits UI component, so Svelte's hash lands on no element. The
         style block below records what that cost.
       - the TRACK is ordinary scoped CSS, because it is a `<span>` THIS file renders.
       - the FILL and THUMB are utilities, because they are child components and a class is the only
         thing that reaches them.
-->
<script lang="ts">
	import { Slider as SliderPrimitive } from "bits-ui";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		value = $bindable(),
		orientation = "horizontal",
		variant = "field",
		class: className,
		...restProps
	}: WithoutChildrenOrChild<SliderPrimitive.RootProps> & {
		variant?: "field" | "guiding";
	} = $props();
</script>

<!--
Discriminated Unions + Destructing (required for bindable) do not
get along, so we shut typescript up by casting `value` to `never`.
-->
<SliderPrimitive.Root
	bind:ref
	bind:value={value as never}
	data-slot="slider"
	data-variant={variant}
	{orientation}
	class={cn(
		"data-disabled:cursor-not-allowed data-vertical:min-h-40 relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:w-auto data-vertical:flex-col",
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
				"encore-slider-track rounded-full data-horizontal:w-full data-vertical:h-full relative grow overflow-hidden"
			)}
		>
			<SliderPrimitive.Range
				data-slot="slider-range"
				class={cn(
					cn(
					"absolute select-none data-horizontal:h-full data-vertical:w-full",
					variant === "guiding"
						? "bg-linear-to-r from-[var(--accent)] to-[var(--accent2)]"
						: "bg-[var(--accent)]"
				)
				)}
			/>
		</span>
		{#each thumbItems as thumb (thumb.index)}
			<SliderPrimitive.Thumb
				data-slot="slider-thumb"
				index={thumb.index}
				class={cn(
					"rounded-full block shrink-0 select-none disabled:pointer-events-none disabled:opacity-50",
					variant === "guiding"
						? "size-[22px] border-2 border-[var(--accent)] bg-[var(--ink)] shadow-[0_2px_8px_rgba(0,0,0,0.5)] data-disabled:border-[var(--line-strong)] data-disabled:bg-[var(--ink-dim)]"
						: "size-[28px] border-[3px] border-[var(--ink)] bg-[var(--accent)] shadow-[var(--shadow)]"
				)}
			/>
		{/each}
	{/snippet}
</SliderPrimitive.Root>

<style>
	/*
	 * `:global`, keyed on shadcn's own data-slot. This was `.encore-slider` — a SCOPED class — and the
	 * rule compiled to `.encore-slider.svelte-<hash>`, which can never match: the root is a Bits UI
	 * COMPONENT, so Svelte puts the hash on nothing. The whole rule was dead in the build, the 44px tap
	 * floor with it, and the 28px thumb overflowed upward into the label above every settings slider.
	 *
	 * Nothing in the suite could see it. touch-targets.test.ts reads the RULE, so it passed on a rule
	 * that never applied — which is why `ui-scoped-style-reach-913.test.ts` now checks reach, and why
	 * this was found by a screenshot instead.
	 */
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
