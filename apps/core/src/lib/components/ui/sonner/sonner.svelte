<!--
  ── ENCORE DEVIATIONS (#913 S5) ───────────────────────────────────────────────────────────────────

  1. `theme={mode.current}` and its `mode-watcher` import are GONE. Encore has one theme; a light/dark
     watcher is a dependency for a feature this app does not have, and #903's rule is that a
     dependency stays only while something imports it. `theme="dark"` states the fact directly.

  2. The style block read `var(--color-popover)`, `var(--color-popover-foreground)` and
     `var(--color-border)`. Those names exist ONLY in `app.css`'s `@theme` bridge, which mints
     utilities and emits no custom property — so read as custom properties they resolve to nothing and
     the toast paints unstyled. design-system.test.ts catches exactly this and says what to do: use the
     `:root` token each one forwards to. So `--popover`, `--popover-foreground`, `--border`.

     Worth recording because the first pass through S5 read that finding as a verdict against sonner
     rather than as the one-line fix it names. It is the same trap as a guard flagging its own
     documentation: the message was the instruction, not the wall.

  3. `animate-spin` is gone from the loading icon. `motion.test.ts` bans motion utility names
     tree-wide, because a keyframes animation cannot honour Reduce Motion — the same deletion already
     applied to seven other vendored components here. Encore's own `.search-spinner` is the app's
     spinner, and a toast never needs the loading state anyway: the two surfaces that use this are an
     undo affordance and an error, both instantaneous.

  4. The action button carries `min-height: var(--tap)`. The Undo control is the one interactive
     element on the phone that previously fell under the app's own tap floor, and it sits on a
     five-second timer, which makes it the hardest to hit in time. The guard that holds it is
     `routes/page.test.ts`'s "Undo toast control reaches the tap floor" arm, which followed the control
     into this file; it is mutation-proved (a 32px button reds it). Note that `touch-targets.test.ts`'s
     generic `controlRules()` derivation could NOT see it — a vendored component renders no bare
     `button` tag for that scan to find, which is the same blind spot #913 S4 recorded for the tabs.
-->
<script lang="ts">
	import { Toaster as Sonner, type ToasterProps as SonnerProps } from 'svelte-sonner';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
	import InfoIcon from '@lucide/svelte/icons/info';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	let { ...restProps }: SonnerProps = $props();
</script>

<Sonner
	theme="dark"
	class="toaster group"
	style="--normal-bg: var(--popover); --normal-text: var(--popover-foreground); --normal-border: var(--border);"
	{...restProps}
>
	{#snippet successIcon()}
		<CircleCheckIcon class="size-4" />
	{/snippet}
	{#snippet errorIcon()}
		<OctagonXIcon class="size-4" />
	{/snippet}
	{#snippet infoIcon()}
		<InfoIcon class="size-4" />
	{/snippet}
	{#snippet warningIcon()}
		<TriangleAlertIcon class="size-4" />
	{/snippet}
</Sonner>

<style>
	/*
	 * The action button's tap floor. `:global` because this file renders a COMPONENT and Svelte's
	 * scoped CSS cannot reach an element another component renders; `[data-button]` is sonner's own
	 * attribute for it, so it survives a re-vendor where a class of ours would not.
	 *
	 * var(--tap), named rather than restated (XR-PH-01).
	 */
	:global([data-sonner-toast] [data-button]) {
		min-height: var(--tap);
		padding-inline: var(--space-md);
		cursor: pointer;
	}
	/* The toast sits on the app's card surface with its own ink, like every other floating surface. */
	:global([data-sonner-toast]) {
		font-size: var(--ph-text-base);
	}
</style>
