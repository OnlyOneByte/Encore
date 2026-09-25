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
		readyEmptyState,
		processingGroupIds,
		type Readiness
	} from '$lib/readiness';
	import { waitShort } from '$lib/phrasing/position-sentence';
	import { queueAnnouncement } from '$lib/phrasing/queue-announcement';
	import { focusGrip, measureCarriedRowHeight, measureRowBoxes, trackDragPointer } from '$lib/queue-drag';
	import { processAndQueue } from '$lib/process-and-queue';
	import { libraryShelf } from '$lib/library-browse';
	import { originalKeyLabel, isProcessableSource } from '$lib/contract';
	import type { MediaStatus } from '$lib/contract';
	import { Toaster } from '$lib/components/ui/sonner';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Spinner } from '$lib/components/ui/spinner';
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
		try {
			const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
			if (ctrl.signal.aborted) return;
			const j = await res.json();
			readyResults = j.ready ?? [];
			rawResults = j.results ?? [];
			processingResults = j.processing ?? [];
			room.mergeMedia([...readyResults, ...rawResults, ...processingResults]);
		} catch (e) {
			if ((e as Error).name !== 'AbortError') {
				clearResults();
				showError('Search failed.');
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

	/** Ids another group already shows, so no song appears twice and no job draws two progress bars. THE TWO `ids.add`
	 * LOOPS ARE PINNED BY `browse-screen.test.ts` mechanism 1, which reads them as source text to prove the
	 * de-duplication covers both the ready list and the processing rows ungated — so this stays an accumulator, and the
	 * `svelte/prefer-svelte-reactivity` warning it raises stays with it. A `SvelteSet` would be the wrong answer anyway:
	 * this is a plain value recomputed wholesale, so reactive sources on it buy nothing. */
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
	let posAnchor = { pos: 0, wall: 0 };
	$effect(() => {
		posAnchor = { pos: playback.positionSec, wall: performance.now() };
	});
	function livePositionSec(): number {
		return playback.isPlaying ? posAnchor.pos + (performance.now() - posAnchor.wall) / 1000 : posAnchor.pos;
	}

	// Once a second, not a frame: the bar's width transition covers the gap. Re-arms on every playback change, so a
	// seek snaps instead of sliding.
	let displayPos = $state(0);
	$effect(() => {
		displayPos = playback.positionSec;
		if (!playback.isPlaying) return;
		const id = setInterval(() => (displayPos = livePositionSec()), 1000);
		return () => clearInterval(id);
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
		<h1 class="brand"><Icon name="mic" /> <span class="wordmark">Encore</span></h1>
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
			<div class="findbox">
				<span class="find-mark"><Icon name="search" /></span>
				<input
					bind:this={queryEl}
					bind:value={query}
					oninput={onQueryInput}
					aria-label="Search a song or artist"
					placeholder="Search a song or artist…"
				/>
				{#if searching}<Spinner aria-label="Searching" />{/if}
				{#if searchActive}
					<Button variant="ghost" size="icon" aria-label="Clear the search" onclick={clearSearch}>
						<Icon name="close" />
					</Button>
				{/if}
			</div>
		</div>

		{#if searching && rawResults.length === 0 && readyResults.length === 0}
			<div aria-busy="true" aria-label="Searching…">
				{#each [0, 1, 2] as i (i)}
					<div class="skel-row">
						<Skeleton variant="thumb" />
						<div class="skel-text">
							<Skeleton />
							<Skeleton variant="line-short" />
						</div>
					</div>
				{/each}
			</div>
		{/if}

		<!-- One scroll, two views: everything to the library is gated on `searchActive`. -->
		{#if nothingYet}
			<!-- ONE state for the whole screen. No `Queued` heading either: a section label above nothing is a
					promise the page cannot keep, and the only useful instruction here points back at the field above. -->
			<Empty.Root>
				<div class="queue-empty">
					<Empty.Header>
						<Empty.Title>Nothing queued yet</Empty.Title>
						<Empty.Description>Search above for a song and we'll make the karaoke track.</Empty.Description>
					</Empty.Header>
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
							<Empty.Title>Nothing Queued</Empty.Title>
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
							dimmed={false}
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
							dimmed={false}
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
			{:else if processingGroup.length === 0}
				<!-- Nothing ready AND nothing on the way: the only genuinely empty library. -->
				<Empty.Root>
					<Empty.Header>
						<Empty.Title>No karaoke tracks yet.</Empty.Title>
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

			{#if !searching && rawResults.length === 0 && readyResults.length === 0}
				<Empty.Root>
					<Empty.Header>
						<Empty.Description>No results. YouTube search needs yt-dlp on the server.</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{/if}

			<!-- Nothing singable matched but the library has songs: clearing the box restores both it and the queue. -->
			{#if !readyResults.length && library.length}
				{@const empty = readyEmptyState({ searchActive, libraryCount: library.length, query })}
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
	.wordmark {
		background: var(--grad);
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
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
		min-width: 0;
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
	.grouphead {
		font-size: var(--ph-text-2xs);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-dim);
		font-weight: 700;
		margin: var(--space-2xl) var(--space-2xs) var(--space-sm);
	}
	.grouphead:first-of-type {
		margin-top: var(--space-2xs);
	}

	/* The field is in NORMAL FLOW, and so is `.topbar` above it — neither is stuck to the viewport. (An earlier note
	   here claimed the topbar was sticky; it never declares `position`, and the bottom edge is the band's anyway.) A
	   second sticky surface would need the header's RENDERED height as its offset, and an out-of-scale token in that
	   calc() invalidates the declaration silently. The focus ring belongs to the WHOLE box, which is why app.css's
	   global input ring is suppressed below. */
	.findbox {
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		display: flex;
		align-items: center;
		gap: var(--space-md);
		padding: var(--space-lg) var(--space-xl);
		min-height: 52px;
		/* `flex: 1` plus `min-width: 0`, NOT `width: 100%`: the box now shares a row with the library door, and at
		   100% it would claim the whole row and push that control off the edge. min-width:0 is what lets it shrink
		   under SC 1.4.10 reflow at 320px, where the 44px door and the gap come out of this box's width. */
		flex: 1;
		min-width: 0;
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
		gap: var(--space-md);
		margin-bottom: var(--space-lg);
	}
	/* A wrapper, because a class handed to <Button> is scoped to this file where Svelte strips it as unused. `0 0 auto`
	   is load-bearing: beside a field that shrinks, an unpinned 44px control is what collapses instead. */
	.lib-slot {
		flex: 0 0 auto;
		display: flex;
	}
	/* `size-tap` sets a fixed height as well as a width, so filling the stretched slot needs this override. Keyed on
	   the primitive's OWN `data-slot` and anchored under `.lib-slot`, which is the sanctioned form — a bare class rule
	   would compile to a hash that lands on nothing. Only the HEIGHT is released: the 44px width stays, so the door
	   reads as a control paired with the field rather than a second box competing with it, and the tap floor holds on
	   both axes by construction. */
	.lib-slot :global([data-slot='button']) {
		height: 100%;
	}
	.findbox input {
		border: 0;
		background: transparent;
		color: var(--ink);
		font-size: var(--ph-text-base);
		/* flex + min-width:0, never width:100% — the box must be able to shrink under SC 1.4.10 reflow. */
		flex: 1;
		min-width: 0;
		/* The input, not the wrapper, is the tap target. */
		min-height: var(--tap);
	}
	.findbox:has(input:focus-visible) {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.findbox input:focus-visible {
		outline: none;
	}
	.find-mark {
		display: grid;
		place-items: center;
		color: var(--ink-dim);
	}

	.skel-row {
		display: flex;
		align-items: center;
		gap: var(--space-lg);
		padding: var(--space-lg) var(--space-xl);
		margin-bottom: var(--space-sm);
		border-radius: var(--radius-sm);
		background: var(--card);
		border: 1px solid var(--line);
	}
	.skel-text {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	.showall-row {
		display: flex;
		justify-content: center;
		padding: 0 0 var(--space-sm);
	}

	@media (max-height: 480px) {
		.findbox {
			min-height: var(--tap);
			padding: var(--space-sm) var(--space-xl);
		}
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
		gap: var(--space-sm);
		min-height: 40vh;
		padding: var(--space-2xl) var(--space-md);
		text-align: center;
	}
	/* See the markup note: the void is only right when nothing follows the state. */
	.queue-empty.tight {
		min-height: 0;
	}
	.queue-empty:global([data-slot='empty-title']) {
		font-size: var(--ph-text-3xl);
		line-height: var(--lh-snug);
		font-weight: 700;
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
