
<!--
  ── ENCORE DEVIATIONS (S2) ───────────────────────────────────────────────────────────────────
  The registry's appearance is REPLACED by Encore's field look, not layered over it. Every reason is a
  measured constraint this app already settled, and each names the test that holds it:

  1. `h-9` (36px) is under this app's 44px `--tap` floor. #863 established that floor for every
     settings field after a native select measured 41px and a text box 35px; `gate:measured` verifies
     it on a real render because a select's box is browser-owned. `min-height: var(--tap)` reads the
     token rather than restating 44px, which `touch-targets.test.ts` requires.
  2. `text-base md:text-sm` drops to 14.4px on a phone. iOS Safari auto-zooms on focusing any control
     under 16px and never zooms back out, leaving the operator stuck at 1.3x for the session. So the
     size is `var(--ph-text-base)`, pinned at 16px.
  3. The colours are Encore's surfaces — `var(--card2)` on `var(--line)` with `var(--ink)` — not
     `bg-transparent border-input`. A field must read against the card it sits on, and the semantic
     bridge deliberately does NOT alias the app's surface tokens onto shadcn's.
  4. Appearance lives in scoped CSS rather than utilities because `app.css` sets `source(none)` with a
     single `@source` over this directory: a utility is minted only from here, and scoped CSS needs no
     minting at all. Same mechanism as the Button's press states.
-->
<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLInputAttributes, HTMLInputTypeAttribute } from "svelte/elements";

	type InputType = Exclude<HTMLInputTypeAttribute, "file">;

	type Props = WithElementRef<
		Omit<HTMLInputAttributes, "type"> &
			({ type: "file"; files?: FileList } | { type?: InputType; files?: undefined })
	>;

	let {
		ref = $bindable(null),
		value = $bindable(),
		type,
		variant = "field",
		files = $bindable(),
		class: className,
		"data-slot": dataSlot = "input",
		...restProps
	}: Props & { variant?: "field" | "comfortable" | "mono" | "join" } = $props();
</script>

{#if type === "file"}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		data-variant={variant}
		class={cn(
			"encore-field",
			className
		)}
		type="file"
		bind:files
		bind:value
		{...restProps}
	/>
{:else}
	<input
		bind:this={ref}
		data-slot={dataSlot}
		data-variant={variant}
		class={cn(
			"encore-field",
			className
		)}
		{type}
		bind:value
		{...restProps}
	/>
{/if}

<style>
	.encore-field {
		width: 100%;
		box-sizing: border-box;
		padding: 9px var(--space-md);
		border-radius: var(--radius-btn);
		border: 1px solid var(--line);
		background: var(--card2);
		color: var(--ink);
		min-height: var(--tap);
		font-size: var(--ph-text-base);
	}
	/* Your own name is the one field worth typing comfortably, so it keeps the sheet's larger box. */
	.encore-field[data-variant='comfortable'] {
		padding: var(--space-lg) var(--space-xl);
		font-size: 1.05rem;
		border-radius: 14px;
	}
	/* A LAN address is read character by character to check it, so keep the digits monospaced and stop
	   iOS from title-casing what the user types. The name field deliberately does NOT inherit this. */
	/* The join screen's one field, on a phone held at arm's length: the sheet's largest comfortable box. */
	.encore-field[data-variant='join'] {
		padding: var(--space-xl);
		font-size: var(--ph-text-lg);
		background: var(--card);
	}
	.encore-field[data-variant='mono'] {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		padding: 7px var(--space-md);
	}
	.encore-field[aria-invalid='true'] {
		border-color: var(--warn);
	}
	.encore-field:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.encore-field:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}
</style>
