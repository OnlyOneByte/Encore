<!--
  ── ENCORE DEVIATIONS (switch adoption) ──────────────────────────────────────────────────────
  1. `transition-all` (root) and `transition-transform` (thumb) ARE REMOVED. motion.test.ts bans
     `transition-*` as a utility name tree-wide, because a utility cannot honour Reduce Motion. The
     thumb's slide is re-declared below as CSS on `transform` only — a composited property — inside a
     `prefers-reduced-motion: no-preference` block, so motion is OPT-IN. Same idiom as `skeleton`,
     `spinner` and `alert-dialog`. `transition-all` is not replaced at all: it animated colour and
     shadow alongside the transform, and the thumb's travel is the whole affordance.
  2. NO TAP BOX HERE, on purpose. The control is 32x18.4px, well under `--tap`, and that is correct:
     these switches sit inside `<label class="check">`, whose `min-height: var(--tap)` is the row's tap
     target — the same arrangement the Checkbox they replace relied on. Giving the switch its own 44px
     box would make the row 88px and put two competing targets in it. touch-targets.test.ts measures
     the label, which is where the target lives.
  3. Sizes are arbitrary values (`h-[18.4px]`, `w-[32px]`) as shipped, which is what
     vendored-dimension-keys.test.ts requires — a named scale key here would resolve through the
     spacing namespace and collapse the control, the way `max-w-sm` collapsed Empty's column to 8px.
  4. EVERY STATE VARIANT IS `data-[state=checked]`, NEVER `data-checked` — and that is a defect fix, not
     a spelling preference.

     This shipped with shadcn's `data-checked:` / `data-unchecked:` shorthand throughout. That shorthand
     means "an attribute literally named `data-checked`", and `bits-ui` does not emit one: its Switch
     writes `data-state="checked"` / `data-state="unchecked"` on both the root and the thumb (measured on
     the render — the root carries `data-slot data-size data-state aria-checked aria-required
     data-switch-root` and nothing else). So every one of those variants matched nothing, and Tailwind
     emitted NO rule for them at all: a DOM scan of the shipped stylesheet found zero selectors
     containing `[data-checked]`.

     WHAT THAT LOOKED LIKE, which is how it was found: the switch was completely inert. The thumb read
     `transform: none` in BOTH states, so it never travelled and sat at a 7px offset in a 32px track —
     reported as "the circle is stuck in the middle rather than working like a toggle". The track was
     `rgb(107,107,107)` checked AND unchecked, so colour said nothing either. The only visible difference
     between on and off was none.

     The tell was in this file the whole time: the last line of the thumb's class list already used
     `rtl:data-[state=checked]:` — the correct form — for the RTL case alone.

     `justify-start` and `p-0` go with it, and `p-0` is the other half of the reported symptom.

     THE ROOT IS A `<button>`, and Preflight is OFF in this app (see the README in this directory). So the
     UA's own `padding: 1px 6px` applied: measured on the render, a 32px track with `box-sizing: border-box`
     had a content box of 32 − 2 (border) − 12 (padding) = **18px**, and a 16px thumb inside it has 2px of
     travel. That is the "stuck in the middle" the report describes — the thumb was centred in a slot barely
     bigger than itself, and it is the exact hazard this directory's README names: "a shadcn component is
     written expecting box-sizing, zeroed margins and list-style: none… supply what the component needs in
     its own classes". shadcn's switch assumes Preflight zeroed that padding.

     With `p-0` the content box is the full 30px, the thumb rests at the left edge, and the 14px translate
     (`calc(100% - 2px)` of a 16px thumb) lands it flush right with a 1px inset either side — symmetric, and
     the full width of the track is used. Before this it overhung the track's right edge by 5px.
-->
<script lang="ts">
	import { Switch as SwitchPrimitive } from 'bits-ui';
	import { cn, type WithoutChildrenOrChild } from '$lib/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		checked = $bindable(false),
		size = 'default',
		...restProps
	}: WithoutChildrenOrChild<SwitchPrimitive.RootProps> & {
		size?: 'sm' | 'default';
	} = $props();
</script>

<SwitchPrimitive.Root
	bind:ref={ref}
	bind:checked={checked}
	data-slot="switch"
	data-size={size}
	class={cn(
		'data-[state=checked]:bg-primary data-[state=unchecked]:bg-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 dark:data-[state=unchecked]:bg-input/80 shrink-0 rounded-full border border-transparent shadow-xs focus-visible:ring-3 aria-invalid:ring-3 group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:border-transparent data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] peer group/switch relative inline-flex items-center justify-start p-0 outline-none after:absolute after:-inset-x-3 after:-inset-y-2 data-disabled:cursor-not-allowed data-disabled:opacity-50',
		className
	)}
	{...restProps}
>
	<SwitchPrimitive.Thumb
		data-slot="switch-thumb"
		class={cn(
			'bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-primary-foreground rounded-full group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-[state=checked]:translate-x-[calc(100%_-_2px)] group-data-[size=sm]/switch:data-[state=checked]:translate-x-[calc(100%_-_2px)] group-data-[size=default]/switch:data-[state=unchecked]:translate-x-0 group-data-[size=sm]/switch:data-[state=unchecked]:translate-x-0 pointer-events-none block ring-0',
			'rtl:data-[state=checked]:translate-x-[calc(-100%)]'
		)}
	/>
</SwitchPrimitive.Root>

<style>
	/*
	 * The thumb is rendered by a CHILD component, so it carries no scoping hash for this file and a
	 * plain rule would ship and match nothing. `:global([data-slot=…])` is the correct reach, and
	 * shadcn's own data-slot is more stable across a re-vendor than a class of ours.
	 *
	 * Motion is OPT-IN inside a no-preference block rather than declared-then-reset: there is no reset
	 * to lose the cascade to, and an instant snap is a fine resting state for a toggle.
	 */
	@media (prefers-reduced-motion: no-preference) {
		:global([data-slot='switch-thumb']) {
			transition: transform var(--motion-fast) ease-out;
		}
	}
</style>
