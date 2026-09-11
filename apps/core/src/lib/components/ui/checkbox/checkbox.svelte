<!--
  ── ENCORE DEVIATIONS (S3) ───────────────────────────────────────────────────────────────────
  1. `size-4` (16px) → `size-[18px]`. Encore's checkbox glyph is 18px and #863 settled that the glyph
     is NOT the tap target — the wrapping <label class="check"> carries `min-height: var(--tap)` and is
     examined as its own control by touch-targets.test.ts, which explicitly exempts the glyph. So this
     is a cosmetic match to the incumbent, not a target-size change.
  2. The filled state is `bg-primary` with `text-primary-foreground`, which resolve through the
     semantic layer to `var(--accent)` and `var(--on-accent)`: white on #7254e6 measures 5.09:1, so
     the checkmark passes AA on the fill. That pairing is why the ink ban is by NAME in app source and
     not a refusal to mint — a vendored component using both halves together is correct.
-->
<script lang="ts">
	import { Checkbox as CheckboxPrimitive } from "bits-ui";
	import CheckIcon from '@lucide/svelte/icons/check';
	import MinusIcon from '@lucide/svelte/icons/minus';
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		checked = $bindable(false),
		indeterminate = $bindable(false),
		class: className,
		...restProps
	}: WithoutChildrenOrChild<CheckboxPrimitive.RootProps> = $props();
</script>

<CheckboxPrimitive.Root
	bind:ref
	data-slot="checkbox"
	class={cn(
		"flex size-[18px] items-center justify-center rounded-[4px] border border-input shadow-xs group-has-disabled/field:opacity-50 group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-input focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground group-has-[:focus-visible]/field-label:data-checked:border-primary dark:data-checked:bg-primary peer relative shrink-0 outline-none after:absolute after:-inset-x-3 after:-inset-y-2 disabled:cursor-not-allowed disabled:opacity-50",
		className
	)}
	bind:checked
	bind:indeterminate
	{...restProps}
>
	{#snippet children({ checked, indeterminate })}
		<div
			data-slot="checkbox-indicator"
			class="[&>svg]:size-3.5 grid place-content-center text-current"
		>
			{#if checked}
				<CheckIcon />
			{:else if indeterminate}
				<MinusIcon />
			{/if}
		</div>
	{/snippet}
</CheckboxPrimitive.Root>
