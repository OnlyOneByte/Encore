<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type { ServerEvent, QueueEntry, Media, PublicSinger } from '@encore/shared';
	import { chosenCandidate, isPlayable, effectiveSongIntroMs, songDisplay, soundingKeyLabel } from '@encore/shared';
	import { GaplessController } from '$lib/tv/gapless';
	import TvPlayer from '$lib/tv/TvPlayer.svelte';
	import LyricsOverlay from '$lib/tv/LyricsOverlay.svelte';
	import TvProgress from '$lib/tv/TvProgress.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import {
		effectiveGuideLevel,
		resolveLyricsPresentation,
		type EffectiveSettings,
		type TvBackgroundStyle
	} from '@encore/shared';
	import { stageBackgroundCss } from '$lib/tv/background';
	import VisualizerStage from '$lib/tv/VisualizerStage.svelte';
	import TvLobby from '$lib/tv/TvLobby.svelte';
	import JoinBadge from '$lib/tv/JoinBadge.svelte';
	import { tvScreen, lobbyRoster, isUnreachableJoinOrigin, lyricsAdvancing } from '$lib/tv/screen';

	let { data } = $props();

	let entries = $state<QueueEntry[]>([]);
	let singers = $state<Map<string, PublicSinger>>(new Map());
	let mediaCatalog = $state<Map<string, Media>>(new Map());
	let connected = $state(false);
	// Singer ids with a live socket right now. Drives the lobby roster and the join card's
	// count — NOT `singers`, which is every singer who ever joined (append-only + file-backed).
	let online = $state<string[]>([]);
	// In the room but unreachable — a locked phone, a pocket. Counted and rendered greyed, never
	// erased: a socket dropping is not someone leaving the party.
	let away = $state<string[]>([]);
	// Room + global settings as ONE object, seeded from the load and kept live by settings:changed.
	// Held whole rather than copied field-by-field: the previous shape needed a new local, a new effect
	// line and a new assignment in the socket handler per field, which is three lists to keep in step.
	// The effect re-adopts `data` so a load re-run is not pinned to the value captured at mount.
	let settings = $state<EffectiveSettings>(untrack(() => data.settings));
	$effect(() => {
		settings = data.settings;
	});
	const songIntroMs = $derived(effectiveSongIntroMs(settings.room));
	// Already clamped against the global sync mode — the TV renders what it is handed.
	const lyricsStyle = $derived(resolveLyricsPresentation(settings));

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
	let tvProgressStyle = $derived(settings.room.tvProgressStyle);
	// What the room paints behind the song. Derived from the same settings object, so a live
	// settings:changed needs no per-field assignment here.
	let tvBackgroundStyle = $derived(settings.room.tvBackgroundStyle);
	let tvBackgroundHue = $derived(settings.room.tvBackgroundHue);
	let tvVisualizer = $derived(settings.room.tvVisualizer);
	// playback isPlaying (pause/resume from the phone) — wired into both player slots
	let isPlaying = $state(true);
	// seek target (positionSec from playback:state) — the player jumps the video on a real change
	let seekSec = $state(0);
	// Per-song background override from playback:state. null = use the room default (the resting state).
	let backgroundOverride = $state<TvBackgroundStyle | null>(null);
	// The GUIDING TRACK, resolved the same way: the per-song override from playback:state (null = none
	// pinned) over the room's standing default. `effectiveGuideLevel` does the resolution — read raw, a
	// null override is indistinguishable from "explicitly off", which is the distinction that lets a
	// room default survive a song change.
	let guideOverride = $state<number | null>(null);
	const guideLevel = $derived(
		effectiveGuideLevel({ guideLevel: guideOverride }, settings.room.guideLevelDefault)
	);
	// Current transpose in semitones (±), straight from playback:state. The TV now HONOURS this: the
	// player shifts pitch in the browser (see pitch-shift.ts), so there is no pre-rendered variant to
	// 404 on — which is why it was ignored before.
	let keyShift = $state(0);
	let slotMedia = $state<{ A: Media | null; B: Media | null }>({ A: null, B: null });

	let ws: WebSocket | undefined;
	let interstitialTimer: ReturnType<typeof setTimeout> | undefined;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let reconnectAttempt = 0;
	let disposed = false;

	/**
	 * Fold a fresh `queue:sync` media list into the existing catalog, PRESERVING the existing object
	 * identity for any song whose fields are unchanged.
	 *
	 * Bug A root cause: the old `new Map(e.media.map(...))` gave every Media a fresh identity on every
	 * sync, including the one currently playing. `applyNowPlaying` -> `syncSlots` then wrote that new
	 * object into `slotMedia`, and even with TvPlayer's src-assign guard this is the honest fix — an
	 * unrelated cook must not churn the object graph the whole render tree reads. Comparing by JSON is
	 * adequate here: Media is a flat, JSON-shaped record already sent over the wire as JSON, so a
	 * structural match means genuinely-equal fields, and reusing the prior object on a match keeps
	 * identity stable for every downstream consumer.
	 */
	function mergeCatalog(prev: Map<string, Media>, incoming: Media[]): Map<string, Media> {
		const next = new Map<string, Media>();
		for (const m of incoming) {
			const existing = prev.get(m.id);
			next.set(m.id, existing && JSON.stringify(existing) === JSON.stringify(m) ? existing : m);
		}
		return next;
	}

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

	/**
	 * Which entry the song-intro card is announcing. Captured explicitly at each point we enter the
	 * interstitial rather than derived from `upNext`, because `nowplaying:changed` can land mid-intro and
	 * advance both `current` and `upNext` — deriving it would make the card name the song after next.
	 */
	let introEntry = $state<QueueEntry | null>(null);
	/** The session has shown at least one song, so the next intro is a transition rather than an opener. */
	let openedOnce = $state(false);

	function onVisibleEnded() {
		const next = ctl.onEnded(upNext);
		tvState = next;
		// tell the server the song ended so it advances authoritatively (nowplaying:changed comes back)
		sendTelemetry('ended');
		if (next === 'interstitial') {
			introEntry = upNext;
			holdSongIntro();
		}
		syncSlots();
	}

	/**
	 * The opening song of a session gets an intro too.
	 *
	 * The card used to fire only from `onEnded`, which was right when it was a "Next up" transition and
	 * wrong now that it announces the song: the first song of the night — the one where nobody yet knows
	 * whose turn it is — was the only one that appeared unannounced.
	 */
	function onFirstSongReady() {
		if (openedOnce || songIntroMs === 0 || !current) return;
		openedOnce = true;
		introEntry = current;
		ctl.enterInterstitial();
		tvState = ctl.state;
		holdSongIntro();
	}

	/** Hold on the intro card, then let the song start. 0 = the intro is switched off; hard-cut. */
	function holdSongIntro() {
		clearTimeout(interstitialTimer);
		if (songIntroMs === 0) {
			ctl.onInterstitialDone(); // pure gapless hard-cut
			tvState = ctl.state;
			return;
		}
		interstitialTimer = setTimeout(() => {
			ctl.onInterstitialDone();
			tvState = ctl.state;
		}, songIntroMs);
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
				if (e.media) mediaCatalog = mergeCatalog(mediaCatalog, e.media);
				// only adopt presence when the server actually sent it — an omitted `online` means
				// "no info", not "nobody here", and must not blank a roster we already have.
				if (e.online) online = e.online;
				if (e.away) away = e.away;
			}
			if (e.type === 'singer:presence') {
				online = e.online;
				away = e.away;
			}
			// Room settings are live: a change on a phone applies without reloading the TV. One
			// assignment, so a new setting needs no edit here.
			if (e.type === 'settings:changed') {
				settings = e.settings;
				// The join address is the one setting the TV cannot apply in place: the QR is a
				// server-rendered image, and the whole point of the setting is that the TV's own URL is
				// not the address to advertise. An empty setting means "fall back", which resolves to the
				// value the load already computed — so compare resolved-to-resolved and re-run the load
				// only when the address actually moved, rather than on every unrelated settings write.
				const nextOrigin = e.settings.global.joinOrigin || data.joinFallbackOrigin;
				if (nextOrigin !== data.joinOrigin) invalidateAll();
			}
			if (e.type === 'nowplaying:changed') applyNowPlaying(e.current, e.upNext);
			// pause/resume from the phone (playback:state.isPlaying) -> drives the player slots
			if (e.type === 'playback:state') {
				isPlaying = e.state.isPlaying;
				seekSec = e.state.positionSec;
				// Per-song background override; null hands the song back to the room default.
				backgroundOverride = e.state.background;
				guideOverride = e.state.guideLevel;
				// keyShift is now honoured — the player transposes in the browser. See `keyShift` state.
				keyShift = e.state.keyShift;
			}
			// live media catalog updates (cooking progress + ready flip) so the TV leaves WAITING
			// promptly and resolves the ready song's instrumental (also mitigates the cook->play gap)
			if (e.type === 'media:status') {
				const m = mediaCatalog.get(e.mediaId);
				if (m) {
					mediaCatalog = new Map(mediaCatalog).set(e.mediaId, {
						...m,
						stemStatus: e.status === 'ready' ? 'ready' : e.status === 'failed' ? m.stemStatus : 'queued'
					});
				}
				// A cook that FAILED, or a job NO connected worker can ever run (`unservable`), will never
				// become playable — and enterWaiting() sets no timer, so if this is the entry the room is
				// holding on, the party stares at "Making the karaoke" forever. Leave WAITING the same way
				// the dead-media path does: say so on screen via the error treatment, tell the server the
				// entry ended so it advances authoritatively, and drop out of the waiting hold.
				// Defensive: this fires purely on the wire signal and does not assume the server TTL fix
				// has landed.
				const stuck = e.status === 'failed' || e.unservable === true;
				if (stuck && tvState === 'waiting' && current && current.mediaId === e.mediaId) {
					const who = singerName(current.singerId);
					skipNotice = `Couldn't make the karaoke for ${who}'s song — skipping`;
					setTimeout(() => (skipNotice = ''), 4000);
					sendTelemetry('ended');
					onVisibleEnded();
				}
			}
			// learn singers who join AFTER our initial sync, or the lower-third shows "Someone" for
			// late joiners instead of their real name (mirrors the phone).
			if (e.type === 'singer:joined') singers = new Map(singers).set(e.singer.id, e.singer);
			// A rename has to reach the TV or the roster chip and the "Now singing" lower-third keep the old
			// name until the next full sync, which on a quiet room is not until someone touches the queue.
			if (e.type === 'singer:updated') singers = new Map(singers).set(e.singer.id, e.singer);
			if (e.type === 'singer:left') {
				online = online.filter((id) => id !== e.singerId);
				away = away.filter((id) => id !== e.singerId);
			}
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
		tvScreen({ playerState: tvState, current, entries, inRoomCount: online.length + away.length })
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
	const roster = $derived(lobbyRoster(online, away, singers));
	/*
	 * The stage background, and the band it is shown in.
	 *
	 * Gated on `!isAttract` — the SAME flag that gates the player slots — rather than on
	 * `screen === 'playing'`. That is deliberate: a literal playing check would drop the background
	 * during the interstitial, putting a black flash between every song, and it would also drop it on
	 * `waiting` (a song IS on the stage, it is still cooking). Reusing the flag also means the two
	 * conditions cannot drift apart later.
	 *
	 * The attract and lobby screens keep painting their own glow at z-index 5 and are untouched by this
	 * feature, so they sit above this layer regardless.
	 */
	const currentSingerColor = $derived(current ? (singers.get(current.singerId)?.color ?? null) : null);
	/*
	 * The key line for the lower-third: what the room is HEARING, plus the shift if any.
	 *
	 * `soundingKeyLabel` already moves the detected key by `keyShift` and returns null when there is no
	 * trustworthy key — so a song with no detected key shows nothing rather than a guess. The shifted
	 * key is the honest label (a +2 song in G is heard in A), and the "· +2" suffix tells the singer HOW
	 * FAR they have moved from the original. At 0 there is no suffix. The sign is written with ASCII
	 * `+`/`-` and the separator is a Latin-1 middot — a typographic sharp/flat/arrow would trip the
	 * icons.test.ts codepoint guard (musical sharp U+266F / flat U+266D are in its banned range); the
	 * shared helper already spells accidentals as ASCII 'G#'/'Ab'.
	 */
	const keyLine = $derived.by(() => {
		const label = soundingKeyLabel(mediaOf(current)?.songProfile, keyShift);
		if (!label) return null;
		return keyShift === 0 ? label : `${label} · ${keyShift > 0 ? '+' : ''}${keyShift}`;
	});
	/*
	 * The override wins over the room default when set; `null` means defer to the room.
	 */
	const resolvedBackground = $derived(backgroundOverride ?? tvBackgroundStyle);
	const stageBg = $derived(stageBackgroundCss(resolvedBackground, tvBackgroundHue, currentSingerColor));
	// lyrics overlay is live only while a song is actually playing (not attract/lobby/interstitial/waiting)
	const lyricsActive = $derived(screen === 'playing' && tvState !== 'interstitial');
	// Bug B: the reel and ball ADVANCE only while the transport is actually playing. `lyricsActive`
	// stays true through a pause (a paused song is still `current`), so binding the overlay's `playing`
	// prop to it kept the words scrolling with the audio frozen. Visibility still rides `lyricsActive`
	// — the overlay stays on screen, just frozen mid-line.
	const lyricsPlaying = $derived(lyricsAdvancing(screen, tvState, isPlaying));
	// Bug C: the lower-third showed the RAW upload title. Resolve the display fields once — canonical
	// title/artist when a confident parse produced them, never the uploader. Artist is null when there
	// is nothing trustworthy, and the markup omits the line rather than inventing one.
	const nowPlayingDisplay = $derived(songDisplay(mediaOf(current)));
	// Which candidate the current lyricsRef came from, so the overlay can label a guess.
	// Null for a pre-candidate artifact — unknown provenance, asserted as neither verified nor not.
	const lyricsProvenance = $derived.by(() => {
		const m = mediaOf(current);
		return m ? chosenCandidate(m) : null;
	});
	/*
	 * Whether the join QR advertises an address no phone can reach.
	 *
	 * `data.joinOrigin` is derived from the request host, so opening /tv ON the serving machine puts a
	 * loopback / bare-hostname address on the wall and every scan fails silently. When that is the case
	 * we replace the working-looking QR with an operator notice that names the fix, rather than letting
	 * the room discover the dead QR one failed scan at a time.
	 */
	const joinUnreachable = $derived(isUnreachableJoinOrigin(data.joinOrigin));

	/*
	 * Which ONE transient treatment is on screen. Previously the skip notice, the "Next up" intro and
	 * the waiting state were three independent {#if} blocks at the same z-index, all inset:0, with
	 * non-exclusive conditions — the media:status "stuck" path sets `skipNotice` AND leaves `tvState`
	 * mid-transition, so two full-screen panels could paint over each other. Deriving a single value and
	 * gating every block on it makes exactly one mountable, and the precedence states which wins:
	 *   error   — a skip notice is the most urgent thing to say, so it outranks everything.
	 *   waiting — the player is actively holding for a cook; a real, named in-progress state.
	 *   next    — the song-intro card (opener or gapless-swap transition).
	 *   loading — the FALLBACK for the missed-preload path (P1 black stage). When the gapless swap
	 *             misses its window, `onEnded` sets `loading` with `current` still set, so `screen`
	 *             derives `playing` and a not-yet-loaded <video> would render black under only the
	 *             lower-third — the swap path shows a card, this path showed nothing. Keep a loading
	 *             treatment up until the visible player reports ready (onVisibleReady flips `loading`
	 *             to `playing`). Also covers the first-song load before onFirstSongReady, where black
	 *             was equally wrong.
	 */
	const transient = $derived.by(() => {
		if (skipNotice) return 'error';
		if (tvState === 'waiting') return 'waiting';
		if (tvState === 'interstitial' && introEntry) return 'next';
		if (tvState === 'loading' && current) return 'loading';
		return null;
	});
	/** The entry the loading treatment is announcing — the one the visible player is loading toward. */
	const loadingDisplay = $derived(songDisplay(mediaOf(current)));
</script>

<div class="tv">
	<!--
		z-index 0 — the stage background, beneath both player slots (1 and 2). First child so the
		document order matches the paint order. `.tv` keeps its own black as the floor under it, which is
		what shows while this layer is faded out.
	-->
	<div class="stage-bg" class:shown={!isAttract} style="background: {stageBg}">
		<!--
			INSIDE the stage layer, not a sibling: the visualizer then inherits the one visibility gate and
			the one crossfade already proven for backgrounds, rather than introducing a second element that
			has to agree with this one about when to show. `stageBg` is its black floor (see
			background.ts's `visualizer` case), so a first frame that has not painted yet shows black.

			`playing` is the SAME `!isAttract` band, so the loop is cancelled on the idle screens instead of
			animating behind an opaque attract gradient for nothing.
		-->
		{#if resolvedBackground === 'visualizer'}
			<VisualizerStage variant={tvVisualizer} hue={tvBackgroundHue} playing={!isAttract} />
		{/if}
	</div>
	<!-- two stacked player slots -->
	<TvPlayer
		media={slotMedia.A}
		visible={visible === 'A' && !isAttract}
		active={visible === 'A'}
		playing={isPlaying}
		seekSec={seekSec}
		{keyShift}
		{guideLevel}
		onready={() => { ctl.onVisibleReady(); ctl.onHiddenReady(slotMedia.A?.id ?? ''); tvState = ctl.state; onFirstSongReady(); }}
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
		{keyShift}
		{guideLevel}
		onready={() => { ctl.onVisibleReady(); ctl.onHiddenReady(slotMedia.B?.id ?? ''); tvState = ctl.state; onFirstSongReady(); }}
		onended={onVisibleEnded}
		onerror={onVisibleError}
		onposition={(s, d) => { positionSec = s; durationSec = d; sendTelemetry('playing', s, d, 100); }}
	/>

	<!-- Word-timed karaoke lyrics over the active player -->
	<LyricsOverlay
		lyricsRef={mediaOf(current)?.lyricsRef}
		provenance={lyricsProvenance}
		{positionSec}
		playing={lyricsPlaying}
		visible={lyricsActive}
		ball={lyricsStyle.ball}
		highlight={lyricsStyle.highlight}
		leadSec={lyricsStyle.leadSec}
		scalePct={settings.room.lyricsScalePct}
		font={settings.room.lyricsFont}
		textCase={settings.room.lyricsCase}
		linesBefore={settings.room.lyricsLinesBefore}
		linesAfter={settings.room.lyricsLinesAfter}
	/>

	{#if screen === 'attract'}
		<!-- attract: nobody here yet — the QR is the only thing to do, so it owns the screen -->
		<div class="attract">
			<div class="brand"><Icon name="mic" /> <span class="grad">Encore</span></div>
			<div class="join">
				<JoinBadge qrDataUrl={data.qrDataUrl} joinUrl={data.joinUrl} placement="hero" size={320} unreachable={joinUnreachable} />
				{#if !joinUnreachable}
					<div class="join-copy">
						<h1>Scan to join the party</h1>
						<p class="url">{data.joinUrl}</p>
						<p class="hint">Pick a name, queue a song, grab the mic.</p>
					</div>
				{/if}
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
			unreachable={joinUnreachable}
		/>
	{:else}
		<!-- now-playing lower-third -->
		<div class="lower-third">
			<span class="ls-label">Now singing</span>
			<span class="ls-name">{singerName(current?.singerId)}</span>
			<span class="ls-song">{nowPlayingDisplay.title}</span>
			<!-- Artist only when a confident parse produced one — never the uploader. -->
			{#if nowPlayingDisplay.artist}<span class="ls-artist">{nowPlayingDisplay.artist}</span>{/if}
			<!-- The sounding key + how far it is transposed. Only rendered when the cook found a
			     trustworthy key; muted like the eyebrow so it reads as metadata, not a heading. It lives in
			     the card because all four screen corners are already occupied (brand top-left, status
			     top-right, score/lyrics centre, join QR bottom-right) — the card is the only free space, and
			     it is capped at 46vw so this extra line cannot grow it into the QR.
			     NOTE the card can now reach five lines (eyebrow, singer, two-line title, artist, key). It is
			     bottom-anchored and grows UPWARD, so it cannot reach the QR, but a fixed bottom band is
			     being reserved for these cards — worth an eyes-on at 1080p before trusting the worst case. -->
			{#if keyLine}
				<span class="ls-key">{keyLine}</span>
			{/if}
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
			onlineCount={online.length + away.length}
			unreachable={joinUnreachable}
		/>
	{/if}

	<!--
	  Transient states, ONE at a time. They used to be three independent {#if} blocks sharing one
	  z-index and inset:0 with non-exclusive conditions, so two full-screen panels could stack (e.g. the
	  media:status stuck path raises `skipNotice` while `tvState` is still transitioning). `transient`
	  now selects exactly one, and each keeps its own mark, colour family and eyebrow so a viewer can
	  tell a failure from a normal song change at a glance.
	-->
	{#if transient === 'next' && introEntry}
		{@const m = mediaOf(introEntry)}
		{@const d = songDisplay(m)}
		<div class="interstitial state-next">
			<!-- "Now singing" for the opener; "Next up" once the night is under way. Saying "Next up" for
			     the very first song of the evening is simply untrue — there is no previous song it follows. -->
			<div class="up-label">{openedOnce && introEntry.id !== current?.id ? 'Next up' : 'Now singing'}</div>
			<div class="up-name">{singerName(introEntry.singerId)}</div>
			<div class="up-song">{d.title}</div>
			<!-- Artist disambiguates between covers, but ONLY when trustworthy: the old fallback rendered
			     the UPLOADER (e.g. "7clouds") as the artist, which is a bug, not a fallback. Show the
			     canonical artist or nothing. -->
			{#if d.artist}<div class="up-artist">{d.artist}</div>{/if}
		</div>
	{:else if transient === 'error'}
		<!-- An error. --danger exists precisely so this cannot be mistaken for an affirmative event. -->
		<div class="interstitial state-error" role="alert">
			<div class="state-mark"><Icon name="warning" /></div>
			<div class="up-label">Skipped</div>
			<div class="up-song">{skipNotice}</div>
		</div>
	{:else if transient === 'waiting'}
		<!-- Not an error and not a transition: work in progress. Warm, and it names what is happening. -->
		<div class="interstitial state-waiting">
			<div class="state-mark"><Icon name="flame" /></div>
			<div class="up-label">Making the karaoke</div>
			<div class="up-song">Stripping the vocals — hang tight</div>
		</div>
	{:else if transient === 'loading'}
		<!--
		  P1: the missed-preload path. `onEnded` could not swap (hidden slot not warmed) and set `loading`
		  with `current` still set, so `screen` derives `playing` and the not-yet-loaded <video> renders
		  black under only the lower-third. This keeps a treatment up until the visible player reports
		  ready (onVisibleReady -> playing dismisses it). Uses the affirmative `state-next` treatment
		  because a song IS coming — it is the same "a song is about to play" beat the swap card covers.
		-->
		<div class="interstitial state-next">
			<div class="up-label">{openedOnce ? 'Up next' : 'Loading'}</div>
			<div class="up-name">{singerName(current?.singerId)}</div>
			<div class="up-song">{loadingDisplay.title}</div>
			{#if loadingDisplay.artist}<div class="up-artist">{loadingDisplay.artist}</div>{/if}
		</div>
	{/if}

	<div class="status" class:on={connected}></div>
</div>

<style>
	/*
	 * STAGE Z-INDEX SCHEME. Two unrelated layers previously shared a z-index (the lower-third and the
	 * lyrics reel both at 6; the interstitial, the progress bar and the join corner all at 7), so paint
	 * order fell to DOM order and a future reorder could silently push a transient behind the chrome.
	 * One monotonic scale now, higher = closer to the viewer. The lyrics reel (6) is owned by the
	 * sibling LyricsOverlay and is the fixed anchor this scheme is built around.
	 *
	 *   0  stage background + visualizer (this file: .stage-bg)
	 *   1  hidden player slot / 2  visible player slot (TvPlayer .slot, inline z-index)
	 *   5  idle full-screen screens: attract, lobby (.attract, TvLobby .lobby)
	 *   6  lyrics reel (LyricsOverlay .lyrics — SIBLING-owned, not editable here)
	 *   7  persistent chrome that must sit ABOVE the reel and the video: lower-third, brand-float,
	 *      progress bar (TvProgress), join corner/badqr (JoinBadge)
	 *   8  transient full-screen overlays: interstitial / error / waiting / loading (.interstitial) —
	 *      must cover ALL chrome, which the old shared 7 did only by DOM luck
	 *   9  connection status dot (.status) — tiny, always visible, never occluded
	 *
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
		/* Pure black floor UNDER the video/stage — contrast-critical letterbox bars behind object-fit:
		   contain, not a themeable surface. Legitimate literal (kept per the token sweep). */
		background: #000;
		overflow: hidden;
	}
	/*
	 * Fades in and out on the same 0.25s opacity curve the player slots use (TvPlayer `.slot`), so the
	 * lobby->stage handover matches the crossfade already in the gapless swap instead of hard-cutting.
	 */
	.stage-bg {
		position: absolute;
		inset: 0;
		z-index: 0;
		opacity: 0;
		transition: opacity 0.25s ease;
	}
	.stage-bg.shown { opacity: 1; }
	.attract {
		position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center;
		justify-content: center; gap: 48px; z-index: 5;
		background: radial-gradient(80% 60% at 50% 30%, var(--stage-glow) 0%, var(--bg) 70%);
	}
	.brand {
		position: absolute; top: var(--tv-safe-y); left: var(--tv-safe-x);
		font-weight: 800; font-size: var(--tv-name); display: inline-flex; align-items: center; gap: 12px;
	}
	/* the lobby paints its own full-bleed backdrop; the brand floats on the chrome layer above it */
	.brand-float { z-index: 7; }
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
		position: absolute; left: var(--tv-safe-x); bottom: var(--tv-safe-y); z-index: 7;
		display: flex; flex-direction: column;
		max-width: 46vw;
		gap: 4px; padding: 16px 28px; border-radius: 16px;
		/*
		 * Near-opaque, not a 0.7 tint. This card sits over arbitrary video, so translucency put its
		 * white text at a contrast ratio nothing could predict — and backdrop-filter is unreliable on TV
		 * browsers, so the blur that was supposed to rescue it may never run at all.
		 *
		 * LEGITIMATE LITERAL EXCEPTION (kept, per the token sweep): these are NOT --grad. --grad is
		 * decoration-only and white text on it measures 2.84:1 (app.css) — below the 3:1 floor. These
		 * two stops are --accent/--accent2 deliberately DARKENED (88,62,200 vs accent 124,92,255) so
		 * white reads over them AND over the video behind them. This is the contrast-critical text-over-
		 * video case the sweep exempts; converting it to var(--grad) would reintroduce the contrast bug.
		 */
		background: linear-gradient(120deg, rgba(88, 62, 200, 0.96), rgba(190, 55, 130, 0.94));
		backdrop-filter: blur(6px);
	}
	.ls-label { font-size: var(--tv-label); letter-spacing: 0.16em; text-transform: uppercase; opacity: 0.92; }
	.ls-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--tv-name); font-weight: 800; }
	/*
	 * Clamp the title to two lines. An UNPARSED long raw title (no canonical title to shorten it) would
	 * otherwise grow the card downward — the TV-LAYOUT agent is reserving a fixed bottom band for these
	 * cards, and an unbounded title defeats that. -webkit-line-clamp is the only cross-browser two-line
	 * clamp; it needs the -webkit box display and hidden overflow to take effect.
	 */
	.ls-song {
		font-size: var(--tv-body); opacity: 0.97;
		display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2;
		overflow: hidden;
	}
	/* Secondary to the title: it disambiguates rather than identifies, so it stays dimmer and one line. */
	.ls-artist {
		font-size: var(--tv-body); color: var(--ink-dim);
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	/* Metadata, not a heading: sized and dimmed like the eyebrow so it sits under the title quietly. */
	.ls-key { font-size: var(--tv-label); letter-spacing: 0.04em; opacity: 0.82; margin-top: 2px; }
	.interstitial {
		position: absolute; inset: 0; z-index: 8; display: flex; flex-direction: column; align-items: center;
		justify-content: center; gap: 12px;
		/* rgba(11,11,18,0.94) was --bg at 94%. color-mix keeps the theme swap intact. */
		background: color-mix(in srgb, var(--bg) 94%, transparent);
		padding: var(--tv-safe-y) var(--tv-safe-x);
		text-align: center;
	}
	.up-label { font-size: var(--tv-label); letter-spacing: 0.2em; text-transform: uppercase; color: var(--ink-dim); }
	.up-name { font-size: var(--tv-hero); font-weight: 800; }
	.up-song { font-size: var(--tv-name); }
	/* Secondary to the title: it disambiguates rather than identifies, so it must not compete with it. */
	.up-artist { font-size: var(--tv-body); color: var(--ink-dim); margin-top: 6px; }
	/* A mark large enough to be the first thing read, since it is what distinguishes these states. */
	.state-mark { font-size: var(--tv-hero); line-height: 1; margin-bottom: 4px; }

	/* Affirmative: something good is about to happen. */
	.state-next .up-song { color: var(--accent2); }

	/* Failure. Distinct family AND a distinct eyebrow, so colour is not the only carrier.
	   rgba(42,27,34,0.95) was --danger-bg at 95%; color-mix keeps it themeable. */
	.state-error { background: color-mix(in srgb, var(--danger-bg) 95%, transparent); }
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
		width: 16px; height: 16px; border-radius: 50%; background: var(--ink-dim); z-index: 9;
	}
	/* rgba(51,214,166,0.18) was --ok at 18%; color-mix keeps the ring on the theme's ok colour. */
	.status.on { background: var(--ok); box-shadow: 0 0 0 5px color-mix(in srgb, var(--ok) 18%, transparent); }
</style>
