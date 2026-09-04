<script lang="ts">
	import { SINGER_COLORS, TV_BACKGROUND_STYLES } from '@encore/shared';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { ServerEvent, QueueEntry, Media, PublicSinger, PlaybackState, PlayerCommand } from '@encore/shared';
	import { QueueStore } from '$lib/stores/queue';
	import { WsClient } from '$lib/ws/client';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import SongRow from '$lib/components/SongRow.svelte';
	import QueueSheet from '$lib/components/QueueSheet.svelte';
	import GuidingTrack from '$lib/components/GuidingTrack.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { cookAndQueue } from '$lib/cook-and-queue';
	import { displayReadiness, canCook, readyEmptyState, nextPlayableEntryId, entryPlayable, type Readiness } from '$lib/readiness';
	import type { MediaStatus } from '@encore/shared';
	import { isPlayable, hasGuidingTrack, effectiveGuideLevel } from '@encore/shared';

	let me = $state<PublicSinger | null>(null);
	let entries = $state<QueueEntry[]>([]);
	let singers = $state<Map<string, PublicSinger>>(new Map());
	let mediaCatalog = $state<Map<string, Media>>(new Map());
	let connected = $state(false);
	let playback = $state<PlaybackState>({
		currentEntryId: null,
		positionSec: 0,
		isPlaying: false,
		keyShift: 0,
		background: null,
		guideLevel: null
	});
	// live make-karaoke progress per mediaId — driven by media:status broadcasts AND seeded
	// from /api/library on load, so a reload mid-cook doesn't lose the progress bar.
	let mediaStatus = $state<Map<string, { status: MediaStatus; pct: number; etaSec?: number }>>(new Map());
	let sheetOpen = $state(false);

	let store: QueueStore;
	let ws: WsClient;

	// derived: my position in the rotation + who's right before me
	const myNextEntry = $derived(
		entries.filter((e) => e.singerId === me?.id && e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq)[0]
	);
	const myPositionLabel = $derived.by(() => {
		if (!myNextEntry) return '';
		const q = entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq);
		const idx = q.findIndex((e) => e.id === myNextEntry.id);
		if (idx < 0) return '';
		// Only claim "up next" when the song can actually play next. Ranking by raw rotationSeq said
		// "You're up next!" for a still-cooking song that the TV skips straight past, contradicting the
		// playable-aware badge in the queue list below.
		if (idx === 0) {
			const playable = entryPlayable(mediaCatalog.get(myNextEntry.mediaId), liveOf(myNextEntry.mediaId));
			return playable ? "You're up next!" : "You're next once it's ready";
		}
		const before = q[idx - 1];
		const beforeName = before ? singers.get(before.singerId)?.displayName ?? 'someone' : 'someone';
		return `You're #${idx + 1} · after ${beforeName}`;
	});

	function mediaTitle(id: string): string {
		const m = mediaCatalog.get(id);
		return m ? `${m.title}${m.artist ? ' — ' + m.artist : ''}` : id;
	}
	function singerOf(id: string): PublicSinger | undefined {
		return singers.get(id);
	}
	/** Merge media into the client catalog. The catalog is otherwise fed ONLY by queue:sync/patch, so
	 *  a song that came from search or the library — and is not (yet) in anyone's queue — has no
	 *  resolvable title: a cooking card would render a raw ULID. */
	function mergeMedia(list: Media[]) {
		if (!list.length) return;
		const next = new Map(mediaCatalog);
		for (const m of list) next.set(m.id, m);
		mediaCatalog = next;
	}

	onMount(() => {
		let disposed = false;
		(async () => {
			const res = await fetch('/api/me');
			if (!res.ok) {
				await goto('/join');
				return;
			}
			me = (await res.json()).singer;
			if (disposed || !me) return;

			store = new QueueStore({
				singerId: me.id,
				sendCommand: (cmd) => ws.send({ type: 'queue:command', command: cmd }),
				onReject: (reason) => showError(`Couldn't do that: ${reason}`)
			});
			store.subscribe((e) => (entries = e));

			ws = new WsClient({
				url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=phone`,
				getLastRev: () => store.rev,
				onEvent: (e: ServerEvent) => {
					if (e.type === 'queue:sync') {
						if (e.singers) singers = new Map(e.singers.map((s) => [s.id, s]));
						if (e.media) mediaCatalog = new Map(e.media.map((m) => [m.id, m]));
						// The room's guiding-track default — needed to LABEL the control, since a null
						// per-song override means "inherit" and the phone would otherwise show 0%.
						if (e.settings) roomGuideDefault = e.settings.room.guideLevelDefault;
						queueMicrotask(() => store.resendPending());
					}
					if (e.type === 'queue:patch' && e.patch.media) mergeMedia(e.patch.media);
					if (e.type === 'singer:joined') singers = new Map(singers).set(e.singer.id, e.singer);
					if (e.type === 'playback:state') playback = e.state;
					// A room default changed mid-party: adopt it so the guiding-track control keeps
					// reporting the level the TV is actually mixing at.
					if (e.type === 'settings:changed') roomGuideDefault = e.settings.room.guideLevelDefault;
					if (e.type === 'media:status') {
						const next = new Map(mediaStatus);
						next.set(e.mediaId, { status: e.status, pct: e.pct, etaSec: e.etaSec });
						mediaStatus = next;
						// reflect the flip on the catalog copy so readiness agrees without a full sync
						const m = mediaCatalog.get(e.mediaId);
						if (m) {
							const nm = new Map(mediaCatalog);
							nm.set(e.mediaId, { ...m, stemStatus: e.status === 'ready' ? 'ready' : 'queued' });
							mediaCatalog = nm;
						}
						// a song that just finished cooking belongs in the saved library now
						if (e.status === 'ready') loadLibrary();
					}
					store.onServerEvent(e);
				}
			});
			ws.open();
			connected = true;
			loadShortcuts();
			loadLibrary();
		})();
		return () => {
			disposed = true;
			ws?.close();
		};
	});

	function addSong(mediaId: string) {
		store?.addSong(mediaId);
		if (navigator.vibrate) navigator.vibrate(8);
		setTimeout(loadShortcuts, 300); // refresh popular/recent after the add lands
	}

	/**
	 * "✨ Sing" — the raw row's ONE action: take the turn, then start the cook.
	 *
	 * Order is load-bearing, not stylistic: the core derives the cook's job priority from the rotation
	 * position of the turns pointing at that media, so cooking first files the job at
	 * NO_QUEUE_PRIORITY — behind the lyrics backfill — while a singer stands there waiting. See
	 * $lib/cook-and-queue.ts for the full reasoning and its test.
	 */
	function singThis(mediaId: string) {
		cookAndQueue({ queue: () => addSong(mediaId), cook: () => void makeKaraoke(mediaId) });
	}

	/** Request stem-separation ("make karaoke") — flips the song to a cooking file server-side; the
	 *  live media:status broadcasts then drive the row's progress bar. */
	async function makeKaraoke(mediaId: string) {
		if (navigator.vibrate) navigator.vibrate(12);
		// optimistic: the row reads as cooking immediately, before the request lands
		mediaStatus = new Map(mediaStatus).set(mediaId, { status: 'queued', pct: 0 });
		try {
			const res = await fetch('/api/make-karaoke', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mediaId })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				mediaStatus = new Map([...mediaStatus].filter(([id]) => id !== mediaId));
				showError(body.error ?? 'Could not start make-karaoke');
				return;
			}
			// the stems were already on disk (cooked on an earlier night) — nothing to wait for
			if (body.alreadyReady) loadLibrary();
		} catch {
			mediaStatus = new Map([...mediaStatus].filter(([id]) => id !== mediaId));
			showError('Could not start make-karaoke — check your connection');
		}
	}

	// ── readiness ────────────────────────────────────────────────────────────
	// One axis, three states: ready (stems on disk, sing now), cooking (stems in flight, still
	// queueable because rotation holds its slot), raw (plays with the original vocals).
	type Filter = 'all' | 'ready' | 'cooking';
	let filter = $state<Filter>('all');

	function liveOf(id: string) {
		return mediaStatus.get(id);
	}
	function readinessFor(m: Media): Readiness {
		return displayReadiness(m, liveOf(m.id));
	}
	/**
	 * Everything a SongRow displays about a song, in ONE place.
	 *
	 * Spread rather than written out at each call site because there are five of them (ready, cooking,
	 * raw, popular, recently-queued) and they had already drifted: the ready group read
	 * `artistCanonical ?? artist` while the other four read the raw `artist`, so one song showed a
	 * different name depending on which group it happened to be in. Both canonical fields are passed
	 * through and SongRow decides how to combine them, so that judgement lives in one component instead
	 * of being re-made at five tag sites.
	 */
	const rowMeta = (m: Media) => ({
		title: m.title,
		artist: m.artist,
		artistCanonical: m.artistCanonical,
		thumbnail: m.thumbnail,
		durationSec: m.durationSec,
		viewCount: m.viewCount
	});
	/** Is this song already in MY part of the rotation? Turns ＋ Turn into a ✓ Queued confirmation. */
	function inMyQueue(mediaId: string): boolean {
		return queued.some((e) => e.mediaId === mediaId && e.singerId === me?.id);
	}

	/**
	 * Every song cooking right now, from any origin — the live status map plus anything the catalog
	 * says is cooking. Deliberately NOT filtered by the search query: this is the one place a cooking
	 * song is guaranteed to be visible, and a song you kicked off then searched away from must not
	 * disappear while it works.
	 */
	const cookingRows = $derived.by(() => {
		const ids = new Set<string>();
		for (const [id, s] of mediaStatus) if (s.status !== 'ready' && s.status !== 'failed') ids.add(id);
		for (const [id, m] of mediaCatalog) if (readinessFor(m) === 'cooking') ids.add(id);
		return [...ids]
			.map((id) => ({ id, media: mediaCatalog.get(id), live: liveOf(id) }))
			.filter((r) => r.media)
			.map((r) => ({ id: r.id, media: r.media!, pct: r.live?.pct ?? 0, etaSec: r.live?.etaSec }));
	});

	const showReady = $derived(filter === 'all' || filter === 'ready');
	const showCooking = $derived(filter === 'all' || filter === 'cooking');
	const showRaw = $derived(filter === 'all');
	/*
	 * The readiness group headings only earn their space when more than one group is on screen. With a
	 * chip selected, "Ready to sing · no wait" restates the chip directly above it — the fourth of the
	 * four overlapping filter mechanisms, and the one that was pure duplication. A browse facet keeps
	 * its heading either way, because there the heading carries the count and the facet name.
	 */
	const showGroupHeads = $derived(filter === 'all');

	/**
	 * The songs the readiness groups above already account for. The whole point of the readiness axis
	 * is that a song appears EXACTLY ONCE, so the zero-query shortcut lists (popular / recently
	 * queued) must subtract it — otherwise a cooked song shows up three times on one screen, once per
	 * list, which is precisely the confusion the source tabs used to cause.
	 */
	const accountedFor = $derived.by(() => {
		const ids = new Set<string>();
		if (showReady) for (const m of searchActive ? readyResults : library) ids.add(m.id);
		if (showCooking) for (const c of cookingRows) ids.add(c.id);
		return ids;
	});
	function unaccounted(list: Media[]): Media[] {
		return list.filter((m) => !accountedFor.has(m.id));
	}

	// ── search (debounced + cancel-in-flight) ────────────────────────────────
	let query = $state('');
	let readyResults = $state<Media[]>([]);
	let rawResults = $state<Media[]>([]);
	let searching = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let inflight: AbortController | undefined;
	const searchActive = $derived(query.trim().length > 0);

	function onQueryInput() {
		clearTimeout(debounceTimer);
		const q = query.trim();
		if (!q) {
			readyResults = [];
			rawResults = [];
			searching = false;
			inflight?.abort();
			loadShortcuts();
			return;
		}
		debounceTimer = setTimeout(() => runSearch(q), 150);
	}

	/** Drop the search and go back to the full library. Same teardown as clearing the box by hand. */
	function clearSearch() {
		query = '';
		onQueryInput();
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
			// server also returns the query-matching cooking group; it is folded into cookingRows via
			// the catalog, so merging is all that's needed here
			mergeMedia([...readyResults, ...rawResults, ...(j.cooking ?? [])]);
		} catch (e) {
			if ((e as Error).name !== 'AbortError') {
				readyResults = [];
				rawResults = [];
				showError('Search failed — check your connection');
			}
		} finally {
			if (inflight === ctrl) searching = false;
		}
	}

	// transient error toast
	let errorMsg = $state('');
	let errorTimer: ReturnType<typeof setTimeout> | undefined;
	function showError(msg: string) {
		errorMsg = msg;
		clearTimeout(errorTimer);
		errorTimer = setTimeout(() => (errorMsg = ''), 4000);
	}

	// remove + undo toast
	let undo = $state<{ mediaId: string; title: string } | null>(null);
	let undoTimer: ReturnType<typeof setTimeout> | undefined;
	function removeWithUndo(entry: QueueEntry) {
		store?.removeEntry(entry.id);
		if (navigator.vibrate) navigator.vibrate(8);
		undo = { mediaId: entry.mediaId, title: mediaTitle(entry.mediaId) };
		clearTimeout(undoTimer);
		undoTimer = setTimeout(() => (undo = null), 5000);
	}
	function doUndo() {
		if (!undo) return;
		store?.addSong(undo.mediaId);
		undo = null;
		clearTimeout(undoTimer);
	}

	// zero-keystroke shortcuts (shown when the search box is empty)
	let recent = $state<Media[]>([]);
	let popular = $state<Media[]>([]);
	async function loadShortcuts() {
		try {
			const j = await (await fetch('/api/search?q=')).json();
			recent = j.recent ?? [];
			popular = j.popular ?? [];
			mergeMedia([...recent, ...popular]);
		} catch {
			/* ignore */
		}
	}

	// the saved-karaoke library + whatever is cooking, for a client that just loaded
	let library = $state<Media[]>([]);
	// Browse: facets describe the WHOLE ready library (never the current filter), so picking an
	// artist cannot collapse the rail to that one artist and strand you with no way back.
	let facets = $state<{ artists: { artist: string; count: number }[]; genres: { genre: string; count: number }[] }>({ artists: [], genres: [] });
	let browseFilter = $state<{ artist?: string; genre?: string } | null>(null);
	/*
	 * Browse starts collapsed so the readiness spine is the only filter on screen at rest. It opens
	 * itself when a facet is active, because a filter narrowing the list while its control is hidden
	 * reads as an empty library rather than an applied filter.
	 */
	let browseOpen = $state(false);
	$effect(() => {
		if (browseFilter) browseOpen = true;
	});

	function setBrowse(kind: 'artist' | 'genre' | null, value: string) {
		// tapping the active chip again clears it — a filter you cannot undo is a trap
		const same = kind === 'artist' ? browseFilter?.artist === value : kind === 'genre' ? browseFilter?.genre === value : false;
		browseFilter = kind === null || same ? null : kind === 'artist' ? { artist: value } : { genre: value };
		if (navigator.vibrate) navigator.vibrate(8);
		loadLibrary();
	}

	async function loadLibrary() {
		try {
			const qs = browseFilter?.artist
				? `?artist=${encodeURIComponent(browseFilter.artist)}`
				: browseFilter?.genre
					? `?genre=${encodeURIComponent(browseFilter.genre)}`
					: '';
			const j = await (await fetch(`/api/library${qs}`)).json();
			if (j.facets) facets = j.facets;
			library = j.library ?? [];
			mergeMedia(library);
			const cooking: { media: Media; status: MediaStatus; pct: number; etaSec?: number }[] = j.cooking ?? [];
			if (cooking.length) {
				mergeMedia(cooking.map((c) => c.media));
				const next = new Map(mediaStatus);
				// a live broadcast is fresher than this snapshot — never overwrite one
				for (const c of cooking) if (!next.has(c.media.id)) next.set(c.media.id, { status: c.status, pct: c.pct, etaSec: c.etaSec });
				mediaStatus = next;
			}
		} catch {
			/* ignore — the library is an accelerator, never a blocker */
		}
	}

	const queued = $derived(entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq));
	const myPicks = $derived(queued.filter((e) => e.singerId === me?.id));
	// the Ready chip's count reflects what that chip would actually show for the current query
	const libraryCount = $derived(searchActive ? readyResults.length : library.length);
	function myIdx(id: string): number {
		return myPicks.findIndex((e) => e.id === id);
	}
	function moveMine(id: string, delta: number) {
		const i = myIdx(id);
		if (i < 0) return;
		store?.moveEntry(id, i + delta);
		if (navigator.vibrate) navigator.vibrate(8);
	}
	/** Live processing state for an entry's media, or null if it isn't cooking. */
	function cooking(mediaId: string): { status: MediaStatus; pct: number; etaSec?: number } | null {
		const s = mediaStatus.get(mediaId);
		return s && s.status !== 'ready' && s.status !== 'failed' ? s : null;
	}
	// The entry that will ACTUALLY play next (skipping any still cooking), matching the server's
	// nextPlayable(). Pure + unit-tested in $lib/readiness.
	const nextPlayableId = $derived(
		nextPlayableEntryId(
			queued,
			(id) => mediaCatalog.get(id),
			(id) => mediaStatus.get(id)
		)
	);

	function sendPlayer(command: PlayerCommand) {
		ws?.send({ type: 'player:command', command });
	}
	const nowEntry = $derived(entries.find((e) => e.id === playback.currentEntryId));
	const nowMedia = $derived(nowEntry ? mediaCatalog.get(nowEntry.mediaId) : undefined);
	// key-shift is available only once a song's stems are separated — there is nothing to re-pitch before
	const keyShiftEnabled = $derived(!!nowMedia && isPlayable(nowMedia));
	const keyLabel = $derived(playback.keyShift === 0 ? 'Key' : `Key · ${playback.keyShift > 0 ? '+' : '−'}${Math.abs(playback.keyShift)}`);

	// ── guiding track ──────────────────────────────────────────────────
	// How loud the original vocals sit under the instrumental. Available only for a song that actually
	// HAS an isolated vocals stem — the same shape as the key control being gated on separation.
	const guideEnabled = $derived(!!nowMedia && hasGuidingTrack(nowMedia));
	/** The room's standing default, adopted from queue:sync / settings:changed. */
	let roomGuideDefault = $state(0);
	/**
	 * While a finger is on the slider we show the LOCAL value, not the server's. Without this the
	 * thumb fights the ~throttled echo coming back over the websocket and jumps under the finger.
	 */
	let guideDragging = $state(false);
	let guideDraft = $state(0);
	const guideServerPct = $derived(
		Math.round(effectiveGuideLevel({ guideLevel: playback.guideLevel }, roomGuideDefault) * 100)
	);
	const guidePct = $derived(guideDragging ? guideDraft : guideServerPct);

	/**
	 * Send at most this often while dragging. Every accepted level is authoritative playback state, so
	 * it bumps `rev` and broadcasts to every client — an unthrottled `oninput` would emit one of those
	 * per animation frame and churn rev hard enough to trip other clients' resync path. The `onchange`
	 * on release always sends the final value, so throttling can never lose where the finger stopped.
	 */
	const GUIDE_SEND_THROTTLE_MS = 120;
	let guideLastSent = 0;
	let guidePending: ReturnType<typeof setTimeout> | null = null;

	function sendGuide(pct: number): void {
		guideLastSent = Date.now();
		sendPlayer({ cmd: 'guide', level: pct / 100 });
	}

	function onGuideInput(pct: number): void {
		guideDragging = true;
		guideDraft = pct;
		const since = Date.now() - guideLastSent;
		if (since >= GUIDE_SEND_THROTTLE_MS) {
			sendGuide(pct);
			return;
		}
		// Trailing send so a slow drag that never crosses the threshold still moves the TV.
		if (guidePending) clearTimeout(guidePending);
		guidePending = setTimeout(() => {
			guidePending = null;
			sendGuide(guideDraft);
		}, GUIDE_SEND_THROTTLE_MS - since);
	}

	function onGuideCommit(pct: number): void {
		if (guidePending) {
			clearTimeout(guidePending);
			guidePending = null;
		}
		guideDraft = pct;
		sendGuide(pct);
		guideDragging = false;
	}

	// ── interpolated playback position ─────────────────────────────────
	let posAnchor = { pos: 0, wall: 0 };
	$effect(() => {
		posAnchor = { pos: playback.positionSec, wall: performance.now() };
	});
	function livePositionSec(): number {
		return playback.isPlaying ? posAnchor.pos + (performance.now() - posAnchor.wall) / 1000 : posAnchor.pos;
	}

	// A reactive copy of the interpolated position, for the peek's progress row. Ticking once a second
	// is enough because the bar's width transition covers the gap between ticks; a rAF loop would wake
	// the phone ~60x more often for no visible gain. The timer only runs while playing, and re-arms on
	// every playback:state so a seek or restart snaps instead of sliding from a stale anchor.
	let displayPos = $state(0);
	$effect(() => {
		displayPos = playback.positionSec;
		if (!playback.isPlaying) return;
		const id = setInterval(() => (displayPos = livePositionSec()), 1000);
		return () => clearInterval(id);
	});
	const nowDurationSec = $derived(
		nowEntry ? (mediaCatalog.get(nowEntry.mediaId)?.durationSec ?? 0) : 0
	);
</script>

<header style="padding:16px 18px 8px;display:flex;align-items:center;gap:10px;">
	<div class="brand"><Icon name="mic" /> <span class="wordmark">Encore</span></div>
	{#if me}
		<div style="margin-left:auto;display:flex;align-items:center;gap:8px;font-size:.85rem;color:var(--ink-dim);">
			<span>{me.displayName}</span>
			<span class="me-dot" style="--singer:{me.color};"></span>
			<!--
			  Was a bare ⚙️ at font-size 1.05rem in ~18px of padding: a forced-colour-emoji glyph (the
			  trailing U+FE0F requests emoji presentation outright) in a target under even the 24px WCAG
			  2.5.8 floor, in an app that had already adopted 44px everywhere else. Now a real mark in a
			  real target.
			-->
			<a class="gear" href="/settings" aria-label="Settings" title="Settings"><Icon name="gear" /></a>
		</div>
	{/if}
</header>

<main>
	<!-- ONE box across every source: a singer picks by readiness ("can I sing this now?"), never by
	     which index the song came from — so there is no source switch. -->
	<div class="card searchbox">
		<span class="search-mark"><Icon name="search" /></span>
		<input bind:value={query} oninput={onQueryInput} aria-label="Search a song or artist"
			placeholder="Search a song or artist…" />
		{#if searching}<span class="search-spinner" aria-label="Searching"></span>{/if}
	</div>

	<div class="chips" role="group" aria-label="Filter by readiness">
		<button class="chip" class:active={filter === 'all'} onclick={() => (filter = 'all')}>All</button>
		<button class="chip ok" class:active={filter === 'ready'} onclick={() => (filter = 'ready')}>
			<Icon name="mic" /> Ready{#if libraryCount}&nbsp;{libraryCount}{/if}
		</button>
		<button class="chip warn" class:active={filter === 'cooking'} onclick={() => (filter = 'cooking')}>
			<Icon name="sparkle" /> Cooking{#if cookingRows.length}&nbsp;{cookingRows.length}{/if}
		</button>
	</div>

	{#if showReady}
		{@const readyList = searchActive ? readyResults : library}
		<!--
		  Browse lives behind ONE disclosure. Previously the two facet rails rendered inline whenever the
		  library had enough variety, so the top of the screen could stack four independent ways to narrow
		  the same list — three readiness chips, an artist rail, a genre rail, and group headings that
		  re-announced the readiness axis in prose. Worse, the rails appeared and vanished as you typed,
		  so the control row changed shape while you were using it. One collapsed row keeps the readiness
		  spine primary and the control set stable.
		-->
		{#if !searchActive && (facets.artists.length > 1 || facets.genres.length > 1)}
			<div class="browse">
				<button
					class="browse-toggle"
					aria-expanded={browseOpen}
					onclick={() => (browseOpen = !browseOpen)}
				>
					<Icon name={browseOpen ? 'chevron-down' : 'chevron-right'} />
					Browse
					{#if browseFilter}<span class="browse-active">{browseFilter.artist ?? browseFilter.genre}</span>{/if}
				</button>
				<!-- Clearing stays reachable while collapsed: a filter you cannot see is a filter you
				     cannot undo, and an empty-looking list with no visible cause is the result. -->
				{#if browseFilter}
					<button class="chip chip-icon" onclick={() => setBrowse(null, '')}><Icon name="close" /> Clear</button>
				{/if}
			</div>
			{#if browseOpen}
				{#if facets.artists.length > 1}
					<div class="facets" role="group" aria-label="Browse by artist">
						<span class="facet-label">Artist</span>
						{#each facets.artists as f (f.artist)}
							<button class="chip" class:active={browseFilter?.artist === f.artist} onclick={() => setBrowse('artist', f.artist)}>
								{f.artist}&nbsp;<span class="facet-count">{f.count}</span>
							</button>
						{/each}
					</div>
				{/if}
				{#if facets.genres.length > 1}
					<div class="facets" role="group" aria-label="Browse by genre">
						<span class="facet-label">Genre</span>
						{#each facets.genres as f (f.genre)}
							<button class="chip ok" class:active={browseFilter?.genre === f.genre} onclick={() => setBrowse('genre', f.genre)}>
								{f.genre}&nbsp;<span class="facet-count">{f.count}</span>
							</button>
						{/each}
					</div>
				{/if}
			{/if}
		{/if}
		{#if readyList.length}
			{@const facetHead = browseFilter && !searchActive}
			{#if showGroupHeads || facetHead}
				<div class="grouphead ok">
					{facetHead
						? `${browseFilter?.artist ?? browseFilter?.genre} · ${readyList.length} ${readyList.length === 1 ? 'song' : 'songs'}`
						: 'Ready to sing · no wait'}
				</div>
			{/if}
			{#each readyList as m (m.id)}
				<SongRow {...rowMeta(m)} readiness="ready" inQueue={inMyQueue(m.id)} onadd={() => addSong(m.id)} />
			{/each}
		{/if}
	{/if}

	{#if showCooking && cookingRows.length}
		<!-- Queue it anyway: rotation HOLDS a cooking song's slot, so it keeps its fair
		     position and plays when the stems land. Cooking is not a blocked state. -->
		{#if showGroupHeads}<div class="grouphead warn">Cooking · queue it anyway</div>{/if}
		{#each cookingRows as c (c.id)}
			<SongRow
				{...rowMeta(c.media)}
				readiness="cooking"
				pct={c.pct}
				etaSec={c.etaSec}
				inQueue={inMyQueue(c.id)}
				onadd={() => addSong(c.id)}
			/>
		{/each}
	{/if}

	{#if showRaw}
		{#if searchActive}
			{#if searching && rawResults.length === 0 && readyResults.length === 0}
				<div aria-busy="true" aria-label="Searching…">
					{#each [0, 1, 2] as i (i)}
						<div class="skel-row">
							<div class="skel-thumb"></div>
							<div class="skel-text"><div class="skel-line"></div><div class="skel-line short"></div></div>
						</div>
					{/each}
				</div>
			{/if}
			{@const rawRows = unaccounted(rawResults)}
			{#if rawRows.length}
				<div class="grouphead">Needs karaoke · has vocals</div>
				{#each rawRows as m (m.id)}
					{@const r = readinessFor(m)}
					<SongRow
						{...rowMeta(m)}
						readiness={r}
						pct={liveOf(m.id)?.pct ?? 0}
						inQueue={inMyQueue(m.id)}
						onadd={() => addSong(m.id)}
						onmake={canCook(r) ? () => singThis(m.id) : undefined}
					/>
				{/each}
			{/if}
			{#if !searching && rawResults.length === 0 && readyResults.length === 0}
				<p class="empty">No results. YouTube search needs yt-dlp installed on the server.</p>
			{/if}
		{:else}
			{@const popularRows = unaccounted(popular)}
			{@const recentRows = unaccounted(recent)}
			{#if popularRows.length}
				<div class="grouphead grouphead-mark"><Icon name="flame" /> Popular tonight</div>
				{#each popularRows as m (m.id)}
					{@const r = readinessFor(m)}
					<SongRow {...rowMeta(m)} readiness={r} pct={liveOf(m.id)?.pct ?? 0}
						inQueue={inMyQueue(m.id)} onadd={() => addSong(m.id)}
						onmake={canCook(r) ? () => singThis(m.id) : undefined} />
				{/each}
			{/if}
			{#if recentRows.length}
				<div class="grouphead grouphead-mark"><Icon name="clock" /> Recently queued</div>
				{#each recentRows as m (m.id)}
					{@const r = readinessFor(m)}
					<SongRow {...rowMeta(m)} readiness={r} pct={liveOf(m.id)?.pct ?? 0}
						inQueue={inMyQueue(m.id)} onadd={() => addSong(m.id)}
						onmake={canCook(r) ? () => singThis(m.id) : undefined} />
				{/each}
			{/if}
			{#if !popularRows.length && !recentRows.length && !library.length}
				<p class="empty">Search for a song above, or be the first to queue one.</p>
			{/if}
		{/if}
	{/if}

	{#if filter !== 'all' && ((filter === 'ready' && !(searchActive ? readyResults : library).length) || (filter === 'cooking' && !cookingRows.length))}
		{#if filter === 'ready'}
			{@const empty = readyEmptyState({ searchActive, libraryCount: library.length, query })}
			<p class="empty">{empty.message}</p>
			{#if empty.showAllCount !== null}
				<!-- the way back: the library is one tap away, not gone -->
				<div style="display:flex;justify-content:center;padding:0 0 8px;">
					<button class="chip ok chip-icon" onclick={clearSearch}><Icon name="mic" /> Show all {empty.showAllCount}</button>
				</div>
			{/if}
		{:else}
			<p class="empty">Nothing cooking right now.</p>
		{/if}
	{/if}
</main>

<!-- The rotation lives in a pull-up sheet: at a party you are either browsing or checking the queue,
     so the two should not fight over one scroll. The peek carries "when am I up?" — the question
     that used to sit in a card above the search box and scroll out of sight. -->
<QueueSheet
	open={sheetOpen}
	title={nowEntry ? mediaTitle(nowEntry.mediaId) : 'Nothing playing'}
	sub={nowEntry ? `${singerOf(nowEntry.singerId)?.displayName ?? 'Someone'} is singing` : 'Queue a song to start the party'}
	position={myPositionLabel}
	queueCount={queued.length}
	elapsedSec={displayPos}
	durationSec={nowDurationSec}
	ontoggle={(v) => (sheetOpen = v)}
>
	{#snippet controls()}
		<button class="ic no-drag" aria-label="restart" onclick={() => sendPlayer({ cmd: 'restart' })}><Icon name="prev" /></button>
		<button class="ic play no-drag" aria-label="play/pause" onclick={() => sendPlayer({ cmd: playback.isPlaying ? 'pause' : 'play' })}>
			<Icon name={playback.isPlaying ? 'pause' : 'play'} />
		</button>
		<button class="ic no-drag" aria-label="skip" onclick={() => sendPlayer({ cmd: 'skip' })}><Icon name="next" /></button>
	{/snippet}

	<!-- Guiding track: how loud the ORIGINAL vocals sit under the instrumental. Above the Key control,
	     sharing its labelled-row idiom; both are per-song adjustments to the same playing song. -->
	<GuidingTrack
		pct={guidePct}
		available={guideEnabled}
		roomDefaultPct={Math.round(roomGuideDefault * 100)}
		pinned={playback.guideLevel !== null}
		oninput={onGuideInput}
		oncommit={onGuideCommit}
	/>

	<div class="key" class:disabled={!keyShiftEnabled} class:shifted={playback.keyShift !== 0}>
		<span class="lab">{keyLabel}</span>
		<button class="key-btn" disabled={!keyShiftEnabled || playback.keyShift <= -7} onclick={() => sendPlayer({ cmd: 'key', semitones: playback.keyShift - 1 })}><Icon name="minus" /> semitone</button>
		<button class="key-btn" disabled={!keyShiftEnabled || playback.keyShift >= 7} onclick={() => sendPlayer({ cmd: 'key', semitones: playback.keyShift + 1 })}><Icon name="plus" /> semitone</button>
	</div>

	<!--
		Per-song stage background. UNGATED, like every other control in this group (restart/play/skip and
		±semitone carry no ownership check either) — repainting the stage is a party control, and a
		strictly milder one than skip.

		"Room default" is a real choice, not an absence: it sends `style: null`, handing the song back to
		whatever the room picked, which is how you undo a change without knowing what the room's setting
		was.
	-->
	<div class="bg-pick" class:disabled={!nowEntry} class:overridden={playback.background !== null}>
		<span class="lab">Stage</span>
		<button
			class="bg-btn"
			class:on={playback.background === null}
			disabled={!nowEntry}
			onclick={() => sendPlayer({ cmd: 'background', style: null })}>Room default</button
		>
		{#each TV_BACKGROUND_STYLES as s (s.id)}
			<button
				class="bg-btn"
				class:on={playback.background === s.id}
				disabled={!nowEntry}
				title={s.note}
				onclick={() => sendPlayer({ cmd: 'background', style: s.id })}>{s.label}</button
			>
		{/each}
	</div>

	<div class="grouphead">Up next · rotation</div>
	{#if queued.length === 0}
		<p class="empty">Queue's empty — add a song to start the party.</p>
	{:else}
		{#each queued as e, i (e.id)}
			{@const s = singerOf(e.singerId)}
			{@const proc = cooking(e.mediaId)}
			{#if proc}
				<ProcessingCard
					seq={i + 1}
					title={mediaTitle(e.mediaId)}
					singerName={e.singerId === me?.id ? 'You' : s?.displayName ?? 'Guest'}
					singerColor={s?.color ?? SINGER_COLORS[0]}
					status={proc.status}
					pct={proc.pct}
					onremove={e.singerId === me?.id ? () => removeWithUndo(e) : undefined}
					reorderable={e.singerId === me?.id && myPicks.length > 1}
					canUp={myIdx(e.id) > 0}
					canDown={myIdx(e.id) >= 0 && myIdx(e.id) < myPicks.length - 1}
					onup={() => moveMine(e.id, -1)}
					ondown={() => moveMine(e.id, 1)}
				/>
			{:else}
				<!-- `queued` excludes the PLAYING entry (its status is 'playing'), so every row here is
				     safe to remove. The old `i !== 0` guard meant to protect the current song but
				     actually froze whatever sat at position 0 — i.e. the next-up song. -->
				<QueueRow
					seq={i + 1}
					title={mediaTitle(e.mediaId)}
					singerName={e.singerId === me?.id ? 'You' : s?.displayName ?? 'Guest'}
					singerColor={s?.color ?? SINGER_COLORS[0]}
					mine={e.singerId === me?.id}
					up={e.id === nextPlayableId}
					pending={e.rotationSeq === Number.MAX_SAFE_INTEGER}
					subtitle={e.id === nextPlayableId ? 'up next' : ''}
					removable={e.singerId === me?.id}
					reorderable={e.singerId === me?.id && myPicks.length > 1}
					canUp={myIdx(e.id) > 0}
					canDown={myIdx(e.id) >= 0 && myIdx(e.id) < myPicks.length - 1}
					onremove={() => removeWithUndo(e)}
					onup={() => moveMine(e.id, -1)}
					ondown={() => moveMine(e.id, 1)}
				/>
			{/if}
		{/each}
	{/if}
</QueueSheet>

{#if undo}
	<div class="undo-toast" role="status">
		<span>Removed “{undo.title}”</span>
		<button onclick={doUndo}>Undo</button>
	</div>
{/if}

{#if errorMsg}
	<div class="error-toast" role="alert">{errorMsg}</div>
{/if}

<style>
	/* the sheet's peek is docked, so the page must be able to scroll clear of it */
	main { flex: 1; padding: 6px 18px calc(var(--peek-h) + 28px); }

	/*
	 * The wordmark. The mic was 🎤 — a different drawing on every platform, and a tofu box on a browser
	 * with no emoji font, which is not something a brand mark can be. The gradient stays on the TEXT
	 * (background-clip), where it is the glyph fill against the page and carries no label of its own.
	 */
	.brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 800; font-size: 1.25rem; }
	.wordmark {
		background: var(--grad);
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}

	/*
	 * The singer's own identity dot. The colour arrives as a --singer custom property rather than being
	 * interpolated straight into `background:`, which is what lets the halo be derived with color-mix.
	 * The previous form concatenated hex alpha digits onto the value — `box-shadow: 0 0 0 3px {color}30`
	 * — and that only ever worked because all eight presets happened to be 6-digit hex. A 3-digit hex,
	 * an rgb() or an oklch() produced invalid CSS and the halo silently vanished. color-mix takes any
	 * colour syntax, so the free hue picker cannot break it.
	 */
	.me-dot {
		width: 22px; height: 22px; border-radius: 50%; flex: 0 0 auto;
		background: var(--singer);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--singer) 19%, transparent);
	}
	/* 44px, matching every other control in the app. The emoji gear this replaced was ~18px. */
	.gear {
		display: grid; place-items: center;
		min-width: 44px; min-height: 44px; margin-right: -10px;
		font-size: 1.15rem; color: var(--ink-dim); text-decoration: none;
	}
	.gear:hover { color: var(--ink); }

	/*
	 * Wide viewports spend the extra room on MORE SONGS, not longer rows. Only song rows flow into
	 * columns — the search box, chips, facet rails and group headings each label everything below
	 * them, so a heading confined to one column would read as applying to half the list. The rule is
	 * inverted deliberately: everything spans by default and rows opt in, so a new block added here
	 * spans (always safe) rather than silently landing in a column beside a song.
	 */
	@media (min-width: 768px) {
		main {
			display: grid;
			/* 440px is measured off the row's own contents, not picked for looks: a row spends roughly 220px
			   on the thumbnail, readiness badge, action button and gaps, so a narrower column truncates
			   every title to "Quee..." and two unreadable columns are worse than one readable one. */
			grid-template-columns: repeat(auto-fill, minmax(440px, 1fr));
			gap: 0 14px;
			align-content: start;
		}
		main > :global(*) {
			grid-column: 1 / -1;
		}
		main > :global(.row) {
			grid-column: auto;
		}
	}
	.searchbox { display: flex; align-items: center; gap: 10px; padding: 12px 14px; margin-bottom: 10px; min-height: 52px; }
	.searchbox input { border: 0; background: transparent; color: var(--ink); font-size: 1rem; width: 100%; outline: none; }
	.chips { display: flex; gap: 7px; margin-bottom: 14px; }
	/* One collapsed row where two facet rails used to render inline and reshuffle as you typed. */
	.browse { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
	.browse-toggle {
		min-height: 44px; display: inline-flex; align-items: center; gap: 7px;
		background: none; border: 0; padding: 0 2px; cursor: pointer;
		color: var(--ink-dim); font-size: 0.68rem; font-weight: 700;
		letter-spacing: 0.14em; text-transform: uppercase;
	}
	.browse-toggle:hover { color: var(--ink); }
	/* Names the active facet on the collapsed row, so a narrowed list always shows its cause. */
	.browse-active { color: var(--accent2); text-transform: none; letter-spacing: 0; font-size: 0.8rem; }
	/* browse facet rails: horizontally scrollable so a 20-artist library cannot push the
	   song list off the screen on a phone. */
	.facets {
		display: flex; align-items: center; gap: 7px; margin-bottom: 8px;
		overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch;
	}
	.facets::-webkit-scrollbar { display: none; }
	.facets .chip { flex: none; }
	.facet-label {
		flex: none; font-size: .68rem; letter-spacing: .14em; text-transform: uppercase;
		color: var(--ink-dim); padding-right: 2px;
	}
	.facet-count { opacity: .55; font-variant-numeric: tabular-nums; }
	.chip {
		/* 44px, matching the queue actions and the row buttons. These were ~30px: above the 24px WCAG
		   floor, but below the threshold this app had already set for itself everywhere else — and the
		   readiness chips are the most-tapped controls on the screen. */
		min-height: 44px;
		display: inline-flex; align-items: center; gap: 6px;
		padding: 7px 14px; border-radius: 22px; font-size: 0.82rem; font-weight: 600; cursor: pointer;
		background: var(--card); border: 1px solid var(--line); color: var(--ink-dim);
	}
	.chip.ok { color: var(--ok); }
	.chip.warn { color: var(--warn); }
	.chip.active { background: var(--accent-strong); border-color: transparent; color: var(--on-accent); }
	/* any label that leads with a mark rather than a word */
	.chip-icon { display: inline-flex; align-items: center; gap: 6px; }
	.search-mark { display: grid; place-items: center; color: var(--ink-dim); }
	.grouphead-mark { display: flex; align-items: center; gap: 7px; }
	.chip:active { transform: scale(0.95); }
	.grouphead {
		font-size: 0.68rem; letter-spacing: 0.14em; text-transform: uppercase;
		color: var(--ink-dim); font-weight: 700; margin: 16px 4px 8px;
	}
	.grouphead:first-of-type { margin-top: 4px; }
	.grouphead.ok { color: var(--ok); }
	.grouphead.warn { color: var(--warn); }
	.empty { color: var(--ink-dim); padding: 0 4px; font-size: 0.9rem; }

	/* playback controls, rendered into the sheet's peek */	.ic { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; border: 1px solid var(--line); background: var(--card); color: var(--ink); font-size: 1rem; cursor: pointer; }
	/* The one filled transport control. Solid accent + paired ink, because in stage 1 the glyph became
	   an SVG drawn with currentColor — on --grad that mark sat at 2.84:1, under the 3:1 non-text floor. */
	.ic.play { background: var(--accent-strong); color: var(--on-accent); border-color: transparent; width: 44px; height: 44px; }
	.ic:active { transform: scale(0.92); }

	.key { display: flex; gap: 6px; margin: 6px 0 2px; align-items: center; }
	/*
	 * Wraps, unlike .key: five choices will not fit one phone row at a 44px touch target, and shrinking
	 * them to fit is how a control becomes unhittable mid-song in a dark room.
	 */
	.bg-pick { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 2px; align-items: center; }
	.bg-pick.disabled { opacity: 0.5; }
	.bg-pick .lab { font-size: 0.7rem; color: var(--ink-dim); letter-spacing: 0.1em; text-transform: uppercase; }
	.bg-pick.overridden .lab { color: var(--warn); }
	.bg-btn {
		border: 1px dashed var(--line-strong); background: transparent; color: var(--ink-dim);
		border-radius: 10px; padding: 8px 10px; font-size: 0.8rem; cursor: pointer; min-height: 44px;
	}
	.bg-pick:not(.disabled) .bg-btn:not(:disabled) { border-style: solid; border-color: var(--line); color: var(--ink); }
	/* The active choice is stated by border + text, never by colour alone. The BORDER carries the
	   accent (a non-text element, 3:1 floor); the label stays --ink because --accent as text measures
	   4.51:1 on --bg and only 3.95:1 on a card, so at 0.8rem it sits on the AA threshold and falls
	   below it the moment this control moves onto a card. See lib/contrast.test.ts. */
	.bg-btn.on { border-color: var(--accent); color: var(--ink); font-weight: 700; }
	.bg-pick:not(.disabled) .bg-btn:not(:disabled):active { transform: scale(0.95); }
	.bg-btn:disabled { cursor: default; }
	.key.disabled { opacity: 0.5; }
	.key .lab { font-size: 0.7rem; color: var(--ink-dim); letter-spacing: 0.1em; text-transform: uppercase; }
	.key.shifted .lab { color: var(--warn); }
	.key button { flex: 1; border: 1px dashed var(--line-strong); background: transparent; color: var(--ink-dim); border-radius: 10px; padding: 6px; font-size: 0.8rem; cursor: pointer; }
	/* Centre the mark with its word. The glyphs these replaced were U+2212 and U+FF0B — the fullwidth
	   plus carries CJK metrics, so it sat off-baseline beside Latin text at every size. */
	.key-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
	.key:not(.disabled) button:not(:disabled) { border-style: solid; border-color: var(--line); color: var(--ink); }
	.key:not(.disabled) button:not(:disabled):active { transform: scale(0.95); }
	.key button:disabled { cursor: default; }


	.search-spinner {
		width: 15px; height: 15px; flex: none; border-radius: 50%;
		border: 2px solid var(--line); border-top-color: var(--accent2);
		animation: spin 0.7s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
	.skel-row {
		display: flex; align-items: center; gap: 12px; padding: 12px 14px; margin-bottom: 8px;
		border-radius: 14px; background: var(--card); border: 1px solid var(--line);
	}
	.skel-thumb { width: 44px; height: 44px; flex: none; border-radius: 10px; }
	.skel-text { flex: 1; display: flex; flex-direction: column; gap: 8px; }
	.skel-line { height: 12px; border-radius: 6px; }
	.skel-line.short { width: 55%; }
	.skel-thumb, .skel-line {
		background: linear-gradient(90deg, var(--card2) 25%, var(--line) 37%, var(--card2) 63%);
		background-size: 400% 100%; animation: shimmer 1.3s ease-in-out infinite;
	}
	@keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
	.undo-toast {
		position: fixed; left: 50%; bottom: calc(var(--peek-h) + 14px); transform: translateX(-50%);
		display: flex; align-items: center; gap: 14px; z-index: 30;
		background: var(--card2); border: 1px solid var(--line); border-radius: 14px;
		padding: 12px 16px; box-shadow: var(--shadow); font-size: 0.9rem; max-width: 90vw;
	}
	.undo-toast button {
		border: 0; background: var(--accent-strong); color: var(--on-accent); font-weight: 700;
		border-radius: 8px; padding: 6px 12px; cursor: pointer;
	}
	.error-toast {
		/* Offset above the undo toast: both sat at the same bottom and z-index, so one drew over the
		   other and a guest saw only whichever rendered last. */
		position: fixed; left: 50%; bottom: calc(var(--peek-h) + 70px); transform: translateX(-50%); z-index: 30;
		background: var(--danger-bg); color: var(--danger-ink); border: 1px solid var(--danger-line);
		padding: 11px 16px; border-radius: 12px; font-size: 0.88rem; max-width: 90vw;
	}
</style>
