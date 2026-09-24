<!-- Four rules an innocent edit would break. EVERY STATE VARIANT IS `data-[state=checked]`, never `data-checked`:
  bits-ui emits `data-state`, so the shorthand matches nothing, Tailwind emits no rule at all, and the switch is silently
  inert in both states. `p-0` is load-bearing, not tidiness — the root is a button and Preflight is off, so the UA's own
  `padding: 1px 6px` eats the track's content box and leaves a 16px thumb 2px of travel. No tap box here on purpose:
  these sit inside a label whose min-height is var(--tap). Sizes stay arbitrary values, which
  vendored-dimension-keys.test.ts requires — a named scale key collapses the control. -->
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
	/* The thumb is a CHILD component, so it carries no scoping hash for this file and a plain rule would ship and match
	   nothing; data-slot is also more stable across a re-vendor than a class of ours. Motion is opt-in inside a
	   no-preference block rather than declared-then-reset, and the transition is on `transform` alone. */
	@media (prefers-reduced-motion: no-preference) {
		:global([data-slot='switch-thumb']) {
			transition: transform var(--motion-fast) ease-out;
		}
	}
</style>
