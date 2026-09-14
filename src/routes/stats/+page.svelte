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
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import * as Card from '$lib/components/ui/card';
	import * as Alert from '$lib/components/ui/alert';

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
	<!--
		`title="Party stats"` is spelled as a LITERAL, and the same string is repeated on <main> below rather
		than hoisted into a const both read. That is deliberate: SEL.statsPage's anchor in
		apps/core/e2e/contract.ts is the exact text `title="Party stats"`, so interpolating the attribute
		(`title={PAGE_TITLE}`) deletes the anchor the e2e flow uses to know it landed on this page — the
		guard reds, correctly. Two occurrences of a four-word string is the cheaper of the two costs.
	-->
	<PageHeader title="Party stats" back={{ href: '/settings', label: 'Back to settings' }} />

	<!--
		The shadcn migration: the content is a <main> landmark, the shape /admin and /settings already use. The cap,
		--page-measure and the auto inline margin stay on .stats so the PageHeader inside it still shares
		the content's 720px measure; <main> only carries the grid the cards lay out in.
	-->
	<main aria-label="Party stats">
		{#if failed}
			<Alert.Root variant="destructive"><Alert.Title>Could not load stats.</Alert.Title></Alert.Root>
		{:else}
			<!--
				ONE live region that EXISTS BEFORE ITS CONTENT CHANGES (the shadcn migration). This was
				`{:else if !stats}<p role="status">Loading…</p>`, a region CREATED by the load rather than
				updated by it — a live region announces when its contents change, so a region that arrives
				already holding its message announces nothing, and a guest waiting on this page heard silence
				both while it loaded and when it arrived. Persisting the element and swapping only its text
				makes the transition the change. The loaded copy states the window every figure below is
				measured over, which the page named only inside a tile's footnote before.
			-->
			<p class="note" role="status">
				{#if !stats}
					Loading…
				{:else}
					Party stats for the last {stats.window.days} days.
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
									<span class="sub">{stats.sings.window} in the last {stats.window.days} days</span>
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
									<!-- The catalog count is a footnote, never the headline: it counts every search result ever
				     seen (271 behind 7 singable songs on the live box), so quoting it as "the library"
				     overstates it by ~40x. -->
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
						<Card.Title>Most sung</Card.Title>
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
							<Card.Title>Hot lately</Card.Title>
						</Card.Header>
						<Card.Content>
							<Bars rows={stats.topRecent.map((s) => ({ label: s.title, value: s.plays }))} unit="sings" />
							<p class="note">Last {stats.window.days} days.</p>
						</Card.Content>
					</Card.Root>
				{/if}

				<Card.Root>
					<Card.Header>
						<Card.Title>Top artists</Card.Title>
					</Card.Header>
					<Card.Content>
						<Bars
							rows={stats.topArtists.map((a) => ({ label: a.artist, value: a.plays }))}
							unit="sings"
							empty="No artists identified yet"
						/>
						<!-- Honest about the gap rather than silently short: the normalizer stores null instead of
			     guessing a low-confidence artist, so some sung songs cannot be attributed at all. -->
						<p class="note">Songs we couldn't match to an artist aren't counted.</p>
					</Card.Content>
				</Card.Root>

				<Card.Root>
					<Card.Header>
						<Card.Title>Sings per day</Card.Title>
					</Card.Header>
					<Card.Content>
						<Trend points={stats.perDay} since={stats.window.since} until={now} />
						<p class="note">No bar means nothing was sung — or the server was off. We can't tell those apart.</p>
					</Card.Content>
				</Card.Root>
			{/if}
		{/if}
	</main>
</section>

<style>
	/*
	 * Capped below the 1080px shell. A bar row is a label on the left and its count on the right, so at
	 * full desktop width the two ends of one row sat ~1000px apart and stopped reading as a pair —
	 * proximity is what binds them. This is a reading-width surface, not a data grid.
	 */
	/*
	 * SPACING HERE STAYS IN rem, DELIBERATELY (the primitive-adoption pass reverted a conversion to --space-*).
	 * app.css's "what this deliberately does not do" note rules on exactly this: "a rem gap tracks the
	 * guest's text-size setting while a px one does not -- so converting one to the other is a behaviour
	 * change under text zoom, not a rename. Whether phone spacing should scale with text at all is a
	 * design question, and it is not answered by this issue." The px --space-* scale is 16px flat, so
	 * tokenising `gap: 1rem` would freeze these gaps at 200% text instead of letting them grow with the
	 * type they separate. The three operator routes are not outliers to be normalised; they are the
	 * surfaces that scale. Font SIZES on these pages did move onto the --ph-text-* ladder, which is rem
	 * and therefore keeps that property.
	 */
	.stats {
		display: grid;
		gap: 1rem;
		/* 3rem (48px) is off-scale — the scale stops at --space-4xl (20px) — so it stays a literal. */
		padding: 1rem 0 3rem;
		max-width: 720px;
		/* The PageHeader inside this block caps on --page-measure; match it to the content width so the
		   header and the content share one measure at every viewport (and the header never caps below
		   the block it sits in when --max-w steps down in the 768–1200 band). */
		--page-measure: 720px;
		/* The cap takes width off the right only on a flex child (.app-shell is a
		   centered flex column); width:100% keeps the stretch so margin-inline:auto
		   re-centres the full capped block instead of collapsing it to content width. */
		width: 100%;
		margin-inline: auto;
	}
	/*
	 * The <main> landmark (the shadcn migration). It carries the CARD grid and nothing else: the cap, --page-measure and
	 * the auto inline margin stay on .stats so the PageHeader sitting inside that block keeps sharing the
	 * content's measure.
	 */
	main {
		display: grid;
		gap: 1rem;
	}
	/*
	 * The .card primitive in app.css carries background/border/radius ONLY — no padding, and nothing
	 * up the chain (app-shell has just safe-area insets, the layout adds none) supplies any. So every
	 * card rendered its content flush against its own border, which makes the border read as a line
	 * drawn THROUGH the content rather than a frame around it.
	 */
	/*
	 * Section headers are the wayfinding on a page that is one long scroll, so they take full-strength
	 * ink. At --ink-dim they were the same grey as the footnotes they sit above, which put the
	 * navigation and the fine print at the same visual level.
	 */
	/*
	 * S4: the card heading rule left this file. Card.Title owns it now — a normal-weight base-size
	 * title where this was hand-styled, which is part of the visual change accepted for S4.
	 */
	/*
	 * 1fr is safe now that .stats itself is capped — the reason for a fixed max was an uncapped shell
	 * stretching each tile to ~350px, and capping the container solved that at the root. A fixed 260px
	 * max here instead wrapped the third tile onto its own row inside the narrower container.
	 *
	 * The floor is in `em`, not `px`. A tile's own longest word cannot wrap — "different" is one
	 * token — so a track narrower than that word plus the card's padding does not clip, it pushes the
	 * whole page wider. A px floor is fixed while the word it has to hold grows with the guest's
	 * text-size setting, so at 200% the floor stops bounding anything. 9em tracks the type: at the
	 * default size it is 144px (what the 140px floor was), and it doubles exactly when the word does.
	 * `min(100%, …)` is what keeps the floor itself from becoming the overflow — a floor wider than the
	 * row would push a single track past the viewport, which is the same defect one level up.
	 */
	/*
	 * The wrapper that carries the tile into the grid.
	 *
	 * S8 replaced a single element that was grid item, surface and layout at once with a wrapper around
	 * <Card.Root>. The wrapper became the grid item and stretches to the row's height, but `Card.Root` is
	 * `flex flex-col` with no `h-full`, so it sized to its own CONTENT and the three cards' bottom edges
	 * stair-stepped instead of lining up. `display: grid` makes the single child fill the slot, which is
	 * what the shared surface used to do for free by BEING the grid item.
	 *
	 * The gap is content-dependent, so no single number describes it: tile 1 sets `.primary .n` to 2.6rem
	 * against the others' 1.5rem, and only two of the three carry a `.sub` line, which itself wraps at
	 * narrow columns. Measured examples ranged from ~27px to ~51px of bottom-edge spread at 1080px
	 * depending on the strings, against 0.0px with this rule present. Deliberately NOT asserted as a
	 * figure anywhere: rendered geometry cannot be measured on the mount rung, which breaks
	 * `getBoundingClientRect` on purpose (XR-VER-03). What IS guarded is that the class resolves to a rule
	 * at all — `app-class-resolution-913.test.ts` — because the defect was the missing rule, not the pixel
	 * count.
	 *
	 * Phone width hid it entirely: `auto-fit` collapses to one column, so every tile is its own row and
	 * there is no shared height to disagree with. That is why the eyes-on pass at 390px missed it.
	 */
	.tile-slot {
		display: grid;
	}

	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 9em), 1fr));
		gap: 0.75rem;
	}
	/*
	 * On a phone three tiles cannot sit side by side without becoming cramped, and auto-fit's 2+1 left
	 * the third stranded beside empty space. The headline takes the full row instead, which reads as a
	 * banner over two supporting figures rather than a broken grid.
	 *
	 * `max(9em, 40%)` is that two-up written as a floor rather than as a fixed `1fr 1fr`. The
	 * 40% term is what caps the row at two — three tracks would need 120% of the row, so they never
	 * fit — and it replaces the fixed pair without changing the phone layout at the default text size.
	 * The 9em term is what makes the row give way: once the type outgrows half the width, one column is
	 * all that fits, and the tiles stack instead of overflowing the viewport (SC 1.4.10 Reflow).
	 */
	@media (max-width: 520px) {
		.tiles {
			grid-template-columns: repeat(auto-fit, minmax(min(100%, max(9em, 40%)), 1fr));
		}
		.primary {
			grid-column: 1 / -1;
		}
	}
	/*
	 * S8 fix: the grid is on the element that CONTAINS the spans, INSIDE Card.Content. It was on the
	 * outer wrapper for one build, where it did nothing — Card.Content sits between, so each tile's
	 * number, label and footnote laid out inline and read as a single wrapping line. A screenshot caught
	 * it; nothing else could, because both elements exist and both rules apply, just not to each other.
	 */
	.tile {
		display: grid;
		gap: 0.2rem;
		align-content: start;
	}
	/* One number leads. All three at 2rem/700 meant nothing did, and the glanceable question a guest
	   actually has ("is this party going?") is answered by the sing count, not the library size. */
	.n {
		font-size: var(--ph-text-2xl);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		line-height: var(--lh-tight);
	}
	.primary .n {
		font-size: 2.6rem;
	}
	.k {
		font-size: 0.88rem;
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
