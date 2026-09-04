<script lang="ts">
	/*
	 * One mark, drawn as inline SVG.
	 *
	 * SIZING. `1em` by default, so an icon takes its size from the font-size of whatever contains it.
	 * That is what lets the SAME path serve a 44px phone button and a 10-foot TV: the TV sets a larger
	 * font-size on the container and the mark scales with it, resolution-independent, with no second
	 * asset and no bitmap to go soft.
	 *
	 * COLOUR. `currentColor`, so a mark inherits `color` from its button and automatically tracks
	 * hover/disabled/theme states. Never hard-code a stroke colour here.
	 *
	 * ACCESSIBLE NAME. Default is `aria-hidden`, which is correct for the common cases: an icon beside
	 * real text (the text is the name), or an icon-only button whose `aria-label` is on the BUTTON. A
	 * name on both would make screen readers announce it twice. Pass `label` only when this svg is
	 * genuinely the sole carrier of meaning and nothing around it names the control.
	 *
	 * The 44px touch target belongs on the button, never here — shrinking the hit area to the glyph is
	 * how a control ends up technically present and practically unhittable.
	 */
	import { ICON_PATHS, type IconName } from './icons';

	let {
		name,
		size = '1em',
		strokeWidth = 2,
		label
	}: {
		name: IconName;
		/** Any CSS length. Defaults to 1em so the mark tracks the container's font-size. */
		size?: string;
		/** Optical weight. Heavier reads better at TV scale, lighter at small sizes. */
		strokeWidth?: number;
		/** Set ONLY when this svg is the sole carrier of meaning; otherwise leave it aria-hidden. */
		label?: string;
	} = $props();
</script>

<!--
  {@html} is safe here specifically: ICON_PATHS is a frozen map of compile-time string constants in
  our own source, with no interpolation and no path from user input or the network.
-->
<svg
	class="icon"
	viewBox="0 0 24 24"
	width={size}
	height={size}
	fill="none"
	stroke="currentColor"
	stroke-width={strokeWidth}
	stroke-linecap="round"
	stroke-linejoin="round"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	focusable="false">{@html ICON_PATHS[name]}</svg
>

<style>
	/*
	 * `block` kills the inline-descender gap that otherwise pushes a mark off-centre inside a grid- or
	 * flex-centred button. The polygon marks (play/prev/next) are drawn filled as well as stroked so
	 * they read as solid shapes rather than outlines at small sizes.
	 */
	.icon {
		display: block;
		flex: 0 0 auto;
	}
	.icon :global(polygon),
	.icon :global(rect) {
		fill: currentColor;
	}
</style>
