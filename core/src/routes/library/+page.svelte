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
	 * THIS IS THE LIBRARY TAB, reached from the dock rather than through a door on the home column, so nothing here is a
	 * leaf route and nothing on it needs a way back — which is why the header carries no back arrow and the toast
	 * carries no action. Adding a song still does not navigate: you came here to pick, and picking two is normal. The
	 * toast now says where the song went instead of offering a trip to a tab already on screen.
	 */
	import { onMount } from 'svelte';
	import type { Media, PublicSinger, QueueEntry } from '$lib/contract';
	import type { QueueStore } from '$lib/stores/queue';
	import { room } from '$lib/stores/room';
	import { originalKeyLabel, songDisplay } from '$lib/contract';
	import {
		artistFacetsOf,
		browseLibrary,
		FACET_CHIP_LIMIT,
		LIBRARY_PAGE,
		libraryWindow,
		tagFacetsOf,
		type LibrarySort
	} from '$lib/library-browse';
	import JoinLanding from '$lib/components/JoinLanding.svelte';
	import SongRow from '$lib/components/SongRow.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import FindField from '$lib/ui/FindField.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { Button } from '$lib/components/ui/button';
	import SkeletonRows from '$lib/ui/SkeletonRows.svelte';
	import * as Empty from '$lib/components/ui/empty';
	import { toast } from 'svelte-sonner';
	import { rememberedKey } from '$lib/stores/remembered-key';

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
	/** Mirrored beside `libraryLoaded` because this page needs both: loaded says the fetch RETURNED, failed says it
	 *  DIED. Without the second, one dropped request renders "No karaoke tracks yet" over a full library. */
	let libraryFailed = $state(false);
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
			libraryFailed = room.libraryFailed;
			entries = room.entries;
			store = room.queue;
		};
		sync();
		const stopMirror = room.subscribe(sync);
		void room.connect();
		/* AN ARRIVAL IS A RETRY, and it is the cheap half of the fix. The one fetch fires at JOIN, inside
		   `connect()`, which is guarded idempotent — so a blip at join poisoned this tab for the rest of the
		   session for a guest who only walks over here later, and no number of tab round trips re-asked. One mount
		   per arrival bounds it by construction, and on a first mount the flag is false, so this is inert in the
		   common case. It does not replace the failure arm below: a guest who is still offline needs to be told. */
		if (room.libraryFailed) void room.refreshLibrary();
		return stopMirror;
	});

	let query = $state('');
	/* WHAT THE ROWS ARE FILTERED BY, 150ms behind the box. The field itself stays live — `query` is what the input
	   binds, and it echoes every keystroke — but the row list is not rebuilt per keystroke. Measured at 390x844 with
	   2000 ready songs under a 4x CPU throttle (a mid-range phone): the first two letters of a six-letter query blocked
	   the main thread for 634ms and 427ms, and the backspace that widened the list again blocked it for 3.4 SECONDS.
	   With this and the window below, the same keystrokes cost 85ms then ~31ms and the widening backspace 40ms.
	   150ms is the home field's search debounce to the millisecond, so the two fields feel alike while only one of them
	   goes anywhere. */
	let appliedQuery = $state('');
	let filterTimer: ReturnType<typeof setTimeout> | undefined;
	let queryEl = $state<HTMLInputElement | null>(null);
	let sort = $state<LibrarySort>('title');
	/** How much of the match list is rendered. Grows on tap; back to one page whenever the match list changes, or a
	 *  600-row DOM built up under one query would be handed straight to the next one. */
	let revealed = $state(LIBRARY_PAGE);

	/* The window resets WITH the rows and never on the keystroke: reset on input, a guest who had revealed 120 rows
	   watched them collapse to 60 for the 150ms before the filter landed, which reads as the page dropping rows it was
	   still showing. */
	function applyQuery(next: string) {
		appliedQuery = next;
		revealed = LIBRARY_PAGE;
	}
	function onQueryInput() {
		clearTimeout(filterTimer);
		// An EMPTIED box applies at once, as on `/`: "show me everything again" must not sit behind a timer, and with
		// the window in place restoring the full list only renders LIBRARY_PAGE rows.
		if (!query.trim()) {
			applyQuery('');
			return;
		}
		filterTimer = setTimeout(() => applyQuery(query), 150);
	}
	/** One at a time, and `null` for "no facet" — the mutual exclusion /api/library imposes on ?artist/?tag. */
	let pickedArtist = $state<string | null>(null);
	let pickedTag = $state<string | null>(null);

	/* Facets from the WHOLE library, never from `rows`: derived from the filtered set they would collapse to the one
	   value you just picked and leave no way back. Capped, because past a dozen chips are a second list to read. */
	const artistFacets = $derived(artistFacetsOf(library).slice(0, FACET_CHIP_LIMIT));
	const tagFacets = $derived(tagFacetsOf(library, libraryTags).slice(0, FACET_CHIP_LIMIT));

	const rows = $derived(
		browseLibrary({
			library,
			tags: libraryTags,
			query: appliedQuery,
			facet: { artist: pickedArtist, tag: pickedTag },
			sort
		})
	);
	/** The window actually rendered, and what the reveal control still has behind it. */
	const view = $derived(libraryWindow(rows, revealed));
	/** What the ROWS reflect — the count line must never describe a query the list has not applied yet. */
	const filtering = $derived(appliedQuery.trim().length > 0 || pickedArtist !== null || pickedTag !== null);
	/** What is in the BOX, and now only that. `query` rather than `appliedQuery` is still the point — the clear
	 *  control has to appear on the first keystroke, not 150ms after the last one — but the two facet terms this
	 *  carried were surplus to that: they put an X inside a visibly EMPTY field whenever a chip was picked, and
	 *  paired with a handler that cleared the chip too. `/`'s twin passes `clearable={searchActive}`, query only. */
	const boxHasText = $derived(query.trim().length > 0);

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
	/** The filtered-to-nothing sentence, hoisted for the reason this file already records for `countLabel` (the
	 *  newline note in this `<script>`): inline across two lines it rendered "Nothing here matches“zzqq”." — Svelte
	 *  trims the leading whitespace of a branch fragment's first text node, so neither half kept a separator and the
	 *  quote sat hard against the "s" (measured: a 0.00px gap between the glyph rects, not merely a textContent
	 *  artefact). A literal leading space inside the branch is trimmed by the same rule; `&nbsp;` would survive it
	 *  but makes "matches <query>" unbreakable and can overflow a long query at 390px.
	 *  The APPLIED query, never the live one: quoting the box would name a query these rows were not filtered by
	 *  for the 150ms the debounce is still holding. Curly quotes as the literal codepoints, matching
	 *  `noRowsState`'s own `Nothing matches “…”.` in readiness.ts so the two surfaces are spelled alike. */
	const emptyLabel = $derived(
		appliedQuery.trim() ? `Nothing here matches “${appliedQuery.trim()}”.` : 'Nothing here matches.'
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

	/* Every refinement resets the window: you are looking at a different list, from the top. */
	function pickArtist(artist: string) {
		pickedTag = null;
		pickedArtist = pickedArtist === artist ? null : artist;
		revealed = LIBRARY_PAGE;
	}
	function pickTag(tag: string) {
		pickedArtist = null;
		pickedTag = pickedTag === tag ? null : tag;
		revealed = LIBRARY_PAGE;
	}
	function pickSort(next: LibrarySort) {
		sort = next;
		revealed = LIBRARY_PAGE;
	}
	/** THE FIELD'S X, and its scope is the field. It used to be wired to `clearFilters` below, so an X drawn inside
	 *  a text input and named "Clear the filter" also un-pressed a chip in a separate, possibly COLLAPSED panel:
	 *  undoing a typo took the artist facet with it, so the count went from "1 of 135 songs" back to the whole
	 *  "135 songs" — `clearFilters` nulls both facets, which is right for its own caller. Same pending-timer
	 *  ordering and same focus return as `clearFilters`, because both of those are about the box. */
	function clearQuery() {
		clearTimeout(filterTimer);
		query = '';
		applyQuery('');
		queryEl?.focus();
	}
	/** EVERYTHING the rows are narrowed by — the zero-state's own control, where clearing the facet too is the point. */
	function clearFilters() {
		// The PENDING TIMER FIRST, or the keystroke that was still in flight re-applies the query 150ms after the
		// clear and the control reads as having undone itself.
		clearTimeout(filterTimer);
		query = '';
		applyQuery('');
		pickedArtist = null;
		pickedTag = null;
		queryEl?.focus();
	}

	function addSong(m: Media) {
		store?.addSong(m.id, rememberedKey(m.id));
		if (navigator.vibrate) navigator.vibrate(8);
		/* NO ACTION ON THE TOAST, and that is a fix rather than a trim. It read `View queue` and assigned `'/'` to
		   `window.location` — so it named the queue and landed on the SING tab, and it was the app's one direct
		   `window.location` write, and it is now gone from src/ entirely. Every other PROGRAMMATIC navigation there
		   goes through `goto` — the lone holdout is `JoinLanding`'s `location.reload()`, which re-enters the URL it is
		   already on rather than crossing to another — and the rest of them are real anchors. Driven in a browser:
		   clicking it recorded two main-frame navigations, a sentinel set on `window` beforehand was GONE afterwards,
		   and the URL came out as `/` — a full document replacement, so the socket closed, /api/library re-fetched and
		   the shell re-parsed to cross one tab. The dock carries a Queue tab on every surface now, so the destination
		   lives there permanently and this toast's one job is to say where the song went. */
		toast(`Added “${songDisplay(m).title}” to the queue`, { duration: 5000 });
	}
</script>

{#if me}
	<div class="library-page">
		<!-- NO BACK ARROW, because this is the Library TAB and not a push. The arrow it used to carry was a lie twice
			over: its accessible name sent you back to the QUEUE while its href pointed at `/`, the SING tab — the queue is its own
			route now. And a back arrow on a tab root is wrong in kind: tabs are siblings, so the dock is the way between
			them, and `PageHeader`'s own case for `back` (a home-screen install with no back gesture still has an in-app
			exit) is met three times over by the tab bar. `/queue` ships the same headerless-of-back header.
			MEASURED at 390x844 on this tree's 2-ready catalog: the pill goes 64px to 41px — the 44px icon box was
			setting its height — and every head element and every song row rises exactly 23px. The h1's leading edge
			goes x=86 to x=32, which is where `.field-slot` and every `.row` already start; with the arrow, the title
			was the only thing on the page beginning anywhere else.
			THE HEADER ITSELF STAYS, also measured: it costs 73px of 844 without the arrow against 96 with it, and 0
			buys nothing but a nameless page, since it holds the route's only h1 on a sticky surface. -->
		<PageHeader title="Your library" icon="library" />

		<main>
			<!-- A FILTER, not a search: same shape as the home field for consistency, but its own placeholder, and the
					count line below carries the actual distinction.
					GONE WHEN THERE ARE NO ROWS TO FILTER, because a filter over nothing is dead chrome — measured on a
					0-ready catalog at 390x844, the slot painted 102..172 directly above "No karaoke tracks yet", offering
					to narrow a list with no rows in it. That covers both row-less arms below: the proven-empty library and
					the FAILED fetch, which has no rows either and carries its own control. The `!libraryLoaded` arm keeps
					it mounted while the skeleton shows, so in the common case it is there from the first frame rather than
					appearing late.
					The div does NOT move out of its place in `main`'s flow: the --bp-lg arm puts `.field-slot` in
					grid-column 1, and library-wide-head.test.ts asserts that placement. -->
			{#if !libraryLoaded || library.length > 0}
				<div class="field-slot">
					<FindField
						bind:value={query}
						bind:element={queryEl}
						ariaLabel="Filter your library"
						placeholder="Filter your library…"
						clearable={boxHasText}
						clearLabel="Clear the filter"
						onclear={clearQuery}
						oninput={onQueryInput}
					/>
				</div>
			{/if}

			{#if !libraryLoaded}
				<SkeletonRows count={4} label="Loading your library…" />
			{:else if libraryFailed && library.length === 0}
				<!-- THE FETCH DIED, checked BEFORE the empty-library arm so its "No karaoke tracks yet" copy is
						unreachable on this path. One dropped request used to render that sentence over a 135-song library,
						with every control on the page gone and the dock simultaneously playing a track from the library the
						page called empty — and nothing re-asked, because the only fetch is `connect()`'s and that is
						idempotent, so it survived any number of tab round trips and needed a reload to clear.
						`library.length === 0` IS LOAD-BEARING, not redundant with the flag: `refreshLibrary()` also runs on
						every `media:status` ready event, and one of those failing must never replace a shelf of working rows
						with an error state. Description-only with a retry, which is the register `/`'s own search-failure
						arm uses — the same defect in the same shape one route over. -->
				<Empty.Root>
					<div class="lib-empty">
						<Empty.Header>
							<Empty.Description>Couldn't reach the server — your library didn't load.</Empty.Description>
						</Empty.Header>
						<Button variant="secondary" size="tap" onclick={() => void room.refreshLibrary()}>
							<Icon name="restart" /> Try again
						</Button>
					</div>
				</Empty.Root>
			{:else if library.length === 0}
				<!-- The genuinely empty library. The only useful instruction points at the SING tab, which is the one
						surface that can ADD a song — this page can only show what is already here. It used to say "Search
						from the queue screen", which named a surface that no longer exists under that name: `/` is the Sing
						tab and the queue is its own route, so neither half of that sentence was true.
						THE BUTTON STAYS, and it is checked against the sibling rather than assumed: `/queue`'s twin empty
						state also carries a `Find a song` control pointing at `/`, so deleting this one would be the two
						tabs disagreeing about whether an empty state offers an action. It also costs nothing either way —
						measured at 390x844 on a 0-ready catalog, `.lib-empty` is 337.6px tall (`min-height: 40vh`) with the
						button and 337.6px with it removed from the live DOM. And this is the state where the dock is THINNEST:
						with no ready song nothing can be playing, so the strip is absent and --dock-h measures 46px — the tab
						bar alone, a 0.75rem label at the far end of the screen, which is the least legible the way out ever
						gets. That is also why the description NAMES the tab in words instead of gesturing at it. -->
				<Empty.Root>
					<div class="lib-empty">
						<Empty.Header>
							<Empty.Title role="heading" aria-level={2}>No karaoke tracks yet</Empty.Title>
							<Empty.Description>Find a song on the Sing tab and we'll make the karaoke track.</Empty.Description>
						</Empty.Header>
						<Button variant="secondary" size="tap" href="/">
							<Icon name="search" /> Find a song
						</Button>
					</div>
				</Empty.Root>
			{:else}
				<!-- THE HEAD'S TRAILING HALF, and the wrapper earns its place at ONE width: from --bp-lg it is the second
						track of `main`'s row grid, beside the field, so the page's controls line up with the songs they
						filter instead of stacking above them. Below that it is `display: contents` and generates no box at
						all — no margin to collapse against, no grid item to place — so the head's y-positions on a phone and a
						tablet are what they were before this div existed: field 79..149, count 157..173, disclosure
						183..227, first row 227, at BOTH 390x844 and 768x900. (The y's are shared; the x's are not — the
						shell's gutter differs, so at 768 the count sits at x=40 against x=36 on the phone.) Those four
						readings were field 102..172, count 180..196, disclosure 206..250, first row 250 until the header
						lost its back arrow: a uniform 23px lift, which is what that 44px icon box was adding to the pill.
						Why a wrapper rather than placing the three children directly: they appear on three different
						conditions, and grid auto-placement fills whatever head cell is free — with `hasRefinements` false a
						SONG ROW would slide up beside the filter field. One box, one placement, no state to enumerate. -->
				<div class="lib-meta">
					<!-- ONE line, and it always states the total: "12 of 47" is what tells a guest this box hides rows rather
							than fetching them, which is the whole difference from the field on `/`. It is still the line that
							states it at every width — at --bp-lg it sits BESIDE the field rather than under it, which is the
							same visual row and the place a desktop toolbar puts a count. -->
					<p class="count" role="status" aria-live="polite">{countLabel}</p>

					<!-- COLLAPSED BY DEFAULT, and that is the page's main design decision. Expanded, the chip rows are
							~420px of chrome on a nine-song library — seven artists, six tags and three sorts, each with its own
							heading — which pushed the FIRST SONG ROW to about y=650 and left one row visible above the DOCK.
							That is the exact fault /library exists to fix, relocated. Scrolling songs is the default state; the
							refinements are one tap away. Measured at 390x844 with the payload in the note on `chips` below.
							STILL COLLAPSED at --bp-lg, and defaulting it OPEN there was considered and rejected on arithmetic. The
							wide arm does leave the expanded page better off — the panel spends the head's second track instead of
							a full-width row, which at 1440x900 moved the first expanded song row from 432 to 354, a pair both
							read while the header still carried its back arrow; today it reads 331, the same 23px lift the
							collapsed head took — but the
							TAP itself costs almost what it always did (174px of push against 182px; most of the 78px is the
							head's own lift, not the panel's placement), and the panel's height is unbounded in the direction that
							matters: this worktree's 2-song library opens to 174px (149..323) in that track, while
							FACET_CHIP_LIMIT allows twelve artist chips and twelve tag chips in one 500px track, and /library's
							`main` has only 736px between its own top (y=73) and the DOCK (y=809) at 900px tall. A default-open
							panel on a full library would put the first row back under the dock — the same fault, at a different
							width.
							AND 174 IS THE WIDE READING ONLY, which this note never said. The SAME panel at 390x844 measures
							202px (243..445), putting the first song row at y=453, because the phone's narrower track wraps the
							three sort chips and the two artist chips further than a 500px one does. The phone is the case the
							collapse is for, so it is the larger number that justifies it. -->
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
												onclick={() => pickSort(value)}
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
				</div>

				{#if rows.length}
					{#each view.shown as m (m.id)}
						<SongRow
							{...rowMeta(m)}
							readiness="ready"
							inQueue={inMyQueue(m.id)}
							onadd={store ? () => addSong(m) : undefined}
						/>
					{/each}
					<!-- A DOOR, not a cap: this page is where `See all` leads, so every matching song has to stay reachable —
							it just is not all in the DOM at once. 2000 rows cost 4.6s and 40,125 nodes before the first one was
							usable on a throttled 390x844 phone. The remaining count rides on the control so a guest can tell a
							paused list from a finished one; focus stays on it across the tap, so the changed label is what
							announces the reveal. -->
					{#if view.hidden > 0}
						<div class="reveal">
							<Button variant="secondary" size="tap" onclick={() => (revealed += LIBRARY_PAGE)}>
								Show {Math.min(LIBRARY_PAGE, view.hidden)} more <span class="chip-n">{view.hidden} left</span>
							</Button>
						</div>
					{/if}
				{:else}
					<!-- Filtered to nothing. Distinct from the empty library above, and it must offer the way out: the
							filter is the only reason these songs are hidden. -->
					<Empty.Root>
						<div class="lib-empty tight">
							<Empty.Header>
								<!-- ONE expression, no inline `{#if}` — see `emptyLabel`, which also carries the note on why the
										APPLIED query is the one quoted. Inline across two lines this sentence rendered with no space
										before the opening quote. -->
								<Empty.Description>{emptyLabel}</Empty.Description>
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
		/* Reserves the DOCK's measured height. No env() term here: `TabBar`, the bottom-most element in the dock, is the
		   one place that spends `env(safe-area-inset-bottom)`, and it reaches this column through --dock-h. The
		   declaration itself is left exactly as `/`, `/settings` and `/song/[mediaId]` spell it — changing the idiom on
		   one route would be the drift, and measured-join-gate.spec.ts pins the 28px term: its failure message quotes
		   this declaration's COMPUTED form, `6px 16px calc(var(--dock-h, 0px) + 28px)`, not the token spelling below. */
		padding: var(--space-xs) var(--space-2xl) calc(var(--dock-h, 0px) + 28px);
	}

	/* The ring belongs to the whole box, so app.css's per-input ring is suppressed. */

	/* The field's own box. A wrapper because a class handed to a component is stripped at the caller, and the spacing
	   below the field belongs to this page rather than to the control. */
	.field-slot {
		margin-bottom: var(--space-sm);
		/* THE PROSE MEASURE, exactly as `/`'s twin — this is the same control, and without the cap it is WIDER here:
		   the page measure is --measure-grid (the row column) and below --bp-lg this slot is a plain block inside it, so
		   the field spanned the whole column while `/`'s at least had a door and a picker taking their share. WHERE THE
		   CAP ACTUALLY BITES, measured in headless Chromium on this tree's library: 768x900, 696 -> 560 (and `/`'s twin
		   is still uncapped at 510 there); inert at 390x844, where the slot is 326. Both roles the token pair was minted
		   for appear on this page: --measure-grid bounds the rows, --measure-prose bounds the one thing on it that is
		   prose. Unconditional for the reason given on `/`: a max-width only ever takes space back, so this adds no
		   breakpoint. THE 768 READING IS A READING PLUS 4px, not a fresh read: `main`'s inline gutter came down one rung
		   (18 -> 16) when app.css retired `--space-3xl`, and this slot takes both sides of it.
		   FROM --bp-lg THE CAP IS INERT and the grid bounds the field instead — see the wide arm at the foot of this
		   block: track one is 500px against a 560px cap, so the field measures 500 at 1440x900 and its two edges land on
		   the first song row's two edges (212..712). Capped it was 212..772 — 60px PAST that row's trailing edge on one
		   side and 456px short of the column's on the other. */
		max-width: var(--measure-prose);
	}
	/* See the markup note for why this box exists. `display: contents` is the whole of it below --bp-lg: no box, no
	   margin, no grid item, so the count, the disclosure and the panel stay exactly where they were in `main`'s flow.
	   Verified rather than assumed — the collapsed head measures the same at 390x844 and 768x900 (field 79..149, count
	   157..173, disclosure 183..227, first row 227), and at 768x900 the expanded stack is panel 227..401 with the first
	   row at 409.
	   THAT PAIR USED TO BE QUOTED AS REPRODUCING THE PRE-WIDE-ARM 1440x900 STACK DIGIT FOR DIGIT (panel 250..424, first
	   row 432), and it no longer does — not because the wrapper changed, but because dropping the header's back arrow
	   lifted this whole column 23px while a historical reading cannot move. What the two stacks genuinely share, and
	   what the claim was really about, is the SHAPE: the panel is 174px tall in both and the first row follows 8px
	   under it. The absolute y's were a coincidence of header height, which is exactly the kind of number that goes
	   false without anyone touching the rule it describes. */
	.lib-meta {
		display: contents;
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
	/* THE NESTED REGISTER. These three groupheads are not page sections — they are chip groups inside one
	   disclosure, a nesting level deeper than `/`'s sections, so they take the inter-group rung that app.css's base
	   rule no longer carries. Not cosmetic: this panel's height is the documented reason it is collapsed by default
	   (see the note on the reveal button — ~420px of chrome put the first song row near y=650), and unpinned the
	   section rung measured 16px taller on this panel — 8px at each of its two INTERNAL group boundaries, the first
	   heading's margin collapsing out of this borderless, paddingless box rather than adding a third. This page has
	   no grouphead outside `.refine`, so the override costs the rest of it nothing and /library's geometry is
	   unchanged by the new rung. */
	.refine .grouphead {
		margin-top: var(--space-2xl);
	}
	/* WRAPS rather than scrolls horizontally: a scroller hides its own overflow, and these are the page's only
	   navigation. Wrapping is also WHY the panel is collapsed by default — nine songs across seven artists and six
	   tags wrapped to ~420px and put the first row at y=650 on a 390x844 phone. The count cap lives in
	   library-browse.ts, so this rule never has to know how many there are. BOTH FIGURES HERE PREDATE A CHIP NARROWING: the `tap` size's inline inset came down 14 -> 12 when app.css retired `--space-xl`, so each chip is 4px narrower and the wrap points can only move in the direction that makes this panel SHORTER — the reason it is collapsed by default stands, the two numbers are an upper bound now. */
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

	/* The reveal control's own box, for the same reason `.field-slot` exists: spacing below the last row belongs to the
	   page, not to a shared button. */
	.reveal {
		display: flex;
		justify-content: center;
		margin-top: var(--space-md);
	}

	/* FLEX COLUMN, not grid + place-items: the vendored `Empty.Header` is `display: contents`, so its children become
	   direct children of this box and grid would split the min-height between them. See `.idle` on `/`. */
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
			gap: 0 var(--space-2xl);
			align-content: start;
		}
		main > :global(*) {
			grid-column: 1 / -1;
		}
		main > :global(.row) {
			grid-column: auto;
		}
	}

	/* THE WIDE HEAD ADOPTS THE ROW GRID. 1200 is --bp-lg, and it is the width where `main` first has two tracks: at and
	   above it --max-w is 1080, which less the shell's two 16px gutters and this page's own two leaves a 1016px column,
	   and 1016 is 500 + --space-2xl + 500. The head ignored those tracks. Measured in headless Chromium at 1440x900 on
	   this worktree's library — 2 STEM-READY SONGS, which is the figure that matters and the one this block's geometry
	   is read against; the catalog's total is deliberately not quoted, because it accumulates every search result ever
	   materialised and drifts whenever a benchmark runs — BEFORE this arm: the filter field painted 560px at x=212
	   inside a column ending at 1228, so 456px of the column trailed it empty, and the count and the disclosure
	   stacked beneath it in their own full-width rows with the first song row at y=250.
	   AFTER: the field is track one and the count + disclosure + panel are track two, so both halves of the head land on
	   the song rows below them — field 212..712 over the first row's 212..712, the disclosure at 728 on the second row's
	   leading edge, the count 4px inboard of it at 732 because it keeps its own --space-2xs inline margin (the
	   `.grouphead` idiom) — and the first song row is at y=180. The width that is still unspent is a grid track holding
	   a control, not a field abandoned mid-column. Expanded, the panel fills that track: 728..1228, 500px wide, and the
	   first song row sits at 354 where it used to sit at 432. THE TAP is not what got cheaper — opening still pushes the
	   rows 174px against the old 182px — the HEAD did: 70 of that 78px is the collapsed lift and 8 is the placement.
	   THE TRADE, stated because one number goes the other way: the last row's bottom comes up from 344.4 to 274.4, so on
	   a 2-ready library the gap between it and the DOCK GROWS, 464.6 -> 534.6. Neither figure is copied: the dock's top
	   is 809 at every viewport 900px tall, 809 - 344.4 = 464.6 where 344.4 is the pre-arm last-row bottom (its measured
	   first-row top 250 plus the measured 94.4px row height), and 809 - 274.4 = 534.6 after. That gap is content-bound
	   at this corpus (see docs/FRONTEND.md#the-library-page) — two rows cannot fill the 736px between this page's `main`
	   at y=73 and the dock at y=809, however they are placed — while the 70px lift is worth a row on the corpus this
	   page is for.
	   EVERY y ABOVE IS AN ARROW-ERA READING, kept because it is the only way to state what this arm did and the pre-arm
	   layout is no longer reproducible. The head then lost the header's back arrow and the whole column rose 23px, so
	   TODAY the same 1440x900 drive reads: `main` 73, field 79..149 at 212..712, count left 732 at 79..95, disclosure
	   left 728 at 105..149, the two rows 157..251.4 side by side at 212..712 and 728..1228, the panel 149..323, the
	   first expanded row 331 — and 809 - 251.4 = 557.6px of gap to the dock. Everything this arm is actually ABOUT is
	   unmoved by that: the field is still 500 at 212..712 over the first row's own 212..712, the disclosure still at
	   728, the count still 4px inboard at 732, the panel still 500 wide at 728..1228 and still 174px tall.
	   `align-items: flex-start` so the disclosure keeps its own width (a 500px-wide eyebrow would be a hit area three
	   times its ink); `.refine` takes the track back, so its chips wrap at 500 and not at the widest chip. */
	@media (min-width: 1200px) {
		.field-slot {
			grid-column: 1;
			grid-row: 1;
			/* HUGS ITS CONTROL. A grid item stretches by default, and with the panel open this cell is as tall as the
			   chips beside it: without this line the slot measured 102..346 around a 70px field. Nothing paints on this
			   box today, so the stretch was invisible; `start` keeps it that way if anything ever does. */
			align-self: start;
		}
		.lib-meta {
			display: flex;
			flex-direction: column;
			align-items: flex-start;
			grid-column: 2;
			grid-row: 1;
		}
		.lib-meta .refine {
			align-self: stretch;
		}
	}

	@media (max-height: 480px) {
		/* BOTH selectors in ONE rule, and `.refine .grouphead` has to be named here: it is 0,3,0 against this arm's
		   0,2,0, so without it the nested pin out-cascades the landscape claw-back and silently holds 16px in the
		   case this arm exists to reclaim. */
		.grouphead,
		.refine .grouphead {
			margin: var(--space-sm) var(--space-2xs) var(--space-2xs);
		}
	}
</style>
