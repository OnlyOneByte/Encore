<script lang="ts">
	/*
	 * YOUR LIBRARY, as its own route. It exists because the home column stacked the library UNDER an unbounded queue,
	 * so with a busy rotation the songs you already own were metres down a scroll — and the home field could not stand
	 * in for them, because that field FETCHES from YouTube and needs a name you already know. Browsing is for when you
	 * do not. See docs/FRONTEND.md#the-library-page.
	 *
	 * The filter here is a FILTER, never a search: it narrows `room.library`, in memory, with no request. The count
	 * line under the field is what says so — two fields that look alike and do opposite things would be a worse problem
	 * than the one this page fixes, so the difference is stated rather than implied by styling.
	 *
	 * No auto-navigation on adding a song: you came here to pick, and picking two is normal. The toast carries the way
	 * back instead, so nothing strands you on a leaf route.
	 */
	import { onMount } from 'svelte';
	import type { Media, PublicSinger, QueueEntry } from '$lib/contract';
	import type { QueueStore } from '$lib/stores/queue';
	import { room } from '$lib/stores/room';
	import { originalKeyLabel } from '$lib/contract';
	import { artistFacetsOf, browseLibrary, FACET_CHIP_LIMIT, tagFacetsOf, type LibrarySort } from '$lib/library-browse';
	import JoinLanding from '$lib/components/JoinLanding.svelte';
	import SongRow from '$lib/components/SongRow.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import FindField from '$lib/ui/FindField.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { Button } from '$lib/components/ui/button';
	import SkeletonRows from '$lib/ui/SkeletonRows.svelte';
	import * as Empty from '$lib/components/ui/empty';
	import { Toaster } from '$lib/components/ui/sonner';
	import { toast } from 'svelte-sonner';

	let me = $state<PublicSinger | null>(null);
	/* `$state.raw`, NOT `$state`, for the three mirrored collections: `sync()` REASSIGNS each one wholesale from the
	   room link and nothing here ever mutates them, so deep reactivity buys nothing and costs a proxy per object.
	   `library` is the whole ready catalog and every Media carries nested `songProfile` and `lyricsCandidates`, so
	   plain `$state` proxies hundreds of nested objects on every sync — on a page whose entire claim is that
	   filtering is instant. Raw still updates on REASSIGNMENT, which is the only way these ever change. If a future
	   edit needs to mutate one in place, it has to reassign instead — that is the trade being made here. */
	let library = $state.raw<Media[]>([]);
	let libraryTags = $state.raw<Record<string, string[]>>({});
	let entries = $state.raw<QueueEntry[]>([]);
	let libraryLoaded = $state(false);
	/* Left un-raw deliberately, and it is not an oversight: Svelte proxies plain objects and arrays, never class
	   instances, so there is no proxy here to avoid. */
	let store = $state<QueueStore | undefined>(undefined);

	/* As on `/`: `sync()` runs ONCE before subscribing, because the link is a singleton that outlives this component,
	   so arriving here from the queue finds it already live and subscribing alone would render an empty shelf. */
	onMount(() => {
		const sync = () => {
			me = room.me;
			library = room.library;
			libraryTags = room.libraryTags;
			libraryLoaded = room.libraryLoaded;
			entries = room.entries;
			store = room.queue;
		};
		sync();
		const stopMirror = room.subscribe(sync);
		const stopErrors = room.onError((message) => toast.error(message, { duration: 4000 }));
		void room.connect();
		return () => {
			stopMirror();
			stopErrors();
		};
	});

	let query = $state('');
	let queryEl = $state<HTMLInputElement | null>(null);
	let sort = $state<LibrarySort>('title');
	/** One at a time, and `null` for "no facet" — the mutual exclusion /api/library imposes on ?artist/?tag. */
	let pickedArtist = $state<string | null>(null);
	let pickedTag = $state<string | null>(null);

	/* Facets from the WHOLE library, never from `rows`: derived from the filtered set they would collapse to the one
	   value you just picked and leave no way back. Capped, because past a dozen chips are a second list to read. */
	const artistFacets = $derived(artistFacetsOf(library).slice(0, FACET_CHIP_LIMIT));
	const tagFacets = $derived(tagFacetsOf(library, libraryTags).slice(0, FACET_CHIP_LIMIT));

	const rows = $derived(
		browseLibrary({ library, tags: libraryTags, query, facet: { artist: pickedArtist, tag: pickedTag }, sort })
	);
	const filtering = $derived(query.trim().length > 0 || pickedArtist !== null || pickedTag !== null);

	/* Built HERE rather than inline in the markup, because an inline `{#if}` across two lines puts a NEWLINE
	   between the number and its noun — invisible on screen, but it is the element's text, so it reaches a screen
	   reader and any assertion as "1\n\t\t\tsong". Unfiltered it states the total; filtered it states both, because
	   the second number is the only thing on this page that says the box HIDES rows rather than fetching them. */
	/** The sort toggles, as a constant so the template holds no tuple literal to re-type on every render. */
	const SORTS: ReadonlyArray<readonly [LibrarySort, string]> = [
		['title', 'Title'],
		['artist', 'Artist'],
		['newest', 'Newest']
	];

	let panelOpen = $state(false);
	/** Nothing to refine with one song and no facets, and an empty disclosure is worse than no disclosure. */
	const hasRefinements = $derived(library.length > 1 || artistFacets.length > 1 || tagFacets.length > 1);
	/** NAMES THE ACTIVE FACET, because the panel that shows the pressed chip may be shut: without this, a guest
	 *  sees "2 of 9 songs" with no visible cause and reads it as the page having lost their songs. */
	const panelLabel = $derived(
		pickedArtist ? `Sort & filter · ${pickedArtist}` : pickedTag ? `Sort & filter · ${pickedTag}` : 'Sort & filter'
	);

	const countLabel = $derived(
		filtering
			? `${rows.length} of ${library.length} songs`
			: `${library.length} ${library.length === 1 ? 'song' : 'songs'}`
	);

	const queued = $derived(entries.filter((e) => e.status === 'queued'));
	function inMyQueue(mediaId: string): boolean {
		return queued.some((e) => e.mediaId === mediaId && e.singerId === me?.id);
	}

	/** Identical to the home column's, so a row cannot describe the same song differently on two surfaces. */
	const rowMeta = (m: Media) => ({
		title: m.title,
		artist: m.artist,
		artistCanonical: m.artistCanonical,
		thumbnail: m.thumbnail,
		durationSec: m.durationSec,
		viewCount: m.viewCount,
		keyName: originalKeyLabel(m.songProfile) ?? undefined,
		tags: libraryTags[m.id]
	});

	function pickArtist(artist: string) {
		pickedTag = null;
		pickedArtist = pickedArtist === artist ? null : artist;
	}
	function pickTag(tag: string) {
		pickedArtist = null;
		pickedTag = pickedTag === tag ? null : tag;
	}
	function clearFilters() {
		query = '';
		pickedArtist = null;
		pickedTag = null;
		queryEl?.focus();
	}

	function addSong(m: Media) {
		store?.addSong(m.id);
		if (navigator.vibrate) navigator.vibrate(8);
		// The way back out, offered rather than forced: a guest adding a second song must not be navigated away.
		toast(`Added “${m.title}”`, {
			duration: 5000,
			action: { label: 'View queue', onClick: () => (location.href = '/') }
		});
	}
</script>

{#if me}
	<div class="library-page">
		<PageHeader title="Your library" icon="library" back={{ href: '/', label: 'Back to the queue' }} />

		<main>
			<!-- A FILTER, not a search: same shape as the home field for consistency, but its own placeholder, and the
					count line below carries the actual distinction. -->
			<div class="field-slot">
				<FindField
					bind:value={query}
					bind:element={queryEl}
					ariaLabel="Filter your library"
					placeholder="Filter your library…"
					clearable={filtering}
					clearLabel="Clear the filter"
					onclear={clearFilters}
				/>
			</div>

			{#if !libraryLoaded}
				<SkeletonRows count={4} label="Loading your library…" />
			{:else if library.length === 0}
				<!-- The genuinely empty library. The only useful instruction points back at the queue's field, which is
						the one surface that can ADD a song — this page can only show what is already here. -->
				<Empty.Root>
					<div class="lib-empty">
						<Empty.Header>
							<Empty.Title role="heading" aria-level={2}>No karaoke tracks yet</Empty.Title>
							<Empty.Description>Search from the queue screen and we'll make one.</Empty.Description>
						</Empty.Header>
						<Button variant="secondary" size="tap" href="/">
							<Icon name="search" /> Find a song
						</Button>
					</div>
				</Empty.Root>
			{:else}
				<!-- ONE line, and it always states the total: "12 of 47" is what tells a guest this box hides rows rather
						than fetching them, which is the whole difference from the field on `/`. -->
				<p class="count" role="status" aria-live="polite">{countLabel}</p>

				<!-- COLLAPSED BY DEFAULT, and that is the page's main design decision. Expanded, the chip rows are
						~420px of chrome on a nine-song library — seven artists, six tags and three sorts, each with its own
						heading — which pushed the FIRST SONG ROW to about y=650 and left one row visible above the band.
						That is the exact fault /library exists to fix, relocated. Scrolling songs is the default state; the
						refinements are one tap away. Measured at 390x844 with the payload in the note on `chips` below. -->
				{#if hasRefinements}
					<Button
						variant="eyebrow"
						aria-expanded={panelOpen}
						aria-controls="library-refine"
						onclick={() => (panelOpen = !panelOpen)}
					>
						<Icon name={panelOpen ? 'chevron-up' : 'chevron-down'} />
						{panelLabel}
					</Button>
					{#if panelOpen}
						<div id="library-refine" class="refine">
							<!-- `aria-pressed`, not a radiogroup: three toggles over one value, and the pressed one IS the sort. -->
							{#if library.length > 1}
								<h2 class="grouphead">Sort</h2>
								<div class="chips">
									{#each SORTS as [value, label] (value)}
										<Button
											variant={sort === value ? 'secondary' : 'outline'}
											size="tap"
											aria-pressed={sort === value}
											onclick={() => (sort = value)}
										>
											{label}
										</Button>
									{/each}
								</div>
							{/if}

							{#if artistFacets.length > 1}
								<h2 class="grouphead">Artists</h2>
								<div class="chips">
									{#each artistFacets as f (f.artist)}
										<Button
											variant={pickedArtist === f.artist ? 'secondary' : 'outline'}
											size="tap"
											aria-pressed={pickedArtist === f.artist}
											onclick={() => pickArtist(f.artist)}
										>
											{f.artist} <span class="chip-n">{f.count}</span>
										</Button>
									{/each}
								</div>
							{/if}

							{#if tagFacets.length > 1}
								<h2 class="grouphead">Tags</h2>
								<div class="chips">
									{#each tagFacets as f (f.tag)}
										<Button
											variant={pickedTag === f.tag ? 'secondary' : 'outline'}
											size="tap"
											aria-pressed={pickedTag === f.tag}
											onclick={() => pickTag(f.tag)}
										>
											{f.tag} <span class="chip-n">{f.count}</span>
										</Button>
									{/each}
								</div>
							{/if}
						</div>
					{/if}
				{/if}

				{#if rows.length}
					{#each rows as m (m.id)}
						<SongRow
							{...rowMeta(m)}
							readiness="ready"
							inQueue={inMyQueue(m.id)}
							onadd={store ? () => addSong(m) : undefined}
						/>
					{/each}
				{:else}
					<!-- Filtered to nothing. Distinct from the empty library above, and it must offer the way out: the
							filter is the only reason these songs are hidden. -->
					<Empty.Root>
						<div class="lib-empty tight">
							<Empty.Header>
								<Empty.Description>
									Nothing here matches{#if query.trim()}
										&ldquo;{query.trim()}&rdquo;{/if}.
								</Empty.Description>
							</Empty.Header>
							<Button variant="secondary" size="tap" onclick={clearFilters}>
								<Icon name="close" /> Clear the filter
							</Button>
						</div>
					</Empty.Root>
				{/if}
			{/if}
		</main>
	</div>
{:else}
	<JoinLanding />
{/if}

<Toaster position="bottom-center" offset="var(--dock-h, 0px)" style="--width: min(92vw, 420px);" />

<style>
	.library-page {
		/* The grid measure, not the prose one: this is a column of song rows, so it must agree with `/`. */
		--page-measure: var(--measure-grid);
	}
	main {
		flex: 1;
		max-width: var(--page-measure);
		margin-inline: auto;
		width: 100%;
		box-sizing: border-box;
		/* Reserves the band's measured height; no env() term — the band carries the only inset. */
		padding: var(--space-xs) var(--space-3xl) calc(var(--dock-h, 0px) + 28px);
	}

	/* The ring belongs to the whole box, so app.css's per-input ring is suppressed. */

	/* The field's own box. A wrapper because a class handed to a component is stripped at the caller, and the spacing
	   below the field belongs to this page rather than to the control. */
	.field-slot {
		margin-bottom: var(--space-sm);
	}
	.count {
		margin: 0 var(--space-2xs) var(--space-md);
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
		font-variant-numeric: tabular-nums;
	}

	/* The disclosure's body. A bottom margin only, because each group inside carries its own heading spacing. */
	.refine {
		margin-bottom: var(--space-sm);
	}
	/* WRAPS rather than scrolls horizontally: a scroller hides its own overflow, and these are the page's only
	   navigation. Wrapping is also WHY the panel is collapsed by default — nine songs across seven artists and six
	   tags wrapped to ~420px and put the first row at y=650 on a 390x844 phone. The count cap lives in
	   library-browse.ts, so this rule never has to know how many there are. */
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
		margin-bottom: var(--space-sm);
	}
	.chip-n {
		margin-left: var(--space-xs);
		color: var(--ink-dim);
		font-variant-numeric: tabular-nums;
	}

	/* FLEX COLUMN, not grid + place-items: the vendored `Empty.Header` is `display: contents`, so its children become
	   direct children of this box and grid would split the min-height between them. See `.queue-empty` on `/`. */
	.lib-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-md);
		min-height: 40vh;
		padding: var(--space-2xl) var(--space-md);
		text-align: center;
	}
	/* The void is only right when nothing follows the state; a filtered-to-nothing list still has chips above it. */
	.lib-empty.tight {
		min-height: 0;
	}
	/* The space is load-bearing — see the twin rule on `/`. Compound, this matched nothing and the title rendered at
	   the vendored `text-lg`; `empty-title` is a grandchild through `Empty.Header`'s `display: contents`. */
	/* Full --ink, matching `/`'s twin: `.encore-empty` dims its whole subtree, which on a heading this size reads as a
	   placeholder rather than as a title. The SIZE was already right here and is what `/` was brought down to. */
	.lib-empty :global([data-slot='empty-title']) {
		font-size: var(--ph-text-2xl);
		line-height: var(--lh-snug);
		font-weight: 700;
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	/* Wide viewports spend the room on MORE SONGS, not longer rows, exactly as `/` does — and the opt-in is inverted
	   the same way, so a block added here cannot land beside a song row. */
	@media (min-width: 768px) {
		main {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(440px, 1fr));
			gap: 0 var(--space-xl);
			align-content: start;
		}
		main > :global(*) {
			grid-column: 1 / -1;
		}
		main > :global(.row) {
			grid-column: auto;
		}
	}

	@media (max-height: 480px) {
		.grouphead {
			margin: var(--space-sm) var(--space-2xs) var(--space-2xs);
		}
	}
</style>
