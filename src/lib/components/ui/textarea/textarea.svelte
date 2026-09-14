<!--
  ── ENCORE DEVIATIONS ────────────────────────────────────────────────────────────────────────
  Adapted the same way `ui/input` was, for the same reasons and by the same mechanism. The registry's
  appearance is REPLACED by Encore's field look rather than layered over it:

  1. `transition-[color,box-shadow]` is REMOVED. `motion.test.ts` rejects `transition-*` as a utility
     name tree-wide, and the ban is not cosmetic: a utility cannot carry the reduced-motion arm this
     app requires, so live motion is declared CSS on transform/opacity inside
     `@media (prefers-reduced-motion: no-preference)`. A focus ring does not need to animate at all,
     so nothing replaces it.
  2. `text-base md:text-sm` drops to 14.4px on a phone. iOS Safari auto-zooms when a control under
     16px takes focus and never zooms back out, which strands the singer at 1.3x for the session — the
     same defect `ui/input` records. The size is `var(--ph-text-base)`, which is 1rem. The incumbent
     inherited 16px from the body, so this pins what was already true instead of moving it.
  3. The colours are Encore's surfaces — `var(--card2)` on `var(--line)` with `var(--ink)` — not
     `bg-transparent border-input`. The semantic bridge deliberately does not alias the app's surface
     tokens onto shadcn's, so a field must be told which card it sits on.
  4. Appearance lives in scoped CSS, not utilities, because `app.css` sets `source(none)` with a single
     `@source` over this directory: a utility is minted only from here and scoped CSS needs no minting.
  5. `resize: vertical` is kept from the incumbent. A lyrics paste is many short lines, so growing the
     box downward is the useful axis; horizontal resize would break out of the card.
  6. NO `margin` of any kind. The incumbent carried `margin-top: var(--space-xs)`, which is the call
     site's spacing rather than the field's — it now lives on the wrapper that page renders, because a
     primitive that ships its own outer margin cannot be reused at a second call site.
-->
<script lang="ts">
	import { cn, type WithElementRef, type WithoutChildren } from '$lib/utils.js';
	import type { HTMLTextareaAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		'data-slot': dataSlot = 'textarea',
		...restProps
	}: WithoutChildren<WithElementRef<HTMLTextareaAttributes>> = $props();
</script>

<textarea
	bind:this={ref}
	data-slot={dataSlot}
	class={cn('encore-textarea', className)}
	bind:value={value}
	{...restProps}></textarea>

<style>
	.encore-textarea {
		width: 100%;
		box-sizing: border-box;
		background: var(--card2);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		color: var(--ink);
		font: inherit;
		font-size: var(--ph-text-base);
		padding: var(--space-xs);
		resize: vertical;
	}
	.encore-textarea::placeholder {
		color: var(--ink-dim);
	}
	.encore-textarea:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.encore-textarea[aria-invalid='true'] {
		border-color: var(--warn);
	}
	.encore-textarea:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}
</style>
