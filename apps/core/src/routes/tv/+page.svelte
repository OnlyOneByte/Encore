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
		hueOfColor,
		resolveLyricsPresentation,
		loudnessNormalizationGain,
		type EffectiveSettings,
		type TvBackgroundStyle
	} from '@encore/shared';
	import { stageBackgroundCss } from '$lib/tv/background';
	import VisualizerStage from '$lib/tv/VisualizerStage.svelte';
	import { WsClient } from '$lib/ws/client';
	import TvLobby from '$lib/tv/TvLobby.svelte';
	import JoinBadge from '$lib/tv/JoinBadge.svelte';
	import {
		tvScreen,
		lobbyRoster,
		isUnreachableJoinOrigin,
		lyricsAdvancing,
		cookStep,
		COOK_STEPS
	} from '$lib/tv/screen';
	import { isAutoTranscribed, provenanceLabel } from '$lib/tv/lyrics';
	import { cookStageLabel } from '$lib/cook-phrasing';
	import { mergeCatalog, snapshot, cookIsTerminal, type PlaybackSnapshot } from '$lib/tv/catalog';
	import { makePhraseBag, reducedMotionPhrase, seedFromString, ATTRACT_PHRASES } from '$lib/tv/phrases';

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
	let tvBackgroundColor = $derived(settings.room.tvBackgroundColor);
	// The room's 0..1 stage dimmer (#782). Handed to stageBackgroundCss, which darkens the resolved
	// stage colour toward black by this fraction — a lightness control, no layer over the video.
	let tvBackgroundDim = $derived(settings.room.tvBackgroundDim);
	// The visualizers build their palette by hue ARITHMETIC around the room's colour
	// (`stageHueToHex(hue + deg)`), so they need an ANGLE and the stored value is a hex since #425.
	// `hueOfColor` is the atan2 of the OKLab chromatic axes — scale-free, so it recovers the hue of a
	// dark stage colour that `nearestSingerHue` would snap to the wrong wheel stop.
	let tvBackgroundHue = $derived(hueOfColor(tvBackgroundColor));
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
	// The QUEUE-ENTRY id playing in each slot, parallel to `slotMedia` (#701). A song queued twice
	// snapshots to the byte-identical media in both turns, so the media id and resolved src cannot tell
	// the second turn from the first; the entry id can, and the player re-arms its transport on it. Set
	// only in `syncSlots`, the same explicit-transition seam that re-snapshots the media.
	let slotEntryId = $state<{ A: string | null; B: string | null }>({ A: null, B: null });

	// ── loudness normalization (#462, PR3) ──────────────────────────────────────────────────────────
	// The decision happens HERE, at playback, not in the worker: the master pulldown for a song depends
	// on the LIVE library median, which is a property of the room's whole catalog at play time, not of
	// the song's cook. The route owns both facts — the full `mediaCatalog` and the room's setting — so
	// it resolves the gain and hands each slot a plain `masterLevel`. TvPlayer stays a pure applier.
	//
	// Every measured `loudnessLufs` in the library. `null`/absent levels are simply not in the list, so
	// the count is the population the floor (>=8) is checked against. Re-derives whenever the catalog
	// changes (a new cook lands a new level), so the median tracks the library rather than a stale seed.
	const libraryLoudnessLevels = $derived(
		[...mediaCatalog.values()]
			.map((m) => m.songProfile?.loudnessLufs ?? null)
			.filter((v): v is number => typeof v === 'number')
	);
	// Resolve one slot's master level from its own song's measured loudness, the library levels, and the
	// room toggle. 1 (unity) for the whole existing library and every song when the feature is off,
	// below the measured floor, or unmeasured — attenuate-only, never above 1.
	function resolveMasterLevel(m: PlaybackSnapshot | null): number {
		return loudnessNormalizationGain({
			songLufs: m?.songProfile?.loudnessLufs ?? null,
			libraryLevels: libraryLoudnessLevels,
			enabled: settings.room.loudnessNormalization
		}).gain;
	}
	// Parallel to slotMedia — each slot gets the pulldown for the song IT holds (they can differ: the
	// visible slot plays `current`, the hidden slot pre-warms `upNext`).
	const masterLevelA = $derived(resolveMasterLevel(slotMedia.A));
	const masterLevelB = $derived(resolveMasterLevel(slotMedia.B));

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
		// The entry id travels with its snapshot into the SAME slot, so the player's per-entry transport
		// re-arm (#701) sees a distinct id for the second turn of a same-song queue even though the media
		// snapshot is byte-identical.
		const curEntryId = current?.id ?? null;
		const nextEntryId = upNext?.id ?? null;
		// visible slot shows current; hidden slot pre-warms upNext
		if (a.visible === 'A') {
			slotMedia = { A: curMedia, B: nextMedia };
			slotEntryId = { A: curEntryId, B: nextEntryId };
		} else {
			slotMedia = { A: nextMedia, B: curMedia };
			slotEntryId = { A: nextEntryId, B: curEntryId };
		}
	}

	function applyNowPlaying(cur: QueueEntry | null, next: QueueEntry | null) {
		current = cur;
		upNext = next;
		// Reset the drawn-position anchor on the entry change itself. Both `positionSec` and
		// `durationSec` have exactly two writers — the active slot's `onposition` at the two sites
		// below — and neither runs until the NEW <audio> fires its first `timeupdate` (~250ms in
		// Chromium). Until then `drawPosition` extrapolates FORWARD from the previous song's anchor,
		// so the reel opens the turn parked on (and sweeping past) the old song's last lines and the
		// progress bar opens two-thirds full. `nowplaying:changed` is the exact event that marks the
		// new song's zero, so re-anchor here rather than relaxing `drawPosition`'s floor (#54 — that
		// purity is load-bearing) or guarding inside `LyricsOverlay`. See issue #868.
		positionSec = 0;
		durationSec = 0;
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
			// #658 one-TV-per-room: bind this TV socket to the room the loader resolved (data.roomCode) by
			// passing it on the WS URL. The server's tvRoomId turns the code into the room id the socket is
			// scoped to, so the TV is IN-ROOM for that party (subscribeTopicFor, #657) rather than an
			// unscoped spectator of the served room. A code-less loader (prerender/unavailable app) omits
			// the param and the server falls back to the served room — unchanged from before #658.
			url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=tv${data.roomCode ? `&room=${encodeURIComponent(data.roomCode)}` : ''}`,
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

	/*
	 * Measure the top-right "Up next" block the same way (#889). `.fs-btn` and `.upnext` both pin to
	 * the top-right at z-tier 7, so the fullscreen button must sit BELOW the whole Up-next block, not
	 * below a guessed height — the block grows when the next title wraps. A ResizeObserver on the real
	 * element publishes its rendered height as `--tv-upnext-h` on `.tv`; the button offsets by
	 * `.upnext`'s own top (safe-y + 2.6vh) + that height + a gap. Null before the first measure and
	 * whenever `.upnext` is absent (no next song) -> the app.css `--tv-upnext-h: 0px` fallback stands,
	 * so the button just sits at the top-right inset with nothing to clear.
	 */
	let upnextEl = $state<HTMLElement | undefined>();
	let measuredUpnextPx = $state<number | null>(null);
	$effect(() => {
		const el = upnextEl;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver((entries) => {
			for (const e of entries) {
				const box = e.borderBoxSize?.[0]?.blockSize;
				measuredUpnextPx = typeof box === 'number' ? box : el.offsetHeight;
			}
		});
		ro.observe(el);
		return () => ro.disconnect();
	});
	// Combined style written onto `.tv`: the chrome band AND the up-next height, each falling back to
	// its app.css default before the first measurement / when its element is absent.
	const tvStyle = $derived(
		[chromeBandStyle, measuredUpnextPx === null ? undefined : `--tv-upnext-h: ${Math.ceil(measuredUpnextPx)}px`]
			.filter(Boolean)
			.join('; ') || undefined
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
	// #826/XR-TV-14: the lobby shows the WHOLE roster with no "+N more" — the reason to show it is that
	// it must not degrade as the party grows, so it is never truncated. Pass Infinity so nothing is
	// capped; TvLobby renders every chip and steps the chip size down above a threshold instead.
	const roster = $derived(lobbyRoster(online, away, singers, Infinity));

	/*
	 * KEEP THE TV AWAKE while a song is on stage (#478).
	 *
	 * Nothing here held the screen on, so the OS screensaver blanked the room mid-song — a long
	 * instrumental break with no input was enough to lose the lyrics. This takes a Screen Wake Lock for
	 * as long as the TV is showing a song, and releases it the moment the room goes idle.
	 *
	 * Gated on `!isAttract` — the SAME flag the player slots and the stage background use — not on a
	 * literal `screen === 'playing'`: a song that is cooking (`waiting`) or between tracks
	 * (`interstitial`) is still on stage and must keep the screen lit, exactly the instrumental-break
	 * case the issue names. `attract`/`lobby` (nobody singing, or nothing queued) release it.
	 *
	 * Two platform facts shape it, mirroring the ResizeObserver effect above (acquire a platform
	 * resource, free it in the returned cleanup):
	 *   - `navigator.wakeLock` is SECURE-CONTEXT ONLY. Behind the https tunnel or at `localhost` on the
	 *     box it exists; on the documented plain-HTTP LAN room (`http://192.168.x.x:3000`) it is simply
	 *     `undefined`. The feature-detect guard makes this effect INERT there — no error, no-op — the
	 *     same shape as the `typeof ResizeObserver === 'undefined'` guard above. Blanking on a plain-HTTP
	 *     LAN TV stays a deployment concern (disable the OS screensaver), by owner ruling.
	 *   - The platform DROPS the lock whenever the document hides (tab switch, TV input change) and does
	 *     NOT restore it on its own. So we re-acquire on `visibilitychange` when we become visible again
	 *     and the room is still playing; without that it would work once and then quietly stop.
	 */
	$effect(() => {
		// Read reactively: this effect re-runs (releasing, then re-taking) whenever the room enters or
		// leaves an on-stage screen.
		const playing = !isAttract;
		if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
		if (!playing) return;

		let sentinel: WakeLockSentinel | null = null;
		// True from the moment we issue a request until its promise settles. `sentinel` is null for that
		// whole window, so without this flag a `visibilitychange` arriving mid-flight would issue a SECOND
		// request and leak the first held lock (it would survive the song's end). Short-circuit on it too.
		let acquiring = false;
		let released = false;

		const acquire = () => {
			// A pending, in-flight, or held lock needs no second request; a released sentinel is spent, so
			// re-request.
			if (acquiring || (sentinel && !sentinel.released)) return;
			acquiring = true;
			navigator
				.wakeLock!.request('screen')
				.then((s) => {
					if (released) {
						// The effect tore down while the request was in flight — do not leak it.
						s.release().catch(() => {});
						return;
					}
					sentinel = s;
				})
				// A rejected request (user-agent policy, low battery) must not throw — the screen just
				// falls back to its default sleep behaviour.
				.catch(() => {})
				.finally(() => {
					acquiring = false;
				});
		};

		const onVisibility = () => {
			if (document.visibilityState === 'visible') acquire();
		};

		acquire();
		document.addEventListener('visibilitychange', onVisibility);

		return () => {
			released = true;
			document.removeEventListener('visibilitychange', onVisibility);
			sentinel?.release().catch(() => {});
			sentinel = null;
		};
	});

	/*
	 * FULL SCREEN on the TV page (#424, owner ruling C).
	 *
	 * `/tv` is already `position: fixed; inset: 0`, so it owns the whole VIEWPORT — what it cannot claim
	 * on its own is the browser's own chrome (URL bar, tab strip) eating the top of an HDMI-plugged
	 * laptop or a TV browser. The Fullscreen API closes that, but `requestFullscreen()` needs TRANSIENT
	 * USER ACTIVATION in the TV's own document: there is no autofullscreen on load and no phone-triggered
	 * fullscreen (a realtime message carries no activation). So every path here is anchored to a real
	 * gesture ON the TV — the `f` key, the corner button, or the autoplay-recovery tap as a free rider.
	 */
	function toggleFullscreen() {
		if (typeof document === 'undefined' || !document.documentElement?.requestFullscreen) return;
		// Guarded on `document.fullscreenElement` so the one affordance toggles: enter if we are not
		// fullscreen, leave if we are. Both promises can reject (a policy denial, no activation) — swallow
		// it rather than throw out of a key/click handler.
		if (document.fullscreenElement) {
			document.exitFullscreen?.().catch(() => {});
		} else {
			document.documentElement.requestFullscreen().catch(() => {});
		}
	}

	/*
	 * The corner button self-hides after a few seconds of no input, so it is not persistent chrome on a
	 * wall (the issue's stated cost for ruling C). ANY pointer or key input on the page reveals it and
	 * restarts the timer — the same gesture surface the autoplay recovery already listens to.
	 * `controlsVisible` starts true so the affordance is discoverable when the stage first appears, then
	 * fades. Mirrors the ResizeObserver / wake-lock idiom above: arm listeners plus a timer, and tear
	 * both down in the returned cleanup.
	 */
	let controlsVisible = $state(true);
	const CONTROLS_IDLE_MS = 4000;
	$effect(() => {
		if (typeof window === 'undefined') return;
		let hideTimer: ReturnType<typeof setTimeout> | undefined;
		const arm = () => {
			if (hideTimer) clearTimeout(hideTimer);
			hideTimer = setTimeout(() => (controlsVisible = false), CONTROLS_IDLE_MS);
		};
		const wake = () => {
			controlsVisible = true;
			arm();
		};
		const onKey = (e: KeyboardEvent) => {
			// `f` toggles fullscreen from the keyboard — a real keypress carries the activation
			// requestFullscreen() needs. Ignore it while typing into a field (defensive; /tv renders none)
			// and honour a modifier-free `f` only, so browser shortcuts (Ctrl/Cmd combos) are untouched.
			const t = e.target as HTMLElement | null;
			const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
			if (!typing && (e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
				toggleFullscreen();
			}
			wake();
		};
		// `capture` + `passive` so the reveal sees the gesture even if something downstream stops
		// propagation, and we never preventDefault — the same shape TvPlayer's recovery listener uses.
		const opts: AddEventListenerOptions = { capture: true, passive: true };
		window.addEventListener('pointermove', wake, opts);
		window.addEventListener('pointerdown', wake, opts);
		window.addEventListener('keydown', onKey, opts);
		arm();
		return () => {
			if (hideTimer) clearTimeout(hideTimer);
			window.removeEventListener('pointermove', wake, opts);
			window.removeEventListener('pointerdown', wake, opts);
			window.removeEventListener('keydown', onKey, opts);
		};
	});

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
	const stageBg = $derived(
		stageBackgroundCss(resolvedBackground, tvBackgroundColor, currentSingerColor, tvBackgroundDim)
	);
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
	 * The attract panel shows the room CODE as its own largest element (.jt-code), so repeating it in
	 * the URL's `?room=CODE` query is both redundant and the reason the address wrapped to five lines in
	 * a 600px panel. Strip the scheme AND the query for the attract URL line — host + path only, the
	 * shortest legible thing to type — while the QR still encodes the full room-scoped URL.
	 */
	const attractJoinUrl = $derived(joinShort.replace(/\?.*$/, ''));
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

	/*
	 * THE ATTRACT PHRASE (issue #826, XR-TV-16/17/18). A fixed `Karaoke` label with one of seven phrases
	 * rotating beneath it in a fixed two-line box. The order is a shuffled bag reseeded per room
	 * (phrases.ts), advanced every 8s, with no repeat until the whole set has shown.
	 *
	 * Seeded from the room code so a room's rotation is stable and deterministic — the same requirement
	 * the phrase bag is built to satisfy, and testable because both are pure. A code-less TV (no active
	 * room resolved) falls back to a fixed seed, which is fine: the sequence just is not room-specific.
	 *
	 * REDUCED MOTION (XR-TV-05/17). Under `prefers-reduced-motion: reduce` the cycle does not start at
	 * all: one phrase is chosen per room and HELD for the session — Minecraft's own splash behaviour.
	 * The crossfade itself is a CSS animation gated on `(prefers-reduced-motion: no-preference)` (see the
	 * `.phrase-line` rule), never a Svelte `transition:` directive (motion.test.ts rejects those because
	 * the transition runtime never consults the media query). So motion is stopped in TWO independent
	 * ways under reduce — the clock never ticks AND the fade animation is media-gated off — and either
	 * alone is sufficient.
	 */
	const phraseSeed = $derived(seedFromString(data.roomCode || 'encore-attract'));
	// SSR-safe: matchMedia does not exist during load. Defaults to full motion; corrected on mount.
	let prefersReducedMotion = $state(false);
	// The phrase currently shown. Under reduce it is the held phrase; while cycling it is the bag's head.
	let attractPhrase = $state<string>(ATTRACT_PHRASES[0]);

	onMount(() => {
		const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
		prefersReducedMotion = mq?.matches ?? false;

		let timer: ReturnType<typeof setInterval> | undefined;

		// (Re)decide the phrase behaviour for the current motion preference. Called on mount and whenever
		// the OS preference changes, so a mid-session toggle stops or starts the cycle without a reload.
		const apply = () => {
			clearInterval(timer);
			timer = undefined;
			if (prefersReducedMotion) {
				// Hold ONE phrase for the session (XR-TV-17). No clock, no crossfade.
				attractPhrase = reducedMotionPhrase(phraseSeed);
				return;
			}
			// Full motion: draw the bag's first phrase now, then advance every 8s. The crossfade replays
			// via the `{#key attractPhrase}` remount in the markup, animated only under no-preference.
			const bag = makePhraseBag(phraseSeed);
			attractPhrase = bag.next();
			timer = setInterval(() => {
				attractPhrase = bag.next();
			}, 8000);
		};

		const onChange = (e: MediaQueryListEvent) => {
			prefersReducedMotion = e.matches;
			apply();
		};
		mq?.addEventListener?.('change', onChange);
		apply();

		return () => {
			clearInterval(timer);
			mq?.removeEventListener?.('change', onChange);
		};
	});
</script>

<div class="tv" style={tvStyle}>
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
		entryId={slotEntryId.A}
		visible={visible === 'A' && !isAttract}
		active={visible === 'A'}
		playing={isPlaying}
		seekSec={seekSec}
		seekRev={seekRev}
		keyShift={keyShift}
		guideLevel={guideLevel}
		masterLevel={masterLevelA}
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
		entryId={slotEntryId.B}
		visible={visible === 'B' && !isAttract}
		active={visible === 'B'}
		playing={isPlaying}
		seekSec={seekSec}
		seekRev={seekRev}
		keyShift={keyShift}
		guideLevel={guideLevel}
		masterLevel={masterLevelB}
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
		singerColor={currentSingerColor}
	/>

	{#if screen === 'attract'}
		<!--
			NOBODY HAS JOINED — the ratified split panel (issue #826, A2). Left column at the title-safe x:
			a FIXED `Karaoke` label above a rotating phrase in a fixed two-line box, so the label always
			tells a stranger what they are looking at and the rotation never shifts the column. Right
			column: a flat-filled panel carrying the join block, with the ROOM CODE as the largest element
			because the code is the thing being transcribed. The owner copy "Go to XXX and enter room code
			YYYY OR scan the QR code" is kept but BROKEN across the type ladder — a long sentence at ten
			feet is the failure mode — so each part sits on its own tier.
		-->
		<div class="attract">
			<div class="brand"><Icon name="mic" /> <span class="grad">Encore</span></div>
			<div class="asplit-l">
				<div class="phrase-kick">Karaoke</div>
				<!--
					The phrase box is a FIXED height for --tv-phrase-lines lines (XR-TV-18): a one-line and a
					two-line phrase must not move the column. The crossfade is a CSS animation on `.phrase-line`
					gated on (prefers-reduced-motion: no-preference); it replays because `{#key attractPhrase}`
					remounts the line on each 8s tick. Under reduce the cycle never ticks (the clock is not
					started) AND the animation is media-gated off, so the phrase is simply held. This is NOT a
					Svelte transition: directive — motion.test.ts bans those because they ignore the media query.
				-->
				<div class="phrase-box">
					{#key attractPhrase}
						<div class="phrase-line">{attractPhrase}</div>
					{/key}
				</div>
			</div>
			<div class="asplit-r">
				{#if joinUnreachable}
					<JoinBadge
						qrDataUrl={data.qrDataUrl}
						joinUrl={data.joinUrl}
						placement="hero"
						size="var(--tv-attract-qr)"
						unreachable={true}
					/>
				{:else}
					<!-- QR first: scanning types nothing, so it is the fast path and owns the top of the panel. -->
					<JoinBadge
						qrDataUrl={data.qrDataUrl}
						joinUrl={data.joinUrl}
						placement="hero"
						size="var(--tv-attract-qr)"
						unreachable={false}
					/>
					<!-- The typed path, broken across the ladder: "Go to <url> and enter room code <code>". -->
					<div class="join-text">
						<div class="jt-step">Go to</div>
						<div class="jt-url">{attractJoinUrl}</div>
						{#if data.roomCode}
							<div class="jt-step jt-code-step">and enter room code</div>
							<!-- THE LARGEST ELEMENT ON THE SCREEN (--tv-code): it is the thing being transcribed. -->
							<div class="jt-code">{data.roomCode}</div>
						{/if}
						<div class="jt-or">or scan the QR code</div>
					</div>
				{/if}
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
			<div class="upnext" bind:this={upnextEl}>
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
		<!-- Next up (issue #826, T1a) — accent family. The SINGER is the hero at --tv-takeover-name
		     (132px): the one thing the room needs to know is who to look at; the song is secondary. -->
		<div class="interstitial takeover state-next">
			<!-- "Now singing" for the opener; "Next up" once the night is under way. Saying "Next up" for
			     the very first song of the evening is simply untrue — there is no previous song it follows. -->
			<div class="up-label">{openedOnce && introEntry.id !== current?.id ? 'Next up' : 'Now singing'}</div>
			<div class="up-name hero-name">{singerName(introEntry.singerId)}</div>
			<!-- The song is the secondary line under the singer hero. Artist inline, and ONLY when a
			     confident parse produced one — never the uploader (e.g. "7clouds"). -->
			<div class="up-song">
				{d.title}{#if d.artist}<span class="up-artist-inline">{'\u00a0· '}{d.artist}</span>{/if}
			</div>
		</div>
	{:else if transient === 'error'}
		<!-- Skipping (issue #826, T1c) — danger family. Names what is GOING and what REPLACES it in the
		     same breath, so the room is never left wondering whose turn it now is. --danger exists
		     precisely so this cannot be mistaken for an affirmative event. -->
		<div class="interstitial takeover state-error" role="alert">
			<div class="state-mark"><Icon name="warning" /></div>
			<div class="up-label">Skipped</div>
			<div class="up-song">{skipNotice}</div>
			{#if upNext && upNext.id !== current?.id}
				<div class="up-replaces">
					Up next — {singerName(upNext.singerId)} · {songDisplay(mediaOf(upNext)).title}
				</div>
			{/if}
		</div>
	{:else if transient === 'waiting'}
		<!-- Still cooking (issue #826, T1b) — warn family. A wait, not a failure: the song title is the
		     hero and a bounded 3-step progress names the current step, so the wait reads as finite. The
		     words come from cook-phrasing (the ONE guest-facing cook vocabulary, shared with the phone).
		     THE TV KNOWS ONLY A COARSE "cooking" STATE: #396 deliberately stripped per-media cook tracking
		     from the TV (a cook for one song was reaching another's playhead), so there is no per-media
		     MediaStatus to read here. cookStep() is a pure, total MediaStatus->step mapping (guarded in
		     screen.test.ts and shared in shape with the phone, XR-TV-15); the TV feeds it the representative
		     mid-cook step 'separating' (the mockup's bolded "Removing vocals") rather than inventing the
		     per-media tracking the TV was purpose-built not to hold. -->
		{@const cookMedia = mediaOf(current)}
		{@const cook = cookStep('separating')}
		<div class="interstitial takeover state-waiting">
			<div class="state-mark"><Icon name="flame" /></div>
			<div class="up-label">{cookStageLabel('queued')}</div>
			<div class="up-song hero-song">{songDisplay(cookMedia).title}</div>
			<!-- Bounded 3-step progress. The bar width tracks the current step so the wait reads as
			     finite; the current step is bolded. Every step label is a fixed guest word (not a worker
			     stage), and exactly one step is current for every status (cookStep is total). -->
			<div class="cook-bar"><i style="width: {cook.fraction}"></i></div>
			<div class="cook-steps">
				{#each COOK_STEPS as label, i (label)}
					<span class:step-current={i === cook.index} class:step-done={i < cook.index}>{label}</span>
				{/each}
			</div>
		</div>
	{:else if transient === 'loading'}
		<!--
		  P1: the missed-preload path. `onEnded` could not swap (hidden slot not warmed) and set `loading`
		  with `current` still set, so `screen` derives `playing` and the not-yet-loaded <video> renders
		  black under only the lower-third. This keeps a treatment up until the visible player reports
		  ready (onVisibleReady -> playing dismisses it). Uses the affirmative `state-next` treatment
		  because a song IS coming — it is the same "a song is about to play" beat the swap card covers.
		-->
		<div class="interstitial takeover state-next">
			<div class="up-label">{openedOnce ? 'Up next' : 'Loading'}</div>
			<div class="up-name hero-name">{singerName(current?.singerId)}</div>
			<div class="up-song">
				{loadingDisplay.title}{#if loadingDisplay.artist}<span class="up-artist-inline"
						>{'\u00a0· '}{loadingDisplay.artist}</span
					>{/if}
			</div>
		</div>
	{/if}

	<!--
		THE JOIN BLOCK SURVIVES EVERY TAKEOVER (issue #826, XR-TV-13), dimmed to 72%, in the same
		bottom-right slot as during playback. A song change is exactly when a new guest looks up, so
		blanking the code then would lose the join path precisely when it is most wanted. Rendered
		whenever a takeover is up (`transient` set) — the corner treatment is the identical component the
		playing state uses, so the slot does not move; `.takeover-join` only dims it.
	-->
	{#if transient}
		<div class="takeover-join">
			<JoinBadge qrDataUrl={data.qrDataUrl} joinUrl={data.joinUrl} placement="corner" unreachable={joinUnreachable} />
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

		ALSO GATED ON `!isAttract` — the SAME flag the player slots, the stage background and the wake lock
		use (#736). The latch has only two writers, both per-slot props, so when the room DRAINS (a skip at
		the last entry: player.ts advance() finds no nextPlayable and sets currentEntryId null / isPlaying
		false) both players unmount and NEITHER onautoplayblocked NOR onautoplayrecovered can fire again.
		Without this term the 82%-opaque full-viewport scrim sat over the lobby of an empty room for good,
		above the join QR and the join address a new singer walks up to read, promising to "start the music"
		with nothing queued.

		Gating the RENDER rather than clearing the latch is deliberate: the block is a real property of this
		TV — it has still never been tapped — so it must be announced again the moment something is on stage,
		and it is, because the latch survives the idle window. On an idle screen there is nothing a tap could
		start anyway: both slots are `visible={… && !isAttract}` and TvPlayer only raises the block when
		active AND visible, so no slot can even report one while this term hides the overlay.
	-->
	{#if autoplayBlocked && !isAttract}
		<button
			type="button"
			class="autoplay-hint"
			onclick={() => {
				// FREE RIDER (#424, ruling C): this tap is a real gesture in the TV's own document, so it
				// carries the activation `requestFullscreen()` needs. Ask for fullscreen alongside clearing
				// the hint — best-effort, and it never blocks the music recovery, which TvPlayer's own
				// document-wide gesture listener performs. It only fires when autoplay was refused, which is
				// exactly why the hotkey and the corner button are the real path and this is the rider.
				toggleFullscreen();
				autoplayBlocked = false;
			}}
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

	<!--
		FULLSCREEN corner button (#424). Self-hides after a few seconds of no input (`controlsVisible`), so
		it is not permanent chrome on a wall. z-tier 7 (see the z-scheme below), the persistent-chrome tier:
		ABOVE the lyrics reel (6) and the player slots so it stays tappable during a song, and BELOW the
		transient full-screen overlays (8) and the autoplay hint (10) so those always cover it. It shares
		tier 7 with the lower-third (bottom-left), the join QR (bottom-right) and the Up-next block
		(top-right), so it is pinned TOP-right BELOW the whole Up-next block (#889) to overlap none;
		inset with the safe-area tokens so a television's overscan cannot crop it.

		The mark is an INLINE SVG, not a Unicode codepoint: icons.test.ts bans a functional control whose
		drawing the platform picks (a bare glyph renders as colour emoji on one device and tofu on a
		stripped-down TV browser), and there is no fullscreen mark in icons.ts to reuse.
	-->
	<button
		type="button"
		class="fs-btn"
		class:shown={controlsVisible}
		onclick={toggleFullscreen}
		aria-label="Toggle full screen (press f)"
		title="Full screen (f)"
	>
		<svg
			class="fs-glyph"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />
		</svg>
	</button>

	<div class="status" class:on={connected}></div>
</div>

<style>
	/*
	 * THE TV TYPE FLOOR — THE ONE DECLARATION (issue #821, XR-TV-01). Every --tv-* type tier in app.css
	 * is a `rem` multiple of THIS root, so the floor is defined in exactly one place. It MUST live on
	 * `:root` (the document root), NOT on `.tv`: `rem` resolves against the document root font-size
	 * unconditionally, so a `font-size` on `.tv` would not re-root `rem` for its descendants.
	 *
	 * `:global(:root)` inside THIS component's <style> — not global in app.css — is the resolution of
	 * XR-TV-02's "one declaration vs the phone is unaffected", stated rather than defaulted: a Svelte
	 * component's stylesheet is injected only WHILE the component is mounted and removed when the last
	 * instance is destroyed, so this root floor applies to the /tv document alone. A global :root in
	 * app.css would re-root the phone's --ph-* rem ladder to ~19px on a phone viewport and regress
	 * SC 1.4.4. Kept in the component's single <style> block (rather than a second <style> or
	 * <svelte:head>) so the file's first-and-only style block stays the component's, which the TV
	 * source-scan guards read.
	 *
	 * max(2.7vh, 20px): the vh term scales with the panel (a TV browser presents a fixed 1920×1080 CSS
	 * viewport, so 2.7vh = 29.16px on a full 1080-tall stage); the 20px term is the legibility floor for
	 * the windowed/dev case where every physical assumption collapses (2.2vh = 20px on a 900px laptop).
	 *
	 * --ui-scale is a persisted preference, range 0.8–1.6, default 1. PERSISTENCE IS DEFERRED to a
	 * follow-up (XR-TV-07's room-setting plumbing lives in packages/shared, out of #821's TV-only scope);
	 * until then it defaults to 1 here. The clamp() is defensive: whatever a future setting writes into
	 * --ui-scale, the multiplier can never leave 0.8–1.6, so the floor holds.
	 */
	/*
	 * --ui-scale registered as a typed custom property (XR-TV-07 default + the reviewer's non-numeric
	 * advisory on #907). `@property` with `syntax: '<number>'` means a non-numeric write (e.g.
	 * `--ui-scale: banana`) is rejected at parse time and FALLS BACK to `initial-value: 1`, instead of
	 * poisoning the clamp() and dropping the whole font-size declaration — which would silently remove
	 * the floor. The clamp() below still bounds a numeric out-of-range value to 0.8–1.6. `inherits: true`
	 * so a future setting can write it once on :root and every tier sees it.
	 */
	@property --ui-scale {
		syntax: '<number>';
		inherits: true;
		initial-value: 1;
	}
	:global(:root) {
		--ui-scale: 1;
		font-size: calc(max(2.7vh, 20px) * clamp(0.8, var(--ui-scale), 1.6));
	}
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
	 *   7  persistent chrome that must sit ABOVE the reel and the video: lower-third (bottom-left),
	 *      brand-float, progress bar (TvProgress), join corner/badqr (JoinBadge, bottom-right),
	 *      fullscreen button (.fs-btn, #424 — shares this tier but pinned TOP-right BELOW the whole
	 *      "Up next" block since #889, so it overlaps none of them; a transient overlay at 8 and the
	 *      autoplay hint at 10 correctly cover it)
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
		z-index: var(--z-tv-bg);
		opacity: 0;
		transition: opacity var(--motion-base) ease;
	}
	.stage-bg.shown {
		opacity: 1;
	}
	/*
	 * THE ATTRACT SPLIT PANEL (issue #826, A2). A left column at the title-safe x carrying the fixed
	 * `Karaoke` label + rotating phrase, and a flat-filled right panel carrying the join block. Two
	 * columns, not a centred stack, so the phrase can be a large left-aligned statement and the join
	 * block a self-contained panel a guest scans or transcribes from.
	 */
	.attract {
		position: absolute;
		inset: 0;
		z-index: var(--z-tv-screen);
		background: radial-gradient(80% 60% at 30% 30%, var(--stage-glow) 0%, var(--bg) 70%);
	}
	/* The wordmark, pinned top-left at the safe-area inset — its offset from the edge is what proves the
	   stage chrome clears the overscan region (the e2e stageBrand anchor reads this). */
	.brand {
		position: absolute;
		top: var(--tv-safe-y);
		left: var(--tv-safe-x);
		font-weight: 800;
		font-size: var(--tv-name);
		display: inline-flex;
		align-items: center;
		gap: var(--space-lg);
	}
	.grad {
		background: var(--grad);
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}
	/* Left column: fixed label above the rotating phrase, vertically centred, at the title-safe inset. */
	.asplit-l {
		position: absolute;
		left: var(--tv-safe-x);
		top: 0;
		bottom: 0;
		width: var(--tv-attract-left);
		display: flex;
		flex-direction: column;
		justify-content: center;
	}
	/* `Karaoke` — the FIXED label. It never rotates: it is the only thing telling a stranger what they
	   are looking at (XR-TV-18). */
	.phrase-kick {
		font-size: var(--tv-name);
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--accent-ink);
	}
	/*
	 * The phrase box is a FIXED height for exactly --tv-phrase-lines lines, content vertically centred
	 * (XR-TV-18), so a one-line and a two-line phrase never move the label above or the panel beside it.
	 * Height = phrase font-size × line-height × lines; the line-height here (1.03) matches the mockup and
	 * is what the box height is computed from.
	 */
	.phrase-box {
		height: calc(var(--tv-phrase) * 1.03 * var(--tv-phrase-lines));
		margin-top: 2vh;
		display: grid;
		align-content: center;
		overflow: hidden;
	}
	.phrase-line {
		font-size: var(--tv-phrase);
		font-weight: 900;
		line-height: 1.03;
	}
	/*
	 * THE CROSSFADE — opacity only, and a CSS animation gated on (prefers-reduced-motion: no-preference)
	 * (XR-TV-05/17). It replays because `{#key attractPhrase}` remounts `.phrase-line` on each 8s tick.
	 * NEVER a Svelte transition: directive — motion.test.ts bans those because the transition runtime
	 * never consults the media query. Under `reduce` this @media block does not apply AND the JS clock is
	 * never started, so the phrase is simply held with no animation.
	 */
	@media (prefers-reduced-motion: no-preference) {
		.phrase-box .phrase-line {
			animation: phrase-fade 0.6s ease-out;
		}
	}
	@keyframes phrase-fade {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	/*
	 * Right column: the flat-filled join panel (--bg2, a 2px --line left border). QR, then the typed
	 * path broken across the ladder, with the ROOM CODE as the largest element (--tv-code) because it is
	 * the thing being transcribed.
	 */
	.asplit-r {
		position: absolute;
		right: 0;
		top: 0;
		bottom: 0;
		width: var(--tv-attract-right);
		background: var(--bg2);
		border-left: 2px solid var(--line);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 3.2vh;
		padding: 0 var(--tv-safe-x);
		text-align: center;
		overflow: hidden;
	}
	.join-text {
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.jt-step {
		font-size: var(--tv-body);
		color: var(--ink-dim);
		line-height: 1.3;
	}
	.jt-code-step {
		margin-top: 1.6vh;
	}
	.jt-url {
		/*
		 * The mockup's `.url` budget is 44px (--tv-name); at --tv-joinurl (88px) a real LAN address split
		 * mid-octet in the 600px panel ("10.69.1.1 / 69:3721/j / oin"), so a guest transcribed the wrong
		 * host (XR-TV-19 blocker). An address is ONE unbreakable token: shrinking beats breaking, so this
		 * carries NO overflow-wrap — the room code (the largest element) is the thing being transcribed,
		 * and it renders unbroken; the URL is the secondary route and fits one line at this budget.
		 */
		font-size: var(--tv-name);
		font-weight: 800;
		font-variant-numeric: tabular-nums;
		line-height: var(--lh-tight);
	}
	/* THE LARGEST ELEMENT ON THE ATTRACT SCREEN (--tv-code, 96px): the room code is what a guest types. */
	.jt-code {
		font-size: var(--tv-code);
		font-weight: 900;
		letter-spacing: 0.11em;
		color: var(--accent-ink);
		line-height: var(--lh-none);
		font-variant-numeric: tabular-nums;
		margin-top: 0.6vh;
	}
	.jt-or {
		font-size: var(--tv-small);
		color: var(--ink-dim);
		margin-top: 1.8vh;
	}
	.lower-third {
		/* Capped: unbounded, a long title or singer name grew this rightward into the join QR at
		   bottom-right. 46vw leaves the QR its corner on every aspect ratio. */
		position: absolute;
		left: var(--tv-safe-x);
		bottom: var(--tv-safe-y);
		z-index: var(--z-tv-card);
		display: flex;
		flex-direction: column;
		max-width: 46vw;
		gap: var(--space-3xs);
		/*
		 * NO CARD. No background, no padding, no border-radius, no backdrop-filter — see the markup
		 * comment for why. Legibility comes from BOTH a blurred text-shadow AND a text-stroke, the same
		 * pair the lyrics reel uses (LyricsOverlay.svelte:346), and both work on every TV browser.
		 *
		 * #425: the stroke is load-bearing, not decoration. Before #425 the stage was pinned dark, so a
		 * shadow tuned against black was enough. #425 lets a room pick ANY stage colour — including
		 * white — and a blurred dark shadow disappears against a bright field of similar luminance, so
		 * the singer name measured 1.10:1 on white (the retired stage pin used to prevent exactly this).
		 * `-webkit-text-stroke` with `paint-order: stroke fill` draws a hard dark outline BEHIND the
		 * glyph, so the text stays readable on any background — the owner's ratified #425 condition,
		 * "always visible regardless of the background". Width in `em` (not px) so it reads the same at
		 * 720p and 4K, and --scrim-strong reuses the reel's one dark-outline source of truth.
		 *
		 * Dropping the fill also drops the reason the block was capped in height: it no longer reads as
		 * an object that can collide with the QR, only as text that must not run into it.
		 */
		text-shadow: 0 2px 14px rgba(0, 0, 0, 0.9);
		-webkit-text-stroke: 0.04em var(--scrim-strong);
		paint-order: stroke fill;
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
		margin-top: var(--space-3xs);
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
		z-index: var(--z-tv-card);
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
		z-index: var(--z-tv-interstitial);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-lg);
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
	/* Inline artist suffix on a takeover song line — same role as the old .up-artist but riding the title. */
	.up-artist-inline {
		color: var(--ink-dim);
	}
	/* A mark large enough to be the first thing read, since it is what distinguishes these states. */
	.state-mark {
		font-size: var(--tv-hero);
		line-height: var(--lh-none);
		margin-bottom: var(--space-2xs);
	}

	/*
	 * ── FULL-SCREEN TAKEOVERS (issue #826, T1) ─────────────────────────────────────────────────────
	 * The three transient states are full-screen takeovers that cannot be confused: one colour family
	 * each, drawn as a 14px LEFT BORDER in the family colour plus a same-direction gradient. Left-aligned
	 * from the title-safe x (the border lives just outside it, so the text still starts at title-safe),
	 * overriding the centred base `.interstitial` layout. Colour is never the only carrier — each also
	 * keeps its own eyebrow and (error/cooking) its own mark.
	 */
	.takeover {
		align-items: flex-start;
		justify-content: center;
		text-align: left;
		padding-left: var(--tv-safe-x);
		border-left: var(--tv-takeover-border) solid transparent;
	}
	/* Next up — accent family. Singer name is the hero at --tv-takeover-name (132px). --accent (not the
	   retired --accent-strong, #840/XR-COL-11) as a NON-TEXT border/fill, which is exactly what --accent
	   is certified for; the text on this takeover is --ink / --accent2, never --accent as ink. */
	.state-next.takeover {
		border-left-color: var(--accent);
		background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 16%, transparent), transparent 55%);
	}
	.hero-name {
		font-size: var(--tv-takeover-name);
		font-weight: 900;
		line-height: 1.02;
	}
	.state-next .up-song {
		color: var(--accent2);
		margin-top: 1.4vh;
	}

	/*
	 * Skipping — danger family. Names what is GOING and what REPLACES it. Keeps a distinct family AND a
	 * distinct eyebrow, so colour is not the only carrier. It no longer needs the old near-opaque wash:
	 * the border + gradient + mark make a skip unmistakable, and the join block below must stay visible
	 * through it (XR-TV-13), which a near-opaque wash would have hidden.
	 */
	.state-error.takeover {
		border-left-color: var(--danger);
		background: linear-gradient(90deg, color-mix(in srgb, var(--danger) 14%, transparent), transparent 55%);
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
	/* What replaces the skipped song — so the room never wonders whose turn it now is. */
	.up-replaces {
		font-size: var(--tv-name);
		color: var(--ink-dim);
		margin-top: 1.4vh;
	}

	/* Still cooking — warn family. Song title is the hero; a bounded 3-step bar says the wait is finite. */
	.state-waiting.takeover {
		border-left-color: var(--warn);
		background: linear-gradient(90deg, color-mix(in srgb, var(--warn) 10%, transparent), transparent 55%);
	}
	.state-waiting .state-mark {
		color: var(--warn);
	}
	.state-waiting .up-label {
		color: var(--warn);
	}
	.state-waiting .up-song {
		color: var(--ink);
	}
	.hero-song {
		font-size: var(--tv-hero);
		font-weight: 900;
		line-height: 1.04;
		margin-top: 1vh;
	}
	.cook-bar {
		width: var(--tv-cook-bar-w);
		height: var(--tv-cook-bar-h);
		border-radius: var(--radius-pill);
		background: var(--track-bg);
		margin-top: 3vh;
		overflow: hidden;
	}
	.cook-bar i {
		display: block;
		height: 100%;
		background: var(--warn);
	}
	.cook-steps {
		display: flex;
		gap: var(--space-4xl);
		margin-top: 2vh;
		font-size: var(--tv-small);
		color: var(--ink-dim);
	}
	.cook-steps .step-current {
		color: var(--warn);
		font-weight: 700;
	}
	.cook-steps .step-done {
		color: var(--ink);
	}
	/*
	 * THE JOIN BLOCK SURVIVES EVERY TAKEOVER, dimmed to 72% (XR-TV-13). It wraps the identical corner
	 * JoinBadge the playing state uses, so the bottom-right slot does not move; only the opacity changes.
	 * The composited --ink-dim run inside it still clears 3:1 at ≥24px because --tv-small is 27px
	 * (XR-TV-04). Sits above the takeover (z-tv-status) so the dimmed block is never painted over.
	 */
	.takeover-join {
		position: absolute;
		inset: 0;
		z-index: var(--z-tv-status);
		opacity: 0.72;
		pointer-events: none;
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
		z-index: var(--z-tv-status);
	}
	/* rgba(51,214,166,0.18) was --ok at 18%; color-mix keeps the ring on the theme's ok colour. */
	.status.on {
		background: var(--ok);
		box-shadow: 0 0 0 5px color-mix(in srgb, var(--ok) 18%, transparent);
	}

	/*
	 * The fullscreen corner button (#424). Fades between states on opacity so the self-hide is a soft
	 * dissolve rather than a pop. Sits at z 7 — the documented persistent-chrome tier: ABOVE the lyrics
	 * reel (6) and the player slots (1/2) so it stays tappable during a song, and BELOW the transient
	 * full-screen overlays (8) and the autoplay hint (10) so those always cover it. It shares the tier
	 * with the lower-third (bottom-LEFT) and the join QR (bottom-RIGHT); it is pinned TOP-right below
	 * the status dot so it overlaps NEITHER — before #889 it sat bottom-right too, sharing the join
	 * QR's exact anchor, and at equal z-index the later-in-DOM button painted over the QR's text.
	 * Safe-area-inset on both axes so overscan cannot clip it, and `pointer-events`
	 * drops with the fade so a hidden button can never eat a tap meant for the stage.
	 *
	 * The clamp's floor is var(--tap) — app.css's own tap-target minimum, named rather than restated
	 * (XR-PH-01, issue #831). A TV remote's pointer needs that floor as much as a thumb does, and this
	 * comment used to CLAIM the binding while the code held a bare `44px`: the one control whose stated
	 * reason for its size was a token it did not read.
	 */
	.fs-btn {
		position: absolute;
		right: var(--tv-safe-x);
		/* TOP-right, tucked BELOW the whole "Up next" block (#889). The bottom-right corner is owned by
		   the join QR (JoinBadge `.corner`) and the bottom-LEFT by the lower-third — both z-tier 7. The
		   top-right holds the status dot (16px, tier 9) AND `.upnext` (tier 7, right:var(--tv-safe-x),
		   top:calc(var(--tv-safe-y) + 2.6vh)). `.upnext` is the same right edge and same z-tier, and
		   `.fs-btn` is later in the DOM, so anchoring level with it would paint over the Up-next readout
		   just as the first #889 attempt (safe-y + 28px) did. So the button sits below `.upnext`'s own
		   top PLUS its MEASURED height (`--tv-upnext-h`, a ResizeObserver on the block — its title
		   wraps, so a fixed offset would fail when it grows) PLUS a gap. `--tv-upnext-h` is 0px when no
		   next song is queued, so the button just sits at the top-right inset with nothing to clear.
		   Raising the QR's `bottom` to stack them would eat its overscan clearance, and bumping the
		   button's z-index would cover chrome OPAQUELY — both worse; the button moves instead. */
		top: calc(var(--tv-safe-y) + 2.6vh + var(--tv-upnext-h) + var(--space-lg));
		z-index: var(--z-tv-card);
		display: grid;
		place-items: center;
		width: clamp(var(--tap), 5.2vmin, 88px);
		height: clamp(var(--tap), 5.2vmin, 88px);
		border: 0;
		border-radius: 14px;
		cursor: pointer;
		color: var(--ink);
		background: color-mix(in srgb, var(--bg) 62%, transparent);
		backdrop-filter: blur(4px);
		-webkit-backdrop-filter: blur(4px);
		opacity: 0;
		pointer-events: none;
		transition: opacity var(--motion-slow) ease;
	}
	.fs-btn.shown {
		opacity: 0.85;
		pointer-events: auto;
	}
	.fs-glyph {
		display: block;
		width: clamp(22px, 3vmin, 48px);
		height: clamp(22px, 3vmin, 48px);
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
		z-index: var(--z-tv-affordance);
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
		/* the mark glyph, sized off the root ladder (XR-TV-01): 2.881rem ≈ 84px at --ui-scale 1, and
		   it tracks the floor down on a short panel so it stays inside the vmin-scaled circle. */
		font-size: 2.881rem;
	}
	.ah-head {
		font-size: var(--tv-hero);
		font-weight: 800;
		line-height: var(--lh-tight);
		text-shadow: 0 2px 12px rgba(0, 0, 0, 0.55);
	}
	.ah-sub {
		font-size: var(--tv-body);
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
		z-index: var(--z-tv-interstitial);
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
		/* the mark glyph, sized off the root ladder (XR-TV-01): 2.881rem ≈ 84px at --ui-scale 1, and
		   it tracks the floor down on a short panel so it stays inside the vmin-scaled circle. */
		font-size: 2.881rem;
	}
	.sr-head {
		font-size: var(--tv-hero);
		font-weight: 800;
		line-height: var(--lh-tight);
		text-shadow: 0 2px 12px rgba(0, 0, 0, 0.55);
	}
	.sr-sub {
		font-size: var(--tv-body);
		color: var(--ink-dim);
		max-width: 60ch;
		text-shadow: 0 1px 8px rgba(0, 0, 0, 0.5);
	}
</style>
