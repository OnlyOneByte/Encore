<script lang="ts">
	/* THE PHONE'S ONLY NAVIGATION, and the thing the app did not have. Before this, every trip between surfaces went
	   through the home page: six `goto('/')` calls, the library behind an unlabelled icon door, settings behind a
	   gear, /stats reachable from exactly one link. On a phone at a party that is a lot of back-and-forth to answer
	   "am I next yet".

	   THREE TABS BECAUSE THERE ARE THREE VERBS. Home used to render six sections and branch all of them on
	   `searchActive` — not-searching gave Queued / Making karaoke / Your library, searching gave Ready to sing /
	   Needs karaoke. That branch WAS this split already; the page was three pages wearing one URL.

	   `/settings`, `/stats`, `/metrics` and `/admin` are deliberately NOT tabs. They are not party-time surfaces,
	   and a tab a guest never presses during the thing the app is for costs the same thumb-width as one they do. */
	import Icon from '$lib/ui/Icon.svelte';
	import type { IconName } from '$lib/ui/icons';

	let { pathname }: { pathname: string } = $props();

	const TABS: { href: string; label: string; icon: IconName }[] = [
		{ href: '/', label: 'Sing', icon: 'search' },
		{ href: '/queue', label: 'Queue', icon: 'clock' },
		{ href: '/library', label: 'Library', icon: 'library' }
	];

	/* EXACT MATCH FOR `/`, prefix for the rest. A `startsWith('/')` test is true of every path, so the naive form
	   lights Sing on every surface in the app. `/song/[mediaId]` is reached from the Queue tab's now-playing card — the only door to it in the tree — and
	   deliberately lights
	   NONE of them: it has its own back affordance, and lighting a tab the guest did not press is a lie about
	   where they are. */
	const isCurrent = (href: string) =>
		href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');
</script>

<nav class="tabs" aria-label="Sections">
	{#each TABS as tab (tab.href)}
		{@const current = isCurrent(tab.href)}
		<!-- `aria-current="page"` is the accessible half and the `current` class is the visual half; neither is
			sufficient alone, and keying the style off the attribute instead would put the two in one place but at a
			specificity that the `:focus-visible` ring would then have to outrank. -->
		<a class="tab" class:current={current} href={tab.href} aria-current={current ? 'page' : undefined}>
			<Icon name={tab.icon} />
			<span class="label">{tab.label}</span>
		</a>
	{/each}
</nav>

<style>
	.tabs {
		display: grid;
		/* Equal tracks rather than flex, so the three targets are the same width whatever their labels say — a tab
		   bar whose hit areas vary with copy length is the shape that makes one tab feel broken. */
		grid-auto-flow: column;
		grid-auto-columns: 1fr;
		background: var(--card);
		border-top: 1px solid var(--line);
		/* THE HOME-INDICATOR INSET LIVES HERE, once, because this is the app's bottom-most element. The strip above
		   composes none, which is why the two are siblings in one fixed container rather than separately fixed. */
		padding-block-end: env(safe-area-inset-bottom);
	}

	.tab {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-3xs);
		/* The floor applies to the TAB, not to its glyph: the label sits inside the same target, so the whole
		   column is tappable rather than just the icon. */
		min-height: var(--tap);
		padding-block: var(--space-xs);
		color: var(--ink-dim);
		text-decoration: none;
	}

	.label {
		font-size: var(--ph-text-xs);
		font-weight: 600;
		letter-spacing: 0.01em;
	}

	/* THE CURRENT TAB IS AN INK CHANGE, not a fill. A filled pill under the active tab is the other convention and
	   it was rejected here: the strip directly above already carries one fill (play/pause), and two fills a few
	   pixels apart read as two primary actions rather than as one location and one control. */
	.tab.current {
		color: var(--ink);
	}

	/* A SECOND, REDUNDANT CHANNEL for the current tab, because colour alone is not a sufficient indicator (SC
		1.4.1) and `--ink` against `--ink-dim` is exactly the kind of difference that disappears for a guest with low
		vision in a dark room. */
	.tab.current::before {
		content: '';
		position: absolute;
		inset-block-start: 0;
		inline-size: var(--space-4xl);
		block-size: var(--space-3xs);
		border-radius: var(--radius-pill);
		background: var(--accent);
	}

	.tab {
		position: relative;
	}
</style>
