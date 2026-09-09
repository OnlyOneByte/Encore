<script lang="ts">
	/*
	 * PageHeader — one heading line for the dashboard pages, so every non-/tv page announces WHERE you
	 * are the same way and offers the same way back. Before this, each page hand-rolled its own chrome:
	 * /settings had an icon-only back anchor, /metrics/[mediaId] had a text link, and /stats + /metrics
	 * had no way back at all (issue #644). /tv and /components are deliberately exempt — /tv is a display
	 * surface with no chrome and /components is a dev gallery — and page-header.test.ts pins that list.
	 *
	 * The back control is a REAL <a href>, not a history.back() button: back is then the browsers own
	 * back, the route stays shareable, and a phone remote added to the home screen (which may have no
	 * back gesture) still has an in-app exit. It is icon-only with an aria-label, the spelling issue
	 * #644 standardised on — the arrow-left mark carries no accessible name of its own, so the label on
	 * the anchor is the sole carrier and screen readers announce the control once.
	 */
	import Icon from '$lib/ui/Icon.svelte';
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

<header class="page-header">
	{#if back}
		<!-- A real link, so back is the browsers back and the route is shareable. -->
		<a class="back" href={back.href} aria-label={back.label}><Icon name="arrow-left" /></a>
	{/if}
	<h1>
		{#if icon}<Icon name={icon} />{/if}{title}
	</h1>
</header>

<style>
	.page-header {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		padding: var(--space-2xl) var(--space-3xl) var(--space-md);
		border-bottom: 1px solid var(--line);
		position: sticky;
		top: 0;
		background: var(--bg);
		z-index: var(--z-header);
	}
	.back {
		color: var(--ink-dim);
		text-decoration: none;
		font-size: 1.2rem;
		/* var(--tap), never the number (XR-PH-01, issue #831). The comment here used to say the literal
		   was kept BECAUSE touch-targets.test.ts pinned this control "by the literal string" — that
		   stopped being true once the pin accepted either form, so the note was defending a constraint
		   the guard no longer had while the control silently held the old value. */
		display: grid;
		place-items: center;
		min-width: var(--tap);
		min-height: var(--tap);
		margin-left: -10px;
		border-radius: 8px;
	}
	.back:focus-visible {
		/* --focus, not --accent: app.css defines a global :focus-visible ring in --focus and this control
		   is inside its selector list, so ringing in --accent here would contradict every other control. */
		outline: 2px solid var(--focus);
	}
	h1 {
		margin: 0;
		font-size: var(--ph-text-lg);
		display: inline-flex;
		align-items: center;
		gap: var(--space-sm);
	}
</style>
