<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type { ServerEvent, QueueEntry, Media, PublicSinger } from '@encore/shared';
	import { chosenCandidate, isPlayable, effectiveSongIntroMs, songDisplay, soundingKeyLabel } from '@encore/shared';
	import { GaplessController } from '$lib/tv/gapless';
	import { telemetryFrame } from '$lib/tv/telemetry';
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
	import { WsClient } from '$lib/ws/client';
	import TvLobby from '$lib/tv/TvLobby.svelte';
	import JoinBadge from '$lib/tv/JoinBadge.svelte';
	import { tvScreen, lobbyRoster, isUnreachableJoinOrigin, lyricsAdvancing } from '$lib/tv/screen';
	import { isAutoTranscribed, provenanceLabel } from '$lib/tv/lyrics';
	import { cookStageLabel } from '$lib/cook-phrasing';
	import { mergeCatalog, snapshot, cookIsTerminal, type PlaybackSnapshot } from '$lib/tv/catalog';

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
	// The active player slot's instrumental had its autoplay REFUSED (NotAllowedError) and the room is
	// silent until someone provides a user gesture. A TV wall registers no gesture on its own, so we
	// surface an on-screen affordance; TvPlayer arms a document-wide gesture listener that re-attempts
	// playback and clears this the moment the room recovers. Only the active+visible slot reports here.
	let autoplayBlocked = $state(false);
	// The instrumental refused to start with an error NO gesture can lift (decode failure, AbortError) —
	// distinct from `autoplayBlocked`, which a tap recovers. There is no recovery here, so the page must
	// SAY the room is silent on screen rather than leave the only trace in the TV's devtools console
	// (#473). Cleared when a fresh song loads (onready) or the element actually starts advancing, so a
	// later good song retracts the panel. Holds the error name for the on-screen detail.
	let playbackFailedReason: string | null = $state(null);
	// Whether the MASTER element is actually running, reported up from the active+visible
	// TvPlayer's own play/pause/ended (#393). The honest counterpart to `isPlaying`, which is the
	// ROOM'S INTENT from the server: the room can intend to play while the element does not (a TV
	// wall whose autoplay was refused, or a current entry whose media is not playable), and the
	// lyrics reel must freeze in exactly those cases rather than sweep over a silent stage. Starts
	// false — nothing is advancing until an element says so.
	let masterAdvancing = $state(false);
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
	// Server `rev` from the last `playback:state`. Bumped by every playback command (restart, pause,
	// seek, key…) but never by position telemetry, so the player's seek effect can track it to
	// re-take its decision on a restart whose position equals the last one (#95).
	let seekRev = $state(0);
	// Per-song background override from playback:state. null = use the room default (the resting state).
	let backgroundOverride = $state<TvBackgroundStyle | null>(null);
	// The GUIDING TRACK, resolved the same way: the per-song override from playback:state (null = none
	// pinned) over the room's standing default. `effectiveGuideLevel` does the resolution — read raw, a
	// null override is indistinguishable from "explicitly off", which is the distinction that lets a
	// room default survive a song change.
	let guideOverride = $state<number | null>(null);
	const guideLevel = $derived(effectiveGuideLevel({ guideLevel: guideOverride }, settings.room.guideLevelDefault));
	// Current transpose in semitones (±), straight from playback:state. The TV now HONOURS this: the
	// player shifts pitch in the browser (see pitch-shift.ts), so there is no pre-rendered variant to
	// 404 on — which is why it was ignored before.
	let keyShift = $state(0);
	// THE SNAPSHOT SEAM (#396). The slots hold immutable `PlaybackSnapshot`s, not live catalog records:
	// a `Media` is not assignable here, so the only way a song reaches the player is through
	// `snapshot()` in `syncSlots()` — i.e. on an explicit playback transition. A cook event cannot
	// reach a playing song even if it churns the catalog, because there is no longer a path from the
	// catalog to a mounted slot that does not go through a deliberate re-assignment.
	let slotMedia = $state<{ A: PlaybackSnapshot | null; B: PlaybackSnapshot | null }>({
		A: null,
		B: null
	});

	// The TV's realtime channel is the shared, tested WsClient (heartbeat, liveness watchdog,
	// capped-backoff reconnect, page-lifecycle rebinding). The TV runs unattended for hours on a
	// set-top browser, so the watchdog for a socket that stops answering but never fires `close`
	// (WsClient.#presumeDead) matters most here. Telemetry keeps its silent-drop path via `quiet`.
	let ws: WsClient | undefined;
	let interstitialTimer: ReturnType<typeof setTimeout> | undefined;

	/*
	 * The catalog writer and the snapshot seam both live in `$lib/tv/catalog.ts` — see that module for
	 * why #396 needed a boundary rather than a fifth consumer-side guard. Two rules hold here:
	 *
	 *   • `mergeCatalog` is the ONLY thing that writes `mediaCatalog`, and it takes a full server list,
	 *     so this route cannot express a partial local edit to a media record. The cook path used to
	 *     make exactly such an edit; that is what reached the playing song.
	 *   • the player is handed `snapshot(...)`, never `mediaOf(...)` directly.
	 */

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
		// SNAPSHOT HERE, and only here. `syncSlots` already ran only on explicit lifecycle transitions
		// (a real `nowplaying:changed`, an `ended`, an interstitial hand-off), which is what makes it the
		// correct seam: the snapshot is re-taken when the song genuinely changes and at no other time.
		const curMedia = snapshot(mediaOf(current));
		const nextMedia = snapshot(mediaOf(upNext));
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

	/**
	 * Position/status telemetry to the server. DROPPED SILENTLY when the socket is not open.
	 *
	 * Silent is right here and wrong for a command: this is a ~4Hz ephemeral stream and the next frame
	 * is 250ms away, so warning per drop would flood the console during any reconnect. What is NOT
	 * acceptable is throwing, which is what `ws?.send(...)` did — optional chaining guards an absent
	 * socket, not a CONNECTING/CLOSING/CLOSED one. Because this is called from the media element's
	 * `ontimeupdate` AFTER the local `positionSec` assignment, that throw left the TV advancing its own
	 * lyrics and progress while the server never learned the playhead — which the phone then rendered as
	 * a progress bar that jumps to the beginning on pause. See lib/ws/send.ts.
	 */
	function sendTelemetry(status: string, positionSec = 0) {
		// The frame — including the entry stamp the server's #70/#125 guard needs on EVERY frame — is
		// built by the pure `telemetryFrame()` in $lib/tv/telemetry.ts, so the stamp is unit-tested
		// behaviourally rather than only by scanning this .svelte source for a literal.
		// SILENT drop when the socket is not open (~4 Hz stream) — `quiet` suppresses WsClient's
		// per-drop warning, which would otherwise flood the console during any reconnect.
		ws?.send(telemetryFrame(status, current, positionSec), { quiet: true });
	}

	function onVisibleError() {
		// dead/unplayable media — treat like ended so the room advances rather than hanging on black.
		// Say so on screen first: advancing silently means several bad files in a row just flash black
		// across the room with nothing explaining why.
		skipNotice = 'Skipping — that track would not play';
		setTimeout(() => (skipNotice = ''), 4000);
		// onVisibleEnded() already sends the single `ended` frame; sending it here too made the
		// server advance twice and eat the next singer's turn (#70).
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

	/** Apply one server event to the TV's local state. Fed by WsClient.onEvent. */
	function handleEvent(e: ServerEvent) {
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
			seekRev = e.rev;
			// Per-song background override; null hands the song back to the room default.
			backgroundOverride = e.state.background;
			guideOverride = e.state.guideLevel;
			// keyShift is now honoured — the player transposes in the browser. See `keyShift` state.
			keyShift = e.state.keyShift;
		}
		/*
		 * COOK LIFECYCLE — and note what is NOT here any more (#396).
		 *
		 * This handler used to write the catalog: `new Map(mediaCatalog).set(id, {...m, stemStatus})`,
		 * on EVERY progress tick, minting a fresh Media identity and inventing a `stemStatus` the
		 * server never sent (anything not `ready`/`failed` was written as `queued`, which made the
		 * PLAYING song locally unplayable for a moment). That write is the coupling this issue is
		 * about: it is how a cook for one song reached the playhead of another.
		 *
		 * It is gone, and nothing replaced it, because nothing needed it:
		 *
		 *   • the READY flip is server-driven. `onMediaReady` publishes a full `queue:sync` (real
		 *     server truth, through `mergeCatalog`) AND `nowplaying:changed`, so the TV leaves
		 *     `waiting` on an explicit playback event. The old comment here claimed these local
		 *     catalog writes were what made the TV "leave WAITING promptly" — that was never true;
		 *     the only exit this handler ever owned is the terminal-failure one below.
		 *   • cook PROGRESS has no consumer on the TV. The TV renders "Making the karaoke", not a
		 *     percentage, so a tick had nothing to update and churned the render tree for free.
		 *
		 * What remains is a pure lifecycle decision, and no state of its own.
		 */
		if (e.type === 'media:status') {
			// A cook that FAILED, or a job NO connected worker can ever run (`unservable`), will never
			// become playable — and enterWaiting() sets no timer, so if this is the entry the room is
			// holding on, the party stares at "Making the karaoke" forever. Leave WAITING the same way
			// the dead-media path does: say so on screen via the error treatment, tell the server the
			// entry ended so it advances authoritatively, and drop out of the waiting hold.
			// Defensive: this fires purely on the wire signal and does not assume the server TTL fix
			// has landed.
			const stuck = cookIsTerminal(e);
			if (stuck && tvState === 'waiting' && current && current.mediaId === e.mediaId) {
				const who = singerName(current.singerId);
				skipNotice = `Couldn't make the karaoke for ${who}'s song — skipping`;
				setTimeout(() => (skipNotice = ''), 4000);
				// onVisibleEnded() already sends the single `ended` frame (#70).
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
	}

	onMount(() => {
		ws = new WsClient({
			url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=tv`,
			// The TV holds no queue rev of its own — it never handles queue:patch and adopts server
			// truth wholesale from each queue:sync — so the hello handshake always sends lastRev 0,
			// exactly as the bespoke socket did.
			getLastRev: () => 0,
			onConnectionChange: (c) => (connected = c),
			onEvent: handleEvent
		});
		// The video/iframe keeps playing through a socket drop — WsClient only re-establishes the
		// control channel (capped backoff + resync), and now also runs the liveness watchdog and
		// page-lifecycle rebinding the hand-rolled socket lacked.
		ws.open();
		return () => ws?.close();
	});

	/*
	 * FIX: MEASURE the reserved bottom chrome band instead of predicting it.
	 *
	 * The band the lyrics reel must not enter has to clear the lower-third card. app.css derives a
	 * static `--tv-chrome-h` by summing the card's type tokens with a 1.2 line-box fudge and a magic
	 * 54px — a prediction that under-counts the card's REAL height (it silently assumed a fixed row
	 * set), so the sung line could still be covered by the "Now singing" card, and any new row added to
	 * the card (a vocal-range line, a second progress style) re-breaks it. A ResizeObserver on the
	 * actual rendered card reserves exactly what it occupies, whatever it renders today or tomorrow.
	 *
	 * The card is `position: absolute; bottom: var(--tv-safe-y)`, so the band from the screen edge is
	 * its offset plus its measured height. We write that as `--tv-chrome-h` on `.tv`, overriding the
	 * app.css fallback (which still applies before the first measurement and whenever the card is
	 * absent — attract/lobby, where the reel is hidden anyway).
	 */
	let lowerThirdEl = $state<HTMLElement | undefined>();
	let measuredCardPx = $state<number | null>(null);
	$effect(() => {
		const el = lowerThirdEl;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver((entries) => {
			for (const e of entries) {
				// borderBoxSize is the full rendered box (padding + border included), which is what the
				// reel must clear. offsetHeight is the fallback where the array form is unsupported.
				const box = e.borderBoxSize?.[0]?.blockSize;
				measuredCardPx = typeof box === 'number' ? box : el.offsetHeight;
			}
		});
		ro.observe(el);
		return () => ro.disconnect();
	});
	// The band, as a CSS length written onto `.tv`. Null before the first measure -> undefined style ->
	// app.css's static --tv-chrome-h fallback stands.
	const chromeBandStyle = $derived(
		measuredCardPx === null ? undefined : `--tv-chrome-h: calc(var(--tv-safe-y) + ${Math.ceil(measuredCardPx)}px)`
	);

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
	// Bug B + #393: the reel and ball ADVANCE only while the song is genuinely playing on BOTH
	// dimensions — the room INTENDS to play (`isPlaying`, from the server) AND the master element is
	// actually running (`masterAdvancing`, reported up from the <audio>'s own play/pause). `isPlaying`
	// alone stayed true through a phone pause (Bug B) and ALSO through an autoplay refusal or an
	// unplayable entry (#393) — the room silent while the reel swept forward on wall-clock. Feeding
	// the element's honest state freezes the words with the sound in every one of those. Visibility
	// still rides `lyricsActive` — the overlay stays on screen, just frozen mid-line.
	const lyricsPlaying = $derived(lyricsAdvancing(screen, tvState, isPlaying, masterAdvancing));
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
	 * Whether those words are a machine's guess.
	 *
	 * The reel tints an unverified line amber; this drives the short label naming why, which lives in
	 * the now-singing block rather than floating centre-bottom as it used to. Unknown provenance (a
	 * pre-candidate artifact) is NOT unverified — we will not assert either way about text we cannot
	 * trace, so a missing provenance renders exactly like verified text.
	 */
	const lyricsUnverified = $derived(isAutoTranscribed(lyricsProvenance));
	/*
	 * The provenance TAG shown on the now-playing card (issue #635): names the source of the words
	 * for EVERY kind, not just ASR. `null` for a pre-candidate artifact, so the card says nothing.
	 */
	const lyricsSourceLabel = $derived(provenanceLabel(lyricsProvenance));
	/*
	 * What the reel actually draws, clamped against BOTH bounds — see `resolveLyricsPresentation`.
	 *
	 * This lives HERE, below `lyricsProvenance`, because it now depends on it. It used to sit beside
	 * `songIntroMs` at the top and read `settings` alone, which is the whole defect: the granularity of
	 * ONE song was being answered from a fleet-wide setting, so a line-only song under the default
	 * word-level `syncMode` got the word treatment and the current line painted plain white with no
	 * accent and no marker.
	 *
	 * `?.timing` — not the candidate object — because that field IS the per-song granularity the worker
	 * records, and passing the whole candidate would invite the resolver to start reading text
	 * provenance too. Undefined when there is no candidate, which the resolver reads as UNKNOWN and
	 * deliberately does not clamp on: a pre-candidate artifact usually does have word timings.
	 */
	const lyricsStyle = $derived(resolveLyricsPresentation(settings, lyricsProvenance?.timing));
	/*
	 * The join address without its scheme. Someone reading this off a wall types the host and the path;
	 * "http://" is nine characters of noise on the least readable thing on the screen. The QR still
	 * carries the full URL, so nothing is lost — only shown differently.
	 */
	const joinShort = $derived(data.joinUrl.replace(/^https?:\/\//, ''));
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

<div class="tv" style={chromeBandStyle}>
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
		seekRev={seekRev}
		keyShift={keyShift}
		guideLevel={guideLevel}
		onready={() => {
			ctl.onVisibleReady();
			tvState = ctl.state;
			onFirstSongReady();
			playbackFailedReason = null;
		}}
		onprewarmed={() => {
			ctl.onHiddenReady(slotMedia.A?.id ?? '');
			tvState = ctl.state;
		}}
		onended={onVisibleEnded}
		onerror={onVisibleError}
		onposition={(s, d) => {
			positionSec = s;
			durationSec = d;
			sendTelemetry('playing', s);
		}}
		onautoplayblocked={() => (autoplayBlocked = true)}
		onautoplayrecovered={() => (autoplayBlocked = false)}
		onplayingchange={(p) => (masterAdvancing = p)}
		onplaybackfailed={(reason) => (playbackFailedReason = reason)}
	/>
	<TvPlayer
		media={slotMedia.B}
		visible={visible === 'B' && !isAttract}
		active={visible === 'B'}
		playing={isPlaying}
		seekSec={seekSec}
		seekRev={seekRev}
		keyShift={keyShift}
		guideLevel={guideLevel}
		onready={() => {
			ctl.onVisibleReady();
			tvState = ctl.state;
			onFirstSongReady();
			playbackFailedReason = null;
		}}
		onprewarmed={() => {
			ctl.onHiddenReady(slotMedia.B?.id ?? '');
			tvState = ctl.state;
		}}
		onended={onVisibleEnded}
		onerror={onVisibleError}
		onposition={(s, d) => {
			positionSec = s;
			durationSec = d;
			sendTelemetry('playing', s);
		}}
		onautoplayblocked={() => (autoplayBlocked = true)}
		onautoplayrecovered={() => (autoplayBlocked = false)}
		onplayingchange={(p) => (masterAdvancing = p)}
		onplaybackfailed={(reason) => (playbackFailedReason = reason)}
	/>

	<!-- Word-timed karaoke lyrics over the active player -->
	<LyricsOverlay
		lyricsRef={mediaOf(current)?.lyricsRef}
		provenance={lyricsProvenance}
		positionSec={positionSec}
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
		<!--
			NOBODY HAS JOINED. Structurally the same screen as the lobby: wordmark, one instruction, the
			QR, the typed fallback beneath it, and a strip along the bottom. Only the instruction and
			what the strip carries differ — the lobby lists who is here, this lists what to do. Before,
			this screen stacked the QR beside its copy and had no bottom row at all, which made it the
			one state that did not look like its sibling and the one with an empty lower third.
		-->
		<div class="attract">
			<div class="idle">
				<div class="brand"><Icon name="mic" /> <span class="grad">Encore</span></div>
				{#if joinUnreachable}
					<JoinBadge
						qrDataUrl={data.qrDataUrl}
						joinUrl={data.joinUrl}
						placement="hero"
						size="var(--tv-qr)"
						unreachable={true}
					/>
				{:else}
					<h1 class="idle-head">Scan to <span class="grad">join the party</span></h1>
					<JoinBadge
						qrDataUrl={data.qrDataUrl}
						joinUrl={data.joinUrl}
						placement="hero"
						size="var(--tv-qr)"
						unreachable={false}
					/>
					<!-- The typed fallback for a camera that will not scan. PRIMARY content here, so it
					     takes its own tier rather than the corner-chrome one. -->
					<p class="idle-url">{joinShort}</p>
				{/if}
			</div>
			<div class="idle-strip">
				<span class="is-label">Nobody here yet</span>
				<span class="is-copy">Pick a name, pick a song, grab the mic</span>
			</div>
		</div>
	{:else if screen === 'lobby'}
		<!-- People ARE here, nothing queued — name them and say what we're waiting for -->
		<TvLobby
			qrDataUrl={data.qrDataUrl}
			joinUrl={data.joinUrl}
			roster={roster.shown}
			overflow={roster.overflow}
			pendingCount={pendingCount}
			unreachable={joinUnreachable}
		/>
	{:else}
		<!--
			WHO IS SINGING — bottom-left, and no longer a card.

			It was a near-opaque violet→pink slab, which is what made the stage read as furniture rather
			than a stage: a filled panel over the room's chosen background (a gradient, the singer's own
			colour, or an animated visualiser) amputates the feature they picked. Three independent
			designers, working from the requirements with no sight of this file, all set this information
			as plain text directly on the backdrop instead. Contrast comes from a painted scrim plus a
			text-shadow, which also sidesteps `backdrop-filter` being unreliable on TV browsers — the
			blur that was supposed to rescue the translucent version may never run at all.

			The class name and the ResizeObserver binding stay: `--tv-chrome-h` is measured from this
			element, and losing the card does not change that the reel must clear whatever it occupies.
		-->
		<div class="lower-third" bind:this={lowerThirdEl}>
			<span class="ls-name"
				><span class="ls-dot" style="--singer: {currentSingerColor ?? 'var(--accent2)'}"></span>{singerName(
					current?.singerId
				)}</span
			>
			<!--
				Artist only when a confident parse produced one — never the uploader. Inline with the title
				rather than its own row: it disambiguates a cover, it does not identify the song, so it
				reads as a suffix. The separator carries its own NBSP because Svelte collapses the leading
				space next to a tag boundary — which shipped as "Mr. Brightside· The Killers" until an
				eyes-on frame caught it.
			-->
			<span class="ls-song"
				>{nowPlayingDisplay.title}{#if nowPlayingDisplay.artist}<span class="ls-artist"
						>{'\u00a0· '}{nowPlayingDisplay.artist}</span
					>{/if}</span
			>
			<!-- The sounding key + how far it is transposed, when the cook found a trustworthy one. -->
			{#if keyLine}
				<span class="ls-key">{keyLine}</span>
			{/if}
			<!--
				WHERE THESE WORDS CAME FROM. The reel tints an auto-transcribed line amber, and that tint
				is what the singer actually reads the meaning off; this line only has to name why the
				words look different. It replaces a full-width letter-spaced sentence that used to float
				centre-bottom, where it landed in the gutter between the two bottom corners and read as
				debris. In flow inside this block it cannot overlap anything, and it is about THIS song,
				which is what this block is about.
			-->
			{#if lyricsSourceLabel}
				<span class="ls-source" class:ls-asr={lyricsUnverified}>{lyricsSourceLabel}</span>
			{/if}
			{#if tvProgressStyle === 'card'}
				<TvProgress style="card" elapsedSec={positionSec} durationSec={durationSec} />
			{/if}
		</div>
		{#if tvProgressStyle !== 'card'}
			<TvProgress style={tvProgressStyle} elapsedSec={positionSec} durationSec={durationSec} />
		{/if}
		<!--
			WHOSE TURN IS NEXT — top-right, and permanent.

			The stage never carried this: the song-intro card names the next singer for a couple of
			seconds and then it is gone, so someone waiting their turn had nothing to look at all song.
			Offset below the connection dot rather than beside it, in vh so the clearance holds at any
			resolution.
		-->
		{#if upNext && upNext.id !== current?.id}
			{@const nextMedia = mediaOf(upNext)}
			<div class="upnext">
				<span class="un-label">Up next</span>
				<span class="un-name"
					><span class="un-dot" style="--singer: {singers.get(upNext.singerId)?.color ?? 'var(--ink-dim)'}"
					></span>{singerName(upNext.singerId)}</span
				>
				<span class="un-song">{songDisplay(nextMedia).title}</span>
			</div>
		{/if}
		<!-- The join QR stays reachable mid-song, bottom-right (the only free corner) -->
		<JoinBadge qrDataUrl={data.qrDataUrl} joinUrl={data.joinUrl} placement="corner" unreachable={joinUnreachable} />
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
		<!-- Not an error and not a transition: work in progress. Warm, and it names what is happening.
		     The words come from cook-phrasing (the ONE guest-facing cook vocabulary, shared with the
		     phone) so the TV and the phone describe the same pipeline state identically. The TV only
		     knows a coarse "cooking" state, so it passes the least-committal in-flight value 'queued' —
		     exactly as SongRow does — rather than naming a step (e.g. 'separating') it cannot know. The
		     sub-line stays a plain reassurance, deliberately NOT the old "Stripping the vocals" (the
		     musician's word cook-phrasing exists to retire). -->
		<div class="interstitial state-waiting">
			<div class="state-mark"><Icon name="flame" /></div>
			<div class="up-label">{cookStageLabel('queued')}</div>
			<div class="up-song">Hang tight — this takes a minute</div>
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

	<!--
		AUTOPLAY BLOCKED — the room is silent until a gesture. Shown ONLY when the active player's
		instrumental.play() was refused with NotAllowedError (TvPlayer -> onautoplayblocked), so a TV that
		autoplays fine never sees it. It is a full-screen affordance at the very top of the stack (z 10, above
		even the status dot) so a tap ANYWHERE lands on it — but the recovery does not depend on hitting this
		element: TvPlayer arms a document-wide gesture listener, so any tap/keypress on the page starts the
		music and clears this via onautoplayrecovered. The overlay is purely the on-screen SAY of what a tap
		will do; it is also click-dismissable so a viewer who preferred silence can put it away.
	-->
	{#if autoplayBlocked}
		<button
			type="button"
			class="autoplay-hint"
			onclick={() => (autoplayBlocked = false)}
			aria-label="Tap anywhere to start the music"
		>
			<span class="ah-mark"><Icon name="play" /></span>
			<span class="ah-head">Tap anywhere to <span class="grad">start the music</span></span>
			<span class="ah-sub">This TV needs one tap before it can play sound</span>
		</button>
	{/if}

	<!--
		PLAYBACK FAILED — the instrumental refused to start with an error a tap CANNOT lift (a decode
		failure, an AbortError). Unlike the autoplay block above there is no gesture recovery, so this is
		NOT a button: it is a plain on-screen SAY that the room is silent, the only operator-visible trace
		of a failure whose sole prior signal was a TV-console warn nobody at a party reads (#473). It sits
		at z 8 (the transient-overlay tier) so a genuinely gesture-liftable block (z 10) always wins if both
		somehow raise. Cleared when a fresh song loads or the element starts advancing again.
	-->
	{#if playbackFailedReason}
		<div class="silent-room" role="status" aria-live="polite">
			<span class="sr-mark"><Icon name="warning" /></span>
			<span class="sr-head">This song <span class="grad">won’t play</span></span>
			<span class="sr-sub"
				>The audio could not be started ({playbackFailedReason}) — the room is silent. The next song may play normally.</span
			>
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
	 *  10  autoplay-blocked "tap to start" affordance (.autoplay-hint) — MUST be tappable above all else
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
	.stage-bg.shown {
		opacity: 1;
	}
	.attract {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		z-index: 5;
		background: radial-gradient(80% 60% at 50% 30%, var(--stage-glow) 0%, var(--bg) 70%);
	}
	.brand {
		position: absolute;
		top: var(--tv-safe-y);
		left: var(--tv-safe-x);
		font-weight: 800;
		font-size: var(--tv-name);
		display: inline-flex;
		align-items: center;
		gap: 12px;
	}
	.grad {
		background: var(--grad);
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}
	/*
	 * THE IDLE STACK, shared in shape by both idle screens: wordmark, one instruction, the QR, the typed
	 * fallback. Centred as a column so the QR is centred on the screen and the URL reads as its caption
	 * — the two are the same object at both scales, which is what makes the corner version during a song
	 * legible as the same thing shrunk.
	 */
	.idle {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
	}
	/* In flow here, not pinned to the corner: on the idle screens the wordmark heads the stack. */
	.idle .brand {
		position: static;
		font-size: var(--tv-name);
	}
	/*
	 * The rhythm is deliberately UNEVEN — wordmark, a beat, the instruction, a bigger beat, then the
	 * thing you point a phone at — so it cannot come from one flex `gap`, which would force all three
	 * intervals equal. Both in vh so the proportions hold at 720p and 4K instead of being right at one
	 * size.
	 *
	 * The instruction sits at --tv-hero, well below the sung-lyric tier: it is read once, not sung
	 * along to, and taking it down is what pays for the room above the QR.
	 */
	.idle-head {
		font-size: var(--tv-hero);
		font-weight: 900;
		line-height: 1.04;
		margin: 5.2vh 0 0;
		max-width: 22ch;
	}
	.idle :global(.hero) {
		margin-top: 6.2vh;
	}
	.idle-url {
		font-size: var(--tv-joinurl);
		font-weight: 800;
		color: var(--ink);
		margin: 3vh 0 0;
		overflow-wrap: anywhere;
	}
	/*
	 * The bottom strip. Full-bleed background so it reaches the panel edge, content inset with the
	 * safe-area tokens because that is what keeps it out of the overscan crop — the same shape as the
	 * lobby's roster strip, and the reason both idles have an occupied lower third instead of one of
	 * them trailing off into black.
	 */
	.idle-strip {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 6;
		display: flex;
		align-items: baseline;
		justify-content: center;
		gap: 1.2em;
		flex-wrap: wrap;
		padding: 2vh var(--tv-safe-x) var(--tv-safe-y);
		background: linear-gradient(0deg, rgba(3, 3, 8, 0.9), rgba(3, 3, 8, 0));
	}
	.is-label {
		font-size: var(--tv-eyebrow);
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--ink-dim);
		font-weight: 700;
	}
	.is-copy {
		font-size: var(--tv-body);
		font-weight: 600;
	}
	.lower-third {
		/* Capped: unbounded, a long title or singer name grew this rightward into the join QR at
		   bottom-right. 46vw leaves the QR its corner on every aspect ratio. */
		position: absolute;
		left: var(--tv-safe-x);
		bottom: var(--tv-safe-y);
		z-index: 7;
		display: flex;
		flex-direction: column;
		max-width: 46vw;
		gap: 2px;
		/*
		 * NO CARD. No background, no padding, no border-radius, no backdrop-filter — see the markup
		 * comment for why. Legibility over arbitrary video comes from the text-shadow below, which is
		 * the same device the lyrics reel already uses and which works on every TV browser.
		 *
		 * Dropping the fill also drops the reason the block was capped in height: it no longer reads as
		 * an object that can collide with the QR, only as text that must not run into it.
		 */
		text-shadow: 0 2px 14px rgba(0, 0, 0, 0.9);
	}
	/* The singer's own colour, as a dot rather than a fill. It is their identity everywhere else in
	   the app, and a dot carries that at a size that cannot compete with the words. */
	.ls-dot {
		display: inline-block;
		width: 0.52em;
		height: 0.52em;
		border-radius: 50%;
		margin-right: 0.42em;
		vertical-align: baseline;
		/* --singer, not an inline background: the colour has to be composable (a glow, a border, a
		   gradient stop) and singer-color.test.ts enforces the custom-property form. */
		background: var(--singer);
	}
	.ls-name {
		font-size: var(--tv-name);
		font-weight: 800;
		line-height: 1.05;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/*
	 * Clamp the title to two lines. An UNPARSED long raw title (no canonical title to shorten it) would
	 * otherwise grow the block upward without bound. -webkit-line-clamp is the only cross-browser
	 * two-line clamp; it needs the -webkit box display and hidden overflow to take effect.
	 */
	.ls-song {
		font-size: var(--tv-body);
		font-weight: 600;
		opacity: 0.97;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
	}
	/*
	 * Secondary to the title: it disambiguates rather than identifies, so it stays dimmer. It is an
	 * INLINE span nested in .ls-song (see the markup), so it must NOT carry overflow/text-overflow/
	 * white-space of its own: overflow + text-overflow are inert on a non-replaced inline element (no
	 * ellipsis is ever painted), while white-space: nowrap DOES apply and turns a long joined credit
	 * (e.g. "Queen feat. David Bowie") into one unbreakable run that overflows .lower-third's 46vw and
	 * gets hard-clipped mid-word with no ellipsis. Truncation belongs to .ls-song's 2-line
	 * -webkit-line-clamp, which absorbs an over-long credit WITH an ellipsis — see #127.
	 */
	.ls-artist {
		font-size: var(--tv-body);
		color: var(--ink-dim);
		font-weight: 500;
	}
	/* Metadata, not a heading: sized and dimmed like the eyebrow so it sits under the title quietly. */
	.ls-key {
		font-size: var(--tv-label);
		color: var(--ink-dim);
		font-weight: 600;
		letter-spacing: 0.04em;
		opacity: 0.82;
		margin-top: 2px;
	}
	/*
	 * The provenance label naming WHERE the words came from (#635). Neutral dim by default -- it is a
	 * source tag, not a warning, so a trustworthy source (LRCLIB, hand-pasted) must not read as one.
	 * Not uppercase and not letter-spaced: a short label read once; the tracked-out version of this
	 * string is precisely what read as debris before.
	 */
	.ls-source {
		font-size: var(--tv-label);
		color: var(--ink-dim);
		font-weight: 700;
	}
	/*
	 * When the words are a machine's guess the tag joins the caution family, matching the amber tint
	 * the reel already puts on those words. Still provenance-only text -- the colour is the same
	 * honesty signal the reel carries, not a separate confidence score.
	 */
	.ls-source.ls-asr {
		color: var(--warn);
	}

	/*
	 * UP NEXT — top-right, dim, and small. It answers "am I soon?" for the one person who needs it and
	 * must not compete with the words for anyone else, so it sits at the eyebrow/label tier.
	 *
	 * Offset below the connection dot with a vh term rather than a pixel nudge, so the clearance scales
	 * with the panel instead of being correct only at 1080p.
	 */
	.upnext {
		position: absolute;
		right: var(--tv-safe-x);
		top: calc(var(--tv-safe-y) + 2.6vh);
		z-index: 7;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 1px;
		max-width: 32vw;
		text-align: right;
		text-shadow: 0 2px 14px rgba(0, 0, 0, 0.9);
	}
	.un-label {
		font-size: var(--tv-eyebrow);
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--ink-dim);
		font-weight: 700;
	}
	.un-name {
		font-size: var(--tv-body);
		font-weight: 800;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 32vw;
	}
	.un-dot {
		display: inline-block;
		width: 0.5em;
		height: 0.5em;
		border-radius: 50%;
		margin-right: 0.4em;
		background: var(--singer);
	}
	.un-song {
		font-size: var(--tv-label);
		color: var(--ink-dim);
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 32vw;
	}
	.interstitial {
		position: absolute;
		inset: 0;
		z-index: 8;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		/*
		 * A SCRIM, not a wash. This was --bg at 94%, which blanked the room's chosen backdrop — a
		 * gradient, the singer's colour, or an animated visualiser — for every song change and every
		 * cook hold. That is the black-flash class of problem the background layer is deliberately gated
		 * on `!isAttract` to avoid, undone one layer up. Dark in the middle where the words go, clear at
		 * the edges so the corner chrome and the backdrop stay visible underneath: the state reads as
		 * something happening ON the stage rather than as a different screen.
		 *
		 * The error state overrides this back to near-opaque — see below.
		 */
		background: radial-gradient(
			70% 55% at 50% 50%,
			color-mix(in srgb, var(--bg) 88%, transparent) 0%,
			color-mix(in srgb, var(--bg) 62%, transparent) 62%,
			transparent 100%
		);
		padding: var(--tv-safe-y) var(--tv-safe-x);
		text-align: center;
	}
	.up-label {
		font-size: var(--tv-eyebrow);
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
	.up-name {
		font-size: var(--tv-hero);
		font-weight: 900;
		line-height: 1.02;
	}
	.up-song {
		font-size: var(--tv-name);
	}
	/* Secondary to the title: it disambiguates rather than identifies, so it must not compete with it. */
	.up-artist {
		font-size: var(--tv-body);
		color: var(--ink-dim);
		margin-top: 6px;
	}
	/* A mark large enough to be the first thing read, since it is what distinguishes these states. */
	.state-mark {
		font-size: var(--tv-hero);
		line-height: 1;
		margin-bottom: 4px;
	}

	/* Affirmative: something good is about to happen. */
	.state-next .up-song {
		color: var(--accent2);
	}

	/*
	 * Failure — and the ONE state that keeps the full opaque wash.
	 *
	 * A skip is rare, urgent and must be unmissable, and demoting it to a scrim beside a cheerful
	 * now-singing block is exactly the "cannot tell a failure from a normal song change" bug this
	 * surface already fixed once. Distinct family AND a distinct eyebrow, so colour is not the only
	 * carrier. rgba(42,27,34,0.95) was --danger-bg at 95%; color-mix keeps it themeable.
	 */
	.state-error {
		background: color-mix(in srgb, var(--danger-bg) 95%, transparent);
	}
	.state-error .state-mark {
		color: var(--danger);
	}
	.state-error .up-label {
		color: var(--danger-ink);
	}
	.state-error .up-song {
		color: var(--danger-ink);
	}

	/* Work in progress: neither affirmative nor broken. */
	.state-waiting .state-mark {
		color: var(--warn);
	}
	.state-waiting .up-label {
		color: var(--warn);
	}
	.state-waiting .up-song {
		color: var(--ink);
	}

	/*
	 * Connection telemetry. Larger than the old 12px and pulled inside the safe area — at 12px in a
	 * corner a TV may clip it informed nobody, and anyone who did see it read it as a stuck pixel.
	 */
	.status {
		position: absolute;
		top: var(--tv-safe-y);
		right: var(--tv-safe-x);
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--ink-dim);
		z-index: 9;
	}
	/* rgba(51,214,166,0.18) was --ok at 18%; color-mix keeps the ring on the theme's ok colour. */
	.status.on {
		background: var(--ok);
		box-shadow: 0 0 0 5px color-mix(in srgb, var(--ok) 18%, transparent);
	}

	/*
	 * The autoplay affordance. A full-screen button so a tap anywhere authorises playback, sitting above
	 * every other layer (z 10). A <button>, not a <div>: it is keyboard-focusable and announces itself,
	 * and a keydown is one of the gestures TvPlayer listens for. Dark scrim so it reads over any stage
	 * background; the tokens are the room's own type/safe-area scale so it sizes correctly on a wall.
	 */
	.autoplay-hint {
		position: absolute;
		inset: 0;
		z-index: 10;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2.2vh;
		padding: var(--tv-safe-y) var(--tv-safe-x);
		border: 0;
		cursor: pointer;
		color: var(--ink);
		text-align: center;
		background: color-mix(in srgb, var(--bg) 82%, transparent);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
	}
	.ah-mark {
		display: grid;
		place-items: center;
		width: clamp(64px, 12vmin, 160px);
		height: clamp(64px, 12vmin, 160px);
		border-radius: 50%;
		background: color-mix(in srgb, var(--accent) 26%, transparent);
		font-size: clamp(32px, 6vmin, 84px);
	}
	.ah-head {
		font-size: var(--tv-hero);
		font-weight: 800;
		line-height: 1.1;
		text-shadow: 0 2px 12px rgba(0, 0, 0, 0.55);
	}
	.ah-sub {
		font-size: var(--tv-body, clamp(16px, 2.4vmin, 32px));
		color: var(--ink-dim);
		text-shadow: 0 1px 8px rgba(0, 0, 0, 0.5);
	}
	/*
	 * The silent-room panel. A transient full-screen overlay (z 8, the documented interstitial tier) that
	 * reports an unrecoverable playback failure. Not interactive — informational, so no button, no cursor.
	 * Same dark scrim and safe-area/type tokens as the affordance above so it sizes on a wall.
	 */
	.silent-room {
		position: absolute;
		inset: 0;
		z-index: 8;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2.2vh;
		padding: var(--tv-safe-y) var(--tv-safe-x);
		color: var(--ink);
		text-align: center;
		background: color-mix(in srgb, var(--bg) 82%, transparent);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
	}
	.sr-mark {
		display: grid;
		place-items: center;
		width: clamp(64px, 12vmin, 160px);
		height: clamp(64px, 12vmin, 160px);
		border-radius: 50%;
		background: color-mix(in srgb, var(--warn, #e0a63a) 26%, transparent);
		font-size: clamp(32px, 6vmin, 84px);
	}
	.sr-head {
		font-size: var(--tv-hero);
		font-weight: 800;
		line-height: 1.1;
		text-shadow: 0 2px 12px rgba(0, 0, 0, 0.55);
	}
	.sr-sub {
		font-size: var(--tv-body, clamp(16px, 2.4vmin, 32px));
		color: var(--ink-dim);
		max-width: 60ch;
		text-shadow: 0 1px 8px rgba(0, 0, 0, 0.5);
	}
</style>
