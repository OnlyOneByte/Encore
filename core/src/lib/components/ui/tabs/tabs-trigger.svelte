<!-- Encore's settings scope switcher is a pill segmented control, styled by global data-slot rules rather than
  utilities, because `touch-targets.test.ts` reads CSS RULES and would not see a `min-h-tap` in a class attribute.
  See docs/FRONTEND.md#shared-components. -->
<script lang="ts">
	import { Tabs as TabsPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils.js';

	let { ref = $bindable(null), class: className, ...restProps }: TabsPrimitive.TriggerProps = $props();
</script>

<TabsPrimitive.Trigger bind:ref={ref} data-slot="tabs-trigger" class={cn(className)} {...restProps} />

<style>
	:global([data-slot='tabs-trigger']) {
		flex: 1;
		/* Named, never restated as a literal: `touch-targets.test.ts` checks every control rule that declares a box. */
		min-height: var(--tap);
		border: 0;
		border-radius: var(--radius-pill);
		background: none;
		color: var(--ink-dim);
		/* 16px so iOS does not auto-zoom when the tab takes focus, same as every control below it. */
		font-size: var(--ph-text-base);
		font-weight: 700;
		cursor: pointer;
	}
	/* `data-state="active"`, NEVER `data-active`: the registry's Tailwind variant is spelled that way but raw CSS needs
	   the attribute bits-ui actually emits, and a wrong spelling leaves the selected tab with no fill while
	   `aria-selected` and the roving tabindex stay correct. --accent with --on-accent is the certified pair. */
	:global([data-slot='tabs-trigger'][data-state='active']) {
		background: var(--accent);
		color: var(--on-accent);
	}
	:global([data-slot='tabs-trigger']:focus-visible) {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
</style>
