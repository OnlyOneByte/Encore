<script lang="ts">
	/*
	 * PageHeader — one heading line for the dashboard pages, so every non-/tv page announces WHERE you
	 * are the same way and offers the same way back. Before this, each page hand-rolled its own chrome:
	 * /settings had an icon-only back anchor, /metrics/[mediaId] had a text link, and /stats + /metrics
	 * had no way back at all. /tv and /components are deliberately exempt — /tv is a display
	 * surface with no chrome and /components is a dev gallery — and page-header.test.ts pins that list.
	 *
	 * The back control is a REAL <a href>, not a history.back() button: back is then the browsers own
	 * back, the route stays shareable, and a phone remote added to the home screen (which may have no
	 * back gesture) still has an in-app exit. It is icon-only with an aria-label, the spelling issue
	 * standardised on — the arrow-left mark carries no accessible name of its own, so the label on
	 * the anchor is the sole carrier and screen readers announce the control once.
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

<!--
	A FLOATING PILL, NOT A SLAB — and being detached is what removes the edge.

	This header used to cap its own box at `--page-measure` while painting a gradient and a shadow onto
	it. On any viewport wider than that measure the result was a painted SLAB floating in the middle of
	the page, ending in a hard vertical edge with nothing on either side of it. Reported as "that abrupt
	edge cutoff", and on `/song/[mediaId]` it was worse: that route set no measure, so the header fell
	back to `--max-w` while its content ran the full width, and the slab did not even line up with the
	card beneath it.

	Three treatments were mocked. Two of them keep a straight horizontal surface and argue about where
	it should stop: span the viewport (no edge, but the header has to break out of the shell's cap), or
	stay capped and round only the bottom corners (the edge survives, merely looks deliberate).

	This is the third answer, and the only one where the question stops existing: the surface DETACHES.
	It carries a margin on all four sides, so it never reaches an edge to cut off — what terminates it
	is a full radius, and a stadium end reads as the shape of the object rather than as the place the
	paint ran out. It still caps at `--page-measure`, so it sits directly over the column it labels.
-->
<header class="page-header">
	<div class="inner">
		{#if back}
			<!--
			Still a real link — `Button` renders an `<a href>` (not a history.back() button) whenever
			`href` is set, so everything the comment above argues for survives: the browser's own back,
			a shareable route, and an in-app exit on a home-screen PWA with no back gesture.

			`size="icon"` IS the 44px box. It compiles to `size-tap grid place-items-center`, and
			`.size-tap` emits `width: var(--tap); height: var(--tap)` with `--tap: 44px` — verified in the
			built CSS rather than assumed, because this migration's sibling found `max-w-xs` silently
			resolving to 6px through the spacing bridge.

			The wrapper carries what the component must not: the optical `-10px` pull that aligns the
			mark with the column edge, and the dim ink. Neither can be a class passed to `Button` —
			Tailwind scans only the `components/ui` directory, and a class handed to a component is scoped to THIS
			file, where Svelte strips it as unused. `ghost` sets no base text colour (only
			`hover:text-foreground`), so the inherited `--ink-dim` reaches the mark and hover still
			brightens it.
		-->
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
		/* Stick below the notch, not under it. .app-shell carries the top safe-area inset as PADDING
		   (app.css), but a sticky offset is measured from the scrollport, so `top: 0` rode up into the
		   inset once scrolled and sat under the status bar on a notched PWA (viewport-fit=cover +
		   apple-mobile-web-app-status-bar-style=black-translucent are both set in app.html). The
		   block margin below rides on top of this, so the pill stops a gap short of the notch rather
		   than against it. */
		top: env(safe-area-inset-top, 0px);
		/*
		 * DETACHED, AND CAPPED TO THE COLUMN.
		 *
		 * The margin is what makes this a floating object: page shows on all four sides, so there is no
		 * boundary between header and background for a hard edge to appear at.
		 *
		 * The inline gutter is measured against `100dvw` AND NOT `100%`, which is the difference between
		 * a pill that matches its column and one that is mysteriously 16px narrower than it. Against
		 * `100%` the term is relative to the SHELL, so it bound on every desktop page — the pill came out
		 * 1048 inside a 1080 column while `/song`, whose 560 measure binds first, sat flush — two
		 * different relationships between header and content on two pages. Against the viewport the term
		 * only bites when the pill genuinely approaches a screen edge: on a phone it insets a gap from
		 * each side and floats, and on a monitor the measure wins and the pill is exactly as wide as the
		 * column it labels.
		 *
		 * `width: 100%` AND NOT `width: auto`, which is the difference between a bar and a chip.
		 * `.app-shell` is a flex column that does not stretch its children, so `auto` resolved to
		 * shrink-to-fit and the pill came out 190px wide at every viewport — a centred title chip whose
		 * size changed with the length of the title, floating above left-aligned content with the back
		 * arrow stranded mid-screen. A definite 100% makes the pill span the column instead, which puts
		 * the arrow back at the column's left edge where the content starts and where a thumb expects
		 * it, and keeps the header the same object on every route. The `max-width` then caps that span
		 * and `margin-inline: auto` centres what is left, exactly as the inner row used to do.
		 */
		margin-block: var(--space-2xl);
		margin-inline: auto;
		width: 100%;
		max-width: min(var(--page-measure, var(--max-w)), calc(100dvw - 2 * var(--space-2xl)));
		border-radius: var(--radius-pill);
		/*
		 * WHY THE STAGE-WASH GRADIENT IS GONE.
		 *
		 * This used to paint `linear-gradient(to bottom, color-mix(--stage-glow 55%, --bg), --bg)`, and
		 * the entire argument for it was CONTINUITY: `body` paints a radial wash whose brightest point is
		 * top-centre, exactly where this header sits, so a flat fill punched a darker rectangle out of the
		 * brightest part of the gradient. Continuing the wash made the header read as the top of the page
		 * instead of a foreign panel dropped onto it.
		 *
		 * A detached pill wants the opposite. It IS a panel — that is the whole point of the shape — and a
		 * fill that resolves to `--bg` at its own bottom edge would melt into the page while the shadow
		 * underneath insisted it was floating. So it takes `--card`, which is not a new colour in this
		 * design: it is the exact fill (#1a1a28) the now-playing band and the drawer already paint, making
		 * this the top-of-screen twin of the surface at the bottom.
		 *
		 * Still fully OPAQUE, for the reason the old comment gave: the element is sticky, so a translucent
		 * fill would let scrolled content read through the title, and Encore's visual language has no
		 * backdrop blur to fall back on.
		 */
		background: var(--card);
		/*
		 * One elevation token, no hairline. The old `0 1px 0 --line` seam and its wide dark companion
		 * were both doing the work of separating a full-width surface from content flush against it;
		 * nothing is flush against this one, so the gap does that work and the shadow only has to say
		 * how far off the page the pill sits. `--shadow` is the app's single elevation token, shared
		 * with the drawer.
		 */
		box-shadow: var(--shadow);
		z-index: var(--z-header);
	}
	/*
	 * THE ROW INSIDE THE PILL. The cap now lives on the surface (it is the surface that has to align
	 * with the column), so this is layout and padding only.
	 *
	 * The vertical padding is SYMMETRIC, which it was not before: the old `--space-2xl` top against
	 * `--space-md` bottom was tuned for a slab whose bottom edge met the content, and inside a stadium
	 * an uneven inset reads immediately as the contents sitting low. The horizontal inset is a step
	 * wider than the vertical one so the first and last child clear the curve of the ends.
	 */
	.inner {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		padding: var(--space-md) var(--space-xl);
		box-sizing: border-box;
		/* A long title must not set a floor this row cannot go under. */
		min-width: 0;
	}
	/*
	 * LAYOUT AND INHERITED INK ONLY. The box, the focus ring and the centring moved into
	 * `Button variant="ghost" size="icon"`:
	 *   - `min-width`/`min-height`/`display:grid`/`place-items:center` → `size-tap grid place-items-center`
	 *   - `border-radius: 8px` (off-scale) → the component's `rounded-md`
	 *   - `.back:focus-visible { outline: 2px solid var(--focus) }` → the base's
	 *     `focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50`, and `--ring` is
	 *     `var(--focus)`, so the ring keeps the colour the old comment insisted on. app.css's global
	 *     `:focus-visible` rule still reaches the anchor too.
	 *
	 * TWO DELIBERATE VISUAL CHANGES, both toward consistency rather than away from it:
	 *   1. The mark is 16px, not 19.2px. `font-size: 1.2rem` here used to size the Icon (it renders at
	 *      `1em`); the component's base declares `[&_svg:not([class*='size-'])]:size-4`. Every other
	 *      icon Button in the app — the transport, the reorder pair, the remove control — is already
	 *      16px, so the back arrow was the odd one out.
	 *   2. The corner is `--radius-md`, not a hand-written 8px.
	 */
	.back-slot {
		/* No optical pull. A slab let the 44px box hang -10px past the text column so the mark's own
		   centre lined up with the column edge; inside a pill that same pull drives the box into the
		   curve of the left end. The row's horizontal padding is the alignment now. */
		/* Inherited by the mark: `ghost` sets no base text colour, so this is what makes the arrow dim,
		   and the variant's `hover:text-foreground` still brightens it on hover. */
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
