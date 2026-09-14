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
		'data-checked:bg-primary data-unchecked:bg-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 dark:data-unchecked:bg-input/80 shrink-0 rounded-full border border-transparent shadow-xs focus-visible:ring-3 aria-invalid:ring-3 group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:border-transparent data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] peer group/switch relative inline-flex items-center outline-none after:absolute after:-inset-x-3 after:-inset-y-2 data-disabled:cursor-not-allowed data-disabled:opacity-50',
		className
	)}
	{...restProps}
>
	<SwitchPrimitive.Thumb
		data-slot="switch-thumb"
		class={cn(
			'bg-background dark:data-unchecked:bg-foreground dark:data-checked:bg-primary-foreground rounded-full group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%_-_2px)] group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%_-_2px)] group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0 pointer-events-none block ring-0',
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
