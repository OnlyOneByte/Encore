<script lang="ts">
	import { onMount } from 'svelte';
	import type { ServerEvent, QueueEntry, Media, PublicSinger } from '@encore/shared';
	import { GaplessController } from '$lib/tv/gapless';
	import TvPlayer from '$lib/tv/TvPlayer.svelte';

	let { data } = $props();

	let entries = $state<QueueEntry[]>([]);
	let singers = $state<Map<string, PublicSinger>>(new Map());
	let mediaCatalog = $state<Map<string, Media>>(new Map());
	let connected = $state(false);

	let current = $state<QueueEntry | null>(null);
	let upNext = $state<QueueEntry | null>(null);
	const ctl = new GaplessController();
	let tvState = $state(ctl.state);
	let visible = $state<'A' | 'B'>('A');
	// which media each slot shows (from the controller's assignment)
	let slotMedia = $state<{ A: Media | null; B: Media | null }>({ A: null, B: null });

	let ws: WebSocket | undefined;
	let interstitialTimer: ReturnType<typeof setTimeout> | undefined;

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
		current = cur;
		upNext = next;
		ctl.onNowPlaying(cur, next);
		syncSlots();
	}

	function sendTelemetry(status: string, positionSec = 0, durationSec = 0, bufferedNextPct = 0) {
		ws?.send(JSON.stringify({ type: 'tv:telemetry', positionSec, durationSec, status, bufferedNextPct }));
	}

	function onVisibleEnded() {
		const next = ctl.onEnded(upNext);
		tvState = next;
		// tell the server the song ended so it advances authoritatively (nowplaying:changed comes back)
		sendTelemetry('ended');
		if (next === 'interstitial') {
			clearTimeout(interstitialTimer);
			interstitialTimer = setTimeout(() => {
				ctl.onInterstitialDone();
				tvState = ctl.state;
			}, 2500);
		}
		syncSlots();
	}

	onMount(() => {
		const proto = location.protocol === 'https:' ? 'wss' : 'ws';
		ws = new WebSocket(`${proto}://${location.host}/ws?role=tv`);
		ws.onopen = () => {
			connected = true;
			ws!.send(JSON.stringify({ type: 'hello', lastRev: 0 }));
		};
		ws.onclose = () => (connected = false);
		ws.onmessage = (ev) => {
			const e: ServerEvent = JSON.parse(ev.data);
			if (e.type === 'queue:sync') {
				entries = e.entries;
				if (e.singers) singers = new Map(e.singers.map((s) => [s.id, s]));
				if (e.media) mediaCatalog = new Map(e.media.map((m) => [m.id, m]));
			}
			if (e.type === 'nowplaying:changed') applyNowPlaying(e.current, e.upNext);
		};
		return () => ws?.close();
	});

	const isAttract = $derived(tvState === 'attract' || !current);
</script>

<div class="tv">
	<!-- two stacked player slots -->
	<TvPlayer
		media={slotMedia.A}
		visible={visible === 'A' && !isAttract}
		active={visible === 'A'}
		onready={() => { ctl.onVisibleReady(); ctl.onHiddenReady(slotMedia.A?.id ?? ''); tvState = ctl.state; }}
		onended={onVisibleEnded}
		onposition={(s, d) => sendTelemetry('playing', s, d, 100)}
	/>
	<TvPlayer
		media={slotMedia.B}
		visible={visible === 'B' && !isAttract}
		active={visible === 'B'}
		onready={() => { ctl.onVisibleReady(); ctl.onHiddenReady(slotMedia.B?.id ?? ''); tvState = ctl.state; }}
		onended={onVisibleEnded}
		onposition={(s, d) => sendTelemetry('playing', s, d, 100)}
	/>

	{#if isAttract}
		<!-- attract: join QR + up-next ticker -->
		<div class="attract">
			<div class="brand">🎤 <span class="grad">Encore</span></div>
			<div class="join">
				<div class="qr-wrap"><img src={data.qrDataUrl} alt="Scan to join" width="320" height="320" /></div>
				<div class="join-copy">
					<h1>Scan to join the party</h1>
					<p class="url">{data.joinUrl}</p>
					<p class="hint">Pick a name, queue a song, grab the mic.</p>
				</div>
			</div>
		</div>
	{:else}
		<!-- now-playing lower-third -->
		<div class="lower-third">
			<span class="ls-label">Now singing</span>
			<span class="ls-name">{singerName(current?.singerId)}</span>
			<span class="ls-song">{mediaOf(current)?.title ?? ''}</span>
		</div>
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
	.grad { background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
	.join { display: flex; align-items: center; gap: 56px; }
	.qr-wrap { padding: 20px; background: #fff; border-radius: 28px; box-shadow: var(--shadow); animation: breathe 4s ease-in-out infinite; }
	.qr-wrap img { display: block; border-radius: 8px; }
	@keyframes breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.03); } }
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
