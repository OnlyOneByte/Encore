<script lang="ts">
	/*
	 * One mark, drawn as inline SVG. `1em` BY DEFAULT and `currentColor`, so one path serves a phone button and a
	 * ten-foot TV with no second asset, and a mark tracks its button's hover, disabled and theme states — never hard-code
	 * a stroke colour here. DEFAULT IS `aria-hidden`: an icon-only button's label lives on the BUTTON, and a name on both
	 * makes a screen reader announce it twice. The tap target belongs on the button, never here.
	 */
	import { ICON_PATHS, SOLID_ICONS, type IconName } from './icons';

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

<!-- eslint-disable svelte/no-at-html-tags -- {@html} is safe here specifically: ICON_PATHS is a frozen map of
	compile-time string constants in our own source, with no interpolation and no path from user input or the network,
	and `name` is typed to its keys, so the only reachable values are those literals. The whole-file form rather than
	`eslint-disable-next-line` because the expression sits inside a multi-line start tag, where no comment can be
	placed on the preceding line; this file holds exactly one {@html} and nothing else the rule can reach. -->
<svg
	class="icon"
	class:solid={SOLID_ICONS.includes(name)}
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
	/* `block` kills the inline-descender gap that otherwise pushes a mark off-centre inside a centred button. */
	.icon {
		display: block;
		flex: 0 0 auto;
	}
	.icon.solid :global(polygon),
	.icon.solid :global(rect) {
		fill: currentColor;
	}
</style>
