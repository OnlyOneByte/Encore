<!--
  ── ENCORE DEVIATIONS (P0 · alert-dialog adoption) ───────────────────────────────────────────
  1. EVERY MOTION UTILITY IS GONE. The registry ships
     `data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0
      data-closed:zoom-out-95 data-open:zoom-in-95 duration-100`, and motion.test.ts bans
     `animate-*` / `duration-*` tree-wide because a keyframes utility cannot honour Reduce Motion.
     The entrance is re-declared below as CSS on `transform`/`opacity` only — both composited — inside
     a `prefers-reduced-motion: no-preference` block, so motion is OPT-IN and there is no reset that a
     later rule can lose the cascade to. Same idiom as `skeleton` and `spinner`.
  2. `rounded-xl` IS REPLACED by `rounded-[var(--radius)]`. `--radius-*` is deliberately NOT registered
     in `@theme` (app.css explains why: this app's tokens already occupy Tailwind's `--radius-*`
     namespace, so a bridge entry would be the self-referential `--radius-sm: var(--radius-sm)`).
     `rounded-xl` would therefore resolve against Tailwind's default scale rather than Encore's, which
     is exactly the silent-drift class of defect this layer exists to prevent. An arbitrary value needs
     no registration and cannot drift.
  3. `p-6` / `gap-6` → `--space-4xl` (20px) / `--space-2xl` (16px). Numeric spacing utilities resolve
     against Tailwind's `--spacing` multiplier (24px here), which is off Encore's 10-step scale.
  4. `ring-1 ring-foreground/10` → a 1px `--line-strong` BORDER plus `--shadow`. Encore separates
     surfaces with a line token and lifts them with the single elevation token; a translucent ink ring
     is a second, unmeasured way to do the same thing.
  5. `z-50` is KEPT and is correct rather than arbitrary: the phone ladder tops out at
     `--z-dock: 30`, and a modal must sit above the docked bands. It is not tokenised because there is
     no `--z-modal` yet; adding one belongs to a change that touches app.css.
  6. The scrim lives on the overlay, not here — see `alert-dialog-overlay.svelte`.
  7. `max-w-xs` / `sm:max-w-lg` ARE REPLACED, and this one is a trap worth reading twice. Encore
     bridges t-shirt SPACING keys into `@theme` (`--spacing-xs`, `--spacing-2xl`, …) and does NOT
     bridge Tailwind's container scale, so `--container-xs` does not exist in the build. Tailwind then
     resolves `max-w-xs` through the spacing namespace instead, and the emitted rule was literally
     `max-width: var(--space-xs)` — SIX PIXELS. The dialog rendered as a 6px-wide strip with its text
     overflowing both sides, and it passed lint, typecheck and all 2799 tests: only a screenshot found
     it. Any `max-w-*` / `w-*` / `min-w-*` in a vendored component carries this hazard. An arbitrary
     value cannot, because it resolves nothing through a namespace.
  8. The width is a viewport calc rather than a fixed rem, so it keeps a real gutter at the 320px
     reflow floor instead of running edge to edge.
-->
<script lang="ts">
	import { AlertDialog as AlertDialogPrimitive } from 'bits-ui';
	import { cn, type WithoutChild, type WithoutChildrenOrChild } from '$lib/utils.js';
	import AlertDialogOverlay from './alert-dialog-overlay.svelte';
	import AlertDialogPortal from './alert-dialog-portal.svelte';
	import type { ComponentProps } from 'svelte';

	let {
		ref = $bindable(null),
		class: className,
		size = 'default',
		portalProps,
		...restProps
	}: WithoutChild<AlertDialogPrimitive.ContentProps> & {
		size?: 'default' | 'sm';
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof AlertDialogPortal>>;
	} = $props();
</script>

<AlertDialogPortal {...portalProps}>
	<AlertDialogOverlay />
	<AlertDialogPrimitive.Content
		bind:ref={ref}
		data-slot="alert-dialog-content"
		data-size={size}
		class={cn(
			'bg-popover text-popover-foreground gap-[var(--space-2xl)] rounded-[var(--radius)] border border-[var(--line-strong)] p-[var(--space-4xl)] shadow-[var(--shadow)] w-[calc(100vw-2*var(--space-4xl))] data-[size=default]:max-w-[26rem] data-[size=sm]:max-w-[22rem] group/alert-dialog-content fixed top-1/2 left-1/2 z-50 grid -translate-x-1/2 -translate-y-1/2 outline-none',
			className
		)}
		{...restProps}
	/>
</AlertDialogPortal>

<style>
	/*
	 * The element is rendered by a CHILD component (Bits UI), so it carries no scoping hash for this
	 * file and a plain `.foo` rule would ship in the bundle and match nothing. `:global([data-slot=…])`
	 * is the correct reach, and shadcn's own data-slot is more stable across a re-vendor than a class of
	 * ours would be. This is the exact shape that shipped a dead `min-height: var(--tap)` on
	 * `slider.svelte` while touch-targets.test.ts stayed green.
	 */
	@media (prefers-reduced-motion: no-preference) {
		:global([data-slot='alert-dialog-content'][data-state='open']) {
			animation: encore-alert-in var(--motion-fast) ease-out;
		}
	}
	/*
	 * Composited properties only. `translate(-50%, -50%)` is the element's resting transform, so the
	 * keyframe carries it too — animating `transform` without it would snap the dialog to the viewport
	 * centre's top-left corner for the duration.
	 */
	@keyframes encore-alert-in {
		from {
			opacity: 0;
			transform: translate(-50%, -50%) scale(0.96);
		}
		to {
			opacity: 1;
			transform: translate(-50%, -50%) scale(1);
		}
	}
</style>
