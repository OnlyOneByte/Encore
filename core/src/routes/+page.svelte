<script lang="ts">
	import { SINGER_COLORS } from '$lib/contract';
	import { onMount, tick } from 'svelte';
	import type { QueueEntry, Media, PublicSinger, PlaybackState } from '$lib/contract';
	import type { QueueStore } from '$lib/stores/queue';
	import { room } from '$lib/stores/room';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import JoinLanding from '$lib/components/JoinLanding.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import SongRow from '$lib/components/SongRow.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import {
		gripVisible,
		liveSortTarget,
		keyboardMoveTarget,
		rowShift,
		liveSeq,
		ordinal,
		modeInvalidation
	} from '$lib/reorder-mode';
	import {
		nextPlayableEntryId,
		queueCardKind,
		displayReadiness,
		canProcess,
		noRowsState,
		showsNoRows,
		processingGroupIds,
		type Readiness
	} from '$lib/readiness';
	import { waitShort } from '$lib/phrasing/position-sentence';
	import { queueAnnouncement } from '$lib/phrasing/queue-announcement';
	import { focusGrip, measureCarriedRowHeight, measureRowBoxes, trackDragPointer } from '$lib/queue-drag';
	import { processAndQueue } from '$lib/process-and-queue';
	import { libraryShelf } from '$lib/library-browse';
	import { drawPosition, secondTicker } from '$lib/playhead';
	import { originalKeyLabel, isProcessableSource } from '$lib/contract';
	import type { MediaStatus } from '$lib/contract';
	import { Toaster } from '$lib/components/ui/sonner';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import SkeletonRows from '$lib/ui/SkeletonRows.svelte';
	import FindField from '$lib/ui/FindField.svelte';
	import * as NativeSelect from '$lib/components/ui/native-select';
	import * as Empty from '$lib/components/ui/empty';

	let me = $state<PublicSinger | null>(null);
	let entries = $state<QueueEntry[]>([]);
	// A KIND, not a set of ids: a pending reorder is marked too, and must not borrow the add path's word.
	let pendingKind = $state<Map<string, 'add' | 'move'>>(new Map());
	let singers = $state<Map<string, PublicSinger>>(new Map());
	let mediaCatalog = $state<Map<string, Media>>(new Map());
	let connected = $state(false);
	/** In the room but unreachable. The room skips their turns, so the surface holding skip has to know. */
	let awaySingers = $state<Set<string>>(new Set());
	let playback = $state<PlaybackState>({
		currentEntryId: null,
		positionSec: 0,
		isPlaying: false,
		keyShift: 0,
		background: null,
		guideLevel: null
	});
	// Seeded from /api/library as well as media:status, so a reload mid-process keeps its progress bar.
	let mediaStatus = $state<Map<string, { status: MediaStatus; pct: number; etaSec?: number }>>(new Map());

	/* One column read top to bottom, with `searchActive` (a non-empty query) as the SOLE switch between the queue
	   view and the results view. Still no browse MODE on this column and no history entry for a search — browsing is a
	   separate ROUTE (/library), reached from the door beside the field and from the shelf's `See all`, so this column keeps
	   one switch. The library here is a four-row shelf, not the library. See docs/FRONTEND.md#the-home-column. */

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
			connected = room.connected;
			playback = room.playback;
			singers = room.singers;
			mediaCatalog = room.mediaCatalog;
			awaySingers = room.awaySingers;
			mediaStatus = room.mediaStatus;
			entries = room.entries;
			pendingKind = room.pendingKind;
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
		};
	});

	const queued = $derived(entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq));

	function liveOf(id: string) {
		return mediaStatus.get(id);
	}

	/* An empty box IS the library, so typing filters the world rather than revealing it, and a query REPLACES the
	   queue: the keyboard leaves ~350px, which a field, a heading and two queue rows would spend. */
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
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let inflight: AbortController | undefined;
	const searchActive = $derived(query.trim().length > 0);

	/* ALL THREE GROUPS TOGETHER, in one place: each is scoped to the query that produced it, so a group left behind
	   renders under whatever the box shows next. Dropping them one site at a time is how `processingResults` was
	   forgotten on the failure path. */
	function clearResults() {
		readyResults = [];
		rawResults = [];
		processingResults = [];
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
		try {
			// `music` is the route's own default, so it sends nothing — one spelling of the default, on the
			// server, instead of two that can drift.
			const source =
				searchSource === 'music' ? '' : `&source=${searchSource === 'everything' ? 'all' : searchSource}`;
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
			/* ANNOUNCED, because the search view replaces the queue and a guest using a screen reader otherwise
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
				clearResults();
				showError('Search failed.');
				// The toast is visual only; the same failure has to reach the region a screen reader is on.
				liveMsg = 'Search failed.';
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

	const processingRows = $derived.by(() => {
		const ids = processingGroupIds({
			searchActive,
			processingResults,
			mediaStatus,
			mediaCatalog,
			readiness: readinessFor
		});
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
	 * are required: the de-duplication has to cover the ready list AND the processing rows, which are ungated. It stays a
	 * plain accumulator, and the `svelte/prefer-svelte-reactivity` warning it raises stays with it — a `SvelteSet` is the
	 * wrong answer for a value recomputed wholesale, where reactive sources buy nothing. */
	const accountedFor = $derived.by(() => {
		const ids = new Set<string>();
		for (const m of searchActive ? readyResults : library) ids.add(m.id);
		for (const c of processingRows) ids.add(c.id);
		return ids;
	});
	function unaccounted(list: Media[]): Media[] {
		return list.filter((m) => !accountedFor.has(m.id));
	}
	const queuedMediaIds = $derived(new Set(queued.map((e) => e.mediaId)));
	const processingGroup = $derived(
		searchActive ? processingRows : processingRows.filter((c) => !queuedMediaIds.has(c.id))
	);

	function addSong(mediaId: string) {
		store?.addSong(mediaId);
		if (navigator.vibrate) navigator.vibrate(8);
	}
	function singThis(mediaId: string) {
		processAndQueue({
			queue: () => addSong(mediaId),
			process: () => void processMedia(mediaId),
			hasQueuedTurn: inMyQueue(mediaId)
		});
	}
	/** Request stem-separation ("make karaoke"). The live media:status broadcasts drive the row's bar. */
	async function processMedia(mediaId: string) {
		if (navigator.vibrate) navigator.vibrate(12);
		// optimistic: the row reads as processing before the request lands
		room.setMediaStatus(mediaId, { status: 'queued', pct: 0 });
		try {
			const res = await fetch('/api/process', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mediaId })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				room.clearMediaStatus(mediaId);
				showError(body.error ?? 'Could not start process');
				return;
			}
			// the stems were already on disk (processed on an earlier night) — nothing to wait for
			if (body.alreadyReady) void room.refreshLibrary();
		} catch {
			room.clearMediaStatus(mediaId);
			showError("Couldn't start that.");
		}
	}

	/*
	 * NOT `unaccounted(library)`, which self-cancels: with no query `accountedFor` is seeded from `library` itself,
	 * so subtracting it empties the primary list and "Your library" never renders. The QUEUE is deliberately not
	 * subtracted either — a queued song is still in the library, and its row says so.
	 */
	const processingIds = $derived(new Set(processingRows.map((c) => c.id)));
	const libraryRows = $derived(library.filter((m) => !processingIds.has(m.id)));

	/* A SHELF, not the library — /library is the library. The cap, the reason for its value and the rule that hides
	   the door when nothing is behind it all live in `libraryShelf`. */
	const shelf = $derived(libraryShelf(libraryRows));

	/**
	 * THE FIRST-RUN SCREEN: nothing queued, nothing in the library, nothing on the way. It gets ONE empty state
	 * instead of two, because the two it used to get said overlapping things 460px apart — `Nothing Queued`
	 * reserved `40vh` and pushed `No karaoke tracks yet.` off the fold on a phone and into the middle of a void
	 * on a desktop. The 40vh is right only when that block is the LAST thing on screen, which in this case it
	 * never is. Measured at 1335x1151: the queued empty was 460px tall with the library empty at y=641.
	 */
	const nothingYet = $derived(
		!searchActive && queued.length === 0 && libraryRows.length === 0 && processingGroup.length === 0
	);

	function showError(msg: string) {
		toast.error(msg, { duration: 4000 });
	}

	function removeWithUndo(entry: QueueEntry) {
		const mediaId = entry.mediaId;
		const title = mediaTitle(mediaId);
		store?.removeEntry(entry.id);
		if (navigator.vibrate) navigator.vibrate(8);
		toast(`Removed \u201c${title}\u201d`, {
			duration: 5000,
			action: { label: 'Undo', onClick: () => store?.addSong(mediaId) }
		});
	}

	// Announced POLITELY, never assertive. The sentence and every rule about when there is nothing to say live in
	// `$lib/phrasing/queue-announcement`; this holds only the last-seen ids, NULL until the first sync.
	let liveMsg = $state('');
	let announcedIds: string[] | null = null;
	$effect(() => {
		const announcement = queueAnnouncement({
			previousIds: announcedIds,
			queued,
			meId: me?.id,
			singerName: (id) => singers.get(id)?.displayName ?? 'Someone',
			songTitle: mediaTitle
		});
		announcedIds = queued.map((e) => e.id);
		if (announcement) liveMsg = announcement;
	});

	/** The entry's index in the WHOLE queued list — the index space `move-to-index` uses. */
	function queuedIdx(id: string): number {
		return queued.findIndex((e) => e.id === id);
	}
	/* Reordering is a LIVE SORT with no mode: `liveSortTarget` both places the rows and decides the commit, so a
	   release cannot land somewhere the guest did not see. The single-pointer alternative (SC 2.5.7 / 2.1.1) is
	   Arrow Up/Down on the grip. See $lib/reorder-mode and docs/FRONTEND.md#the-home-column. */
	let movingId = $state<string | null>(null);
	let dragging = $state(false);
	let dragY = $state(0);
	/** The dragged row's height, measured once at press time — how far its neighbours slide. */
	let rowH = $state(0);
	/**
	 * Measured once at press time, and empty except during a drag, so no stale geometry can place a row: rows
	 * change height mid-flight (a byline gains an `away` badge, another guest queues a card).
	 */
	let rowBounds = $state<{ top: number; height: number }[]>([]);
	// Announced through the SAME polite region the queue uses, and rendered visibly: a sighted guest needs it.
	let reorderNote = $state('');
	/** The grip the gesture began on, so focus can be returned to it. */
	let openerEl: HTMLElement | null = null;
	let dragTeardown: (() => void) | null = null;

	/** Where the dragged row currently sits, which is both what the list renders and what a release commits. */
	const dragFrom = $derived(movingId ? queuedIdx(movingId) : -1);
	const dragTo = $derived(
		dragging && dragFrom >= 0
			? liveSortTarget({ fromIndex: dragFrom, offsetPx: dragY, rowBoundsPx: rowBounds, count: queued.length })
			: -1
	);

	/* Every position is legal under `move-to-index`, so no ordering policy can discard a move: the only condition
	   on the grip is that a second position exists. Both row kinds take THIS value, never a literal. */
	const gripsVisible = $derived(gripVisible({ queuedCount: queued.length, reorderMeaningful: true }));

	function commitMove(id: string, to: number | null) {
		if (to === null) return;
		const from = queuedIdx(id);
		if (from < 0 || to === from) return;
		store?.moveToIndex(id, to);
		if (navigator.vibrate) navigator.vibrate(8);
	}

	/** One place per press, committed immediately; `keyboardMoveTarget` declines at the ends. */
	function nudge(id: string, delta: number) {
		const from = queuedIdx(id);
		const to = keyboardMoveTarget(from, delta, queued.length);
		if (to === null) return;
		commitMove(id, to);
		liveMsg = `Moved to ${ordinal(to + 1)} in the queue.`;
		// After the patch lands, because the row's DOM is recreated at its new position.
		void tick().then(() => focusGrip(id));
	}

	/** End the gesture. `commit` false for a cancel or an invalidation — those commit NOTHING. */
	function endDrag(commit: boolean, note = '') {
		const id = movingId;
		const to = dragTo;
		dragTeardown?.();
		dragTeardown = null;
		if (commit && id) commitMove(id, to >= 0 ? to : null);
		movingId = null;
		dragging = false;
		dragY = 0;
		rowH = 0;
		rowBounds = [];
		reorderNote = note;
		if (note) liveMsg = note;
		// After the patch lands; `openerEl` is the fallback for a row that has gone entirely.
		void tick().then(() => {
			focusGrip(id, openerEl);
			openerEl = null;
		});
	}

	/** Publishes the offset as a custom property for a transform to read; the target is arithmetic, not a hit-test. */
	function onGripPointerDown(entry: QueueEntry, e: PointerEvent) {
		const grip = e.currentTarget as HTMLElement | null;
		if (!grip) return;
		movingId = entry.id;
		dragging = true;
		dragY = 0;
		reorderNote = '';
		openerEl = grip;
		// A pointer press does not focus a button in every engine, so an Escape cancel would have no origin.
		grip.focus?.();
		// Both reads happen ONCE, here, and nothing is measured again for the life of the gesture.
		rowH = measureCarriedRowHeight(grip);
		rowBounds = measureRowBoxes();
		dragTeardown = trackDragPointer(e, {
			onMove: (offsetY) => (dragY = offsetY),
			onEnd: () => endDrag(true),
			onCancel: () => endDrag(false)
		});
	}

	// The queue moving under a drag needs no handling — the live sort is relative to where the row IS. Only the
	// dragged song leaving, starting to play, or the queue falling below two invalidates the gesture.
	$effect(() => {
		const reason = modeInvalidation(queued, movingId, entries.find((e) => e.id === movingId)?.status);
		if (reason) endDrag(false, reason);
	});
	/** What will ACTUALLY play next, skipping anything still processing, matching the server's nextPlayable. */
	const nextPlayableId = $derived(
		nextPlayableEntryId(
			queued,
			(id) => mediaCatalog.get(id),
			(id) => mediaStatus.get(id)
		)
	);

	const nowEntry = $derived(entries.find((e) => e.id === playback.currentEntryId));

	// `playback` is a whole-object $state the store REPLACES on every broadcast, so this anchor effect re-runs on any
	// playback change. Mirroring the fields as scalars would narrow that and strand the anchor.
	/* Once a second, not a frame: the bar's width transition covers the gap. Re-arms on every playback change, so a
	   seek snaps instead of sliding. The anchor is captured INSIDE the effect for the reason the layout's twin gives,
	   and `drawPosition` floors the elapsed term where the hand-rolled version did not. */
	let displayPos = $state(0);
	$effect(() => {
		const positionSec = playback.positionSec;
		const anchoredAtMs = performance.now();
		const playing = playback.isPlaying;
		displayPos = positionSec;
		return secondTicker(playing, () => {
			displayPos = drawPosition({ positionSec, playing, anchoredAtMs, nowMs: performance.now() });
		});
	});
	const nowDurationSec = $derived(nowEntry ? (mediaCatalog.get(nowEntry.mediaId)?.durationSec ?? 0) : 0);

	/* The wait degrades honestly in ONE place (`waitShort`): one entry ahead with no resolvable length makes the
	   whole estimate unknown, and an unknown estimate is OMITTED, never zeroed. */
	const myNextEntry = $derived(
		entries
			.filter((e) => e.singerId === me?.id && e.status === 'queued')
			.sort((a, b) => a.rotationSeq - b.rotationSeq)[0]
	);
	/** 0 when nothing plays; NULL when something plays whose length is unknown — not the same as 0. */
	const nowRemainingSec = $derived.by(() => {
		if (!nowEntry) return 0;
		if (nowDurationSec <= 0) return null;
		return Math.max(0, nowDurationSec - displayPos);
	});
	/** Joins only the TRUE parts, so a row can never render a stray separator. */
	function queueSubtitle(e: QueueEntry): string {
		return [e.id === nextPlayableId ? 'up next' : '', e.id === myNextEntry?.id ? myWait : null]
			.filter(Boolean)
			.join(' · ');
	}

	/** "~3 min" for MY next row, or null when any length ahead is unknown (and then no clause renders). */
	const myWait = $derived.by(() => {
		if (!myNextEntry) return null;
		const idx = queued.findIndex((e) => e.id === myNextEntry.id);
		if (idx < 0) return null;
		return waitShort(
			nowRemainingSec,
			queued.slice(0, idx).map((e) => mediaCatalog.get(e.mediaId)?.durationSec ?? null)
		);
	});
</script>

<!-- Joined singers only: unjoined, JoinLanding paints its own brand, so both would say "Encore" twice. -->
{#if me}
	<header class="topbar">
		<h1 class="brand"><Icon name="mic" /> <span class="grad-text">Encore</span></h1>
		<!-- The store keeps accepting taps while offline (they resend on resync), so a dead socket must not look live. -->
		{#if me && !connected}
			<span class="offline-pill" role="status" aria-live="polite">
				<Icon name="warning" /> Reconnecting…
			</span>
		{/if}
		{#if me}
			<div class="me-cluster">
				<div class="me-slot">
					<Button variant="identity" href="/settings?tab=you" aria-label="Your profile">
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

<!-- `--row-h` is the one measured row height, which the shifting rows multiply by their `--row-shift` count. It is
	0 except during a drag, so no stale shift count can displace a row while nothing is dragged. -->
<main style="--row-h:{rowH}px">
	{#if me}
		<!-- The field is the FIRST thing on the screen, and not sticky — see the `.findbox` rule for why.
				THE LIBRARY DOOR SITS BESIDE IT, not in the topbar and not after the queue. Beside the field is the one
				place that states the relationship: finding a song you do not have and browsing the ones you do are
				PEERS, so they share a row. After the rotation it was reachable only by scrolling past every queued
				song, which is the whole complaint.
				ON THE LEADING EDGE, because the field's TRAILING edge is already occupied — a spinner while a search
				runs and the clear `×` whenever one is active — so a control placed after the box joins a cluster of
				three and moves as that cluster changes. Here its position never shifts.
				`secondary`, NOT `ghost` and NOT `outline`: a ghost is a bare glyph, and `outline` fills with
				`bg-background` — the PAGE colour — so beside a `--card` field it reads as a hole punched in the row
				instead of a control. `secondary` puts it on `--card2`, one step ABOVE the field's own surface, which
				is what makes it the prominent thing in the row. Always rendered, even with an empty library — a
				destination that comes and goes cannot be learned, and /library says plainly when it holds nothing.
				The LABELLED entry point is the `See all N songs` row under the shelf, where the name gets taught. -->
		<div class="find-row">
			<div class="lib-slot">
				<Button variant="secondary" size="icon" href="/library" aria-label="Your library" title="Your library">
					<Icon name="library" />
				</Button>
			</div>
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

		{#if searching && rawResults.length === 0 && readyResults.length === 0}
			<SkeletonRows label="Searching…" />
		{/if}

		<!-- One scroll, two views: everything to the library is gated on `searchActive`. -->
		{#if nothingYet}
			<!-- ONE state for the whole screen. No `Queued` heading either: a section label above nothing is a
					promise the page cannot keep, and the only useful instruction here points back at the field above. -->
			<Empty.Root>
				<div class="queue-empty">
					<!-- A MARK, and it is not decoration: this block is the whole screen on a first run, and a lone sentence in a
							void reads as a page that failed to load rather than as a state someone designed. `aria-hidden` because the
							title beside it already says this in words. -->
					<span class="empty-mark" aria-hidden="true"><Icon name="mic" /></span>
					<Empty.Header>
						<!-- `Empty.Title` renders a <div>, so a zero-state's headline carried no heading SEMANTICS — and the
							 zero-state branches REPLACE every `<h2 class="grouphead">` on this column, so on a first run the
							 only heading in the whole document was the wordmark. A guest cycling headings to orient learned
							 nothing about what the app is. Added at the call site, not by re-vendoring, which is the precedent
							 `settings/+page.svelte:388` set for `Card.Title` and recorded there. -->
						<Empty.Title role="heading" aria-level={2}>Nothing queued yet</Empty.Title>
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
		{#if !searchActive && !nothingYet}
			<h2 class="grouphead">Queued</h2>
			<!-- Not mode chrome: a drag invalidated mid-flight has to say why, visibly as well as announced. -->
			{#if reorderNote}
				<p class="reorder-note">{reorderNote}</p>
			{/if}
			{#if queued.length === 0}
				<!-- `Empty.Root` is load-bearing: a designed empty state is recognised by that primitive, so a bare
						paragraph reports this route as having none. ALWAYS `tight` here — this branch only runs when the
						library or the processing group has rows below, and the 40vh void is for a block with nothing
						after it. `nothingYet` above owns the case where this really is the whole screen. -->
				<Empty.Root>
					<div class="queue-empty tight">
						<Empty.Header>
							<Empty.Title role="heading" aria-level={2}>Nothing Queued</Empty.Title>
						</Empty.Header>
					</div>
				</Empty.Root>
			{:else}
				{#each queued as e, i (e.id)}
					{@const s = singers.get(e.singerId)}
					{@const card = queueCardKind(mediaCatalog.get(e.mediaId), mediaStatus.get(e.mediaId))}
					{#if card === 'processing' || card === 'failed'}
						{@const proc = mediaStatus.get(e.mediaId) ?? { status: 'failed' as MediaStatus, pct: 0 }}
						<ProcessingCard
							seq={liveSeq(i, dragFrom, dragTo)}
							title={mediaTitle(e.mediaId)}
							singerName={e.singerId === me?.id ? 'You' : (s?.displayName ?? 'Guest')}
							singerColor={s?.color ?? SINGER_COLORS[0]}
							singerAway={awaySingers.has(e.singerId)}
							status={proc.status}
							pct={proc.pct}
							pending={pendingKind.get(e.id) ?? null}
							onremove={e.singerId === me?.id ? () => removeWithUndo(e) : undefined}
							reorderable={gripsVisible}
							shift={rowShift(i, dragFrom, dragTo)}
						/>
					{:else}
						<!-- `seq` is the LIVE position, never the source index: `liveSeq` reads the same shift arithmetic that
								places the row, so a number never corrects itself when the patch lands. -->
						<QueueRow
							seq={liveSeq(i, dragFrom, dragTo)}
							title={mediaTitle(e.mediaId)}
							singerName={e.singerId === me?.id ? 'You' : (s?.displayName ?? 'Guest')}
							singerColor={s?.color ?? SINGER_COLORS[0]}
							mine={e.singerId === me?.id}
							singerAway={awaySingers.has(e.singerId)}
							up={e.id === nextPlayableId}
							pending={pendingKind.get(e.id) ?? null}
							subtitle={queueSubtitle(e)}
							removable={e.singerId === me?.id}
							grip={gripsVisible}
							gripId={e.id}
							moving={movingId === e.id && dragging}
							dragY={movingId === e.id && dragging ? dragY : 0}
							shift={rowShift(i, dragFrom, dragTo)}
							ongripdown={(ev) => onGripPointerDown(e, ev)}
							onnudge={(delta) => nudge(e.id, delta)}
							onremove={() => removeWithUndo(e)}
						/>
					{/if}
				{/each}
			{/if}
		{/if}

		<!-- Ungated on purpose: what is being made now is equally relevant in both views, and its MEMBERSHIP is
				query-scoped at the data layer, which decides row by row where a template gate could not. -->
		{#if processingGroup.length}
			<h2 class="grouphead">Making karaoke…</h2>
			{#each processingGroup as c (c.id)}
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
		{/if}

		{#if !searchActive && !nothingYet}
			<!-- Every heading here is gated on having rows: a group heading is a claim about what follows it. -->
			{#if libraryRows.length}
				<h2 class="grouphead">Your library</h2>
				{#each shelf.shown as m (m.id)}
					<SongRow {...rowMeta(m)} readiness="ready" inQueue={inMyQueue(m.id)} onadd={() => addSong(m.id)} />
				{/each}
				<!-- The LABELLED door to /library, stating the number it hides: "See all" alone gives no reason to tap, and
						the count is the only thing here that says this shelf is a subset. Gated on rows ACTUALLY being hidden —
						with three songs there is nothing behind it, and the door beside the field still goes there. -->
				{#if shelf.hidden > 0}
					<div class="showall-row">
						<Button variant="secondary" size="tap" href="/library">
							<Icon name="library" /> See all {libraryRows.length} songs
						</Button>
					</div>
				{/if}
			{:else if processingRows.length === 0}
				<!-- Nothing ready AND nothing on the way: the only genuinely empty library.
						 `processingRows`, NOT `processingGroup`: the group deliberately hides a song that is ALREADY
						 QUEUED (the queue renders its own progress card), so gating on it printed "No karaoke tracks
						 yet." directly beneath a live card at 34%. The unfiltered set is the honest test for
						 "nothing is on the way", which is what this sentence claims. -->
				<Empty.Root>
					<Empty.Header>
						<Empty.Title role="heading" aria-level={2}>No karaoke tracks yet.</Empty.Title>
						<Empty.Description>Search above for a song and we'll make one.</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{/if}
		{/if}

		{#if searchActive}
			{#if readyResults.length}
				<h2 class="grouphead">Ready to sing</h2>
				{#each readyResults as m (m.id)}
					<SongRow {...rowMeta(m)} readiness="ready" inQueue={inMyQueue(m.id)} onadd={() => addSong(m.id)} />
				{/each}
			{/if}

			{@const rawRows = unaccounted(rawResults)}
			{#if rawRows.length}
				<h2 class="grouphead">Needs karaoke</h2>
				{#each rawRows as m (m.id)}
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

			{#if showsNoRows({ searching, readyCount: readyResults.length, rawCount: rawRows.length, processingCount: processingRows.length })}
				{@const empty = noRowsState({ searchActive, libraryCount: library.length, query })}
				<Empty.Root>
					<Empty.Header>
						<Empty.Description>{empty.message}</Empty.Description>
					</Empty.Header>
				</Empty.Root>
				{#if empty.showAllCount !== null}
					<div class="showall-row">
						<Button variant="secondary" size="tap" onclick={clearSearch}>
							<Icon name="mic" /> Show all {empty.showAllCount}
						</Button>
					</div>
				{/if}
			{/if}
		{/if}
	{:else}
		<JoinLanding />
	{/if}
</main>

<!-- `richColors` stays off: the error tone comes from Encore's own --destructive. -->
<Toaster position="bottom-center" offset="var(--dock-h, 0px)" style="--width: min(92vw, 420px);" />

<!-- On the window, not a row: mid-gesture focus sits on the grip, so a keyboard cancel must work anywhere. Guarded
	on `dragging` so it never swallows an Escape the rest of the page wants. -->
<svelte:window onkeydown={(e) => dragging && e.key === 'Escape' && endDrag(false)} />

<div class="sr-live" role="status" aria-live="polite" aria-atomic="true">{liveMsg}</div>

<style>
	/* Reserves the band's MEASURED height so the last row stays reachable, with a fallback for the first frame. No
	   env() term — the band carries the only inset, and it arrives through --dock-h. */
	main {
		flex: 1;
		padding: var(--space-xs) var(--space-3xl) calc(var(--dock-h, 0px) + 28px);
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

	.reorder-note {
		margin: 0 0 var(--space-sm);
		font-size: var(--ph-text-sm);
		color: var(--warn);
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
	.grouphead:first-of-type {
		margin-top: var(--space-2xs);
	}

	/* THE FIELD AND THE LIBRARY DOOR, one row. The bottom margin lives HERE rather than on `.findbox`, or the two
	   controls would carry separate spacing and the shorter one would not clear the group below it.
	   `stretch`, NOT `center`: the field is 70px at every width (--space-lg twice, a --tap-floored input and the
	   border), while `size="icon"` is a FIXED 44px square, so centring left the door 26px short of the thing it
	   sits beside. Stretching binds the two heights together instead of restating a number that would then drift
	   from the field's padding. */
	.find-row {
		display: flex;
		align-items: stretch;
		flex-wrap: wrap;
		gap: var(--space-md);
		margin-bottom: var(--space-lg);
	}
	/* The field takes the rest of the row and is the half that SHRINKS — `min-width: 0` is what lets it, and without
	   it the 44px door would be pushed off the edge at 320px instead. */
	.field-slot {
		flex: 1;
		min-width: 0;
	}
	/* A wrapper, because a class handed to <Button> is scoped to this file where Svelte strips it as unused. `0 0 auto`
	   is load-bearing: beside a field that shrinks, an unpinned 44px control is what collapses instead. */
	.lib-slot {
		flex: 0 0 auto;
		display: flex;
	}
	/* THE PICKER YIELDS THE ROW, NOT THE FIELD, and this cost a measurement to learn. It was first pinned
	   `flex: 0 0 auto` by copying `.lib-slot` above — but that pin's comment was written when the row held TWO
	   controls, where an unpinned 44px door was the thing that would collapse. With a third pinned sibling the
	   only flexible item left is the field, and it absorbed the whole deficit: measured in headless Chromium at
	   320px the search input's content box was 12px, and 4px mid-search once FindField's spinner and clear
	   button took their share — the primary control of the primary surface, showing about one letter and no
	   caret. Below --bp-sm the picker takes its own line instead (142px idle / 63px searching at 320px, and no
	   overflow). The literal is required: a media condition is evaluated before the cascade and cannot read
	   var(--bp-sm). */
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
	/* `size-tap` sets a fixed height as well as a width, so filling the stretched slot needs this override. Keyed on
	   the primitive's OWN `data-slot` and anchored under `.lib-slot`, which is the sanctioned form — a bare class rule
	   would compile to a hash that lands on nothing. Only the HEIGHT is released: the 44px width stays, so the door
	   reads as a control paired with the field rather than a second box competing with it, and the tap floor holds on
	   both axes by construction. */
	.lib-slot :global([data-slot='button']) {
		height: 100%;
	}

	.showall-row {
		display: flex;
		justify-content: center;
		padding: 0 0 var(--space-sm);
	}

	/* `min-height`, not an absolute centring trick: this block sits in a scrolling column whose height three other
	   rules already own. `overflow-wrap: anywhere` is the 320px reflow clause — at --ph-text-3xl and 200% text one
	   unbreakable word is wider than the viewport. The size reaches the vendored slot through `:global()`. */
	/* FLEX COLUMN, not `grid` + `place-items: center`. The vendored `Empty.Header` is `display: contents`, so its
	   children become direct children of THIS box — under grid they became two auto rows that split the 40vh
	   between them and put the description 220px below its own title. A centred flex column stacks them as one
	   group with a real gap, and reads the same when there is only a title. */
	.queue-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-lg);
		/* 32vh, DOWN FROM 40: the block now carries a mark, a title, a line and a button, so the void that used to stand in
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
	/* See the markup note: the void is only right when nothing follows the state. */
	.queue-empty.tight {
		min-height: 0;
	}
	/* THE SPACE IS LOAD-BEARING. Without it this is a COMPOUND selector — one element carrying both `.queue-empty`
	   and `data-slot="empty-title"` — and `empty-title` is a GRANDCHILD (through `Empty.Header`, which computes to
	   `display: contents`). It matched nothing, silently: `:global()` suppresses Svelte's unused-selector warning,
	   so the size, weight and the `overflow-wrap` reflow clause below never applied and the title rendered at the
	   vendored `text-lg`. */
	/* --ph-text-2xl, DOWN FROM 3xl (2.6rem / ~42px). The old size was both the largest type in the app AND dimmed by
	   `.encore-empty`'s --ink-dim, which is the worst pair available: big enough to dominate the screen, faint enough to
	   read as a placeholder nobody finished. Full --ink at a heading size states it once, properly. It also now agrees
	   with /library's twin, which was already at this step. */
	.queue-empty :global([data-slot='empty-title']) {
		font-size: var(--ph-text-2xl);
		line-height: var(--lh-snug);
		font-weight: 700;
		color: var(--ink);
		overflow-wrap: anywhere;
	}
	/* --warn, not --danger: a dropped socket self-heals on the next backoff tick. */
	.offline-pill {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		color: var(--warn);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-pill);
		padding: var(--space-2xs) var(--space-md);
		font-size: var(--ph-text-sm);
		white-space: nowrap;
		/* NOWRAP WITHOUT A FLOOR IS UNSHRINKABLE, and this pill sits in the topbar flex beside the singer's
		   identity and the settings gear. With min-content == max-content == 133px, flexbox had nothing to
		   take: measured at 320px with the pill showing, `scrollWidth` was 334 against a 320 viewport — a
		   horizontal scrollbar on the home screen (SC 1.4.10) with the gear's right edge at 334, i.e. off the
		   display. It fires exactly when the wifi is flaky at a party, which is when the pill exists at all. */
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* Declared here, never inline: an inline style outranks the short-viewport rule below and defeats it. */
	.topbar {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		padding: var(--space-2xl) var(--space-3xl) var(--space-sm);
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

	/* Nothing in this file animates, so there is no reduce arm: motion is opt-in inside the components. */

	/* Short viewports (a phone held sideways) spend almost the whole height on chrome, so the chrome shrinks.
	   --dock-h is NOT overridden here: an inline custom property on :root outranks this rule. */
	@media (max-height: 480px) {
		.topbar {
			padding: var(--space-xs) var(--space-3xl) var(--space-2xs);
		}
		main {
			padding-top: var(--space-3xs);
		}
		.grouphead {
			margin: var(--space-sm) var(--space-2xs) var(--space-2xs);
		}
	}
</style>
