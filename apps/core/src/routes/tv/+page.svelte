<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { ServerEvent, QueueEntry, Media, PublicSinger } from '@encore/shared';
	import { chosenCandidate, isPlayable } from '@encore/shared';
	import { GaplessController } from '$lib/tv/gapless';
	import TvPlayer from '$lib/tv/TvPlayer.svelte';
	import LyricsOverlay from '$lib/tv/LyricsOverlay.svelte';
	import ScoreBadge from '$lib/tv/ScoreBadge.svelte';
	import TvLobby from '$lib/tv/TvLobby.svelte';
	import JoinBadge from '$lib/tv/JoinBadge.svelte';
	import { tvScreen, lobbyRoster } from '$lib/tv/screen';

	let { data } = $props();

	let entries = $state<QueueEntry[]>([]);
	let singers = $state<Map<string, PublicSinger>>(new Map());
	let mediaCatalog = $state<Map<string, Media>>(new Map());
	let connected = $state(false);
	// Singer ids with a live socket right now. Drives the lobby roster and the join card's
	// count — NOT `singers`, which is every singer who ever joined (append-only + file-backed).
	let online = $state<string[]>([]);
	// Seeded from the room's stored pacing and kept live by settings:changed. The effect re-adopts
	// `data` so a load re-run is not pinned to the value captured at mount.
	let interstitialMs = $state(untrack(() => data.interstitialMs) ?? 2500);
	$effect(() => {
		interstitialMs = data.interstitialMs ?? 2500;
	});

	let current = $state<QueueEntry | null>(null);
	let upNext = $state<QueueEntry | null>(null);
	const ctl = new GaplessController();
	let tvState = $state(ctl.state);
	let visible = $state<'A' | 'B'>('A');
	// live playback position (seconds) from the active player's telemetry — drives the lyrics overlay
	let positionSec = $state(0);
	// live score for the current song, from score:update broadcasts (null until first sample)
	let score = $state<Extract<ServerEvent, { type: 'score:update' }> | null>(null);
	// playback isPlaying (pause/resume from the phone) — wired into both player slots
	let isPlaying = $state(true);
	// seek target (positionSec from playback:state) — the player jumps the video on a real change
	let seekSec = $state(0);
	let slotMedia = $state<{ A: Media | null; B: Media | null }>({ A: null, B: null });

	let ws: WebSocket | undefined;
	let interstitialTimer: ReturnType<typeof setTimeout> | undefined;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let reconnectAttempt = 0;
	let disposed = false;

	function mediaOf(entry: QueueEntry | null): Media | null {
		return entry ? (mediaCatalog.get(entry.mediaId) ?? null) : null;
	}
	function singerName(id: string | undefined): string {
		return id ? (singers.get(id)?.displayName ?? 'Someone') : 'Someone';
	}

	function syncSlots() {
		const a = ctl.assignment();
		visible = a.visible;
		tvState = ctl.state;
		const curMedia = mediaOf(current);
		const nextMedia = mediaOf(upNext);
		// visible slot shows current; hidden slot pre-warms upNext
		slotMedia = a.visible === 'A' ? { A: curMedia, B: nextMedia } : { A: nextMedia, B: curMedia };
	}

	function applyNowPlaying(cur: QueueEntry | null, next: QueueEntry | null) {
		if (score && score.entryId !== cur?.id) score = null; // new song → drop the previous score
		current = cur;
		upNext = next;
		// held-slot: if the server handed us a current whose media has no instrumental yet (a cooking
		// make-karaoke song), show WAITING rather than a black player. Server normally skips these via
		// nextPlayable, so this is a belt-and-suspenders guard.
		const m = mediaOf(cur);
		if (cur && m && !isPlayable(m)) {
			ctl.enterWaiting();
			tvState = ctl.state;
			return;
		}
		ctl.onNowPlaying(cur, next);
		syncSlots();
	}

	function sendTelemetry(status: string, positionSec = 0, durationSec = 0, bufferedNextPct = 0) {
		ws?.send(JSON.stringify({ type: 'tv:telemetry', positionSec, durationSec, status, bufferedNextPct }));
	}

	function onVisibleError() {
		// dead/unplayable media — treat like ended so the room advances rather than hanging on black
		sendTelemetry('ended');
		onVisibleEnded();
	}

	function onVisibleEnded() {
		const next = ctl.onEnded(upNext);
		tvState = next;
		// tell the server the song ended so it advances authoritatively (nowplaying:changed comes back)
		sendTelemetry('ended');
		if (next === 'interstitial') {
			clearTimeout(interstitialTimer);
			const ms = interstitialMs;
			if (ms === 0) {
				ctl.onInterstitialDone(); // pure gapless hard-cut
				tvState = ctl.state;
			} else {
				interstitialTimer = setTimeout(() => {
					ctl.onInterstitialDone();
					tvState = ctl.state;
				}, ms);
			}
		}
		syncSlots();
	}

	function connect() {
		const proto = location.protocol === 'https:' ? 'wss' : 'ws';
		ws = new WebSocket(`${proto}://${location.host}/ws?role=tv`);
		ws.onopen = () => {
			connected = true;
			reconnectAttempt = 0;
			// resync handshake — gets queue:sync; nowplaying re-derives on next change.
			ws!.send(JSON.stringify({ type: 'hello', lastRev: 0 }));
		};
		ws.onclose = () => {
			connected = false;
			// IMPORTANT: the video/iframe keeps playing through a socket drop — playback never stops.
			// We only re-establish the control channel with capped backoff and resync.
			if (disposed) return;
			const delay = Math.min(500 * 2 ** reconnectAttempt, 5000);
			reconnectAttempt++;
			reconnectTimer = setTimeout(connect, delay);
		};
		ws.onmessage = (ev) => {
			const e: ServerEvent = JSON.parse(ev.data);
			if (e.type === 'queue:sync') {
				entries = e.entries;
				if (e.singers) singers = new Map(e.singers.map((s) => [s.id, s]));
				if (e.media) mediaCatalog = new Map(e.media.map((m) => [m.id, m]));
				// only adopt presence when the server actually sent it — an omitted `online` means
				// "no info", not "nobody here", and must not blank a roster we already have.
				if (e.online) online = e.online;
			}
			if (e.type === 'singer:presence') online = e.online;
			// Room pacing is live: a slider move on a phone applies without reloading the TV.
			if (e.type === 'settings:changed') interstitialMs = e.settings.room.interstitialMs;
			if (e.type === 'nowplaying:changed') applyNowPlaying(e.current, e.upNext);
			if (e.type === 'score:update') score = e;
			// pause/resume from the phone (playback:state.isPlaying) → drives the player slots
			if (e.type === 'playback:state') { isPlaying = e.state.isPlaying; seekSec = e.state.positionSec; }
			// live media catalog updates (cooking progress + ready flip) so the TV leaves WAITING
			// promptly and resolves the ready song's instrumental (also mitigates the cook→play gap)
			if (e.type === 'media:status') {
				const m = mediaCatalog.get(e.mediaId);
				if (m) {
					mediaCatalog = new Map(mediaCatalog).set(e.mediaId, {
						...m,
						stemStatus: e.status === 'ready' ? 'ready' : e.status === 'failed' ? m.stemStatus : 'queued'
					});
				}
			}
			// learn singers who join AFTER our initial sync, or the lower-third shows "Someone" for
			// late joiners instead of their real name (mirrors the phone).
			if (e.type === 'singer:joined') singers = new Map(singers).set(e.singer.id, e.singer);
		};
	}

	onMount(() => {
		connect();
		return () => {
			disposed = true;
			clearTimeout(reconnectTimer);
			ws?.close();
		};
	});

	// Which surface the TV shows. Replaces the old `isAttract` (which collapsed "nobody here"
	// and "people here, nothing queued" into one screen).
	const screen = $derived(
		tvScreen({ playerState: tvState, current, entries, onlineCount: online.length })
	);
	const isAttract = $derived(screen === 'attract' || screen === 'lobby');
	const roster = $derived(lobbyRoster(online, singers));
	// lyrics overlay is live only while a song is actually playing (not attract/lobby/interstitial/waiting)
	const lyricsActive = $derived(screen === 'playing' && tvState !== 'interstitial');
	// Which candidate the current lyricsRef came from, so the overlay can label a guess.
	// Null for a pre-candidate artifact — unknown provenance, asserted as neither verified nor not.
	const lyricsProvenance = $derived.by(() => {
		const m = mediaOf(current);
		return m ? chosenCandidate(m) : null;
	});
	// show the live score badge whenever we have a score for the currently-playing entry
	const showScore = $derived(screen === 'playing' && !!score && score.entryId === current?.id);
</script>

<div class="tv">
	<!-- two stacked player slots -->
	<TvPlayer
		media={slotMedia.A}
		visible={visible === 'A' && !isAttract}
		active={visible === 'A'}
		playing={isPlaying}
		seekSec={seekSec}
		onready={() => { ctl.onVisibleReady(); ctl.onHiddenReady(slotMedia.A?.id ?? ''); tvState = ctl.state; }}
		onended={onVisibleEnded}
		onerror={onVisibleError}
		onposition={(s, d) => { positionSec = s; sendTelemetry('playing', s, d, 100); }}
	/>
	<TvPlayer
		media={slotMedia.B}
		visible={visible === 'B' && !isAttract}
		active={visible === 'B'}
		playing={isPlaying}
		seekSec={seekSec}
		onready={() => { ctl.onVisibleReady(); ctl.onHiddenReady(slotMedia.B?.id ?? ''); tvState = ctl.state; }}
		onended={onVisibleEnded}
		onerror={onVisibleError}
		onposition={(s, d) => { positionSec = s; sendTelemetry('playing', s, d, 100); }}
	/>

	<!-- Word-timed karaoke lyrics over the active player -->
	<LyricsOverlay
		lyricsRef={mediaOf(current)?.lyricsRef}
		provenance={lyricsProvenance}
		{positionSec}
		playing={lyricsActive}
		visible={lyricsActive}
	/>

	{#if screen === 'attract'}
		<!-- attract: nobody here yet — the QR is the only thing to do, so it owns the screen -->
		<div class="attract">
			<div class="brand">🎤 <span class="grad">Encore</span></div>
			<div class="join">
				<JoinBadge qrDataUrl={data.qrDataUrl} joinUrl={data.joinUrl} placement="hero" size={320} />
				<div class="join-copy">
					<h1>Scan to join the party</h1>
					<p class="url">{data.joinUrl}</p>
					<p class="hint">Pick a name, queue a song, grab the mic.</p>
				</div>
			</div>
		</div>
	{:else if screen === 'lobby'}
		<!-- People ARE here, nothing queued — name them and say what we're waiting for -->
		<div class="brand brand-float">🎤 <span class="grad">Encore</span></div>
		<TvLobby
			qrDataUrl={data.qrDataUrl}
			joinUrl={data.joinUrl}
			roster={roster.shown}
			overflow={roster.overflow}
		/>
	{:else}
		<!-- now-playing lower-third -->
		<div class="lower-third">
			<span class="ls-label">Now singing</span>
			<span class="ls-name">{singerName(current?.singerId)}</span>
			<span class="ls-song">{mediaOf(current)?.title ?? ''}</span>
		</div>
		<!-- The join QR stays reachable mid-song, bottom-right (the only free corner) -->
		<JoinBadge
			qrDataUrl={data.qrDataUrl}
			joinUrl={data.joinUrl}
			placement="corner"
			onlineCount={online.length}
		/>
	{/if}

	{#if tvState === 'interstitial' && upNext}
		<div class="interstitial">
			<div class="up-label">Next up</div>
			<div class="up-name">{singerName(upNext.singerId)}</div>
			<div class="up-song">{mediaOf(upNext)?.title ?? ''}</div>
		</div>
	{/if}

	{#if tvState === 'waiting'}
		<div class="interstitial">
			<div class="up-song">🔥 Still cooking… hang tight</div>
		</div>
	{/if}

	{#if showScore && score}
		<!-- Live score badge (top-right), color + label by accuracy band -->
		<ScoreBadge score={score.score} hits={score.hits} total={score.total} />
	{/if}

	<div class="status" class:on={connected}></div>
</div>

<style>
	.tv { position: fixed; inset: 0; background: #000; overflow: hidden; }
	.attract {
		position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
		justify-content: center; gap: 48px; z-index: 5;
		background: radial-gradient(80% 60% at 50% 30%, #1b1430 0%, var(--bg) 70%);
	}
	.brand { position: absolute; top: 40px; left: 48px; font-weight: 800; font-size: 2rem; }
	/* the lobby paints its own full-bleed backdrop, so the brand needs to float above it */
	.brand-float { z-index: 6; }
	.grad { background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
	.join { display: flex; align-items: center; gap: 56px; }
	.join-copy h1 { font-size: 3rem; margin: 0 0 12px; max-width: 9ch; line-height: 1.05; }
	.url { font-size: 1.4rem; color: var(--accent2); margin: 0 0 16px; }
	.hint { font-size: 1.2rem; color: var(--ink-dim); margin: 0; }
	.lower-third {
		position: absolute; left: 48px; bottom: 48px; z-index: 6; display: flex; flex-direction: column;
		gap: 4px; padding: 16px 24px; border-radius: 16px;
		background: linear-gradient(120deg, rgba(124, 92, 255, 0.85), rgba(255, 92, 174, 0.7)); backdrop-filter: blur(6px);
	}
	.ls-label { font-size: 0.8rem; letter-spacing: 0.16em; text-transform: uppercase; opacity: 0.85; }
	.ls-name { font-size: 1.8rem; font-weight: 800; }
	.ls-song { font-size: 1.2rem; opacity: 0.95; }
	.interstitial {
		position: absolute; inset: 0; z-index: 7; display: flex; flex-direction: column; align-items: center;
		justify-content: center; gap: 12px; background: rgba(11, 11, 18, 0.92);
	}
	.up-label { font-size: 1rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--ink-dim); }
	.up-name { font-size: 3.4rem; font-weight: 800; }
	.up-song { font-size: 1.8rem; color: var(--accent2); }
	.status { position: absolute; top: 48px; right: 48px; width: 12px; height: 12px; border-radius: 50%; background: var(--ink-dim); z-index: 8; }
	.status.on { background: var(--ok); box-shadow: 0 0 0 4px rgba(51, 214, 166, 0.18); }
</style>
