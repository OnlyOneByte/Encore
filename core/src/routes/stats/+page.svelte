<!-- Public party page: aggregate only, no singer names — `plays` has no singer column. docs/FRONTEND.md#stats -->
<script lang="ts">
	import { onMount } from 'svelte';
	import Bars from '$lib/charts/Bars.svelte';
	import Trend from '$lib/charts/Trend.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';
	import { count } from '$lib/metrics-format';

	interface SongTally {
		mediaId: string;
		title: string;
		plays: number;
	}
	interface Stats {
		library: { ready: number; catalog: number };
		sings: { total: number; window: number; distinctSongs: number };
		topSongs: SongTally[];
		topRecent: SongTally[];
		topArtists: { artist: string; plays: number }[];
		perDay: { day: string; plays: number }[];
		window: { days: number; since: number };
	}

	let stats = $state<Stats | null>(null);
	let failed = $state(false);
	const now = Date.now();

	const tallyFingerprint = (rows: SongTally[]) => rows.map((s) => `${s.mediaId}:${s.plays}`).join('|');
	/** On a young install the window covers the whole log, and one chart printed twice reads as a bug. */
	const recentDiffers = $derived.by(() => {
		if (!stats || stats.topRecent.length === 0) return false;
		return tallyFingerprint(stats.topSongs) !== tallyFingerprint(stats.topRecent);
	});

	onMount(async () => {
		try {
			const res = await fetch('/api/stats?days=30');
			if (!res.ok) throw new Error(String(res.status));
			stats = await res.json();
		} catch {
			failed = true; // say so rather than rendering zeros that look like real data
		}
	});
</script>

<svelte:head><title>Encore — stats</title></svelte:head>

<section class="stats">
	<!-- Keep `title="Party stats"` a literal here and on <main>: tests/playwright/world/selectors.ts anchors that exact text. -->
	<PageHeader title="Party stats" back={{ href: '/settings', label: 'Back to settings' }} />

	<main aria-label="Party stats">
		{#if failed}
			<Alert.Root variant="destructive"><Alert.Title>Could not load stats.</Alert.Title></Alert.Root>
		{:else}
			<!-- This live region must OUTLIVE the load: one created by it arrives already holding its message, so silently. -->
			<p class="note" role="status">
				{#if !stats}
					Loading…
				{:else}
					Party stats for the last {count(stats.window.days, 'day')}.
				{/if}
			</p>

			{#if stats}
				<div class="tiles">
					<div class="tile-slot primary">
						<Card.Root>
							<Card.Content>
								<div class="tile">
									<span class="n">{stats.sings.total}</span>
									<span class="k">songs sung</span>
									<span class="sub">{stats.sings.window} in the last {count(stats.window.days, 'day')}</span>
								</div>
							</Card.Content>
						</Card.Root>
					</div>
					<div class="tile-slot">
						<Card.Root>
							<Card.Content>
								<div class="tile">
									<span class="n">{stats.library.ready}</span>
									<span class="k">ready to sing</span>
									<!-- Catalog counts every search result ever seen, so it stays a footnote, never the headline. -->
									<span class="sub">of {stats.library.catalog} found</span>
								</div>
							</Card.Content>
						</Card.Root>
					</div>
					<div class="tile-slot">
						<Card.Root>
							<Card.Content>
								<div class="tile">
									<span class="n">{stats.sings.distinctSongs}</span>
									<span class="k">different songs</span>
								</div>
							</Card.Content>
						</Card.Root>
					</div>
				</div>

				<Card.Root>
					<Card.Header>
						<Card.Title role="heading" aria-level={2}>Most sung</Card.Title>
					</Card.Header>
					<Card.Content>
						<Bars
							rows={stats.topSongs.map((s) => ({ label: s.title, value: s.plays }))}
							unit="sings"
							empty="Nobody has sung yet"
						/>
					</Card.Content>
				</Card.Root>

				{#if recentDiffers}
					<Card.Root>
						<Card.Header>
							<Card.Title role="heading" aria-level={2}>Hot lately</Card.Title>
						</Card.Header>
						<Card.Content>
							<Bars rows={stats.topRecent.map((s) => ({ label: s.title, value: s.plays }))} unit="sings" />
						</Card.Content>
						<Card.Footer><p class="note">Last {count(stats.window.days, 'day')}.</p></Card.Footer>
					</Card.Root>
				{/if}

				<Card.Root>
					<Card.Header>
						<Card.Title role="heading" aria-level={2}>Top artists</Card.Title>
					</Card.Header>
					<Card.Content>
						<Bars
							rows={stats.topArtists.map((a) => ({ label: a.artist, value: a.plays }))}
							unit="sings"
							empty="No artists identified yet"
						/>
						<!-- The normalizer stores null rather than guess, so some sings have no artist to attribute. -->
					</Card.Content>
					<Card.Footer><p class="note">Songs we couldn't match to an artist aren't counted.</p></Card.Footer>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title role="heading" aria-level={2}>Sings per day</Card.Title>
					</Card.Header>
					<Card.Content>
						<Trend points={stats.perDay} since={stats.window.since} until={now} />
					</Card.Content>
					<Card.Footer>
						<p class="note">No bar means nothing was sung — or the server was off. We can't tell those apart.</p>
					</Card.Footer>
				</Card.Root>
			{/if}
		{/if}
	</main>
</section>

<style>
	/* Gaps on this page stay in rem on purpose: the --space-* scale is flat px, so tokenising them would freeze the
	   spacing under text zoom while the type it separates keeps growing. */
	.stats {
		display: grid;
		gap: 1rem;
		/* --dock-h reserves the band, whose own env(safe-area-inset-bottom) reaches this column through it. */
		padding: 1rem 0 calc(var(--dock-h, 0px) + 3rem);
		max-width: var(--measure-grid);
		/* PageHeader caps on --page-measure, so match it here or the header and its content disagree. */
		--page-measure: var(--measure-grid);
		/* .app-shell is a centred flex column: a cap alone shrinks from the right, so keep the stretch. */
		width: 100%;
		margin-inline: auto;
	}
	main {
		display: grid;
		gap: 1rem;
	}
	/* Card.Root is `flex flex-col` with no `h-full`, so it sizes to its content; the grid here makes it fill the row, which
	   is what stops the three tiles' bottom edges stair-stepping. */
	.tile-slot {
		display: grid;
	}

	.tiles {
		display: grid;
		/* Track floor is `em`, not px: it has to hold one unwrappable word, which grows with the guest's text size.
			   `min(100%, …)` stops the floor itself overflowing the row. */
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 9em), 1fr));
		gap: 0.75rem;
	}
	/* `max(9em, 40%)` is a two-up written as a floor: the 40% term caps the row at two tracks, the 9em term lets it fall
	   to one when the type outgrows half the width (SC 1.4.10 Reflow). */
	@media (max-width: 520px) {
		.tiles {
			grid-template-columns: repeat(auto-fit, minmax(min(100%, max(9em, 40%)), 1fr));
		}
		.primary {
			grid-column: 1 / -1;
		}
	}
	/* This grid must stay on the element that CONTAINS the spans: Card.Content sits between it and .tile-slot, so the same
	   rule on the wrapper lays the number, label and footnote out inline. */
	.tile {
		display: grid;
		gap: 0.2rem;
		align-content: start;
	}
	.n {
		font-size: var(--ph-text-2xl);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: var(--lh-tight);
	}
	.primary .n {
		font-size: var(--ph-text-3xl);
	}
	.k {
		font-size: var(--ph-text-md);
	}
	.sub,
	.note {
		font-size: var(--ph-text-xs);
		color: var(--ink-dim);
	}
	.note {
		margin: 0.8rem 0 0;
		line-height: 1.5;
	}
</style>
