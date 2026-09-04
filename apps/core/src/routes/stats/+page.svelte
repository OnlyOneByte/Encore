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
		<p class="note" role="alert">Could not load stats.</p>
	{:else if !stats}
		<p class="note" role="status">Loading…</p>
	{:else}
		<div class="tiles">
			<div class="card tile primary">
				<span class="n">{stats.sings.total}</span>
				<span class="k">songs sung</span>
				<span class="sub">{stats.sings.window} in the last {stats.window.days} days</span>
			</div>
			<div class="card tile">
				<span class="n">{stats.library.ready}</span>
				<span class="k">ready to sing</span>
				<!-- The catalog number is a footnote, never the headline: it counts every row a search
				     ever materialised (271 behind 7 singable songs on the live box), so quoting it as
				     "the library" overstates it by ~40x. -->
				<span class="sub">{stats.library.catalog} in the catalog</span>
			</div>
			<div class="card tile">
				<span class="n">{stats.sings.distinctSongs}</span>
				<span class="k">different songs</span>
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
	/*
	 * Capped below the 1080px shell. A bar row is a label on the left and its count on the right, so at
	 * full desktop width the two ends of one row sat ~1000px apart and stopped reading as a pair —
	 * proximity is what binds them. This is a reading-width surface, not a data grid.
	 */
	.stats {
		display: grid;
		gap: 1rem;
		padding: 1rem 0 3rem;
		max-width: 720px;
	}
	/*
	 * The .card primitive in app.css carries background/border/radius ONLY — no padding, and nothing
	 * up the chain (app-shell has just safe-area insets, the layout adds none) supplies any. So every
	 * card rendered its content flush against its own border, which makes the border read as a line
	 * drawn THROUGH the content rather than a frame around it.
	 */
	.card {
		padding: 1rem 1.1rem;
	}
	h1 {
		font-size: 1.4rem;
		margin: 0;
	}
	/*
	 * Section headers are the wayfinding on a page that is one long scroll, so they take full-strength
	 * ink. At --ink-dim they were the same grey as the footnotes they sit above, which put the
	 * navigation and the fine print at the same visual level.
	 */
	h2 {
		font-size: 1rem;
		margin: 0 0 0.9rem;
		color: var(--ink);
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: uppercase;
	}
	/*
	 * 1fr is safe now that .stats itself is capped — the reason for a fixed max was an uncapped shell
	 * stretching each tile to ~350px, and capping the container solved that at the root. A fixed 260px
	 * max here instead wrapped the third tile onto its own row inside the narrower container.
	 */
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
		gap: 0.75rem;
	}
	/*
	 * On a phone three tiles cannot sit side by side without becoming cramped, and auto-fit's 2+1 left
	 * the third stranded beside empty space. The headline takes the full row instead, which reads as a
	 * banner over two supporting figures rather than a broken grid.
	 */
	@media (max-width: 520px) {
		.tiles {
			grid-template-columns: 1fr 1fr;
		}
		.primary {
			grid-column: 1 / -1;
		}
	}
	.tile {
		display: grid;
		gap: 0.2rem;
		align-content: start;
	}
	/* One number leads. All three at 2rem/700 meant nothing did, and the glanceable question a guest
	   actually has ("is this party going?") is answered by the sing count, not the library size. */
	.n {
		font-size: 1.5rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: 1.1;
	}
	.primary .n {
		font-size: 2.6rem;
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
		line-height: 1.5;
	}
</style>
