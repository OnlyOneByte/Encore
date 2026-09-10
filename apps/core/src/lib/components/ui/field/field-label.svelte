<!--
  ── ENCORE DEVIATIONS (#913 S4) ───────────────────────────────────────────────────────────────────
  shadcn's TYPOGRAPHY is kept — S4 accepted the visual change. What is restored is LAYOUT, because
  losing it is a broken page rather than a different-looking one:

  the settings page stacks 27 of these, and `.field`'s `margin: var(--space-lg) 0 var(--space-2xs)`
  was the entire vertical rhythm separating one control from the next. The registry's label is
  `flex w-fit` with no margins, so a bare swap collapsed every field against its neighbour.

  `:global([data-slot='…'])` because this file renders a COMPONENT (Label → Bits UI Label), and
  Svelte's scoped CSS cannot reach an element another component renders. `data-slot` is shadcn's own
  contract for it, so it survives a re-vendor where an Encore class would not.
-->
<script lang="ts">
	import { Label } from "$lib/components/ui/label/index.js";
	import { cn } from "$lib/utils.js";
	import type { ComponentProps } from "svelte";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: ComponentProps<typeof Label> = $props();
</script>

<Label
	bind:ref
	data-slot="field-label"
	class={cn(
		"gap-2 leading-snug group-data-[disabled=true]/field:opacity-50 has-data-checked:border-primary/30 has-data-checked:bg-primary/5 has-[>[data-slot=field]]:rounded-md has-[>[data-slot=field]]:border has-[>[data-slot=field]]:not-has-[:disabled,[data-disabled]]:hover:bg-muted/50 has-[>[data-slot=field]]:has-[:focus-visible]:border-ring has-[>[data-slot=field]]:has-[:focus-visible]:ring-3 has-[>[data-slot=field]]:has-[:focus-visible]:ring-ring/50 *:data-[slot=field]:p-3 dark:has-data-checked:border-primary/20 dark:has-data-checked:bg-primary/10 group/field-label peer/field-label flex w-fit leading-snug",
		"has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</Label>

<style>
	/*
	 * A label that lays out INLINE with content it contains — settings' stage-colour row puts a live
	 * swatch beside its text. Expressed as a data attribute rather than a passed class because a class
	 * handed to a component is scoped to the CALLER and stripped as unused there.
	 */
	:global([data-slot='field-label'][data-inline]) {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
	}
	/* A control disabled by another setting dims its label with it (settings' song-intro length). */
	:global([data-slot='field-label'][data-dim]) {
		opacity: 0.5;
	}
	:global([data-slot='field-label']) {
		display: block;
		width: auto;
		margin: var(--space-lg) 0 var(--space-2xs);
		color: var(--ink-dim);
	}
</style>
