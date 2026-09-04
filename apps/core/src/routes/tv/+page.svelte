<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type { ServerEvent, QueueEntry, Media, PublicSinger } from '@encore/shared';
	import { chosenCandidate, isPlayable } from '@encore/shared';
	import { GaplessController } from '$lib/tv/gapless';
	import TvPlayer from '$lib/tv/TvPlayer.svelte';
	import LyricsOverlay from '$lib/tv/LyricsOverlay.svelte';
	import TvProgress from '$lib/tv/TvProgress.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import type { TvProgressStyle } from '@encore/shared';
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
	// The player already reports duration alongside position; it used to be forwarded to telemetry and
	// dropped. Progress needs both.
	let durationSec = $state(0);
	let skipNotice = $state('');
	let tvProgressStyle = $state<TvProgressStyle>(untrack(() => data.tvProgressStyle) ?? 'card');
	$effect(() => {
		tvProgressStyle = data.tvProgressStyle ?? 'card';
	});
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
		// dead/unplayable media — treat like ended so the room advances rather than hanging on black.
		// Say so on screen first: advancing silently means several bad files in a row just flash black
		// across the room with nothing explaining why.
		skipNotice = 'Skipping — that track would not play';
		setTimeout(() => (skipNotice = ''), 4000);
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
			if (e.type === 'settings:changed') {
				interstitialMs = e.settings.room.interstitialMs;
				tvProgressStyle = e.settings.room.tvProgressStyle;
				// The join address is the one setting the TV cannot apply in place: the QR is a
				// server-rendered image, and the whole point of the setting is that the TV's own URL is
				// not the address to advertise. An empty setting means "fall back", which resolves to the
				// value the load already computed — so compare resolved-to-resolved and re-run the load
				// only when the address actually moved, rather than on every unrelated settings write.
				const nextOrigin = e.settings.global.joinOrigin || data.joinFallbackOrigin;
				if (nextOrigin !== data.joinOrigin) invalidateAll();
			}
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

	/*
	 * Queued entries that cannot be sung yet. Drives the lobby's wording: with one of these, "Waiting
	 * for someone to pick a song…" is simply false — somebody picked, and the wait is the vocal
	 * separation. The phone was already saying "You're next once it's ready" while the TV contradicted
	 * it.
	 *
	 * isPlayable (not readyToSing) on purpose: this asks "could the TV load a file for it", which is the
	 * same question the player asks, so the lobby cannot claim something is cooking that the player
	 * would happily start.
	 */
	const pendingCount = $derived(
		entries.filter((e) => {
			const m = mediaOf(e);
			return !m || !isPlayable(m);
		}).length
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
		onposition={(s, d) => { positionSec = s; durationSec = d; sendTelemetry('playing', s, d, 100); }}
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
		onposition={(s, d) => { positionSec = s; durationSec = d; sendTelemetry('playing', s, d, 100); }}
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
			<div class="brand"><Icon name="mic" /> <span class="grad">Encore</span></div>
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
		<div class="brand brand-float"><Icon name="mic" /> <span class="grad">Encore</span></div>
		<TvLobby
			qrDataUrl={data.qrDataUrl}
			joinUrl={data.joinUrl}
			roster={roster.shown}
			overflow={roster.overflow}
			{pendingCount}
		/>
	{:else}
		<!-- now-playing lower-third -->
		<div class="lower-third">
			<span class="ls-label">Now singing</span>
			<span class="ls-name">{singerName(current?.singerId)}</span>
			<span class="ls-song">{mediaOf(current)?.title ?? ''}</span>
			{#if tvProgressStyle === 'card'}
				<TvProgress style="card" elapsedSec={positionSec} {durationSec} />
			{/if}
		</div>
		{#if tvProgressStyle !== 'card'}
			<TvProgress style={tvProgressStyle} elapsedSec={positionSec} {durationSec} />
		{/if}
		<!-- The join QR stays reachable mid-song, bottom-right (the only free corner) -->
		<JoinBadge
			qrDataUrl={data.qrDataUrl}
			joinUrl={data.joinUrl}
			placement="corner"
			onlineCount={online.length}
		/>
	{/if}

	<!--
	  Three transient states, three treatments. They used to share one `.interstitial` block and one
	  pink `.up-song`, so "Next up: Bohemian Rhapsody", "that track would not play" and "still cooking"
	  were visually identical — a viewer could not tell a failure from a normal song change at a glance.
	  Each now carries its own mark, its own colour family and its own eyebrow.
	-->
	{#if tvState === 'interstitial' && upNext}
		<div class="interstitial state-next">
			<div class="up-label">Next up</div>
			<div class="up-name">{singerName(upNext.singerId)}</div>
			<div class="up-song">{mediaOf(upNext)?.title ?? ''}</div>
		</div>
	{/if}

	{#if skipNotice}
		<!-- An error. --danger exists precisely so this cannot be mistaken for an affirmative event. -->
		<div class="interstitial state-error" role="alert">
			<div class="state-mark"><Icon name="warning" /></div>
			<div class="up-label">Skipped</div>
			<div class="up-song">{skipNotice}</div>
		</div>
	{/if}

	{#if tvState === 'waiting'}
		<!-- Not an error and not a transition: work in progress. Warm, and it names what is happening. -->
		<div class="interstitial state-waiting">
			<div class="state-mark"><Icon name="flame" /></div>
			<div class="up-label">Making the karaoke</div>
			<div class="up-song">Stripping the vocals — hang tight</div>
		</div>
	{/if}

	{#if showScore && score}
		<!-- Live score badge (top-right), color + label by accuracy band -->
		<ScoreBadge score={score.score} hits={score.hits} total={score.total} />
	{/if}

	<div class="status" class:on={connected}></div>
</div>

<style>
	/*
	 * TV TYPE SCALE AND SAFE AREA — tokens live in app.css so the same components size correctly in the
	 * /components gallery, which renders them outside this route.
	 *
	 * This surface was inheriting the phone's tokens verbatim, which is how "Now singing", the song
	 * title, the score sub-line and the join URL all ended up at 12–19px — sized for a device held at
	 * 40cm and displayed on a wall at three metres.
	 *
	 * Safe area: every edge element previously used a fixed 40–48px offset, which sits INSIDE the
	 * overscan region many television sets still apply (~5%, or ~54px vertically at 1080p). The
	 * lower-third naming who is singing and the join QR could both be clipped off the screen. One pair
	 * of tokens now owns every edge, so there is a single place to reason about corners.
	 */
	.tv {
		position: fixed;
		inset: 0;
		background: #000;
		overflow: hidden;
	}
	.attract {
		position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
		justify-content: center; gap: 48px; z-index: 5;
		background: radial-gradient(80% 60% at 50% 30%, var(--stage-glow) 0%, var(--bg) 70%);
	}
	.brand {
		position: absolute; top: var(--tv-safe-y); left: var(--tv-safe-x);
		font-weight: 800; font-size: var(--tv-name); display: inline-flex; align-items: center; gap: 12px;
	}
	/* the lobby paints its own full-bleed backdrop, so the brand needs to float above it */
	.brand-float { z-index: 6; }
	.grad { background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
	.join { display: flex; align-items: center; gap: 56px; }
	.join-copy h1 { font-size: var(--tv-hero); margin: 0 0 12px; max-width: 9ch; line-height: 1.05; }
	/*
	 * The URL is the fallback when a camera will not scan, so someone is typing it from across the room.
	 * It was 22px — the least readable thing on a screen whose entire job is to be joined.
	 */
	.url { font-size: var(--tv-body); color: var(--accent2); margin: 0 0 16px; overflow-wrap: anywhere; }
	.hint { font-size: var(--tv-label); color: var(--ink-dim); margin: 0; }
	.lower-third {
		/* Capped: unbounded, a long title or singer name grew this card rightward into the join QR at
		   bottom-right. 46vw leaves the QR its corner on every aspect ratio. */
		position: absolute; left: var(--tv-safe-x); bottom: var(--tv-safe-y); z-index: 6;
		display: flex; flex-direction: column;
		max-width: 46vw;
		gap: 4px; padding: 16px 28px; border-radius: 16px;
		/*
		 * Near-opaque, not a 0.7 tint. This card sits over arbitrary video, so translucency put its
		 * white text at a contrast ratio nothing could predict — and backdrop-filter is unreliable on TV
		 * browsers, so the blur that was supposed to rescue it may never run at all.
		 */
		background: linear-gradient(120deg, rgba(88, 62, 200, 0.96), rgba(190, 55, 130, 0.94));
		backdrop-filter: blur(6px);
	}
	.ls-label { font-size: var(--tv-label); letter-spacing: 0.16em; text-transform: uppercase; opacity: 0.92; }
	.ls-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--tv-name); font-weight: 800; }
	.ls-song { font-size: var(--tv-body); opacity: 0.97; }
	.interstitial {
		position: absolute; inset: 0; z-index: 7; display: flex; flex-direction: column; align-items: center;
		justify-content: center; gap: 12px; background: rgba(11, 11, 18, 0.94);
		padding: var(--tv-safe-y) var(--tv-safe-x);
		text-align: center;
	}
	.up-label { font-size: var(--tv-label); letter-spacing: 0.2em; text-transform: uppercase; color: var(--ink-dim); }
	.up-name { font-size: var(--tv-hero); font-weight: 800; }
	.up-song { font-size: var(--tv-name); }
	/* A mark large enough to be the first thing read, since it is what distinguishes these states. */
	.state-mark { font-size: var(--tv-hero); line-height: 1; margin-bottom: 4px; }

	/* Affirmative: something good is about to happen. */
	.state-next .up-song { color: var(--accent2); }

	/* Failure. Distinct family AND a distinct eyebrow, so colour is not the only carrier. */
	.state-error { background: rgba(42, 27, 34, 0.95); }
	.state-error .state-mark { color: var(--danger); }
	.state-error .up-label { color: var(--danger-ink); }
	.state-error .up-song { color: var(--danger-ink); }

	/* Work in progress: neither affirmative nor broken. */
	.state-waiting .state-mark { color: var(--warn); }
	.state-waiting .up-label { color: var(--warn); }
	.state-waiting .up-song { color: var(--ink); }

	/*
	 * Connection telemetry. Larger than the old 12px and pulled inside the safe area — at 12px in a
	 * corner a TV may clip it informed nobody, and anyone who did see it read it as a stuck pixel.
	 */
	.status {
		position: absolute; top: var(--tv-safe-y); right: var(--tv-safe-x);
		width: 16px; height: 16px; border-radius: 50%; background: var(--ink-dim); z-index: 8;
	}
	.status.on { background: var(--ok); box-shadow: 0 0 0 5px rgba(51, 214, 166, 0.18); }
</style>
