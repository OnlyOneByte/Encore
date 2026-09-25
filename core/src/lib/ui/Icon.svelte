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
		label
	}: {
		name: IconName;
		/** Any CSS length. Defaults to 1em so the mark tracks the container's font-size. */
		size?: string;
		/** Optical weight. Heavier reads better at TV scale, lighter at small sizes. */
		/** Set ONLY when this svg is the sole carrier of meaning; otherwise leave it aria-hidden. */
		label?: string;
	} = $props();
</script>

<!-- eslint-disable svelte/no-at-html-tags -- every ICON_PATHS value is a compile-time string literal in our own
	source and `name` is typed to its keys, so no user or network value can reach {@html}. Whole-file rather than
	`eslint-disable-next-line` because the expression sits inside a multi-line start tag, which leaves no preceding
	line to put a comment on; this file holds exactly one {@html}. -->
<svg
	class="icon"
	class:solid={SOLID_ICONS.includes(name)}
	viewBox="0 0 24 24"
	width={size}
	height={size}
	fill="none"
	stroke="currentColor"
	stroke-width="2"
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
