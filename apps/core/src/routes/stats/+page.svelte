<!--
  /stats — the PUBLIC party page. Aggregate only: no singer names anywhere, because the play log has
  no singer column to read from (see the `plays` table in schema.ts).

  Deliberately plain. It is a page a guest glances at between songs, so it leads with the three numbers
  that answer "how big is this thing and what do people sing", and puts the trend below the fold.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import Bars from '$lib/charts/Bars.svelte';
	import Trend from '$lib/charts/Trend.svelte';

	interface Stats {
		library: { ready: number; catalog: number };
		sings: { total: number; window: number; distinctSongs: number };
		topSongs: { mediaId: string; title: string; plays: number }[];
		topRecent: { mediaId: string; title: string; plays: number }[];
		topArtists: { artist: string; plays: number }[];
		perDay: { day: string; plays: number }[];
		window: { days: number; since: number };
	}

	let stats = $state<Stats | null>(null);
	let failed = $state(false);
	const now = Date.now();

	/**
	 * Whether "hot lately" is telling the reader anything "most sung" did not. On a young install the
	 * window covers the entire log, so the two lists are byte-identical — and the same chart printed
	 * twice reads as a rendering bug rather than as two facts.
	 */
	const recentDiffers = $derived.by(() => {
		if (!stats || stats.topRecent.length === 0) return false;
		const a = stats.topSongs.map((s) => `${s.mediaId}:${s.plays}`).join('|');
		const b = stats.topRecent.map((s) => `${s.mediaId}:${s.plays}`).join('|');
		return a !== b;
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
	<h1>Party stats</h1>

	{#if failed}
		<p class="note">Could not load stats.</p>
	{:else if !stats}
		<p class="note">Loading…</p>
	{:else}
		<div class="tiles">
			<div class="card tile">
				<span class="n">{stats.library.ready}</span>
				<span class="k">songs ready to sing</span>
				<!-- The catalog number is shown as a footnote, never as the headline: it counts every row
				     a search ever materialised (271 behind 7 singable songs on the live box), so quoting
				     it as "the library" would overstate it by ~40x. -->
				<span class="sub">{stats.library.catalog} in the catalog</span>
			</div>
			<div class="card tile">
				<span class="n">{stats.sings.total}</span>
				<span class="k">songs sung</span>
				<span class="sub">{stats.sings.window} in the last {stats.window.days} days</span>
			</div>
			<div class="card tile">
				<span class="n">{stats.sings.distinctSongs}</span>
				<span class="k">different songs picked</span>
			</div>
		</div>

		<div class="card">
			<h2>Most sung</h2>
			<Bars rows={stats.topSongs.map((s) => ({ label: s.title, value: s.plays }))} unit="sings" empty="Nobody has sung yet" />
		</div>

		{#if recentDiffers}
			<div class="card">
				<h2>Hot lately</h2>
				<Bars rows={stats.topRecent.map((s) => ({ label: s.title, value: s.plays }))} unit="sings" />
				<p class="note">Last {stats.window.days} days.</p>
			</div>
		{/if}

		<div class="card">
			<h2>Top artists</h2>
			<Bars rows={stats.topArtists.map((a) => ({ label: a.artist, value: a.plays }))} unit="sings" empty="No artists identified yet" />
			<!-- Honest about the gap rather than silently short: the normalizer stores null instead of
			     guessing a low-confidence artist, so some sung songs cannot be attributed at all. -->
			<p class="note">Only songs whose artist could be identified are counted here.</p>
		</div>

		<div class="card">
			<h2>Sings per day</h2>
			<Trend points={stats.perDay} since={stats.window.since} until={now} />
			<p class="note">A day with no bar had no sings recorded — which also covers a day the server was off, since the log cannot tell those apart.</p>
		</div>
	{/if}
</section>

<style>
	.stats {
		display: grid;
		gap: 1rem;
		padding: 1rem 0 3rem;
	}
	h1 {
		font-size: 1.4rem;
		margin: 0;
	}
	h2 {
		font-size: 0.95rem;
		margin: 0 0 0.9rem;
		color: var(--ink-dim);
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: uppercase;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: 0.75rem;
	}
	.tile {
		display: grid;
		gap: 0.2rem;
		align-content: start;
	}
	.n {
		font-size: 2rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: 1.1;
	}
	.k {
		font-size: 0.88rem;
	}
	.sub,
	.note {
		font-size: 0.75rem;
		color: var(--ink-dim);
	}
	.note {
		margin: 0.8rem 0 0;
	}
</style>
