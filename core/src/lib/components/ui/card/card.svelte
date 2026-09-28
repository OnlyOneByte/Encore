<!--
  ENCORE'S CARD SURFACE, not the registry's, plus one containment rule that is not cosmetic: `min-width: 0`,
  because a card is frequently a grid item and a grid item defaults to min-content. Without it /stats' trend
  chart sizes its card to the chart's full scroll width and overflows the document horizontally. Safe on
  every card — min-width only participates when the box is a flex or grid item.

  WHY THE SURFACE MOVED. The registry's own look ran on Tailwind's theme keys — `rounded-xl` (app.css declared
  no `--radius-xl` then, so it fell through to Tailwind's; it now aliases `--radius-sm`, which is the SAME 12px
  this rule sets, and that is a requirement rather than a coincidence: `Card.Header`'s `rounded-t-xl`, the
  `*:[img:…]` corners below and `Card.Footer` all resolve it), `shadow-xs`, and `ring-1 ring-foreground/10`
  in place of a border — while `app.css`'s `.card` carries `--radius-sm`, a 1px `--line` border, and
  `--shadow-sm` + `inset 0 1px 0 var(--edge-hi)`, a pair whose comment says they "belong together on this
  one rule rather than per caller: a border alone made every surface in the app read as an outline drawn on
  the page". Two card looks met at a visible seam — the phone's rows read as lit surfaces while every
  settings and stats card read as a flat outline — and nothing in the app put them side by side until
  /components grew a Primitives section, which measured the difference as: same 12px radius and background,
  but `.card` with `0 1px 2px rgba(0,0,0,.3)` plus the inset edge where `Card.Root` had neither.

  PAINT ONLY. Radius, border and shadow are taken from the app idiom; `--card-spacing` and every layout
  property are left exactly as the registry set them, because that is what makes this safe to apply to every
  existing caller at once — the same argument `.card`'s own comment makes for itself.
-->
<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		size = 'default',
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & { size?: 'default' | 'sm' } = $props();
</script>

<div
	bind:this={ref}
	data-slot="card"
	data-size={size}
	class={cn(
		'encore-card gap-(--card-spacing) overflow-hidden rounded-xl bg-card py-(--card-spacing) text-[length:var(--ph-text-md)] leading-app-normal text-card-foreground shadow-xs ring-1 ring-foreground/10 [--card-spacing:--spacing(6)] has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(4)] *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl group/card flex flex-col',
		className
	)}
	{...restProps}
>
	{@render children?.()}
</div>

<style>
	/* Scoped, therefore unlayered, therefore ahead of the layered utilities in the class list above — the same
	   mechanism `input.svelte` uses to hold its iOS font floor. `box-shadow` is the one that has to be stated
	   rather than removed: Tailwind emits `ring-1` AS a box-shadow, so declaring the property replaces the ring
	   and the `shadow-xs` rung together. */
	.encore-card {
		min-width: 0;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		box-shadow:
			var(--shadow-sm),
			inset 0 1px 0 var(--edge-hi);
	}
</style>
