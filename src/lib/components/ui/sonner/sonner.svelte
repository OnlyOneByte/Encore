<!--
  `theme="dark"` is stated directly: Encore has one theme, so the registry's mode-watcher dependency has
  nothing to watch.

  THE INLINE STYLE MUST NAME THE `:root` TOKENS, never their `@theme` bridge spellings. A bridge key mints
  a utility and emits no custom property, so reading one as `var(--color-popover)` resolves to nothing and
  the toast paints unstyled; `design-system.test.ts` catches it.
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
	 * The Undo control's tap floor, and it lives here because `touch-targets.test.ts`'s generic scan
	 * cannot see it — a vendored component renders no bare `button` tag for that scan to find, so the arm
	 * in `tests/guards/hygiene/page.test.ts` holds it instead. `:global` on sonner's own `[data-button]`
	 * because scoped CSS cannot reach an element another component renders.
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
