<script lang="ts">
	import { onMount } from 'svelte';
	import type { QueueEntry, Media, PublicSinger } from '$lib/contract';
	import type { QueueStore } from '$lib/stores/queue';
	import { room } from '$lib/stores/room';
	import JoinLanding from '$lib/components/JoinLanding.svelte';
	import SongRow from '$lib/components/SongRow.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import {
		displayReadiness,
		canProcess,
		noRowsState,
		showsNoRows,
		processingGroupIds,
		type Readiness
	} from '$lib/readiness';
	import { processAndQueue } from '$lib/process-and-queue';
	import { originalKeyLabel, isProcessableSource } from '$lib/contract';
	import type { MediaStatus } from '$lib/contract';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import SkeletonRows from '$lib/ui/SkeletonRows.svelte';
	import FindField from '$lib/ui/FindField.svelte';
	import { LIBRARY_PAGE, libraryWindow } from '$lib/library-browse';
	import * as NativeSelect from '$lib/components/ui/native-select';
	import * as Empty from '$lib/components/ui/empty';

	let me = $state<PublicSinger | null>(null);
	let entries = $state<QueueEntry[]>([]);
	let mediaCatalog = $state<Map<string, Media>>(new Map());
	// Seeded from /api/library as well as media:status, so a reload mid-process keeps its progress bar.
	let mediaStatus = $state<Map<string, { status: MediaStatus; pct: number; etaSec?: number }>>(new Map());

	/* THE SING TAB. One job — find a song and put it in the rotation — and exactly two states, with `searchActive`
	   (a non-empty query) as the sole switch between them: a query shows its result groups, no query shows the idle
	   state that points back at the field. The queue and the library used to be branches of this same page; they are
	   TABS now (see docs/FRONTEND.md#the-three-tabs), which is what that branch had always been.
	   The standing route to /library is the TabBar, not this page: the one link to it left here is inside the
	   search-found-nothing state, where the library count is news. */

	// Mirrored from the room link, not owned here. Optional because an unjoined guest has no queue at all, which
	// is what every `store?.` call site below reads.
	let store = $state<QueueStore | undefined>(undefined);

	function mediaTitle(id: string): string {
		const m = mediaCatalog.get(id);
		return m ? `${m.title}${m.artist ? ' — ' + m.artist : ''}` : id;
	}
	/* `sync()` runs ONCE before subscribing: the link is a singleton that outlives this component, so on a return
	   to `/` it is already live and subscribing alone renders an empty queue until the room happens to speak. */
	onMount(() => {
		const sync = () => {
			me = room.me;
			mediaCatalog = room.mediaCatalog;
			mediaStatus = room.mediaStatus;
			entries = room.entries;
			library = room.library;
			libraryTags = room.libraryTags;
			store = room.queue;
		};
		sync();
		const stopMirror = room.subscribe(sync);
		// The link holds no opinion about how a failure is shown, so the toast stays a route decision.
		const stopErrors = room.onError((message) => showError(message));
		void room.connect();
		return () => {
			stopMirror();
			stopErrors();
			/* THE SEARCH DEBOUNCE DIES WITH THE TAB. 150 ms is easy to leave inside — typing, then thumbing the
			   Queue or Library tab — and an uncleared timer fires `/api/search` from a component that is already
			   gone: measured at one full abandoned request per mid-debounce departure. That is a resolver fan-out
			   (`?source=all` spawns a yt-dlp subprocess, median 1628 ms against ytmusic's 459 ms) which also
			   MATERIALIZES AND PERSISTS every hit, for rows no longer mounted to render them. Aborting `inflight`
			   drops the one already in the air for the same reason; /api/search does not read `request.signal`, so
			   that half reclaims the client only. */
			clearTimeout(debounceTimer);
			inflight?.abort();
		};
	});

	const queued = $derived(entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq));

	function liveOf(id: string) {
		return mediaStatus.get(id);
	}

	/* An empty box IS the library, so typing filters the world rather than revealing it. NOT a shelf any more and not
	   a row on this tab: `library` survives for two readers only — `library.length` is what `noRowsState` needs to
	   decide whether there is anything to go back TO, and `libraryTags` labels a result row that is already yours.
	   The shelf itself is /library. */
	let library = $state<Media[]>([]);
	let libraryTags = $state<Record<string, string[]>>({});
	let queryEl = $state<HTMLInputElement | null>(null);
	/* WHERE to search. `music` is the DEFAULT and sends no `source` param at all, which the route reads as
	   its default set: the YouTube Music catalog, local files, and Spotify metadata — everything except
	   plain all-of-YouTube ytsearch, whose hits are lyric reuploads and hour loops credited to a channel
	   rather than a performer. `everything` adds ytsearch back for an upload no catalog lists.
	   The spelling matters: `music` is NOT `?source=ytmusic`, because narrowing to one source would drop
	   the user's own local files, which live in a separate disk-scan index rather than the catalog. */
	let searchSource = $state<'music' | 'everything' | 'youtube' | 'local'>('music');
	let query = $state('');
	let readyResults = $state<Media[]>([]);
	let rawResults = $state<Media[]>([]);
	let processingResults = $state<Media[]>([]);
	let searching = $state(false);
	/* A FAILED SEARCH IS A THIRD STATE, not an empty one. Without this the catch below wiped the rows and the
	   zero-state then asserted `Nothing matches "<query>"` — the review's only blocks-the-party finding. Reset
	   wherever a new attempt begins, so the failure cannot outlive the query it belongs to. */
	let searchFailed = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let inflight: AbortController | undefined;
	const searchActive = $derived(query.trim().length > 0);

	/* HOW MUCH OF EACH GROUP IS IN THE DOM. One counter per group, because the three answer different questions and
	   a shared counter would let a long `Needs karaoke` tail decide how many READY songs you can see.
	   THE SERVER IS UNCHANGED and so is the wire: /api/search still answers with every hit, and nothing here is a
	   cap — the reveal control is a DOOR, exactly as /library's note says of the same arithmetic. The payload is a
	   separate decision for the owner (see proposedNotImplemented in this group's report).
	   WHY: `partitionSearch`'s catalog arm walks the WHOLE persisted catalog with no limit (only the resolvers are
	   bounded, at PER_SOURCE_LIMIT = 12), and /api/search MATERIALISES AND PERSISTS every hit, so this column is
	   sized by the install's lifetime catalog rather than by the query.
	   MEASURED AT 390x844 AGAINST THE SAME SERVER, windowed and un-windowed. EVERY READING HERE DRIFTS A LITTLE
	   between runs, and that drift is the defect talking: /api/search persists what it resolves, so this copy's
	   catalog gained rows while it was being measured — it is past 3,700 now. Figures are one session's pair.
	   `q=a`: 3,412 rows / 56,260 DOM nodes / 320,120px of scroll / 1,235ms for the first `+` to read `queued`, with
	   `Not it? Search everything` at y=319,949 — 379 viewports down — became 120 rows / ~2,030 nodes / ~12,500px /
	   53ms, with the widen at y≈12,350. `queen` went 294 rows / 5,054 nodes / 94ms to 61 / 1,164 / 43ms.
	   `wonderwall` is 68 rows and UNCHANGED at 1,230 nodes and 7,280px — under one page per group, so no door paints
	   and nothing moves. That 68-row query confirming its tap in 47ms against the 3,412-row query's 1,235ms on the
	   same server is what makes that second the column's render cost rather than the queue round-trip.
	   LIBRARY_PAGE (60) is reused rather than re-chosen: /library measured it, and two surfaces windowing the same
	   way is one rule a guest learns once. */
	let revealedProcessing = $state(LIBRARY_PAGE);
	let revealedReady = $state(LIBRARY_PAGE);
	let revealedRaw = $state(LIBRARY_PAGE);

	/* ALL THREE GROUPS TOGETHER, in one place: each is scoped to the query that produced it, so a group left behind
	   renders under whatever the box shows next. Dropping them one site at a time is how `processingResults` was
	   forgotten on the failure path. */
	function clearResults() {
		readyResults = [];
		rawResults = [];
		processingResults = [];
		/* THE WINDOWS RESET WITH THE ROWS, and only here — the rule /library's own `applyQuery` states. This is the
		   one seam where all three groups are already dropped, so a guest who revealed 180 rows never watches them
		   collapse on a keystroke that has not resolved into an answer yet; they collapse with the rows they belong
		   to. Resetting on input instead would also hand the next query a DOM the previous one grew. */
		revealedProcessing = LIBRARY_PAGE;
		revealedReady = LIBRARY_PAGE;
		revealedRaw = LIBRARY_PAGE;
	}

	function onQueryInput() {
		clearTimeout(debounceTimer);
		const q = query.trim();
		if (!q) {
			clearResults();
			searching = false;
			inflight?.abort();
			return;
		}
		debounceTimer = setTimeout(() => runSearch(q), 150);
	}

	function onSourceChange() {
		// The pending keystroke's timer is cancelled first, or one source change fires two full searches:
		// this one now, and the debounced one 150 ms later — two resolver fan-outs for one query.
		clearTimeout(debounceTimer);
		const q = query.trim();
		if (q) runSearch(q);
	}

	/* One tap from the narrowed default to the full fan-out, re-running the query it is already holding.
	   Offered beside results, not only when there are none — see the note at its render site. */
	function widenSearch() {
		searchSource = 'everything';
		onSourceChange();
	}

	/** Empties the box, which lands on the idle state. Called by the field's own `×`. */
	function clearSearch() {
		query = '';
		onQueryInput();
		queryEl?.focus();
		if (navigator.vibrate) navigator.vibrate(8);
	}

	async function runSearch(q: string) {
		inflight?.abort();
		const ctrl = new AbortController();
		inflight = ctrl;
		searching = true;
		/* THE PREVIOUS QUERY'S ROWS GO NOW, not when the next answer lands. `onQueryInput` only clears on an
		   EMPTIED box, so refining "bohemian" to "bohemian rhapsody" left ten rows from the first query on
		   screen under the second query's text — and any zero-state beneath them was then describing a
		   different search than the rows above it. The `Searching…` skeleton is what belongs here, and it
		   already has a gate waiting for exactly this state. */
		clearResults();
		searchFailed = false;
		try {
			// `music` is the route's own default, so it sends nothing — one spelling of the default, on the
			// server, instead of two that can drift.
			const source = searchSource === 'music' ? '' : `&source=${searchSource === 'everything' ? 'all' : searchSource}`;
			const res = await fetch(`/api/search?q=${encodeURIComponent(q)}${source}`, { signal: ctrl.signal });
			if (ctrl.signal.aborted) return;
			// A 500 whose body happens to be JSON parsed cleanly into `{}`, so every group came back empty
			// and the failure rendered as "nothing matched" — a broken server looking like a missing song.
			if (!res.ok) throw new Error(`search failed: ${res.status}`);
			const j = await res.json();
			// RECHECKED AFTER THE BODY PARSE, not only after the fetch: `await res.json()` is a second
			// suspension point, and an abort landing inside it would otherwise let a superseded query
			// assign its rows over the live one.
			if (ctrl.signal.aborted) return;
			readyResults = j.ready ?? [];
			rawResults = j.results ?? [];
			processingResults = j.processing ?? [];
			room.mergeMedia([...readyResults, ...rawResults, ...processingResults]);
			/* ANNOUNCED, because the results REPLACE the idle state and a guest using a screen reader otherwise
			   types, waits, and hears nothing at all: the `Searching…` skeleton's `role="status"` is
			   conditionally INSERTED, and an element that appears already carrying its text does not announce.
			   `/library` has had the pattern since it shipped (`<p class="count" role="status">`). The region
			   below is `aria-atomic`, so a fast typist's superseded searches replace rather than queue.
			   SC 4.1.3's own understanding document uses "search returned N results" as its example. */
			const found = readyResults.length + rawResults.length + processingResults.length;
			liveMsg =
				found === 0
					? `No songs found for ${q}`
					: `${found} song${found === 1 ? '' : 's'} found for ${q} — ${readyResults.length} ready to sing`;
		} catch (e) {
			if ((e as Error).name !== 'AbortError') {
				/* `clearResults()` STAYS. Keeping the previous query's rows was considered and is worse — it puts
				   "bohemian"'s ten rows under a box reading "bohemian rhapsody", which is the documented reason
				   clearResults runs at the TOP of this function. The fix is the `searchFailed` term, which stops the
				   empty result set being READ as "nothing matched". */
				clearResults();
				searchFailed = true;
				showError("Couldn't reach the server.");
				// The toast is visual only, and it is also 4 seconds against a permanent screen. Both audiences now
				// get the same sentence, where the pill said "Reconnecting…" and the copy said "Nothing matches".
				liveMsg = "Couldn't reach the server — your search didn't run.";
			}
		} finally {
			if (inflight === ctrl) searching = false;
		}
	}

	function readinessFor(m: Media): Readiness {
		return displayReadiness(m, liveOf(m.id));
	}
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
	function inMyQueue(mediaId: string): boolean {
		return queued.some((e) => e.mediaId === mediaId && e.singerId === me?.id);
	}

	/* THE PROCESSING GROUP IS SEARCH FEEDBACK, which is why this returns nothing without a query. With one, the
	   server has already scoped `j.processing` to that query, so each row is a RESULT — the row that tells a guest
	   "this one is already being made" and stops a second tap on the app's one compound action.
	   WITHOUT a query there is no group at all, and this guard is the whole reason `processingGroupIds` no longer
	   takes a catalog: the union it used to build without a query is a statement about the LIBRARY rather than about
	   anything on this tab — and /queue now draws every queued song that is still cooking. `processAndQueue` always
	   adds the turn alongside the process, so a processing song is in practice always a queued song and /queue is
	   where it belongs. What that trades away, recorded because it is real: a media processing with NO queue entry
	   (an admin-side process, or an entry removed mid-cook) is now visible only while a query matches it, because
	   /library serves `listReady()` and paints every row ready. */
	const processingRows = $derived.by(() => {
		if (!searchActive) return [];
		// The catalog copy is what gets rendered, not the wire row: `room.mergeMedia` has already folded the
		// search answer into it, so a later refresh of the same media reaches the row through this lookup.
		const ids = processingGroupIds(processingResults);
		return [...ids]
			.map((id) => ({ id, media: mediaCatalog.get(id), live: liveOf(id) }))
			.filter((r) => r.media)
			.map((r) => ({
				id: r.id,
				media: r.media!,
				pct: r.live?.pct ?? 0,
				etaSec: r.live?.etaSec,
				status: r.live?.status
			}));
	});

	/** Ids another group already shows, so no song appears twice and no job draws two progress bars. BOTH `ids.add` loops
	 * are required: the de-duplication has to cover the ready group AND the processing rows, which are separate lists on
	 * the wire. It stays a plain accumulator, and the `svelte/prefer-svelte-reactivity` warning it raises stays with it —
	 * a `SvelteSet` is the wrong answer for a value recomputed wholesale, where reactive sources buy nothing. */
	const accountedFor = $derived.by(() => {
		const ids = new Set<string>();
		for (const m of readyResults) ids.add(m.id);
		for (const c of processingRows) ids.add(c.id);
		return ids;
	});
	function unaccounted(list: Media[]): Media[] {
		return list.filter((m) => !accountedFor.has(m.id));
	}
	/* HOISTED OUT OF THE TEMPLATE. It was an `{@const}` inside the `{#if searchActive}` block with three readers
	   (the group, the widen gate and `showsNoRows`); the window below is a fourth, and an `{@const}` cannot be read
	   by the script. */
	const rawRows = $derived(unaccounted(rawResults));

	/* WHAT IS RENDERED, against what the reveal control still has behind it. DE-DUPLICATION AND THE ZERO-STATE READ
	   THE FULL LISTS, not these: `accountedFor`/`unaccounted` decide which group OWNS a song, and `showsNoRows`
	   decides whether the search found anything at all — both would start answering about the WINDOW if they read
	   `.shown`, so a 200-row answer whose first 60 happened to be ready would print "Nothing matches". */
	const processingView = $derived(libraryWindow(processingRows, revealedProcessing));
	const readyView = $derived(libraryWindow(readyResults, revealedReady));
	const rawView = $derived(libraryWindow(rawRows, revealedRaw));

	function addSong(mediaId: string) {
		store?.addSong(mediaId);
		/* SAID HERE, because the row that confirms an add is on ANOTHER TAB now. The queue's announcer
		   ($lib/phrasing/queue-announcement, which /queue drives) is deliberately silent about my own adds — "the row
		   appearing is its own confirmation" — and no row appears on this screen at all, so a screen-reader guest
		   adding three songs off one search heard three silences. Assigned directly rather than routed through that
		   function: its whole job is the diff that suppresses news I caused, and this is news I caused and want. */
		liveMsg = `Added ${mediaTitle(mediaId)} to the queue`;
		if (navigator.vibrate) navigator.vibrate(8);
	}
	function singThis(mediaId: string) {
		processAndQueue({
			queue: () => addSong(mediaId),
			process: () => void processMedia(mediaId),
			hasQueuedTurn: inMyQueue(mediaId)
		});
	}
	/** Request stem-separation ("make karaoke"). The live media:status broadcasts drive the row's bar.
	 *
	 * THE REQUEST ITSELF MOVED TO `RoomLink.requestProcess`, where /queue's stalled-card retry can reach it: the
	 * optimistic set, the rollback-the-mark-not-the-turn rule and the refusal notice are the correctness of that
	 * call, and a second copy of the three is how they drift. What stays here is the haptic, which is a DOM read
	 * the link may not make, and the refusal still lands on this page's toast through `room.onError` above. */
	async function processMedia(mediaId: string) {
		if (navigator.vibrate) navigator.vibrate(12);
		await room.requestProcess(mediaId);
	}

	function showError(msg: string) {
		toast.error(msg, { duration: 4000 });
	}

	/* The polite region for everything this tab says that is not a row: the search result count, an add, and a
	   search failure. `aria-atomic`, so a fast typist's superseded searches replace rather than queue. */
	let liveMsg = $state('');
</script>

<!-- Joined singers only: unjoined, JoinLanding paints its own brand, so both would say "Encore" twice. -->
{#if me}
	<header class="topbar">
		<h1 class="brand"><Icon name="mic" /> <span class="grad-text">Encore</span></h1>
		<!-- THE OFFLINE PILL MOVED TO THE DOCK. It lived here, in a deliberately non-sticky topbar, where it measured
			`top: -2420px, inViewport: false` on a 59-row list — in the DOM and 2.4k pixels above the fold. The dock is
			fixed and on every surface, so the cue is now visible at every scroll position on every route, and `/queue`
			and `/library` gain one they never had. See the banner at `.offline-bar` in +layout.svelte. -->
		{#if me}
			<div class="me-cluster">
				<div class="me-slot">
					<Button variant="identity" href="/settings/you" aria-label="Your profile">
						<span class="me-name">{me.displayName}</span>
						<span class="me-dot" style="--singer:{me.color};"></span>
					</Button>
				</div>
				<!-- `size="icon"` IS the 44px target; do not shrink it back to a bare glyph. -->
				<div class="gear-slot">
					<Button variant="ghost" size="icon" href="/settings" aria-label="Settings" title="Settings">
						<Icon name="gear" />
					</Button>
				</div>
			</div>
		{/if}
	</header>
{/if}

<main>
	{#if me}
		<!-- The field is the FIRST thing on the screen, and not sticky — see the `.findbox` rule for why. A CLUSTER OF
				TWO: the box and the scope it searches. The library door that used to sit on the field's leading edge is
				gone with the shelf it labelled — the TabBar's Library tab sits in the fixed dock at the foot of every phone
				surface, so a second route to the same page from the same screen was one count of the library too
				many. -->
		<div class="find-row">
			<div class="field-slot">
				<FindField
					bind:value={query}
					bind:element={queryEl}
					ariaLabel="Search a song or artist"
					placeholder="Search a song or artist…"
					busy={searching}
					clearable={searchActive}
					clearLabel="Clear the search"
					onclear={clearSearch}
					oninput={onQueryInput}
				/>
			</div>
			<div class="source-slot">
				<NativeSelect.Root
					aria-label="Where to search"
					title="Where to search"
					bind:value={searchSource}
					onchange={onSourceChange}
				>
					<NativeSelect.Option value="music">Music</NativeSelect.Option>
					<NativeSelect.Option value="everything">Everything</NativeSelect.Option>
					<NativeSelect.Option value="youtube">YouTube</NativeSelect.Option>
					<NativeSelect.Option value="local">Library</NativeSelect.Option>
				</NativeSelect.Root>
			</div>
		</div>

		<!-- TWO STATES, AND THE STRUCTURE SAYS SO: a query, or no query. This used to be a four-term boolean naming
				the queue, the library shelf and the processing group, three things that are no longer on this tab. -->
		{#if searchActive}
			{#if searching && rawResults.length === 0 && readyResults.length === 0}
				<SkeletonRows label="Searching…" />
			{/if}

			<!-- Search-scoped, and ABOVE `Ready to sing` where it has always been: a song already being made is the
					answer to the query the guest just typed, so it belongs with the answers. See `processingRows`. -->
			{#if processingRows.length}
				<h2 class="grouphead">Making karaoke…</h2>
				{#each processingView.shown as c (c.id)}
					{@const r = displayReadiness(c.media, liveOf(c.id))}
					<SongRow
						{...rowMeta(c.media)}
						readiness={r}
						pct={c.pct}
						status={c.status}
						inQueue={inMyQueue(c.id)}
						processable={isProcessableSource(c.media.source)}
						onadd={() => addSong(c.id)}
						onmake={canProcess(c.media, r) ? () => singThis(c.id) : undefined}
					/>
				{/each}
				<!-- WINDOWED FOR UNIFORMITY, and in practice this control never paints: a query matches 0-3 songs that
						are being made right now, so `hidden` is 0 and the control is gone. Three groups that window the
						same way is one rule; one group that silently does not is a bug waiting for the night somebody
						queues sixty songs at once. -->
				{#if processingView.hidden > 0}
					<div class="reveal">
						<Button variant="secondary" size="tap" onclick={() => (revealedProcessing += LIBRARY_PAGE)}>
							Show {Math.min(LIBRARY_PAGE, processingView.hidden)} more
							<span class="chip-n">{processingView.hidden} left</span>
						</Button>
					</div>
				{/if}
			{/if}

			<!-- Every heading here is gated on having rows: a group heading is a claim about what follows it. -->
			{#if readyResults.length}
				<h2 class="grouphead">Ready to sing</h2>
				{#each readyView.shown as m (m.id)}
					<SongRow {...rowMeta(m)} readiness="ready" inQueue={inMyQueue(m.id)} onadd={() => addSong(m.id)} />
				{/each}
				<!-- The same door /library ships, down to the copy: the remaining count rides ON the control so a
						paused list is distinguishable from a finished one, and focus stays on it across the tap, so the
						changed label is what announces the reveal. -->
				{#if readyView.hidden > 0}
					<div class="reveal">
						<Button variant="secondary" size="tap" onclick={() => (revealedReady += LIBRARY_PAGE)}>
							Show {Math.min(LIBRARY_PAGE, readyView.hidden)} more
							<span class="chip-n">{readyView.hidden} left</span>
						</Button>
					</div>
				{/if}
			{/if}

			{#if rawRows.length}
				<h2 class="grouphead">Needs karaoke</h2>
				{#each rawView.shown as m (m.id)}
					{@const r = readinessFor(m)}
					<SongRow
						{...rowMeta(m)}
						readiness={r}
						pct={liveOf(m.id)?.pct ?? 0}
						status={liveOf(m.id)?.status}
						inQueue={inMyQueue(m.id)}
						processable={isProcessableSource(m.source)}
						onadd={() => addSong(m.id)}
						onmake={canProcess(m, r) ? () => singThis(m.id) : undefined}
					/>
				{/each}
				<!-- THE LONGEST TAIL ON THE TAB, and the one the window was really written for: on `q=a` this control
						reads "Show 60 more" against a four-figure remaining count — ~3,300 on the shared copy when
						this was last measured, and climbing session to session for the reason the note on the
						`revealed*` counters gives — and every one of those rows used to be in the DOM. -->

				{#if rawView.hidden > 0}
					<div class="reveal">
						<Button variant="secondary" size="tap" onclick={() => (revealedRaw += LIBRARY_PAGE)}>
							Show {Math.min(LIBRARY_PAGE, rawView.hidden)} more
							<span class="chip-n">{rawView.hidden} left</span>
						</Button>
					</div>
				{/if}
			{/if}

			<!-- ONE zero-state, and only when the search found NOTHING AT ALL. It used to be two blocks, and
				 the second was gated on `!readyResults.length` alone — so a query that returned twelve
				 singable-but-unprocessed songs printed "Nothing matches “…”" underneath them, contradicting
				 the rows on screen (reported from a screenshot). Nothing-ready is not nothing-found: the
				 "Needs karaoke" group is the normal, expected result for a song nobody has processed yet.
				 The two blocks also both fired when the query truly matched nothing, stacking two empty
				 states. Whatever renders here must therefore be gated on EVERY group being empty. -->
			<!-- THE ESCAPE HATCH IS NOT GATED ON AN EMPTY RESULT, and that is a measured requirement rather
					 than caution. YouTube Music's `songs` filter NEVER returns nothing: probed live, the nonsense
					 query `zzzzzzznotasongzzzzzz` answers with "A Million Laughing Emoji's" and friends, and
					 `asdkjhqwe zxcvbnm nonsense query 12345` answers with Mariah Carey. So a widen offered only
					 inside the zero-state would be unreachable exactly when it is needed — the default returns
					 twelve confident wrong rows and no hint that a wider net exists. It sits after the rows, low
					 in the column, because most searches do not need it. -->
			{#if !searching && searchSource === 'music' && (rawRows.length || readyResults.length)}
				<div class="showall-row">
					<Button variant="secondary" size="tap" onclick={widenSearch}>
						<Icon name="search" /> Not it? Search everything
					</Button>
				</div>
			{/if}

			<!-- THE FAILURE STATE, checked BEFORE the no-rows state so the "nothing matched" copy and its /library
					link are unreachable on this path. A retry rather than a bare apology: the query is still in the box,
					so re-running it is one tap and needs no retyping. -->
			{#if searchFailed}
				<Empty.Root>
					<Empty.Header>
						<Empty.Description>Couldn't reach the server — your search didn't run.</Empty.Description>
					</Empty.Header>
					<div class="showall-row">
						<Button variant="secondary" size="tap" onclick={() => runSearch(query.trim())}>
							<Icon name="restart" /> Try again
						</Button>
					</div>
				</Empty.Root>
			{:else if showsNoRows( { searching, failed: searchFailed, readyCount: readyResults.length, rawCount: rawRows.length, processingCount: processingRows.length } )}
				{@const empty = noRowsState({ searchActive, libraryCount: library.length, query })}
				<Empty.Root>
					<Empty.Header>
						<Empty.Description>{empty.message}</Empty.Description>
					</Empty.Header>
				</Empty.Root>
				<!-- A LINK TO /library, not a `clearSearch()`. It used to clear the query, which restored a visible
						library in place; clearing now lands on the idle state, which shows no songs — so the label would
						have promised what the tap does not deliver. `showAllCount` is non-null only when the library has
						rows ("only promise the way back when there is something to go back TO"), and it is PRINTED here:
						the count is the only thing that makes this an offer rather than a direction, and it is the one
						moment on this tab where "you already own N songs" is both news and actionable.
						THE NOUN AGREES, and one-ready is not an edge case: it is the ordinary state the first time a song
						finishes processing, and it printed "Show my 1 songs" until this agreement was added — contradicting
						/library's own count line, which already reads "1 song", two taps away from this control. -->
				{#if empty.showAllCount !== null}
					<div class="showall-row">
						<Button variant="secondary" size="tap" href="/library">
							<Icon name="library" /> Show my {empty.showAllCount}
							{empty.showAllCount === 1 ? 'song' : 'songs'}
						</Button>
					</div>
				{/if}
			{/if}
		{:else}
			<!-- THE IDLE STATE, which is the whole screen with an empty box. It says what this TAB is for: the title
					used to read "Nothing queued yet", which is false here (the queue is another tab) and is word for word
					/queue's own idle headline. -->
			<Empty.Root>
				<div class="idle">
					<!-- A MARK, and it is not decoration: this block is the whole screen, and a lone sentence in a void reads
							as a page that failed to load rather than as a state someone designed. `aria-hidden` because the
							title beside it already says this in words. -->
					<span class="empty-mark" aria-hidden="true"><Icon name="mic" /></span>
					<Empty.Header>
						<!-- `Empty.Title` renders a <div>, so a zero-state's headline carried no heading SEMANTICS — and this
							 state REPLACES every `<h2 class="grouphead">` on the tab, so with an empty box the only heading in
							 the whole document was the wordmark. A guest cycling headings to orient learned nothing about what
							 the app is. Added at the call site, not by re-vendoring, which is the precedent /settings set for
							 `Card.Title` at its ten `role="heading" aria-level={2}` call sites, recorded in the comment above
							 that page's `PageHeader` (named, not line-numbered). -->
						<Empty.Title role="heading" aria-level={2}>What do you want to sing?</Empty.Title>
						<Empty.Description>Find any song and we'll make the karaoke track for it.</Empty.Description>
					</Empty.Header>
					<!-- THE ACTION, IN THE STATE. It used to say "Search above", which makes a guest look away from the sentence
							they are reading to find an unlabelled field — and on a phone the field needs a tap to raise the keyboard
							anyway, which is exactly what this does. Not an `href`: the destination is a control on this same screen. -->
					<Button variant="secondary" size="tap" onclick={() => queryEl?.focus()}>
						<Icon name="search" /> Search for a song
					</Button>
				</div>
			</Empty.Root>
		{/if}
	{:else}
		<JoinLanding />
	{/if}
</main>

<!-- `richColors` stays off: the error tone comes from Encore's own --destructive. -->

<div class="sr-live" role="status" aria-live="polite" aria-atomic="true">{liveMsg}</div>

<style>
	/* Reserves the dock's MEASURED height so the last row stays reachable, with a fallback for the first frame. No
	   env() term — `TabBar`, the bottom-most element inside the dock, is the one place that spends
	   `env(safe-area-inset-bottom)`, and it reaches this column through --dock-h. */
	main {
		flex: 1;
		padding: var(--space-xs) var(--space-2xl) calc(var(--dock-h, 0px) + 28px);
	}
	/* These wrappers hold what a component must not: flex-item layout and inherited ink. Neither can be a class
	   passed to <Button> — Tailwind scans only components/ui, and a class handed to a component is stripped here. */
	.me-slot {
		/* Frees the flex minimum the name's ellipsis depends on; without it and the `identity` variant's restored
		   `shrink`, a long name pushes the gear off the row. */
		min-width: 0;
		display: flex;
	}
	.gear-slot {
		/* `ghost` sets no base text colour, only a hover one, so the dim ink is supplied here. */
		margin-right: -10px;
		color: var(--ink-dim);
		display: flex;
	}
	/* The clip-rect idiom, never display:none — most screen readers do not announce a display:none region. */
	.sr-live {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		border: 0;
		overflow: hidden;
		clip: rect(0 0 0 0);
		clip-path: inset(50%);
		white-space: nowrap;
	}

	/* The gradient stays on the TEXT via background-clip, where it is glyph fill and labels nothing. */
	.brand {
		display: inline-flex;
		align-items: center;
		gap: var(--space-sm);
		font-weight: 800;
		font-size: var(--ph-text-xl);
		margin: 0;
		line-height: inherit;
	}

	/* The colour must arrive as `--singer`, not interpolated into `background:`, so color-mix can derive the halo:
	   concatenating alpha digits onto the value only works for 6-digit hex and fails silently otherwise. */
	.me-dot {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		flex: 0 0 auto;
		background: var(--singer);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--singer) 19%, transparent);
	}
	/* The header's one user-supplied width. An unbroken token's min-content width is its full width, so shrink cannot
	   help: truncate, which needs a block box AND min-width:0 all the way up. The dot and gear stay unshrinkable. */
	.me-name {
		display: block;
		/* `text-overflow: ellipsis` needs a non-zero box to draw into. At 320px with the reconnecting pill up
		   this computed to 0px and the singer's own name vanished, leaving the identity control reading as a
		   bare colour dot. A 4ch floor keeps a first initial and the ellipsis. */
		min-width: 4ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* Wide viewports spend the room on MORE SONGS, not longer rows, and only song rows flow into columns. The opt-in
	   is INVERTED on purpose: everything spans by default, so a new block added here cannot land beside a song. */
	@media (min-width: 768px) {
		main {
			display: grid;
			/* 440px is measured off the row's contents: ~220px goes on thumbnail, badge, button and gaps, so a narrower
				   column truncates every title. */
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
	.grouphead:first-of-type {
		margin-top: var(--space-2xs);
	}

	/* THE FIELD AND ITS SCOPE PICKER, one row. The bottom margin lives HERE rather than on `.findbox`, or the two
	   controls would carry separate spacing and the shorter one would not clear the group below it.
	   `center`, NOT `stretch`: stretch was here for the library door, a FIXED 44px square that had to be bound to a
	   70px field, and with the door gone it left the picker top-aligned in the field's 70px slot — measured at 521px,
	   the picker's centre at y=96 against the field's 109, 13px out. `center` puts both on 109. Below 520px the picker
	   takes its own line and neither value applies.
	   That margin takes the SECTION rung, because this is the controls -> content boundary and so the largest
	   structural break on the surface. At --space-lg it was 12px, which made it SMALLER than the 16px then
	   separating two sections of the same kind below it — an inversion, not a near-miss. `.grouphead:first-of-type`
	   above still pulls the first eyebrow's own top margin to 4px and still does its job: below 768px `main` is a
	   block box, so the two COLLAPSE to 24 rather than summing to 28. At and above 768px `main` is a grid with a 0
	   row-gap, where margins do not collapse, so the same boundary is 28. */
	.find-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-md);
		margin-bottom: var(--space-5xl);
	}
	/* The field takes the rest of the row and is the half that SHRINKS, which `min-width: 0` is what allows. */
	.field-slot {
		flex: 1;
		min-width: 0;
		/* THE PROSE MEASURE, and UNCONDITIONALLY — no @media, because a `max-width` can only ever take space BACK and
		   the cap cannot bite until the ROW reaches 692px: 560 plus this row's --space-md gap plus the picker's 122px.
		   RE-DERIVED WITH THE DOOR GONE, and the reading moved: the findbox is 284px at a 767px viewport and 560 at 768,
		   because --max-w steps 480 -> 760 there and the row steps 416 -> 696 with it. So the cap now binds exactly AT
		   --bp-md and never between two widths — the old 230 / 510 figures were taken with a third control in the row.
		   --measure-prose is the token for the ROLE ("protects line length") and a one-line text field is that role; it
		   had no caller on either field. At 1440x900 --max-w 1080, less the shell's 2x--space-2xl and main's
		   2x--space-2xl, is a 1016px row, which would hand this slot ~884px — well over a measure of caret to chase,
		   with the placeholder adrift from the mark that labels it. Capped, the findbox measures exactly 560 (212->772)
		   and the picker stays pinned beside it at 782->904, so the two read as one control cluster rather than a bar
		   stretched across the column. */
		max-width: var(--measure-prose);
	}
	/* THE PICKER YIELDS THE ROW, NOT THE FIELD, and this cost a measurement to learn — twice, because the first
	   reading was taken when a library door was pinned here too. `flex: 0 0 auto` leaves the field as the only
	   flexible item, so it absorbs the whole deficit: measured in headless Chromium at 320px with this arm defeated,
	   the search input's content box is 68px idle, 14px once a query puts FindField's clear control in the row, and
	   ZERO while the search is still in flight and the spinner sits beside the clear — the primary control of the
	   primary surface, showing one word, then no word, then nothing at all. THE THREE STATES ARE NAMED SEPARATELY
	   BECAUSE THEY DIFFER: "mid-search" alone used to carry the 14, which is the settled clear-only reading and the
	   mildest of the three. Below --bp-sm the picker takes its own line instead, which leaves the input 200px idle,
	   146px settled and 121px with the spinner up at 320px (and no overflow: `.find-row` is 124px tall there). The
	   literal is required: a media condition is evaluated before the cascade and cannot read var(--bp-sm). */
	.source-slot {
		flex: 0 0 auto;
		display: flex;
		min-width: 0;
	}
	@media (max-width: 520px) {
		.source-slot {
			flex: 1 1 100%;
		}
	}

	.showall-row {
		display: flex;
		justify-content: center;
		padding: 0 0 var(--space-sm);
	}

	/* THE REVEAL DOOR'S BOX, mirroring /library's rule of the same name rather than reusing `.showall-row`: the two
	   controls are adjacent in the column (a reveal can sit directly above `Not it? Search everything`) and they
	   want opposite spacing — the widen carries padding BELOW it because it ends a group, this carries margin ABOVE
	   it because it follows one. Scoped, not a utility: Tailwind emits nothing authored outside components/ui. */
	.reveal {
		display: flex;
		justify-content: center;
		margin-top: var(--space-md);
	}
	/* THE 320px REFLOW CLAUSE, and it is NOT belt-and-braces here — it is a clip I measured on this control before
	   writing the rule. The Button base carries `whitespace-nowrap` AND `shrink-0`, and this label is long because
	   the remaining count rides on it: at 320px with the root at 32px (the browser's 200% text-only zoom) the
	   `Needs karaoke` door laid out 344.56px wide with its right edge at 332.28 in a 320px viewport. BOTH OF p15's
	   ARMS SEE THAT, which an earlier revision of this comment got wrong by calling the `scrollWidth` clean:
	   re-measured by neutralising exactly these five declarations, documentElement `scrollWidth` reads 332 against
	   `clientWidth` 320 — over by 12 — and that same button is the one element past the right edge. It is an SC
	   1.4.10 failure either way. With these five declarations it measures 256px with right=288 and `main` has no
	   overflowing descendant at all — the same reading the identical clause on
	   `.showall-row :global([data-slot='button'])` produces for the widen control.
	   `:global()` with the `data-slot` anchor for the documented reason: a class handed to a component is stripped
	   at the caller, so the vendored button is only reachable through its own attribute — anchored under `.reveal`
	   so it cannot match every button in the app. */
	.reveal :global([data-slot='button']) {
		white-space: normal;
		overflow-wrap: anywhere;
		flex-shrink: 1;
		min-width: 0;
		max-width: 100%;
	}
	/* The remaining count, dim so the LABEL is what reads as the control. Tabular, so the number does not shift the
	   button's width as the window grows. Same three declarations as /library's `.chip-n`, which this deliberately
	   matches glyph for glyph — the same affordance on two surfaces must not look like two affordances. */
	.chip-n {
		margin-left: var(--space-xs);
		color: var(--ink-dim);
		font-variant-numeric: tabular-nums;
	}

	/* THE 320px REFLOW CLAUSE for this control, and it needs `:global()` for the documented reason: a class handed to
	   a component is stripped at the caller, so the only way to reach the vendored button is its own `data-slot`,
	   ANCHORED under `.showall-row` so it cannot match every button in the app.
	   The Button base carries `whitespace-nowrap`, which is right for a one-word control and wrong for a sentence:
	   measured at 320px with the root at 32px (the browser's 200% text-only zoom), "Not it? Search everything" laid
	   out 384.69px wide with its right edge at 352.34 inside a 320px viewport — an element past the right edge AND
	   documentElement `scrollWidth` at 352 against `clientWidth` 320, so p15 reds on both of its arms rather than
	   only the offender sweep (this sentence used to claim a clean `scrollWidth`; neutralising this clause and the
	   `.reveal` one above it measures 352). An SC 1.4.10 failure either way. Wrapping is the fix rather
	   than shortening the copy, because the copy is doing real work: it names what the widen actually does. */
	.showall-row :global([data-slot='button']) {
		white-space: normal;
		/* The label has spaces to break at, so `anywhere` is belt-and-braces for a future translation that does not. */
		overflow-wrap: anywhere;
		/* AND THE FLEX HALF, which is the actual cause and the one `white-space` alone did not fix: the Button base
		   carries `shrink-0`, so as a flex item it refuses to shrink below its content width and stayed 384.69px wide
		   in a 320px viewport even once the text was allowed to wrap. `min-width: 0` is the documented companion —
		   an item's automatic minimum is its min-content width, which an unbreakable run would otherwise re-impose. */
		flex-shrink: 1;
		min-width: 0;
		max-width: 100%;
	}

	/* `min-height`, not an absolute centring trick: this block sits in a scrolling column whose height three other
	   rules already own. `overflow-wrap: anywhere` is the 320px reflow clause — at --ph-text-2xl (the size the title
	   rule below actually resolves) and 200% text one unbreakable word is wider than the viewport. The size reaches
	   the vendored slot through `:global()`. */
	/* FLEX COLUMN, not `grid` + `place-items: center`. The vendored `Empty.Header` is `display: contents`, so its
	   children become direct children of THIS box — under grid they became two auto rows that split the min-height
	   between them and put the description 220px below its own title. A centred flex column stacks them as one
	   group with a real gap, and reads the same when there is only a title. */
	.idle {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-lg);
		/* 32vh, DOWN FROM 40: the block carries a mark, a title, a line and a button, so the void that used to stand in
		   for content is no longer doing that job. Still a `min-height` and still not a centring trick, for the reason the
		   original note gives — three other rules own this column's height. */
		min-height: 32vh;
		padding: var(--space-2xl) var(--space-md);
		text-align: center;
	}
	/* The mark's own size, on the type ladder rather than a px literal so it scales with the text it sits above. Dim,
	   because the TITLE is the thing to read — an accent-coloured glyph here would out-shout it. */
	.empty-mark {
		display: grid;
		place-items: center;
		font-size: var(--ph-text-2xl);
		color: var(--ink-dim);
	}
	/* THE SPACE IS LOAD-BEARING. Without it this is a COMPOUND selector — one element carrying both `.idle`
	   and `data-slot="empty-title"` — and `empty-title` is a GRANDCHILD (through `Empty.Header`, which computes to
	   `display: contents`). It matched nothing, silently: `:global()` suppresses Svelte's unused-selector warning,
	   so the size, weight and the `overflow-wrap` reflow clause below never applied and the title rendered at the
	   vendored `text-lg`. */
	/* --ph-text-2xl, DOWN FROM 3xl (2.6rem / ~42px, the ladder's display rung). The old size was both the
	   largest type in the app AND dimmed by `.encore-empty`'s --ink-dim, which is the worst pair available: big enough
	   to dominate the screen, faint enough to
	   read as a placeholder nobody finished. Full --ink at a heading size states it once, properly. It also now agrees
	   with /library's `.lib-empty` twin, which was already at this step. */
	.idle :global([data-slot='empty-title']) {
		font-size: var(--ph-text-2xl);
		line-height: var(--lh-snug);
		font-weight: 700;
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	/* Declared here, never inline: an inline style outranks the short-viewport rule below and defeats it. */
	.topbar {
		display: flex;
		/* WRAPS, for the same reason `.find-row` does: at 320px with the root at 32px the wordmark alone takes most of
		   the line, and `.me-cluster`'s `margin-left: auto` then pushed the identity dot to right=341.3 in a 320px
		   viewport — off-screen, clipped rather than reflowed. Wrapping lets the cluster take its own line instead.
		   `align-items: center` stays correct once wrapped: each line centres its own items. */
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-md);
		padding: var(--space-2xl) var(--space-2xl) var(--space-sm);
	}
	.me-cluster {
		margin-left: auto;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
	}

	/* THE HEADER BECOMES A BAND AT --bp-md, and only there. On a phone the wordmark and the identity cluster sit about
	   a --space rung apart and need no boundary; on a desktop column they are most of the viewport apart, and with
	   nothing painted under them they read as two things adrift rather than as one header. THE GAP IS NAME-DEPENDENT,
	   so no constant here is a property of the layout: `.me-cluster` is `margin-left: auto`, so the distance is the
	   content box less the wordmark less the cluster, and the cluster's width is the singer's display name. Read
	   with the eight-character name `Theodora` it is 80px at 390x844 and 770px at 1440x900 — the same order as the
	   ~777px of docs/UI-DESIGN-REVIEW.md#5. THE NAME IS PART OF THE READING, not noise around it: a narrower eight
	   characters opens the gap further, so a figure quoted here without its name cannot be reproduced.
	   The gap is UNCHANGED by this rule, deliberately, and on its OWN merits rather than by precedent: leading brand /
	   trailing account is a real desktop header form, and the cluster is the one thing on this column that earns the
	   far edge, because it leaves the way into /settings in the same corner it occupies on every other route. What the
	   hairline does for that split is this rule's whole job — it gives the two clusters a shared lower boundary, so
	   they read as the two ends of ONE surface instead of as two things floating in page. PageHeader is NOT the
	   precedent and must not be cited as one: its `.inner` left-packs `.back-slot` then `h1` with `gap:
	   var(--space-md)`, with no trailing slot and no auto margin anywhere in the file. What `/` alone lacks is that
	   every other header is a capped SURFACE, and this is the cheapest honest form of one.
	   Deliberately NOT the PageHeader pill: that fill and blur are earned by being STICKY, and this header is not
	   (docs/FRONTEND.md#the-sing-tab). --line and not --control-line: this is a decorative hairline, not the
	   boundary of anything operable.
	   The rule spans the shell's content box, 16px past the rows' column on each side, which is deliberate — a divider
	   stopping exactly at a row's edge reads as a row boundary rather than as page structure.
	   Its OWN media block rather than the row grid's `@media (min-width: 768px)` above, because a paint rule filed
	   inside the grid arm is a paint rule nobody looking at the header will find. 768 is --bp-md; a media condition is
	   evaluated before the cascade and cannot read the token.
	   ORDER IS LOAD-BEARING: this sits BEFORE the max-height arm below, so a phone held sideways — which can match
	   both — keeps that arm's tighter `padding` shorthand and this only adds the hairline. Measured at 844x390 the
	   computed padding-bottom is 4px and the border is still 1px, which is that arm winning. Moving this block after
	   it would hand 12px of padding back to the one arm whose whole purpose is reclaiming height. */
	@media (min-width: 768px) {
		.topbar {
			border-bottom: 1px solid var(--line);
			/* --space-sm left the rule 8px under the wordmark, which reads as a line stuck to the text. One rung up,
			   not a new number. */
			padding-bottom: var(--space-lg);
		}
	}

	/* Nothing in this file animates, so there is no reduce arm: motion is opt-in inside the components. */

	/* Short viewports (a phone held sideways) spend almost the whole height on chrome, so the chrome shrinks.
	   --dock-h is NOT overridden here: an inline custom property on :root outranks this rule. */
	@media (max-height: 480px) {
		.topbar {
			padding: var(--space-xs) var(--space-2xl) var(--space-2xs);
		}
		main {
			padding-top: var(--space-3xs);
		}
		.grouphead {
			margin: var(--space-sm) var(--space-2xs) var(--space-2xs);
		}
		/* The section rung is a PORTRAIT ruling. This arm exists to reclaim height on a phone held sideways — it
		   already pulls the eyebrows back — so the boundary goes back to the group rung and landscape geometry
		   stays identical to what it was before that rung existed. */
		.find-row {
			margin-bottom: var(--space-lg);
		}
	}
</style>
