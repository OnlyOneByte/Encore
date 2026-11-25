<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import type { QueueEntry, Media, PublicSinger } from '$lib/contract';
	import type { QueueStore } from '$lib/stores/queue';
	import { room } from '$lib/stores/room';
	import type { RoomStatus } from '$lib/stores/room';
	import { failureNoticeId, PENDING_GRACE_MS } from '$lib/stores/room';
	import RoomPending from '$lib/components/RoomPending.svelte';
	import SongRow from '$lib/components/SongRow.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import {
		displayReadiness,
		canProcess,
		noRowsState,
		showsNoRows,
		processingGroupIds,
		waitingTurns,
		makeableNow,
		type MakerVerdicts,
		type Readiness
	} from '$lib/readiness';
	import { processAndQueue, REPLACE_PARAM } from '$lib/process-and-queue';
	import { cantMakeHeading, processingGroupHeading } from '$lib/phrasing/process-phrasing';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { originalKeyLabel, isProcessableSource } from '$lib/contract';
	import type { MediaStatus } from '$lib/contract';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import SkeletonRows from '$lib/ui/SkeletonRows.svelte';
	import FindField from '$lib/ui/FindField.svelte';
	import Spotlight from '$lib/ui/Spotlight.svelte';
	import { LIBRARY_PAGE, libraryWindow } from '$lib/library-browse';
	import * as Empty from '$lib/components/ui/empty';
	import { rememberedKey } from '$lib/stores/remembered-key';
	import { keepSearch, keptSearch } from '$lib/sing-search-keep';
	import {
		cachedYourSongs,
		forgetYourSongs,
		loadYourSongs,
		yourSongLine,
		YOUR_SONGS_SHOWN,
		type YourSong,
		type YourSongs
	} from '$lib/your-songs';

	let me = $state<PublicSinger | null>(null);
	let status = $state<RoomStatus>('checking');
	let entries = $state<QueueEntry[]>([]);
	/** The library read and the first queue sync have both landed, so `noMaker` is the room's verdict, not a default. */
	let verdictKnown = $state(false);
	let mediaCatalog = $state<Map<string, Media>>(new Map());
	// The room's maker verdicts (`queue:sync`), so the tab says "can't make" before anyone's pick dies.
	let verdicts = $state<MakerVerdicts>({ canMake: true, canFetch: true });
	let defaultFetcher = $state<string | undefined>(undefined);
	// Seeded from /api/library as well as media:status, so a reload mid-process keeps its progress bar.
	let mediaStatus = $state<Map<string, { status: MediaStatus; pct: number; etaSec?: number; unservable?: boolean }>>(
		new Map()
	);

	/* THE SING TAB. One job — find a song and put it in the rotation — and exactly two states, with `searchActive`
	   (a non-empty query) as the sole switch between them: a query shows its result groups, no query shows the idle
	   state that points back at the field. The queue and the library used to be branches of this same page; they are
	   TABS now (see docs/FRONTEND.md#the-three-tabs), which is what that branch had always been.
	   The standing route to /library is the TabBar, not this page: the one link to it left here is inside the
	   search-found-nothing state, where the library count is news. */

	// Mirrored from the room link, not owned here. Optional because an unjoined guest has no queue at all, which
	// is what every `store?.` call site below reads.
	let store = $state<QueueStore | undefined>(undefined);

	/* `sync()` runs ONCE before subscribing: the link is a singleton that outlives this component, so on a return
	   to `/` it is already live and subscribing alone renders an empty queue until the room happens to speak. */
	onMount(() => {
		const sync = () => {
			me = room.me;
			status = room.status;
			mediaCatalog = room.mediaCatalog;
			// Every search row was merged into the catalog, so one missing from it is a song the room refused as
			// deleted (`#songGone`): the open answer stops offering it. Reassigned only when something left. Relies on the
			// catalog never losing a row any other way, pinned by room-lean-sync.test.ts "the catalog only grows".
			const live = (list: Media[]) => list.filter((m) => mediaCatalog.has(m.id));
			if (live(readyResults).length !== readyResults.length) readyResults = live(readyResults);
			if (live(rawResults).length !== rawResults.length) rawResults = live(rawResults);
			mediaStatus = room.mediaStatus;
			verdicts = room.verdicts;
			defaultFetcher = room.settings.global.defaultFetcher;
			entries = room.entries;
			verdictKnown = room.libraryLoaded && (room.queue?.synced ?? false);
			library = room.library;
			libraryTags = room.libraryTags;
			store = room.queue;
		};
		sync();
		const stopMirror = room.subscribe(sync);
		void room.connect();
		// Left mid-search, so no answer was kept: ask again rather than show an empty box as "nothing found".
		if (restored?.pending && query.trim()) void announce(query.trim());
		return () => {
			keepSearch(room.me?.id, urlSource, {
				query,
				widened,
				ready: $state.snapshot(readyResults),
				raw: $state.snapshot(rawResults),
				processing: $state.snapshot(processingResults),
				failed: searchFailed,
				answeredFor,
				pending: searching || debounceTimer !== undefined
			});
			stopMirror();
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

	let yours = $state<YourSongs | null>(cachedYourSongs(room.me?.id));
	// Once joined, not before (the route answers 401 to a visitor). Below everything on the idle screen, so
	// arriving after first paint moves nothing; a return paints the cache.
	const meId = $derived(me?.id);
	// A new singer on this phone (a Leave, then a join) starts from their own cache or nothing, never the last one's.
	$effect(() => {
		const id = meId;
		untrack(() => {
			yours = cachedYourSongs(id);
			if (id) refreshYours();
			else forgetYourSongs();
		});
	});
	// One of my turns just left the queue (sung, skipped or failed), so the list a reload would show has changed.
	let mineBefore = new Set<string>();
	$effect(() => {
		const mine = new Set(entries.filter((e) => e.singerId === me?.id).map((e) => e.id));
		const gone = [...mineBefore].some((id) => !mine.has(id));
		mineBefore = mine;
		if (gone) refreshYours();
	});
	function refreshYours() {
		const id = meId;
		void loadYourSongs(id).then((r) => {
			// Dropped if the singer changed while it was in the air.
			if (!r || meId !== id) return;
			room.mergeMedia(r.songs.flatMap((s) => (s.media ? [s.media] : [])));
			yours = r;
		});
	}
	/** A save whose song left the library has no row here yet: "needs making" is proposal 36, PR 3. */
	const yourRows = $derived(
		(yours?.songs ?? [])
			.flatMap((s) => {
				// The catalog alone, so a song the room refused as deleted (`#songGone`) leaves the list too.
				const media = s.mediaId ? mediaCatalog.get(s.mediaId) : undefined;
				return media ? [{ song: s, media }] : [];
			})
			.slice(0, YOUR_SONGS_SHOWN)
	);

	const queued = $derived(entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq));
	/** The turn "Pick another" was tapped on, while it is still mine and still waiting. Anything else drops the mode,
	 * so a stale link never swaps a song into a turn that has moved on. */
	const replacing = $derived.by(() => {
		const id = page.url.searchParams.get(REPLACE_PARAM);
		return id ? (queued.find((e) => e.id === id && e.singerId === me?.id) ?? null) : null;
	});
	/* NO MAKER: an unprocessed pick would die the same way, so the banner points at a ready one — the TV and strip's
	   "Can't make new karaoke right now", worded for this screen. */
	const noMaker = $derived(
		waitingTurns(
			queued,
			(id) => mediaCatalog.get(id),
			(id) => mediaStatus.get(id),
			verdicts.canMake
		).noMaker
	);

	// "Find any song and we'll make it" promises SEARCH results, so it needs a fetcher as well as a maker.
	const onlyReady = $derived(noMaker || !verdicts.canFetch);

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
	/* WHERE to search. NO MENU (proposal 21): the default sends no `source` param at all, which the route reads as
	   its default set: the YouTube Music catalog, local files, and Spotify metadata — everything except
	   plain all-of-YouTube ytsearch, whose hits are lyric reuploads and hour loops credited to a channel
	   rather than a performer. `Not it? Search everything` (`widened`) adds ytsearch back for an upload no
	   catalog lists, for the query it was tapped on; the next keystroke goes back to the default.
	   `?source=` on this page's own URL passes straight through as the narrowing filter, off-screen, so a test
	   or a host trying one source (`/?source=local`) can still narrow without a control a guest has to read.
	   The widen still shows under a narrowed URL, so a shared `/?source=local` link is never a search with no way
	   wider; only `source=all` hides it, because there is nothing wider than all. */
	const urlSource = $derived(page.url.searchParams.get('source') ?? '');
	// Only this singer's search, made under this same `?source=`: another narrowing would show rows it did not ask for.
	const restored = keptSearch(room.me?.id, page.url.searchParams.get('source') ?? '');
	let widened = $state(restored?.widened ?? false);
	/** The widened answer's count, described on the element the widen focuses. Empty once a newer search starts. */
	let widenCount = $state('');
	let widenTarget: HTMLElement | null = null;
	/** Drops the count and its `aria-describedby`, so the attribute never points at nothing. */
	function clearWidenCount() {
		widenCount = '';
		widenTarget?.removeAttribute('aria-describedby');
		widenTarget = null;
	}
	const searchSource = $derived(widened ? 'all' : urlSource);
	let query = $state(restored?.query ?? '');
	let readyResults = $state<Media[]>(restored?.ready ?? []);
	let rawResults = $state<Media[]>(restored?.raw ?? []);
	let processingResults = $state<Media[]>(restored?.processing ?? []);
	// A restore left mid-search starts as searching, so its first render never reads as "nothing found".
	let searching = $state(restored?.pending ?? false);
	// Tenet 2: no skeleton for a search under PENDING_GRACE_MS (#1091). No hold after: rows replace it as they land.
	let showSkeleton = $state(false);
	$effect(() => {
		if (!searching) return;
		const timer = setTimeout(() => (showSkeleton = true), PENDING_GRACE_MS);
		return () => {
			clearTimeout(timer);
			showSkeleton = false;
		};
	});
	/* A FAILED SEARCH IS A THIRD STATE, not an empty one. Without this the catch below wiped the rows and the
	   zero-state then asserted `Nothing matches "<query>"` — the review's only blocks-the-party finding. Reset
	   wherever a new attempt begins, so the failure cannot outlive the query it belongs to. */
	let searchFailed = $state(restored?.failed ?? false);
	// The text the rows on screen answer. "Nothing matches" only for that text: typed text the debounce has not
	// sent yet has no answer, so it says nothing (#1192).
	let answeredFor = $state<string | null>(restored?.answeredFor ?? null);
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
	let revealedCant = $state(LIBRARY_PAGE);

	/* ALL THREE GROUPS TOGETHER, in one place: each is scoped to the query that produced it, so a group left behind
	   renders under whatever the box shows next. Dropping them one site at a time is how `processingResults` was
	   forgotten on the failure path. */
	function clearResults() {
		readyResults = [];
		rawResults = [];
		processingResults = [];
		// The rows that answered are gone, so nothing is answered: the same text typed again waits for its own answer.
		answeredFor = null;
		/* THE WINDOWS RESET WITH THE ROWS, and only here — the rule /library's own `applyQuery` states. This is the
		   one seam where all three groups are already dropped, so a guest who revealed 180 rows never watches them
		   collapse on a keystroke that has not resolved into an answer yet; they collapse with the rows they belong
		   to. Resetting on input instead would also hand the next query a DOM the previous one grew. */
		revealedProcessing = LIBRARY_PAGE;
		revealedReady = LIBRARY_PAGE;
		revealedRaw = LIBRARY_PAGE;
		revealedCant = LIBRARY_PAGE;
	}

	function onQueryInput() {
		clearTimeout(debounceTimer);
		debounceTimer = undefined;
		widened = false;
		clearWidenCount();
		const q = query.trim();
		if (!q) {
			clearResults();
			searching = false;
			inflight?.abort();
			return;
		}
		debounceTimer = setTimeout(announce, 150, q);
	}

	/** Runs the search and reads its answer out: every path but the widen, which ties it to the focus it moves. */
	async function announce(q: string) {
		debounceTimer = undefined;
		const msg = await runSearch(q);
		if (msg) liveMsg = msg;
	}

	/* One tap from the narrowed default to the full fan-out, re-running the query it is already holding.
	   Offered beside results, not only when there are none — see the note at its render site. */
	async function widenSearch() {
		// The pending keystroke's timer is cancelled first, or one widen fires two full searches:
		// this one now, and the debounced one 150 ms later — two resolver fan-outs for one query.
		clearTimeout(debounceTimer);
		debounceTimer = undefined;
		widened = true;
		const q = query.trim();
		if (!q) return;
		const msg = await runSearch(q);
		// Aborted (superseded, or the page unmounted while it was in the air) or the field has left the page: the
		// heading query below would otherwise run against whatever route the guest went to.
		if (!msg || !queryEl?.isConnected) return;
		/* THE TAP REMOVES ITS OWN BUTTON, so focus would fall to <body> and a keyboard or switch user starts over at
		   the top. It goes to the first group heading of the widened answer, or back to the field when there is no
		   group (a failure or nothing found). Not if the guest has typed since: the next keystroke clears `widened`,
		   and stealing focus from the field they are typing in is worse than losing it. */
		if (!widened || query.trim() !== q) {
			liveMsg = msg;
			return;
		}
		/* The count is the focus target's description, read as focus lands. A live update queued before a focus move
		   is often dropped. `clearWidenCount` runs on the next search, so nothing stale is left to read. */
		widenCount = msg;
		await tick();
		widenTarget = document.querySelector<HTMLElement>('main h2.grouphead') ?? queryEl;
		widenTarget?.setAttribute('aria-describedby', 'widen-count');
		widenTarget?.focus();
	}

	/** Empties the box, which lands on the idle state. Called by the field's own `×`. */
	function clearSearch() {
		query = '';
		onQueryInput();
		queryEl?.focus();
		if (navigator.vibrate) navigator.vibrate(8);
	}

	/** The sentence to announce for this query's answer, or `undefined` when a newer search or an unmount aborted it.
	 * It does not set `liveMsg` itself, because the widen gives the count to the element it focuses instead. */
	async function runSearch(q: string): Promise<string | undefined> {
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
		clearWidenCount();
		try {
			// The default is the route's own, so it sends nothing — one spelling of the default, on the
			// server, instead of two that can drift.
			const source = searchSource ? `&source=${encodeURIComponent(searchSource)}` : '';
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
			answeredFor = q;
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
			// Prefixed after a widen, so the same count for the same query still reads as news.
			return (
				(widened ? 'Searched everything: ' : '') +
				(found === 0
					? `No songs found for ${q}`
					: `${found} song${found === 1 ? '' : 's'} found for ${q} — ${readyResults.length} ready to sing`)
			);
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
				return "Couldn't reach the server — your search didn't run.";
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
	   anything on this tab — and /queue now draws every queued song that is still cooking. `processAndQueue` adds the
	   turn right after the process, and only if it started, so a processing song is in practice always a queued song and /queue is
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
				status: r.live?.status,
				unservable: r.live?.unservable
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
	// A pick the server would refuse is not offered: those rows get their own group (docs/FRONTEND.md#the-sing-tab).
	const cantMakeRow = (m: Media) => canProcess(m, readinessFor(m)) && !makeableNow(m, verdicts, defaultFetcher);
	const makeRows = $derived(rawRows.filter((m) => !cantMakeRow(m)));
	const cantRows = $derived(rawRows.filter(cantMakeRow));

	/* WHAT IS RENDERED, against what the reveal control still has behind it. DE-DUPLICATION AND THE ZERO-STATE READ
	   THE FULL LISTS, not these: `accountedFor`/`unaccounted` decide which group OWNS a song, and `showsNoRows`
	   decides whether the search found anything at all — both would start answering about the WINDOW if they read
	   `.shown`, so a 200-row answer whose first 60 happened to be ready would print "Nothing matches". */
	const processingView = $derived(libraryWindow(processingRows, revealedProcessing));
	const readyView = $derived(libraryWindow(readyResults, revealedReady));
	const rawView = $derived(libraryWindow(makeRows, revealedRaw));
	const cantView = $derived(libraryWindow(cantRows, revealedCant));

	/** `last` is a Your songs row's key and guide from your last finished turn of it, which beat this phone's memory. */
	function addSong(mediaId: string, last?: Pick<YourSong, 'keyShift' | 'guideLevel'>) {
		const key = last?.keyShift ?? rememberedKey(mediaId);
		/* PICK ANOTHER: the same turn, another song, so the spot the dead song held is kept — carrying THIS song's
		   remembered key, never the dead one's. Back to /queue, where the turn now reads as the new song's card, and
		   the dead song's "try again" notice is dismissed: it names a song that is no longer in the queue. */
		if (replacing) {
			// Read BEFORE the swap: the optimistic op rewrites the entry `replacing` derives from.
			const deadMediaId = replacing.mediaId;
			store?.replaceMedia(replacing.id, mediaId, key ?? 0, last?.guideLevel);
			toast.dismiss(failureNoticeId(deadMediaId));
			liveMsg = `${room.titleOf(mediaId)} takes your spot`;
			if (navigator.vibrate) navigator.vibrate(8);
			void goto(resolve('/queue'));
			return;
		}
		store?.addSong(mediaId, key, last?.guideLevel);
		/* SAID HERE, because the row that confirms an add is on ANOTHER TAB now. The queue's announcer
		   ($lib/phrasing/queue-announcement, which /queue drives) is deliberately silent about my own adds — "the row
		   appearing is its own confirmation" — and no row appears on this screen at all, so a screen-reader guest
		   adding three songs off one search heard three silences. Assigned directly rather than routed through that
		   function: its whole job is the diff that suppresses news I caused, and this is news I caused and want. */
		liveMsg = `Added ${room.titleOf(mediaId)} to the queue`;
		if (navigator.vibrate) navigator.vibrate(8);
	}
	// Plain, not reactive: nothing renders from it, it only drops a second tap while the first one's POST is out.
	const singing = new Set<string>();
	function singThis(mediaId: string, last?: Pick<YourSong, 'keyShift' | 'guideLevel'>) {
		void processAndQueue({
			mediaId,
			inFlight: singing,
			process: () => processMedia(mediaId),
			queue: () => addSong(mediaId, last),
			hasQueuedTurn: inMyQueue(mediaId)
		});
	}
	/** Request stem-separation ("make karaoke"). The live media:status broadcasts drive the row's bar.
	 *
	 * THE REQUEST ITSELF MOVED TO `RoomLink.requestProcess`, where /queue's stalled-card retry can reach it: the
	 * optimistic set, the rollback-the-mark-not-the-turn rule and the refusal notice are the correctness of that
	 * call, and a second copy of the three is how they drift. What stays here is the haptic, which is a DOM read
	 * the link may not make, and the refusal lands on the root layout's `room.onError` toast. */
	async function processMedia(mediaId: string): Promise<boolean> {
		if (navigator.vibrate) navigator.vibrate(12);
		return room.requestProcess(mediaId);
	}

	function showError(msg: string) {
		toast.error(msg, { duration: 4000 });
	}

	/* The polite region for everything this tab says that is not a row: the search result count, an add, and a
	   search failure. `aria-atomic`, so a fast typist's superseded searches replace rather than queue. */
	let liveMsg = $state('');
</script>

<!-- Its own title, which the route announcer reads on arrival: without one a tab arrival from /queue kept "Queue ·
	Encore", and Pick another, which opens here from /queue, said so too. -->
<!-- The join screen is not the Sing tab: a guest who has not joined keeps the layout's plain "Encore". -->
<svelte:head
	><title>{status === 'not-joined' ? 'Encore' : replacing ? 'Pick another · Encore' : 'Sing · Encore'}</title
	></svelte:head
>

<!-- TWO WHOLE BLOCKS, the join screen and the tab, never one `<main>` the join screen moves into: when a slow 401
	replaces the placeholder (or a session is lost) the topbar goes, and a `<main>` that stayed would jump up under the
	guest (CLS 0.074 at 390). A new block is an insertion, not a shift — the swap `/queue` and `/library` make. Unjoined,
	there is no topbar: JoinLanding paints its own brand, so both would say "Encore" twice. -->
{#if status === 'not-joined'}
	<main>
		<!-- Loaded on demand: a joined phone opens Sing all night and never needs the join screen's ~1.8 KB gz of CSS. -->
		{#await import('$lib/components/JoinLanding.svelte') then { default: JoinLanding }}
			<JoinLanding />
		{:catch}
			<!-- The chunk can fail on bad wifi or after an update renamed it: never a blank screen. -->
			<div class="join-lost">
				<p>Couldn't load the join screen.</p>
				<Button variant="secondary" size="tap" onclick={() => location.reload()}>Try again</Button>
			</div>
		{/await}
	</main>
{:else}
	<header class="topbar">
		<h1 class="brand"><Icon name="mic" /> <span class="grad-text">Encore</span></h1>
		<!-- THE OFFLINE PILL MOVED TO THE DOCK. It lived here, in a deliberately non-sticky topbar, where it measured
			`top: -2420px, inViewport: false` on a 59-row list — in the DOM and 2.4k pixels above the fold. The dock is
			fixed and on every surface, so the cue is now visible at every scroll position on every route, and `/queue`
			and `/library` gain one they never had. See the offline cue in NowPlayingStrip.svelte. -->
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
	<main>
		{#if me}
			<!-- The field is the FIRST thing on the screen, and not sticky — see the `.findbox` rule for why. ONE
					CONTROL: the scope menu that sat under it is gone (proposal 21). The library door that used to sit on the field's leading edge is
					gone with the shelf it labelled — the TabBar's Library tab sits in the fixed dock at the foot of every phone
					surface, so a second route to the same page from the same screen was one count of the library too
					many. -->
			{#if replacing}
				<!-- Says what the next tap does, because Sing does something different here: it swaps, it does not add. -->
				<div class="replacing">
					<p>{noMaker ? 'Pick a ready song' : 'Pick another song'} — you keep your spot.</p>
					<Button variant="ghost" size="tap" href={resolve('/queue')}>Cancel</Button>
				</div>
			{/if}
			<!-- THE SPOTLIGHT is the field alone, as in the chosen prototype; its title names the region but is not
					drawn, so the results start right under it. -->
			<div class="find-row">
				<div class="field-slot">
					<Spotlight title="What do you want to sing?">
						<FindField
							bind:value={query}
							bind:element={queryEl}
							ariaLabel="Search a song or artist"
							placeholder="Search a song or artist…"
							clearable={searchActive}
							clearLabel="Clear the search"
							onclear={clearSearch}
							oninput={onQueryInput}
						/>
					</Spotlight>
				</div>
				{#if !searchActive}
					<!-- NEITHER LINE UNTIL THE VERDICT IS KNOWN, and both in one grid cell so the box is always the taller
							one's height: a cold load printed the promise, then took it back 120 ms later (CLS 0.0039). -->
					<p class="promise">
						<span class:shown={verdictKnown && !onlyReady}>Find any song and we'll make the karaoke track for it.</span>
						<span class:shown={verdictKnown && onlyReady}>Only ready songs can play right now.</span>
					</p>
				{/if}
			</div>

			<!-- TWO STATES, AND THE STRUCTURE SAYS SO: a query, or no query. With no query there is the Spotlight and, if you
					have any, your songs. While the skeleton is up it is the only answer, so it never sits above rows it is about to leave. -->
			{#if !searchActive && yourRows.length}
				<!-- YOUR SONGS: what you sang and saved, in your last key, so a return to the party is one tap. Nothing at all
						for a guest with none yet, so a first visit is the bare box. -->
				<h2 class="grouphead">Your songs</h2>
				{#each yourRows as { song, media } (media.id)}
					{@const r = readinessFor(media)}
					<SongRow
						{...rowMeta(media)}
						durationSec={undefined}
						viewCount={undefined}
						keyName={undefined}
						detail={yourSongLine(song)}
						flat
						readiness={r}
						pct={liveOf(media.id)?.pct ?? 0}
						status={liveOf(media.id)?.status}
						unservable={liveOf(media.id)?.unservable}
						inQueue={inMyQueue(media.id)}
						processable={isProcessableSource(media.source)}
						cantMake={cantMakeRow(media)}
						onadd={() => addSong(media.id, song)}
						onmake={canProcess(media, r) ? () => singThis(media.id, song) : undefined}
					/>
				{/each}
				{#if yours?.canKeep}
					<p class="keep-line">
						On this phone only. <a href={resolve('/settings/you')}>Keep {me.displayName}</a> to have them on any phone.
					</p>
				{/if}
			{:else if searchActive && showSkeleton}
				<SkeletonRows flat label="Searching…" />
			{:else if searchActive}
				<!-- Search-scoped, and ABOVE `Ready to sing` where it has always been: a song already being made is the
						answer to the query the guest just typed, so it belongs with the answers. See `processingRows`. -->
				{#if processingRows.length}
					<!-- A heading is a claim about what follows: "Making karaoke…" only while some row really is being made. -->
					<!-- `tabindex="-1"` on every group heading: the widen moves focus to the first one. -->
					<h2 class="grouphead" tabindex="-1">
						{processingGroupHeading(
							processingRows.map((c) => displayReadiness(c.media, liveOf(c.id)) === 'processing' && !c.unservable)
						)}
					</h2>
					{#each processingView.shown as c (c.id)}
						{@const r = displayReadiness(c.media, liveOf(c.id))}
						<SongRow
							{...rowMeta(c.media)}
							flat
							readiness={r}
							pct={c.pct}
							status={c.status}
							unservable={c.unservable}
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
					<h2 class="grouphead" tabindex="-1">Ready to sing</h2>
					{#each readyView.shown as m (m.id)}
						<SongRow {...rowMeta(m)} flat readiness="ready" inQueue={inMyQueue(m.id)} onadd={() => addSong(m.id)} />
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

				{#if makeRows.length}
					<!-- Holds the taller can't-make wording's height, so a maker dropping swaps the words without a shift. -->
					<h2 class="grouphead" tabindex="-1">
						<span class="swap"
							><span>Needs karaoke</span><span class="ghost" aria-hidden="true">{cantMakeHeading(makeRows.length)}</span
							></span
						>
					</h2>
					{#each rawView.shown as m (m.id)}
						{@const r = readinessFor(m)}
						<SongRow
							{...rowMeta(m)}
							flat
							readiness={r}
							pct={liveOf(m.id)?.pct ?? 0}
							status={liveOf(m.id)?.status}
							unservable={liveOf(m.id)?.unservable}
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

				<!-- WHAT NOTHING CONNECTED CAN MAKE RIGHT NOW, listed so the guest sees the song exists, with no Sing button. -->
				{#if cantRows.length}
					<h2 class="grouphead" tabindex="-1">{cantMakeHeading(cantRows.length)}</h2>
					{#each cantView.shown as m (m.id)}
						<SongRow {...rowMeta(m)} flat readiness={readinessFor(m)} inQueue={inMyQueue(m.id)} cantMake />
					{/each}
					{#if cantView.hidden > 0}
						<div class="reveal">
							<Button variant="secondary" size="tap" onclick={() => (revealedCant += LIBRARY_PAGE)}>
								Show {Math.min(LIBRARY_PAGE, cantView.hidden)} more
								<span class="chip-n">{cantView.hidden} left</span>
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
				{#if !searching && searchSource !== 'all' && (rawRows.length || readyResults.length)}
					<div class="showall-row">
						<Button variant="secondary" size="tap" onclick={widenSearch}>
							<Icon name="search" /> Not it? Search everything
						</Button>
					</div>
				{/if}
				<!-- Last, below the rows and the widen: arriving mid-search it must push nothing from under a thumb. -->
				{#if cantRows.length && !readyResults.length && library.length}
					<div class="showall-row">
						<Button variant="secondary" size="tap" href="/library">
							<Icon name="library" /> See all ready songs
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
							<Button variant="secondary" size="tap" onclick={() => announce(query.trim())}>
								<Icon name="restart" /> Try again
							</Button>
						</div>
					</Empty.Root>
				{:else if showsNoRows( { searching: searching || answeredFor !== query.trim(), failed: searchFailed, readyCount: readyResults.length, rawCount: rawRows.length, processingCount: processingRows.length } )}
					{@const empty = noRowsState({ searchActive, libraryCount: library.length, query })}
					<Empty.Root>
						<Empty.Header>
							<Empty.Description>{empty.message}</Empty.Description>
						</Empty.Header>
					</Empty.Root>
					<!-- A LINK TO /library, not a `clearSearch()`. It used to clear the query, which restored a visible
							library in place; clearing now lands on the idle state, which shows no library — so the label would
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
			{/if}
		{:else}
			<RoomPending unreachable={status === 'unreachable'} />
		{/if}
	</main>
{/if}

<!-- `richColors` stays off: the error tone comes from Encore's own --destructive. -->

<div class="sr-live" role="status" aria-live="polite" aria-atomic="true">{liveMsg}</div>
{#if widenCount}<p id="widen-count" hidden>{widenCount}</p>{/if}

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
	/* Button's `size` classes (rem) win over the variant's padding and gap, so at a 32px root the button outgrew
	   `.me-cluster`'s floor and the dot slid under the gear. These are the values that floor sums. */
	.me-slot :global([data-slot='button']) {
		padding-inline: var(--space-xs);
		gap: var(--space-sm);
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
		/* The row's height is the identity cluster's 44px gear, which only a joined phone has: reserved here, so the
		   placeholder's topbar is the joined one's height and the column under it does not drop 9px on arrival. */
		min-height: var(--tap);
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
			/* 440px keeps a long title to two lines beside its byline and button. */
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

	/* THE FIELD'S ROW, and the field is all of it: the scope picker that shared it is gone (proposal 21), so
	   `Not it? Search everything` under the results is the one way wider. The bottom margin lives HERE rather than
	   on `.findbox`.
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
	/* Both wordings stacked in one cell: the box is the taller one's height whichever shows, or while neither does. */
	.promise {
		display: grid;
		flex-basis: 100%;
	}
	/* THE SPOTLIGHT IS THE FIELD: its ring is the field's boundary and, on focus, the one focus ring. The title
	   stays as the region's name and is not drawn. */
	.field-slot :global(.spotlight) {
		padding: var(--step-8) var(--step-4);
	}
	.field-slot :global(.spotlight > .title) {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	.field-slot :global(.spotlight .body) {
		margin-top: 0;
	}
	.field-slot :global(.spotlight:has(input:focus-visible)) {
		box-shadow: none;
		outline: 2px solid var(--role-focus);
		outline-offset: 0;
	}
	.field-slot :global(.findbox) {
		min-height: var(--tap);
		padding-block: 0;
		border-color: transparent;
		background: none;
	}
	.field-slot :global(.findbox:has(input:focus-visible)) {
		outline: none;
	}
	.promise > span {
		grid-area: 1 / 1;
		visibility: hidden;
	}
	.promise > .shown {
		visibility: visible;
	}
	/* The same stacking for a group heading: the box is the taller wording's. */
	.swap {
		display: grid;
	}
	.swap > span {
		grid-area: 1 / 1;
	}
	.swap > .ghost {
		visibility: hidden;
	}
	.replacing {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
		margin-bottom: var(--space-md);
		color: var(--ink-dim);
	}
	/* The field takes the rest of the row and is the half that SHRINKS, which `min-width: 0` is what allows. */
	.field-slot {
		flex: 1;
		min-width: 0;
		/* THE PROSE MEASURE, and UNCONDITIONALLY — no @media, because a `max-width` can only ever take space BACK.
		   --measure-prose is the token for the ROLE ("protects line length") and a one-line text field is that role.
		   At 1440x900 --max-w 1080, less the shell's 2x--space-2xl and main's 2x--space-2xl, is a 1016px row, which
		   would hand this slot the whole row — well over a measure of caret to chase, with the placeholder adrift from
		   the mark that labels it. Capped, the findbox measures 560. */
		max-width: var(--measure-prose);
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

	/* Under the Spotlight with an empty box, dim: the field is the thing to read. */
	.promise {
		margin: 0;
		padding-inline: var(--step-4);
		font-size: var(--type-meta);
		color: var(--role-ink-dim);
	}
	/* Dim and below the rows: a fact about where the list lives, with the one way to change it. */
	.keep-line {
		margin: var(--step-16) 0 0;
		padding-inline: var(--step-4);
		font-size: var(--type-meta);
		color: var(--role-ink-dim);
	}
	.keep-line a {
		color: var(--role-ink);
		font-weight: 600;
		text-decoration: underline;
	}
	.join-lost {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--step-12);
		padding: var(--step-48) var(--step-16);
		color: var(--role-ink-dim);
	}
	/* NO EYEBROWS on a Spotlight screen: the group headings are dim sentence case, not uppercase letterspaced. */
	.grouphead {
		font-size: var(--type-meta);
		font-weight: 600;
		letter-spacing: normal;
		text-transform: none;
		/* Under the find row's 24 px, so the controls -> results break still out-ranks one group -> the next. */
		margin-top: var(--step-16);
		margin-bottom: 0;
	}

	/* Declared here, never inline: an inline style outranks the short-viewport rule below and defeats it. */
	.topbar {
		display: flex;
		/* WRAPS, for the same reason `.find-row` does: at 320px with the root at 32px the wordmark alone takes most of
		   the line, and the far-edge cluster was pushed to right=341.3 in a 320px viewport — off-screen, clipped
		   rather than reflowed. Wrapping lets the cluster take its own line instead, and ONLY then: see `.me-cluster`.
		   `align-items: center` stays correct once wrapped: each line centres its own items. */
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-md);
		/* An 8 px top, not 16: the 44 px gear already sets the row, and the results need the height at 320. */
		padding: var(--step-8) var(--space-2xl) var(--space-sm);
	}
	/* A ZERO BASIS AND AN EXPLICIT FLOOR, so the wrap above is decided by the smallest the cluster can be, not by
	   the full name. With `auto` the line broke on the name's max-content width, so at 320 any name of 6+
	   characters dropped the whole cluster under the wordmark and the name's ellipsis never got to act. The floor
	   is written out because `min-width: auto` would be the name's min-content, which for one unbroken word is the
	   whole word again. It sums the cluster's fixed parts: the name's 4ch floor, the identity button's inline
	   padding and border, its gap, the 22px dot, this gap, and the 44px gear less its -10px margin. In `ch` and rem
	   tokens, so it grows with text zoom and the 200% case at 320 still wraps.
	   shortcut: the sum restates the parts below; `sing-one-search-box`'s topbar probe catches it drifting (at 390
	   with the root at 32px, a floor short by 4ch slides the dot under the gear, which its no-overlap check fails).
	   `justify-content: flex-end` does what `margin-left: auto` did, keeping the cluster on the far edge. */
	.me-cluster {
		flex: 1 1 0;
		min-width: calc(4ch + 2 * var(--space-xs) + 2px + 2 * var(--space-sm) + 22px + var(--tap) - 10px);
		justify-content: flex-end;
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
	}

	/* THE HEADER BECOMES A BAND AT --bp-md, and only there. On a phone the wordmark and the identity cluster sit about
	   a --space rung apart and need no boundary; on a desktop column they are most of the viewport apart, and with
	   nothing painted under them they read as two things adrift rather than as one header. THE GAP IS NAME-DEPENDENT,
	   so no constant here is a property of the layout: `.me-cluster` packs to the far edge, so the distance is the
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
	   Deliberately NOT the PageHeader pill: that fill is earned by being STICKY, and this header is not
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
