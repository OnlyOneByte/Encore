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
		back,
		note
	}: {
		/** The page name. Rendered as the single h1 landmark the route paints. */
		title: string;
		/** Optional leading mark beside the title (e.g. the gear on /settings). */
		icon?: IconName;
		/** Optional back affordance. Omit on a root page. `label` is the anchors accessible name. */
		back?: { href: string; label: string };
		/**
		 * One short line under the title, in the description register. Its one caller is `/settings`' three scope
		 * routes, which state who a change there reaches ("Everyone in this room") — and they state it HERE, in the
		 * sticky header, because that is the only place on a 2.5-screen column that cannot scroll away from a control.
		 * Keep it to a phrase: it shares the pill with the title and a 44px back box.
		 */
		note?: string;
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
		<!-- A COLUMN ONLY WHEN THERE IS A SECOND LINE: with no `note` this renders the h1 as the row's own child, so a
			header without one keeps the box it has always had to the pixel. -->
		{#if note}
			<div class="titles">
				<h1>
					{#if icon}<Icon name={icon} />{/if}{title}
				</h1>
				<p class="note">{note}</p>
			</div>
		{:else}
			<h1>
				{#if icon}<Icon name={icon} />{/if}{title}
			</h1>
		{/if}
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
		/* Opaque, so scrolled rows never read through the title. */
		background: var(--card);
		z-index: var(--z-header);
	}
	/* The cap lives on the SURFACE, because that is what has to align with the column, so this is layout only. The
	   vertical padding must stay symmetric — inside a stadium an uneven inset reads as the contents sitting low. */
	.inner {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		/* The INLINE half is the gutter rung, the same one `.app-shell` spends and the same one the `max-width` above
		   subtracts twice — so the title's inset inside the pill is the app's one gutter rather than a second number
		   2px away from it. It was `xl` (14) until that rung was retired; see app.css's ladder. */
		padding: var(--space-md) var(--space-2xl);
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
	/* The title and its note read as one block, so they share the row's single gap with the back box rather than
	   adding a second one. `min-width: 0` because the note is prose beside a nowrap-ish heading in a flex row. */
	.titles {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	/* THE DESCRIPTION REGISTER, not the section one: this is a sentence about the page, so it stays sentence case
	   with no tracking — the uppercase letterspaced dress belongs to a heading over a block, which this is not. No
	   top margin: the line sits inside the title block, and the pill's symmetric inset is what frames the pair. */
	.note {
		margin: 0;
		font-size: var(--ph-text-xs);
		color: var(--ink-dim);
	}
</style>
