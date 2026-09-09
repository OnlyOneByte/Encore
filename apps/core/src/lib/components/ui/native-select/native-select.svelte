
<!--
  ── ENCORE DEVIATIONS (#913 S3) ───────────────────────────────────────────────────────────────────
  The registry's appearance is REPLACED by Encore's field look, not layered over it. Every reason is a
  measured constraint this app already settled, and each names the test that holds it:

  1. `h-9` (36px) is under this app's 44px `--tap` floor. #863 established that floor for every
     settings field after a native select measured 41px and a text box 35px; `gate:measured` verifies
     it on a real render because a select's box is browser-owned. `min-height: var(--tap)` reads the
     token rather than restating 44px, which `touch-targets.test.ts` (#831) requires.
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
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLSelectAttributes } from "svelte/elements";

	type NativeSelectProps = Omit<WithElementRef<HTMLSelectAttributes>, "size"> & {
		size?: "sm" | "default";
	};

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		size = "default",
		children,
		...restProps
	}: NativeSelectProps = $props();
</script>

<div
	class={cn(
		"cn-native-select-wrapper group/native-select relative w-full has-[select:disabled]:opacity-50",
		className
	)}
	data-slot="native-select-wrapper"
	data-size={size}
>
	<select
		bind:value
		bind:this={ref}
		data-slot="native-select"
		data-size={size}
		class="encore-field"
		{...restProps}
	>
		{@render children?.()}
	</select>
	<ChevronDownIcon class="top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground pointer-events-none absolute select-none" aria-hidden data-slot="native-select-icon" />
</div>

<style>
	.encore-field {
		width: 100%;
		box-sizing: border-box;
		appearance: none;
		padding: 9px var(--space-xl) 9px var(--space-md);
		border-radius: var(--radius-btn);
		border: 1px solid var(--line);
		background: var(--card2);
		color: var(--ink);
		min-height: var(--tap);
		font-size: var(--ph-text-base);
	}
	.encore-field:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.encore-field:disabled {
		cursor: not-allowed;
	}
</style>
