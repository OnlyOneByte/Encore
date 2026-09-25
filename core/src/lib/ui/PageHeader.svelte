<script lang="ts">
	/*
	 * One heading line for every dashboard page, so each announces where you are the same way. /tv and /components are
	 * deliberately exempt (the TV has no operator and the gallery is dev-only). The back control is a REAL anchor, never a
	 * history.back() button: back is then the browser's own, the route stays shareable, and a home-screen install with
	 * no back gesture still has an in-app exit. Icon-only, so the aria-label is the sole carrier of the name.
	 */
	import Icon from '$lib/ui/Icon.svelte';
	import { Button } from '$lib/components/ui/button';
	import type { IconName } from '$lib/ui/icons';

	let {
		title,
		icon,
		back
	}: {
		/** The page name. Rendered as the single h1 landmark the route paints. */
		title: string;
		/** Optional leading mark beside the title (e.g. the gear on /settings). */
		icon?: IconName;
		/** Optional back affordance. Omit on a root page. `label` is the anchors accessible name. */
		back?: { href: string; label: string };
	} = $props();
</script>

<!-- A FLOATING PILL, NOT A SLAB, and being detached is what removes the edge: a surface capped at the page measure
	while painting to its own boundary ends in a hard vertical edge with page either side of it.
	See docs/FRONTEND.md#charts-fields-and-the-rest. -->
<header class="page-header">
	<div class="inner">
		{#if back}
			<!-- `Button` renders a real anchor whenever `href` is set, and `size="icon"` IS the 44px box. The WRAPPER carries the
				dim ink, because a class handed to a component is scoped to this file where Svelte strips it as unused; `ghost` sets
				no base text colour, so the inherited ink reaches the mark and the variant's own hover still brightens it. -->
			<div class="back-slot">
				<Button variant="ghost" size="icon" href={back.href} aria-label={back.label}>
					<Icon name="arrow-left" />
				</Button>
			</div>
		{/if}
		<h1>
			{#if icon}<Icon name={icon} />{/if}{title}
		</h1>
	</div>
</header>

<style>
	.page-header {
		position: sticky;
		/* Stick below the notch, never under it: `.app-shell` carries the top safe-area inset as PADDING, but a
		   sticky offset is measured from the scrollport, so `top: 0` rides up into the inset once scrolled and
		   sits under the status bar on a notched install. */
		top: env(safe-area-inset-top, 0px);
		/* Two units here are load-bearing. The inline gutter is measured against `100dvw`, NEVER `100%`: against `100%` the
			   term is relative to the SHELL, so it binds on every desktop page and the pill comes out narrower than the column it
			   labels. And `width: 100%`, NEVER `auto`: `.app-shell` is a flex column that does not stretch its children, so
			   `auto` shrink-wraps the pill into a centred title CHIP and strands the back arrow mid-screen. */
		margin-block: var(--space-2xl);
		margin-inline: auto;
		width: 100%;
		max-width: min(var(--page-measure, var(--max-w)), calc(100dvw - 2 * var(--space-2xl)));
		border-radius: var(--radius-pill);
		/* `--card`, the same fill the band and the drawer paint, and the OPAQUE FALLBACK for the blurred one below: on a
			   sticky element a translucent fill with nothing behind it lets scrolled content read straight through the title.
			   The `@supports` arm is what earns the translucency — see the note there. */
		background: var(--card);
		/* The FLOATING rung: this surface sticks over a scrolling column, so it is the far end of the ladder from the rows
		   passing beneath it. With the lit edge, so it agrees with `.card` about where the light is. */
		box-shadow:
			var(--shadow),
			inset 0 1px 0 var(--edge-hi);
		z-index: var(--z-header);
	}
	/* THE BLUR IS GATED, and that is the whole reason the opaque fill stays declared above: `backdrop-filter` is the only
	   thing that makes a translucent sticky surface legible, so the fill may only go translucent where the filter is
	   actually applied. Both spellings are tested — Safari shipped this prefixed and still matches only `-webkit-`. The
	   pair comes from `--chrome-fill`/`--chrome-blur` so the header, the sheet and the band cannot drift apart. */
	@supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
		.page-header {
			background: var(--chrome-fill);
			-webkit-backdrop-filter: var(--chrome-blur);
			backdrop-filter: var(--chrome-blur);
		}
	}
	/* The cap lives on the SURFACE, because that is what has to align with the column, so this is layout only. The
	   vertical padding must stay symmetric — inside a stadium an uneven inset reads as the contents sitting low. */
	.inner {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		padding: var(--space-md) var(--space-xl);
		box-sizing: border-box;
		/* A long title must not set a floor this row cannot go under. */
		min-width: 0;
	}
	/* Layout and inherited ink only — the box, the radius and the focus ring come from the Button variant. NO optical pull
	   here: a negative margin drives the box into the curve of a pill's left end, so the row's padding is the alignment. */
	.back-slot {
		color: var(--ink-dim);
		display: flex;
	}
	h1 {
		margin: 0;
		font-size: var(--ph-text-lg);
		display: inline-flex;
		align-items: center;
		gap: var(--space-sm);
	}
</style>
