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
	FULL-BLEED SURFACE, CAPPED INNER ROW — and the split is the whole fix.

	This header used to cap its own box at `--page-measure` while painting a gradient and a shadow onto
	it. On any viewport wider than that measure the result was a painted SLAB floating in the middle of
	the page, ending in a hard vertical edge with nothing on either side of it. Reported as "that abrupt
	edge cutoff", and on `/song/[mediaId]` it was worse: that route set no measure, so the header fell
	back to `--max-w` while its content ran the full width, and the slab did not even line up with the
	card beneath it.

	The paint now spans the viewport and only the ROW inside it is capped, which is the same split the
	now-playing band already uses for the same reason: a full-bleed surface reads as chrome, a capped
	one reads as a floating card, and the content still aligns with the column it belongs to.
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
		   apple-mobile-web-app-status-bar-style=black-translucent are both set in app.html). */
		top: env(safe-area-inset-top, 0px);
		/*
		 * WHY THIS IS NOT `background: var(--bg)`.
		 *
		 * `body` paints `--bg` PLUS a radial stage wash — `radial-gradient(120% 80% at 50% -10%,
		 * var(--stage-glow) 0%, var(--bg) 55%)` — whose brightest point is top-centre, which is exactly
		 * where this header sits. A flat `--bg` fill therefore punched a DARKER rectangle out of the
		 * brightest part of the gradient and then drew a hard 1px line under the seam: the header read as
		 * a foreign panel dropped onto the page rather than as the top of it.
		 *
		 * So the header continues the wash instead of interrupting it. The vertical gradient starts at
		 * the glow's own tint and resolves to `--bg` by its bottom edge, which does two things at once:
		 * at rest it is tonally continuous with the page behind it, and it hands off to the content below
		 * with no step. `--stage-glow` is the same token `body` uses, so the two cannot drift apart.
		 *
		 * It stays fully OPAQUE on purpose. This element is sticky, so a translucent fill would let
		 * scrolled content read through the title, and Encore's visual language has no backdrop blur to
		 * fall back on (one elevation token and the stage wash are the whole depth vocabulary).
		 */
		background: linear-gradient(to bottom, color-mix(in srgb, var(--stage-glow) 55%, var(--bg)) 0%, var(--bg) 100%);
		/*
		 * The soft edge, replacing `border-bottom: 1px solid var(--line)`. The hairline is still there —
		 * at 55% strength, so it separates without ruling a line across the page — and the second,
		 * wide-but-nearly-black shadow only becomes visible once the header is STUCK over scrolled
		 * content, which is the one moment it genuinely needs to read as a layer above something.
		 */
		box-shadow:
			0 1px 0 color-mix(in srgb, var(--line) 55%, transparent),
			0 12px 24px -20px rgb(0 0 0 / 0.9);
		z-index: var(--z-header);
	}
	/*
	 * THE CAPPED ROW. Everything that used to be measured on `.page-header` lives here instead: the flex
	 * layout, the padding, and the `--page-measure` cap that keeps the header's content aligned with the
	 * column beneath it. The surface above is now full-bleed, so the cap takes width off the CONTENT
	 * rather than off the paint, and there is no edge to see.
	 *
	 * Each route sets `--page-measure` to its own reading width; the fallback is the shell's own cap for
	 * a route that sets none. `width: 100%` keeps the stretch so the cap takes width off both sides
	 * rather than letting the row hang left.
	 */
	.inner {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		padding: var(--space-2xl) var(--space-3xl) var(--space-md);
		width: 100%;
		max-width: var(--page-measure, var(--max-w));
		margin-inline: auto;
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
		/* Optical alignment: pulls the 44px box's left edge back to the text column, since the mark sits
		   centred inside a target much wider than itself. */
		margin-left: -10px;
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
