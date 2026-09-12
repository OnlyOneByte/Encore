<!--
  ── ENCORE DEVIATIONS (S4) ───────────────────────────────────────────────────────────────────
  Encore's settings scope switcher is a PILL SEGMENTED CONTROL, not shadcn's underlined tab strip, and
  the appearance is replaced rather than layered.

  The rules are `:global([data-slot='…'])` rather than plain scoped CSS, and that is forced: this file
  renders a Bits UI COMPONENT, and Svelte's scoped CSS cannot reach an element another component
  renders. `data-slot` is shadcn's own contract for that element, so keying off it is stable across a
  re-vendor in a way an Encore class would not be. Utilities were the alternative and are worse here:
  `touch-targets.test.ts` reads CSS RULES, so a `min-h-tap` in a class attribute would make the tap
  floor invisible to the guard that exists to protect it.

  Two facts carried over verbatim, both guarded elsewhere:
    - `min-height: var(--tap)`, named rather than restated (XR-PH-01). A 38px pill would be the one
      control on this page under the 44px floor.
    - the active fill is `var(--accent)` with `var(--on-accent)` ink — the certified pair that carries
      a label at 5.09:1 (XR-COL-12). The fill and its ink are set together, never separately.
    - `font-size: var(--ph-text-base)` (16px) so iOS does not auto-zoom when a tab takes focus.
-->
<script lang="ts">
	import { Tabs as TabsPrimitive } from 'bits-ui';
	import { cn } from '$lib/utils.js';

	let { ref = $bindable(null), class: className, ...restProps }: TabsPrimitive.TriggerProps = $props();
</script>

<TabsPrimitive.Trigger bind:ref={ref} data-slot="tabs-trigger" class={cn(className)} {...restProps} />

<style>
	:global([data-slot='tabs-trigger']) {
		flex: 1;
		/*
		 * var(--tap), not a smaller literal: touch-targets.test.ts checks every control rule that
		 * declares a box, and a 38px pill would be the one control on the settings page under the 44px
		 * floor. The token is NAMED rather than restated (XR-PH-01).
		 */
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
	/*
	 * --accent + --on-accent is the certified pair that carries a label: 5.09:1 (XR-COL-12 — the
	 * fill and its ink are set together, never separately). `data-active` is Bits UI's own state
	 * attribute, verified by a real mount rather than assumed.
	 */
	/*
	 * `data-state="active"`, NOT `data-active`. The registry's class string uses a `data-active:` Tailwind
	 * variant, and this rule was written from that spelling — but raw CSS needs the attribute Bits UI
	 * actually emits, and it emits `data-state`. Verified by mounting a tablist and dumping the
	 * attributes; the earlier mount arm checked `aria-selected` and the roving tabindex, which are both
	 * correct, so it never noticed the selected tab had no fill.
	 */
	:global([data-slot='tabs-trigger'][data-state='active']) {
		background: var(--accent);
		color: var(--on-accent);
	}
	:global([data-slot='tabs-trigger']:focus-visible) {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
</style>
