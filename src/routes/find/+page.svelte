<script lang="ts">
	/*
	 * THE FIND SURFACE.
	 *
	 * WHY IT IS A ROUTE AND NOT A MODE. Search used to be a docked box on the queue, and the ruling then
	 * was explicit: no browse MODE, no `?browse=1`, results expand upward IN PLACE, because there was no
	 * navigation to back out of. That reasoning was sound and it was about a box that lived on home.
	 * The band took the bottom edge, search became a place you GO — a tap on the band's magnifier — and
	 * once it is somewhere you go, a route is what makes the phone's own back gesture work, keeps the
	 * surface shareable, and stops the queue from re-rendering under a keyboard. The retired
	 * `openBrowse` / `browseToggle` selectors are NOT coming back with it: there is no toggle here,
	 * because the surface IS the browse view.
	 *
	 * THE ZERO-QUERY STATE IS THE LIBRARY, which is the whole design idea. An empty search box used to
	 * show two rails of shortcuts over a hidden library; here the songs you can actually sing right now
	 * ARE the default content, and typing filters the world rather than revealing it. So there is no
	 * empty-box dead end to design around.
	 */
	import { onMount } from 'svelte';
	import {
		originalKeyLabel,
		isProcessableSource,
		type Media,
		type MediaStatus,
		type PublicSinger,
		type QueueEntry
	} from '$lib/contract';
	import type { QueueStore } from '$lib/stores/queue';
	import { room } from '$lib/stores/room';
	import SongRow from '$lib/components/SongRow.svelte';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Spinner } from '$lib/components/ui/spinner';
	import * as Empty from '$lib/components/ui/empty';
	import { Toaster } from '$lib/components/ui/sonner';
	import { toast } from 'svelte-sonner';
	import { processAndQueue } from '$lib/process-and-queue';
	import { displayReadiness, canProcess, readyEmptyState, processingGroupIds, type Readiness } from '$lib/readiness';

	// ── the room, mirrored ──────────────────────────────────────────────
	// Only what this surface renders. The link owns all of it, which is what lets this route exist at
	// all: before the hoist, the socket and the catalog were locals of the queue route.
	let me = $state<PublicSinger | null>(null);
	let connected = $state(false);
	let entries = $state<QueueEntry[]>([]);
	let mediaCatalog = $state<Map<string, Media>>(new Map());
	let mediaStatus = $state<Map<string, { status: MediaStatus; pct: number; etaSec?: number }>>(new Map());
	let library = $state<Media[]>([]);
	let libraryTags = $state<Record<string, string[]>>({});
	let store = $state<QueueStore | undefined>(undefined);

	onMount(() => {
		const sync = () => {
			me = room.me;
			connected = room.connected;
			entries = room.entries;
			mediaCatalog = room.mediaCatalog;
			mediaStatus = room.mediaStatus;
			library = room.library;
			libraryTags = room.libraryTags;
			store = room.queue;
		};
		sync(); // the link outlives this component and is very likely already live — see room.ts
		const stopMirror = room.subscribe(sync);
		const stopErrors = room.onError((message) => showError(message));
		void room.connect();
		// Focus the box on arrival. Getting here is a deliberate act — you tapped the magnifier — so the
		// keyboard should already be up rather than costing a second tap.
		queryEl?.focus();
		return () => {
			stopMirror();
			stopErrors();
		};
	});

	function showError(msg: string) {
		toast.error(msg, { duration: 4000 });
	}

	const queued = $derived(entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq));

	// ── search (debounced + cancel-in-flight) ───────────────────────────
	let queryEl = $state<HTMLInputElement | null>(null);
	let query = $state('');
	let readyResults = $state<Media[]>([]);
	let rawResults = $state<Media[]>([]);
	let processingResults = $state<Media[]>([]);
	let searching = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let inflight: AbortController | undefined;
	/** The sole switch between the library view and the results view. */
	const searchActive = $derived(query.trim().length > 0);

	function onQueryInput() {
		clearTimeout(debounceTimer);
		const q = query.trim();
		if (!q) {
			readyResults = [];
			rawResults = [];
			processingResults = [];
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
				readyResults = [];
				rawResults = [];
				processingResults = [];
				showError('Search failed.');
			}
		} finally {
			if (inflight === ctrl) searching = false;
		}
	}

	// ── readiness and row shaping ───────────────────────────────────────
	function liveOf(id: string) {
		return mediaStatus.get(id);
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
	/** Is this song already in MY part of the rotation? Drives the row's "queued" state. */
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

	/** Ids already shown by another group, so no song appears twice in one list. */
	const accountedFor = $derived.by(() => {
		const ids = new Set<string>();
		for (const m of searchActive ? readyResults : library) ids.add(m.id);
		for (const c of processingRows) ids.add(c.id);
		return ids;
	});
	function unaccounted(list: Media[]): Media[] {
		return list.filter((m) => !accountedFor.has(m.id));
	}

	// ── the two queueing actions ────────────────────────────────────────
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

	/** The library rows, minus anything the processing group is already showing. */
	const libraryRows = $derived(unaccounted(library));
</script>

<!--
	NO ICON ON THE HEADER, and that is the duplicate going rather than a decoration being dropped.

	The header carried `icon="search"` while the search FIELD eleven lines down carries the same magnifier
	in `.find-mark` — two identical marks, 90px apart vertically, on a screen whose entire subject is one
	search box. The field's is the functional one (it sits in the input's own box and says "type here"); the
	header's was decorative, and with the title already reading "Find a song" it told nobody anything the
	words did not.
-->
<PageHeader title="Find a song" back={{ href: '/', label: 'Back to the queue' }} />

<main>
	<!--
		THE BOX IS AT THE TOP, not docked. The band owns the bottom edge of every phone surface now, and
		two things fighting for that edge is exactly the stack this surface exists to unwind. Sticky, so
		it survives a long scroll through the library without pinning a second fixed element to the
		viewport.
	-->
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

	<!-- The room went away mid-search. Says so here rather than letting a stale list read as live. -->
	{#if me && !connected}
		<p class="offline-note" role="status" aria-live="polite">
			<Icon name="warning" /> Reconnecting…
		</p>
	{/if}

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

	{#if !searchActive}
		<!-- ZERO QUERY = THE LIBRARY. The songs that can be sung right now, as the default content. -->
		<!--
			THE HEADING IS GATED ON HAVING ROWS. Eyes-on caught it the other way round: with an empty library
			and one song processing, the surface rendered "READY TO SING · YOUR LIBRARY" with nothing under it
			and "MAKING KARAOKE…" directly beneath — a heading that named a group the page was not showing.
			A group heading is a claim about what follows it, so it must not outlive its rows.
		-->
		{#if libraryRows.length}
			<h2 class="grouphead">Your library</h2>
			{#each libraryRows as m (m.id)}
				<SongRow {...rowMeta(m)} readiness="ready" inQueue={inMyQueue(m.id)} onadd={() => addSong(m.id)} />
			{/each}
		{:else if processingRows.length === 0}
			<!-- Nothing ready AND nothing on the way: the only state where the library is genuinely empty. -->
			<!-- The state, then the next step — see the matching note on the home queue's empty state. The
			     field above is the only way out of this screen, so it is what the description names. -->
			<Empty.Root>
				<Empty.Header>
					<Empty.Title>No karaoke tracks yet.</Empty.Title>
					<Empty.Description>Search above for a song and we'll make one.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{/if}
	{/if}

	<!-- Whatever is being made right now, in both views: it is the thing most likely to be asked about. -->
	{#if processingRows.length}
		<h2 class="grouphead">Making karaoke…</h2>
		{#each processingRows as c (c.id)}
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

	{#if searchActive}
		{@const readyStack = readyResults}
		{#if readyStack.length}
			<h2 class="grouphead">Ready to sing</h2>
			{#each readyStack as m (m.id)}
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

		<!-- Nothing SINGABLE matched, but the library has songs — offer the way back to all of them. -->
		{#if !readyStack.length && library.length}
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
</main>

<Toaster position="bottom-center" offset="var(--dock-h, 0px)" style="--width: min(92vw, 420px);" />

<style>
	main {
		flex: 1;
		/*
		 * Reserves the band in NORMAL FLOW (XR-PH-12) off the height the layout measures, so the last
		 * row cannot bleed under it. No env() term here — the band carries the only one, and adding a
		 * second doubles the gap on a notched phone.
		 */
		padding: var(--space-xs) var(--space-3xl) calc(var(--dock-h, 0px) + 28px);
	}

	/*
	 * DELIBERATELY NOT STICKY, and the reason is worth recording because sticky is the obvious choice.
	 *
	 * PageHeader is already sticky and carries the top safe-area inset itself, so a second sticky
	 * element here would have to be offset by the header's RENDERED HEIGHT to sit below it — and that
	 * height is not a token. Both ways of getting it are worse than not sticking. Inventing a spacing
	 * step does not work: the scale stops at `--space-4xl`, the first attempt here reached past the end
	 * of it, and an undefined custom property inside a calc() makes the whole declaration invalid — so
	 * the box would have ridden up under the title with nothing failing out loud. Measuring the header
	 * and publishing a second custom property does work, and is a band contract's worth of machinery
	 * for a search box.
	 *
	 * So the box scrolls with the content. Scrolling back to it is one flick on a list this short, the
	 * header above it stays pinned as the way out, and the band below it stays pinned as the way
	 * anywhere else.
	 */
	.findbox {
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		display: flex;
		align-items: center;
		gap: var(--space-md);
		padding: var(--space-lg) var(--space-xl);
		min-height: 52px;
		width: 100%;
		margin-bottom: var(--space-lg);
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
	/*
	 * THE FOCUS RING BELONGS TO THE WHOLE FIELD, not to the bare input inside it.
	 *
	 * `.findbox` is a bordered, filled box holding a magnifier, the input, a spinner and a clear control —
	 * so it IS the field as far as anyone looking at it is concerned. app.css's global
	 * `input:focus-visible` rule drew the ring on the input alone, which measured 75→341 inside a wrapper
	 * running 34→356: a violet rounded rect nested inside a grey one, with the magnifier stranded outside
	 * the ring it should have been part of. It read as a field inside a field.
	 *
	 * So the ring moves out one level. `:focus-within` rather than `:focus-visible` on the wrapper because
	 * a wrapper is never itself focused; the inner rule below suppresses the global so only one ring is
	 * ever drawn. Same token, same width — this changes WHERE the indicator is, not whether there is one,
	 * so XR-VER-12's measured floor (a >=2px outline in the resolved `--focus`) still holds, now on a box
	 * that contains everything it is indicating.
	 */
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

	.offline-note {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		margin: 0 0 var(--space-md);
		color: var(--warn);
		font-size: var(--ph-text-sm);
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
		.findbox {
			min-height: var(--tap);
			padding: var(--space-sm) var(--space-xl);
		}
	}
</style>
