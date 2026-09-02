<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { ServerEvent, QueueEntry, Media, PublicSinger, PlaybackState, PlayerCommand } from '@encore/shared';
	import { QueueStore } from '$lib/stores/queue';
	import { WsClient } from '$lib/ws/client';
	import QueueRow from '$lib/components/QueueRow.svelte';
	import ProcessingCard from '$lib/components/ProcessingCard.svelte';
	import SongCard from '$lib/components/SongCard.svelte';
	import NowPlaying from '$lib/components/NowPlaying.svelte';
	import { MicPitch } from '$lib/mic/mic-capture';
	import type { MediaStatus } from '@encore/shared';

	let me = $state<PublicSinger | null>(null);
	let entries = $state<QueueEntry[]>([]);
	let singers = $state<Map<string, PublicSinger>>(new Map());
	let mediaCatalog = $state<Map<string, Media>>(new Map());
	let connected = $state(false);
	let playback = $state<PlaybackState>({ currentEntryId: null, positionSec: 0, isPlaying: false, keyShift: 0 });
	// live make-karaoke progress per mediaId (M7-C7) — driven by media:status broadcasts.
	let mediaStatus = $state<Map<string, { status: MediaStatus; pct: number; etaSec?: number }>>(new Map());

	let store: QueueStore;
	let ws: WsClient;

	// derived: my position in the rotation + who's right before me
	const myNextEntry = $derived(
		entries.filter((e) => e.singerId === me?.id && e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq)[0]
	);
	const myPositionLabel = $derived.by(() => {
		if (!myNextEntry) return '';
		const queued = entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq);
		const idx = queued.findIndex((e) => e.id === myNextEntry.id);
		if (idx < 0) return '';
		if (idx === 0) return "You're up next! 🎤";
		const before = queued[idx - 1];
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

	onMount(() => {
		let disposed = false;
		(async () => {
			// who am I? (redirect to join if not)
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
						// after a (re)sync, replay any still-pending optimistic ops (server dedupes)
						queueMicrotask(() => store.resendPending());
					}
					if (e.type === 'queue:patch' && e.patch.media) {
						// merge media referenced by the patch (e.g. a song another singer just added)
						// so its title renders without waiting for a full sync
						const next = new Map(mediaCatalog);
						for (const m of e.patch.media) next.set(m.id, m);
						mediaCatalog = next;
					}
					if (e.type === 'singer:joined') {
						singers = new Map(singers).set(e.singer.id, e.singer);
					}
					if (e.type === 'playback:state') {
						playback = e.state;
					}
					if (e.type === 'score:update') {
						myScore = e;
					}
					if (e.type === 'media:status') {
						// live make-karaoke progress → drives the ProcessingCard (M7-C7)
						const next = new Map(mediaStatus);
						next.set(e.mediaId, { status: e.status, pct: e.pct, etaSec: e.etaSec });
						mediaStatus = next;
						// reflect the cooking flag on the catalog media too so SongCard sparkles
						const m = mediaCatalog.get(e.mediaId);
						if (m) {
							const nm = new Map(mediaCatalog);
							nm.set(e.mediaId, { ...m, playMode: 'file', stemStatus: e.status === 'ready' ? 'ready' : 'queued' });
							mediaCatalog = nm;
						}
					}
					store.onServerEvent(e);
				}
			});
			ws.open();
			connected = true;
			loadShortcuts();
		})();
		return () => {
			disposed = true;
			ws?.close();
		};
	});

	function addSong(mediaId: string) {
		store?.addSong(mediaId);
		if (navigator.vibrate) navigator.vibrate(8); // haptic tick
		setTimeout(loadShortcuts, 300); // refresh popular/recent after the add lands
	}

	/** Request stem-separation ("make karaoke") for a media — flips it to a cooking file server-side;
	 *  the live media:status broadcasts then drive the ProcessingCard (M7-C7). */
	async function makeKaraoke(mediaId: string) {
		if (navigator.vibrate) navigator.vibrate(12);
		// optimistic: show the bar immediately at "queued" while the request lands
		const next = new Map(mediaStatus);
		next.set(mediaId, { status: 'queued', pct: 0 });
		mediaStatus = next;
		try {
			const res = await fetch('/api/make-karaoke', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ mediaId })
			});
			if (!res.ok) {
				mediaStatus = new Map([...mediaStatus].filter(([id]) => id !== mediaId));
				showError((await res.json().catch(() => ({}))).error ?? 'Could not start make-karaoke');
			}
		} catch {
			showError('Could not start make-karaoke — check your connection');
		}
	}

	/** Live processing state for an entry's media, or null if it isn't cooking. */
	function cooking(mediaId: string): { status: MediaStatus; pct: number; etaSec?: number } | null {
		const s = mediaStatus.get(mediaId);
		return s && s.status !== 'ready' && s.status !== 'failed' ? s : null;
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

	const queued = $derived(entries.filter((e) => e.status === 'queued').sort((a, b) => a.rotationSeq - b.rotationSeq));
	// my own picks in fair order — move ops target an index within THIS list
	const myPicks = $derived(queued.filter((e) => e.singerId === me?.id));
	function myIdx(id: string): number {
		return myPicks.findIndex((e) => e.id === id);
	}
	function moveMine(id: string, delta: number) {
		const i = myIdx(id);
		if (i < 0) return;
		store?.moveEntry(id, i + delta);
		if (navigator.vibrate) navigator.vibrate(8);
	}

	function sendPlayer(command: PlayerCommand) {
		ws?.send({ type: 'player:command', command });
	}
	// the entry that's currently playing (for the now-playing strip)
	const nowEntry = $derived(entries.find((e) => e.id === playback.currentEntryId));
	// key-shift is available only on a make-karaoke (file) song whose stems are ready (M7-C9)
	const nowMedia = $derived(nowEntry ? mediaCatalog.get(nowEntry.mediaId) : undefined);
	const keyShiftEnabled = $derived(!!nowMedia && nowMedia.playMode === 'file' && nowMedia.stemStatus === 'ready');

	// ── M8-C3: live mic pitch → score ─────────────────────────────────────────
	// It's my turn to sing when the playing entry is mine. The phone doesn't play the audio (the TV
	// does), so estimate the playback position by interpolating from the last playback:state.
	const isMyTurn = $derived(!!me && !!nowEntry && nowEntry.singerId === me.id && playback.isPlaying);
	// This song was scored only if its media carries a reference pitch track (M8-C3 Stage 1).
	const scoringAvailable = $derived(!!nowMedia && !!nowMedia.pitchRef);
	let micEnabled = $state(false); // user must opt in (getUserMedia needs a gesture + permission)
	let micError = $state('');
	// M8-C3: my live score, from score:update (shown while it's my turn); cleared when it isn't
	let myScore = $state<Extract<ServerEvent, { type: 'score:update' }> | null>(null);
	const showMyScore = $derived(isMyTurn && !!myScore && myScore.entryId === nowEntry?.id && myScore.singerId === me?.id);
	let posAnchor = { pos: 0, wall: 0 };
	$effect(() => {
		// re-anchor whenever playback changes (song start, seek, play/pause)
		posAnchor = { pos: playback.positionSec, wall: performance.now() };
	});
	function livePositionSec(): number {
		return playback.isPlaying ? posAnchor.pos + (performance.now() - posAnchor.wall) / 1000 : posAnchor.pos;
	}
	// Start capturing only while it's my turn AND I've enabled the mic; stop otherwise / on unmount.
	$effect(() => {
		if (!(isMyTurn && micEnabled)) return;
		const mic = new MicPitch((s) => {
			ws?.send({ type: 'mic:pitch', positionSec: livePositionSec(), f0Hz: s.f0Hz, confidence: s.clarity });
		});
		mic.start().catch(() => {
			micError = 'Microphone unavailable — check permissions';
			micEnabled = false;
		});
		return () => mic.stop();
	});

	// ── search (debounced + cancel-in-flight) ────────────────────────────────
	let query = $state('');
	let searchSource = $state<'youtube' | 'local'>('youtube');
	let results = $state<Media[]>([]);
	let searching = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let inflight: AbortController | undefined;

	function onQueryInput() {
		clearTimeout(debounceTimer);
		const q = query.trim();
		if (!q) {
			results = [];
			searching = false;
			inflight?.abort();
			loadShortcuts(); // box cleared → refresh recent/popular
			return;
		}
		debounceTimer = setTimeout(() => runSearch(q), 150); // debounce ~150ms
	}
	async function runSearch(q: string) {
		inflight?.abort(); // cancel the previous in-flight request
		const ctrl = new AbortController();
		inflight = ctrl;
		searching = true;
		try {
			const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&source=${searchSource}`, { signal: ctrl.signal });
			if (ctrl.signal.aborted) return;
			results = (await res.json()).results ?? [];
		} catch (e) {
			if ((e as Error).name !== 'AbortError') {
				results = [];
				showError('Search failed — check your connection');
			}
		} finally {
			if (inflight === ctrl) searching = false;
		}
	}
	function setSource(s: 'youtube' | 'local') {
		searchSource = s;
		if (query.trim()) runSearch(query.trim());
	}

	// transient error toast
	let errorMsg = $state('');
	let errorTimer: ReturnType<typeof setTimeout> | undefined;
	function showError(msg: string) {
		errorMsg = msg;
		clearTimeout(errorTimer);
		errorTimer = setTimeout(() => (errorMsg = ''), 4000);
	}

	// zero-keystroke shortcuts (shown when the search box is empty)
	let recent = $state<Media[]>([]);
	let popular = $state<Media[]>([]);
	async function loadShortcuts() {
		try {
			const res = await fetch('/api/search?q=');
			const j = await res.json();
			recent = j.recent ?? [];
			popular = j.popular ?? [];
		} catch {
			/* ignore */
		}
	}
</script>

<header style="padding:16px 18px 8px;display:flex;align-items:center;gap:10px;">
	<div style="font-weight:800;font-size:1.25rem;">🎤 <span style="background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;">Encore</span></div>
	{#if me}
		<div style="margin-left:auto;display:flex;align-items:center;gap:8px;font-size:.85rem;color:var(--ink-dim);">
			<span>{me.displayName}</span>
			<span style="width:22px;height:22px;border-radius:50%;background:{me.color};box-shadow:0 0 0 3px {me.color}30;"></span>
		</div>
	{/if}
</header>

<main style="flex:1;padding:6px 18px 120px;">
	{#if myPositionLabel}
		<div class="card" style="padding:12px 14px;margin-bottom:14px;background:linear-gradient(var(--card),#1d1830);border-color:#3a3155;">
			<strong>{myPositionLabel}</strong>
		</div>
	{/if}

	<!-- search -->
	<div class="card" style="display:flex;align-items:center;gap:10px;padding:12px 14px;margin-bottom:10px;">
		<span style="color:var(--ink-dim)">🔎</span>
		<input
			bind:value={query}
			oninput={onQueryInput}
			placeholder="Search a song or artist…"
			style="border:0;background:transparent;color:var(--ink);font-size:1rem;width:100%;outline:none;"
		/>
		{#if searching}<span class="search-spinner" aria-label="Searching"></span>{/if}
	</div>
	<div style="display:flex;gap:8px;margin-bottom:12px;">
		<button class="tab" class:active={searchSource === 'youtube'} onclick={() => setSource('youtube')}>YouTube</button>
		<button class="tab" class:active={searchSource === 'local'} onclick={() => setSource('local')}>Library</button>
	</div>

	{#if query.trim()}
		{#if searching && results.length === 0}
			<!-- loading: skeleton rows hint at the incoming result shape while the search is in flight -->
			<div aria-busy="true" aria-label="Searching…">
				{#each [0, 1, 2] as i (i)}
					<div class="skel-row">
						<div class="skel-thumb"></div>
						<div class="skel-text"><div class="skel-line"></div><div class="skel-line short"></div></div>
					</div>
				{/each}
			</div>
		{/if}
		{#if results.length === 0 && !searching}
			<p style="color:var(--ink-dim);padding:0 4px;font-size:.9rem;">
				No results{searchSource === 'youtube' ? ' (YouTube search needs yt-dlp installed on the server)' : ' in your library'}.
			</p>
		{/if}
		{#each results as m (m.id)}
			<SongCard
				title={m.title}
				sub={`${m.artist ?? (m.source === 'youtube' ? 'YouTube' : 'Library')} · tap to queue`}
				processing={m.playMode === 'file' && m.stemStatus !== 'ready'}
				onadd={() => addSong(m.id)}
				onmake={cooking(m.id) || m.stemStatus === 'ready' ? undefined : () => makeKaraoke(m.id)}
			/>
		{/each}
	{:else}
		<!-- zero-keystroke shortcuts -->
		{#if popular.length}
			<div style="font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin:4px 4px 8px;">🔥 Popular tonight</div>
			{#each popular as m (m.id)}
				<SongCard title={m.title} sub={`${m.artist ?? ''} · tap to queue`} onadd={() => addSong(m.id)} />
			{/each}
		{/if}
		{#if recent.length}
			<div style="font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin:14px 4px 8px;">🕑 Recently queued</div>
			{#each recent as m (m.id)}
				<SongCard title={m.title} sub={`${m.artist ?? ''} · tap to queue`} onadd={() => addSong(m.id)} />
			{/each}
		{/if}
		{#if !popular.length && !recent.length}
			<p style="color:var(--ink-dim);padding:0 4px;font-size:.9rem;">Search for a song above, or be the first to queue one ✨</p>
		{/if}
	{/if}

	<div style="font-size:.78rem;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-dim);margin:18px 4px 10px;">Up next · rotation</div>
	{#if queued.length === 0}
		<p style="color:var(--ink-dim);padding:0 4px;">Queue's empty — add a song to start the party ✨</p>
	{:else}
		{#each queued as e, i (e.id)}
			{@const s = singerOf(e.singerId)}
			{@const proc = cooking(e.mediaId)}
			{#if proc}
				<!-- M7-C7: a make-karaoke song still cooking → live progress card (held slot) -->
				<ProcessingCard
					seq={i + 1}
					title={mediaTitle(e.mediaId)}
					singerName={e.singerId === me?.id ? 'You' : s?.displayName ?? 'Guest'}
					singerColor={s?.color ?? '#7c5cff'}
					status={proc.status}
					pct={proc.pct}
				/>
			{:else}
				<QueueRow
					seq={i + 1}
					title={mediaTitle(e.mediaId)}
					singerName={e.singerId === me?.id ? 'You' : s?.displayName ?? 'Guest'}
					singerColor={s?.color ?? '#7c5cff'}
					mine={e.singerId === me?.id}
					up={i === 0}
					pending={e.rotationSeq === Number.MAX_SAFE_INTEGER}
					subtitle={i === 0 ? 'up next' : ''}
					removable={e.singerId === me?.id && i !== 0}
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
</main>

{#if nowEntry}
	<NowPlaying
		title={mediaTitle(nowEntry.mediaId)}
		sub={`${singerOf(nowEntry.singerId)?.displayName ?? 'Someone'} is singing`}
		isPlaying={playback.isPlaying}
		keyShiftEnabled={keyShiftEnabled}
		keyShift={playback.keyShift}
		onplaypause={() => sendPlayer({ cmd: playback.isPlaying ? 'pause' : 'play' })}
		onprev={() => sendPlayer({ cmd: 'restart' })}
		onnext={() => sendPlayer({ cmd: 'skip' })}
		onkey={(semitones) => sendPlayer({ cmd: 'key', semitones })}
	/>
{/if}

{#if isMyTurn && scoringAvailable}
	<!-- M8-C3: mic opt-in for live scoring on your turn (score readout added in the score:update UI) -->
	<div class="mic-bar">
		{#if !micEnabled}
			<button class="mic-btn" onclick={() => { micError = ''; micEnabled = true; }}>🎤 Sing — enable mic</button>
		{:else if showMyScore && myScore}
			<span class="mic-score"><span class="dot"></span> Score <strong>{myScore.score}</strong> · {myScore.hits}/{myScore.total} on pitch</span>
		{:else}
			<span class="mic-live"><span class="dot"></span> Listening… sing along!</span>
		{/if}
		{#if micError}<span class="mic-err">{micError}</span>{/if}
	</div>
{/if}

{#if undo}
	<div class="undo-toast">
		<span>Removed “{undo.title}”</span>
		<button onclick={doUndo}>Undo</button>
	</div>
{/if}

{#if errorMsg}
	<div class="error-toast">{errorMsg}</div>
{/if}

<style>
	.mic-bar {
		position: fixed; left: 12px; right: 12px; bottom: 92px; z-index: 20; display: flex;
		align-items: center; gap: 10px; justify-content: center;
	}
	.mic-btn {
		border: 0; border-radius: 999px; padding: 12px 22px; font-size: 1rem; font-weight: 800;
		background: var(--grad); color: #fff; box-shadow: var(--shadow, 0 8px 24px rgba(0,0,0,.3)); cursor: pointer;
	}
	.mic-live { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; color: var(--accent2, #7cf); }
	.mic-score {
		display: inline-flex; align-items: center; gap: 8px; font-weight: 700; color: #fff;
		background: var(--card, #17172a); border: 1px solid var(--accent2, #7cf); border-radius: 999px;
		padding: 10px 18px; box-shadow: var(--shadow, 0 8px 24px rgba(0,0,0,.3));
	}
	.mic-score strong { font-size: 1.25rem; color: var(--accent2, #7cf); font-variant-numeric: tabular-nums; }
	.mic-live .dot {
		width: 10px; height: 10px; border-radius: 50%; background: #ff5cae;
		animation: micpulse 1s ease-in-out infinite;
	}
	@keyframes micpulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .4; transform: scale(1.4); } }
	.mic-err { font-size: .8rem; color: var(--danger, #ff6b6b); }
	.search-spinner {
		width: 15px; height: 15px; flex: none; border-radius: 50%;
		border: 2px solid var(--line, #2a2a3e); border-top-color: var(--accent2, #7cf);
		animation: spin 0.7s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
	.skel-row {
		display: flex; align-items: center; gap: 12px; padding: 12px 14px; margin-bottom: 8px;
		border-radius: 14px; background: var(--card, #17172a); border: 1px solid var(--line, #2a2a3e);
	}
	.skel-thumb { width: 44px; height: 44px; flex: none; border-radius: 10px; }
	.skel-text { flex: 1; display: flex; flex-direction: column; gap: 8px; }
	.skel-line { height: 12px; border-radius: 6px; }
	.skel-line.short { width: 55%; }
	.skel-thumb, .skel-line {
		background: linear-gradient(90deg, var(--card2, #1d1d2e) 25%, var(--line, #2a2a3e) 37%, var(--card2, #1d1d2e) 63%);
		background-size: 400% 100%; animation: shimmer 1.3s ease-in-out infinite;
	}
	@keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
	.tab {
		flex: 1; text-align: center; padding: 8px; border-radius: 12px; font-size: 0.85rem;
		font-weight: 600; background: var(--card); color: var(--ink-dim); border: 1px solid var(--line); cursor: pointer;
	}
	.tab.active { background: var(--grad); color: #fff; border-color: transparent; }
	.undo-toast {
		position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
		display: flex; align-items: center; gap: 14px; z-index: 30;
		background: var(--card2); border: 1px solid var(--line); border-radius: 14px;
		padding: 12px 16px; box-shadow: var(--shadow); font-size: 0.9rem; max-width: 90vw;
	}
	.undo-toast button {
		border: 0; background: var(--grad); color: #fff; font-weight: 700;
		border-radius: 8px; padding: 6px 12px; cursor: pointer;
	}
	.error-toast {
		position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 30;
		background: #2a1b22; color: #ffb1b1; border: 1px solid #5a2b39;
		padding: 11px 16px; border-radius: 12px; font-size: 0.88rem; max-width: 90vw;
	}
</style>
