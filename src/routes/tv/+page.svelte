<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type { ServerEvent, QueueEntry, Media, PublicSinger } from '$lib/contract';
	import { chosenCandidate, isPlayable, effectiveSongIntroMs, songDisplay, soundingKeyLabel } from '$lib/contract';
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
	} from '$lib/contract';
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
		processStep,
		PROCESS_STEPS
	} from '$lib/tv/screen';
	import { isAutoTranscribed, provenanceLabel } from '$lib/tv/lyrics';
	import { joinAddressLabel } from '$lib/tv/join-address';
	import { processStageLabel } from '$lib/phrasing/process-phrasing';
	import { mergeCatalog, snapshot, processIsTerminal, type PlaybackSnapshot } from '$lib/tv/catalog';
	import { makePhraseBag, reducedMotionPhrase, seedFromString, ATTRACT_PHRASES } from '$lib/tv/phrases';

	let { data } = $props();

	let entries = $state<QueueEntry[]>([]);
	let singers = $state<Map<string, PublicSinger>>(new Map());
	let mediaCatalog = $state<Map<string, Media>>(new Map());
	let connected = $state(false);
	// Singer ids with a live socket right now — NOT `singers`, which is every singer who ever joined.
	let online = $state<string[]>([]);
	// In the room but unreachable — a locked phone, a pocket. Greyed, never erased: a socket dropping is
	// not someone leaving the party.
	let away = $state<string[]>([]);
	// Room + global settings as ONE object, kept live by settings:changed. Held whole rather than copied
	// field-by-field, so a new setting needs no local, no effect line and no handler assignment. The effect
	// re-adopts `data` so a load re-run is not pinned to the value captured at mount.
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
	let durationSec = $state(0);
	let skipNotice = $state('');
	// The active slot's autoplay was REFUSED and the room is silent until a gesture. A TV wall registers
	// none on its own, so the page surfaces an affordance; TvPlayer arms a document-wide gesture listener
	// that re-attempts playback. Active+visible slot only.
	let autoplayBlocked = $state(false);
	/*
	 * A TRANSPOSE IS WAITING FOR ONE TAP. Distinct from `autoplayBlocked`: there the MUSIC is not playing,
	 * which is obvious in the room; here it plays perfectly and only the key is stuck, so the say is a corner
	 * pill. It is the ONLY way anyone learns the buttons need a tap, because the graph degrades silently.
	 */
	let pitchBlocked = $state(false);
	// The instrumental refused to start with an error NO gesture can lift (decode failure, AbortError), so
	// unlike `autoplayBlocked` there is no recovery and the page must SAY the room is silent on screen.
	// Cleared when a fresh song loads or the element starts advancing. Holds the error name.
	let playbackFailedReason: string | null = $state(null);
	// The honest counterpart to `isPlaying`, which is the ROOM'S INTENT from the server: the room can intend
	// to play while the element does not, and the reel must freeze in exactly those cases.
	let masterAdvancing = $state(false);
	let tvProgressStyle = $derived(settings.room.tvProgressStyle);
	// What the room paints behind the song, derived from the same settings object so a live
	// settings:changed needs no per-field assignment.
	let tvBackgroundStyle = $derived(settings.room.tvBackgroundStyle);
	let tvBackgroundColor = $derived(settings.room.tvBackgroundColor);
	// The room's 0..1 stage dimmer — a LIGHTNESS control on the resolved colour, not a layer over video.
	let tvBackgroundDim = $derived(settings.room.tvBackgroundDim);
	// The visualizers build their palette by hue ARITHMETIC, so they need an ANGLE while the stored value is
	// a hex. `hueOfColor` is scale-free, so it recovers the hue of a dark stage colour that `nearestSingerHue`
	// would snap to the wrong wheel stop.
	let tvBackgroundHue = $derived(hueOfColor(tvBackgroundColor));
	let tvVisualizer = $derived(settings.room.tvVisualizer);
	// playback isPlaying (pause/resume from the phone) — wired into both player slots
	let isPlaying = $state(true);
	// seek target (positionSec from playback:state) — the player jumps the video on a real change
	let seekSec = $state(0);
	// Server `rev` from the last `playback:state`. Bumped by every playback command but NEVER by position
	// telemetry, so the player's seek effect can track it to re-take its decision on a restart whose
	// position equals the last one.
	let seekRev = $state(0);
	// Per-song background override from playback:state. null = use the room default (the resting state).
	let backgroundOverride = $state<TvBackgroundStyle | null>(null);
	// The GUIDING TRACK: per-song override over the room default, resolved by `effectiveGuideLevel`.
	// Read raw, a null override is indistinguishable from "explicitly off" — which is the distinction that
	// lets a room default survive a song change.
	let guideOverride = $state<number | null>(null);
	const guideLevel = $derived(effectiveGuideLevel({ guideLevel: guideOverride }, settings.room.guideLevelDefault));
	// Current transpose in semitones (±), straight from playback:state, HONOURED by shifting pitch in the
	// browser — there is no pre-rendered variant to 404 on.
	let keyShift = $state(0);
	// THE SNAPSHOT SEAM. The slots hold immutable `PlaybackSnapshot`s, not live catalog records: a `Media`
	// is not assignable here, so the only way a song reaches the player is through `snapshot()` in
	// `syncSlots()` — on an explicit playback transition and at no other time.
	let slotMedia = $state<{ A: PlaybackSnapshot | null; B: PlaybackSnapshot | null }>({
		A: null,
		B: null
	});
	// The QUEUE-ENTRY id playing in each slot, parallel to `slotMedia`. A song queued twice snapshots to
	// byte-identical media, so the media id and resolved src cannot tell the second turn from the first;
	// the entry id can, and the player re-arms its transport on it. Set only in `syncSlots`.
	let slotEntryId = $state<{ A: string | null; B: string | null }>({ A: null, B: null });

	// LOUDNESS NORMALIZATION happens HERE, at playback, not in the worker: a song's pulldown depends on the
	// LIVE library median, a property of the room's whole catalog at play time. `null` levels are absent from
	// the list, so its length is the population the floor is checked against.
	const libraryLoudnessLevels = $derived(
		[...mediaCatalog.values()]
			.map((m) => m.songProfile?.loudnessLufs ?? null)
			.filter((v): v is number => typeof v === 'number')
	);
	// 1 (unity) for the whole existing library and every song with the feature off, below the measured
	// floor, or unmeasured. ATTENUATE-ONLY: never above 1.
	function resolveMasterLevel(m: PlaybackSnapshot | null): number {
		return loudnessNormalizationGain({
			songLufs: m?.songProfile?.loudnessLufs ?? null,
			libraryLevels: libraryLoudnessLevels,
			enabled: settings.room.loudnessNormalization
		}).gain;
	}
	// Parallel to slotMedia — the two can differ, since the hidden slot pre-warms `upNext`.
	const masterLevelA = $derived(resolveMasterLevel(slotMedia.A));
	const masterLevelB = $derived(resolveMasterLevel(slotMedia.B));

	// The shared WsClient (heartbeat, liveness watchdog, capped-backoff reconnect, page-lifecycle
	// rebinding). The TV runs unattended for hours on a set-top browser, so the watchdog for a socket that
	// stops answering but never fires `close` matters most here.
	let ws: WsClient | undefined;
	let interstitialTimer: ReturnType<typeof setTimeout> | undefined;

	/*
	 * Two rules from `$lib/tv/catalog.ts` hold here: `mergeCatalog` is the ONLY writer of `mediaCatalog` and
	 * it takes a FULL server list, so no partial local edit is expressible; and the player is handed
	 * `snapshot(...)`, never `mediaOf(...)` directly.
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
		// SNAPSHOT HERE, and only here. `syncSlots` runs only on explicit lifecycle transitions, which is what
		// makes it the correct seam: re-taken when the song genuinely changes and at no other time.
		const curMedia = snapshot(mediaOf(current));
		const nextMedia = snapshot(mediaOf(upNext));
		// The entry id travels with its snapshot into the SAME slot, so the player's per-entry transport re-arm
		// sees a distinct id for the second turn of a same-song queue.
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
		// Compared BEFORE `current` is overwritten, and on the ENTRY id, because a song queued twice is two
		// entries over one media record.
		const entryChanged = cur?.id !== current?.id;
		current = cur;
		upNext = next;
		// Re-anchor on the ENTRY CHANGE ONLY. `positionSec` is written by the active slot's `onposition`, which
		// does not run until the new element fires its first `timeupdate`, so until then `drawPosition`
		// extrapolates from the PREVIOUS song's anchor. The guard is load-bearing because the server calls
		// `emitNowPlaying` at the tail of EVERY player command: without it the guide slider's ~8 commands/second
		// re-pin the reel to the opening line for the whole drag.
		if (entryChanged) {
			positionSec = 0;
			durationSec = 0;
		}
		// Held slot: a current whose media has no instrumental yet shows WAITING rather than a black player.
		// The server normally skips these via nextPlayable, so this is defensive.
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
	 * DROPPED SILENTLY when the socket is not open — right for a ~4Hz stream whose next frame is 250ms away.
	 * What is NOT acceptable is THROWING: optional chaining guards an absent socket, not a CONNECTING/CLOSED
	 * one, and called from `ontimeupdate` that throw left the server never learning the playhead.
	 */
	function sendTelemetry(status: string, positionSec = 0) {
		// The frame — including the entry stamp the server's stale-frame guard needs on EVERY frame — is built
		// by the pure `telemetryFrame()`, so the stamp is unit-tested behaviourally. `quiet` suppresses
		// WsClient's per-drop warning.
		ws?.send(telemetryFrame(status, current, positionSec), { quiet: true });
	}

	function onVisibleError() {
		// Dead/unplayable media — treated like ended so the room advances rather than hanging on black. Say so
		// on screen first: several bad files in a row would otherwise just flash black across the room.
		skipNotice = 'Skipping — that track would not play';
		setTimeout(() => (skipNotice = ''), 4000);
		// `onVisibleEnded()` sends the single `ended` frame; a second one makes the server advance twice and
		// eat the next singer's turn.
		onVisibleEnded();
	}

	/**
	 * Captured explicitly at each entry into the interstitial rather than derived from `upNext`, because
	 * `nowplaying:changed` can land mid-intro and advance both — deriving it names the song AFTER next.
	 */
	let introEntry = $state<QueueEntry | null>(null);
	/** The session has shown at least one song, so the next intro is a transition rather than an opener. */
	let openedOnce = $state(false);

	function onVisibleEnded() {
		const next = ctl.onEnded(upNext);
		tvState = next;
		// Tell the server, so it advances authoritatively and `nowplaying:changed` comes back.
		sendTelemetry('ended');
		if (next === 'interstitial') {
			introEntry = upNext;
			holdSongIntro();
		}
		syncSlots();
	}

	/**
	 * The opening song gets an intro too: `onEnded` only reaches the interstitial via a gapless swap, so the
	 * first song of the night was the only one that appeared unannounced.
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
			// An OMITTED `online` means "no info", not "nobody here", and must not blank a roster we hold.
			if (e.online) online = e.online;
			if (e.away) away = e.away;
		}
		if (e.type === 'singer:presence') {
			online = e.online;
			away = e.away;
		}
		// Room settings are live: a phone's change applies without reloading. ONE assignment, so a new setting
		// needs no edit here.
		if (e.type === 'settings:changed') {
			settings = e.settings;
			// The join address is the ONE setting the TV cannot apply in place, because the QR is a server-rendered
			// image. An empty setting means "fall back", which resolves to what the load already computed — so
			// compare RESOLVED to RESOLVED and re-run the load only when the address actually moved.
			const nextOrigin = e.settings.global.joinOrigin || data.joinFallbackOrigin;
			if (nextOrigin !== data.joinOrigin) invalidateAll();
		}
		if (e.type === 'nowplaying:changed') applyNowPlaying(e.current, e.upNext);
		if (e.type === 'playback:state') {
			isPlaying = e.state.isPlaying;
			seekSec = e.state.positionSec;
			seekRev = e.rev;
			// Per-song override; null hands the song back to the room default.
			backgroundOverride = e.state.background;
			guideOverride = e.state.guideLevel;
			keyShift = e.state.keyShift;
		}
		/*
		 * PROCESS LIFECYCLE — a pure decision with NO state of its own. Writing the catalog from here minted fresh
		 * Media identities and invented a `stemStatus` the server never sent, which is how a process for one song
		 * reached the playhead of another. The READY flip is server-driven, and process PROGRESS has no consumer.
		 */
		if (e.type === 'media:status') {
			// A FAILED process, or a job no connected worker can run, will never become playable — and
			// enterWaiting() sets no timer, so the party would stare at "Making the karaoke" forever. Leave WAITING
			// the way the dead-media path does: say so on screen, tell the server the entry ended, drop the hold.
			const stuck = processIsTerminal(e);
			if (stuck && tvState === 'waiting' && current && current.mediaId === e.mediaId) {
				const who = singerName(current.singerId);
				skipNotice = `Couldn't make the karaoke for ${who}'s song — skipping`;
				setTimeout(() => (skipNotice = ''), 4000);
				onVisibleEnded();
			}
		}
		// Learn singers who join AFTER the initial sync, or the lower-third shows "Someone" for late joiners.
		if (e.type === 'singer:joined') singers = new Map(singers).set(e.singer.id, e.singer);
		// A rename must reach the TV, or the roster chip and the lower-third hold the old name until the next
		// full sync — on a quiet room, not until someone touches the queue.
		if (e.type === 'singer:updated') singers = new Map(singers).set(e.singer.id, e.singer);
		if (e.type === 'singer:left') {
			online = online.filter((id) => id !== e.singerId);
			away = away.filter((id) => id !== e.singerId);
		}
	}

	onMount(() => {
		ws = new WsClient({
			// ONE TV PER ROOM: this socket opens with `role=tv` and carries the resolved room code, so the TV is
			// IN-ROOM for that party rather than an unscoped spectator. See docs/FRONTEND.md#the-tv-socket.
			url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=tv${data.roomCode ? `&room=${encodeURIComponent(data.roomCode)}` : ''}`,
			// The TV holds NO queue rev of its own — it never handles queue:patch and adopts server truth
			// wholesale from each queue:sync — so the hello handshake always sends lastRev 0.
			getLastRev: () => 0,
			onConnectionChange: (c) => (connected = c),
			onEvent: handleEvent
		});
		// Playback continues through a socket drop; WsClient only re-establishes the control channel.
		ws.open();
		return () => ws?.close();
	});

	/*
	 * MEASURE the reserved bottom chrome band instead of predicting it: a static sum of the card's type tokens
	 * assumes a fixed row set and UNDER-counts, so the sung line can still be covered and any new row
	 * re-breaks it. The app.css value is the pre-measurement fallback.
	 */
	let lowerThirdEl = $state<HTMLElement | undefined>();
	let measuredCardPx = $state<number | null>(null);
	$effect(() => {
		const el = lowerThirdEl;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver((entries) => {
			for (const e of entries) {
				// borderBoxSize is the full rendered box, which is what the reel must clear; offsetHeight is the
				// fallback where the array form is unsupported.
				const box = e.borderBoxSize?.[0]?.blockSize;
				measuredCardPx = typeof box === 'number' ? box : el.offsetHeight;
			}
		});
		ro.observe(el);
		return () => ro.disconnect();
	});
	// Null before the first measure -> undefined style -> app.css's static fallback stands.
	const chromeBandStyle = $derived(
		measuredCardPx === null ? undefined : `--tv-chrome-h: calc(var(--tv-safe-y) + ${Math.ceil(measuredCardPx)}px)`
	);

	/*
	 * Same for the top-right "Up next" block, which shares a z-tier and the right edge with `.fs-btn`: the
	 * button must sit below the whole block, which GROWS when the next title wraps, so a guessed height fails.
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
	// Both measured bands, each falling back to its app.css default until measured.
	const tvStyle = $derived(
		[chromeBandStyle, measuredUpnextPx === null ? undefined : `--tv-upnext-h: ${Math.ceil(measuredUpnextPx)}px`]
			.filter(Boolean)
			.join('; ') || undefined
	);

	// Which surface the TV shows.
	const screen = $derived(
		tvScreen({ playerState: tvState, current, entries, inRoomCount: online.length + away.length })
	);

	/*
	 * Queued entries that cannot be sung yet, which drives the lobby's wording. `isPlayable`, not
	 * `readyToSing`: this asks the same question the PLAYER asks, so the lobby cannot claim something is
	 * processing that the player would happily start.
	 */
	const pendingCount = $derived(
		entries.filter((e) => {
			const m = mediaOf(e);
			return !m || !isPlayable(m);
		}).length
	);
	const isAttract = $derived(screen === 'attract' || screen === 'lobby');
	// The lobby shows the WHOLE roster with no "+N more": the reason to show it is that it must not degrade
	// as the party grows. Infinity caps nothing; TvLobby steps the chip size down above a threshold instead.
	const roster = $derived(lobbyRoster(online, away, singers, Infinity));

	/*
	 * KEEP THE TV AWAKE while a song is on stage, or the OS screensaver blanks the room mid-song. Gated on
	 * `!isAttract`, the same flag the player slots use, because a processing or between-tracks song is still on
	 * stage. `navigator.wakeLock` is SECURE-CONTEXT ONLY, and the platform DROPS the lock whenever the document
	 * hides and never restores it. See docs/FRONTEND.md#wake-lock-and-reload-resume.
	 */
	$effect(() => {
		// Read reactively, so the effect releases and re-takes as the room enters or leaves an on-stage screen.
		const playing = !isAttract;
		if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
		if (!playing) return;

		let sentinel: WakeLockSentinel | null = null;
		// `sentinel` is null for the whole in-flight window, so without this flag a `visibilitychange` arriving
		// mid-flight issues a SECOND request and leaks the first held lock past the song's end.
		let acquiring = false;
		let released = false;

		const acquire = () => {
			// A pending, in-flight or held lock needs no second request; a released sentinel is spent.
			if (acquiring || (sentinel && !sentinel.released)) return;
			acquiring = true;
			navigator
				.wakeLock!.request('screen')
				.then((s) => {
					if (released) {
						// Torn down while the request was in flight — do not leak it.
						s.release().catch(() => {});
						return;
					}
					sentinel = s;
				})
				// A rejected request (policy, low battery) must not throw; the screen falls back to default sleep.
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
	 * FULL SCREEN. `requestFullscreen()` needs TRANSIENT USER ACTIVATION in the TV's own document — a realtime
	 * message from a phone carries none — so every path is anchored to a real gesture ON the TV: the `f` key,
	 * the corner button, or the autoplay-recovery tap as a free rider.
	 */
	function toggleFullscreen() {
		if (typeof document === 'undefined' || !document.documentElement?.requestFullscreen) return;
		// Guarded on `document.fullscreenElement` so the one affordance toggles. Both promises can reject (a
		// policy denial, no activation) — swallow rather than throw out of a key/click handler.
		if (document.fullscreenElement) {
			document.exitFullscreen?.().catch(() => {});
		} else {
			document.documentElement.requestFullscreen().catch(() => {});
		}
	}

	/*
	 * The corner button self-hides after a few seconds of no input, so it is not permanent chrome on a wall.
	 * Starts TRUE so the affordance is discoverable when the stage first appears, then fades.
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
			// A real keypress carries the activation `requestFullscreen()` needs. Ignored while typing into a
			// field (defensive; /tv renders none), and modifier-free only, so browser shortcuts are untouched.
			const t = e.target as HTMLElement | null;
			const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
			if (!typing && (e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
				toggleFullscreen();
			}
			wake();
		};
		// `capture` + `passive` so the reveal sees the gesture even if something downstream stops propagation,
		// and we never preventDefault.
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
	 * The stage background's visibility band is `!isAttract`, the same flag that gates the player slots, and
	 * NOT `screen === 'playing'`: a literal playing check drops the background during the interstitial (a
	 * black flash between every song) and on `waiting`, where a song IS on stage.
	 */
	const currentSingerColor = $derived(current ? (singers.get(current.singerId)?.color ?? null) : null);
	/*
	 * What the room is HEARING, plus the shift. `soundingKeyLabel` returns null with no trustworthy key, so a
	 * song without one shows nothing rather than a guess. ASCII `+`/`-` and a Latin-1 middot, because a
	 * typographic accidental or arrow trips `icons.test.ts`'s codepoint guard.
	 */
	const keyLine = $derived.by(() => {
		const label = soundingKeyLabel(mediaOf(current)?.songProfile, keyShift);
		if (!label) return null;
		return keyShift === 0 ? label : `${label} · ${keyShift > 0 ? '+' : ''}${keyShift}`;
	});
	/*
	 * The override wins when set; `null` defers to the room.
	 */
	const resolvedBackground = $derived(backgroundOverride ?? tvBackgroundStyle);
	const stageBg = $derived(
		stageBackgroundCss(resolvedBackground, tvBackgroundColor, currentSingerColor, tvBackgroundDim)
	);
	// The overlay is live only while a song is actually on screen.
	const lyricsActive = $derived(screen === 'playing' && tvState !== 'interstitial');
	// ADVANCE needs BOTH dimensions: the room INTENDS to play AND the master element is actually running.
	// `isPlaying` alone stays true through a phone pause, an autoplay refusal and an unplayable entry — the
	// room silent while the reel sweeps on wall-clock. VISIBILITY still rides `lyricsActive`.
	const lyricsPlaying = $derived(lyricsAdvancing(screen, tvState, isPlaying, masterAdvancing));
	// Canonical title/artist when a confident parse produced them, NEVER the uploader. Artist is null when
	// there is nothing trustworthy, and the markup omits the line rather than inventing one.
	const nowPlayingDisplay = $derived(songDisplay(mediaOf(current)));
	// Which candidate the current lyricsRef came from. Null for a pre-candidate artifact — unknown
	// provenance, asserted as neither verified nor not.
	const lyricsProvenance = $derived.by(() => {
		const m = mediaOf(current);
		return m ? chosenCandidate(m) : null;
	});
	/*
	 * The reel tints an unverified line amber; this drives the short label naming why. Unknown provenance is
	 * NOT unverified — text that cannot be traced is not asserted either way.
	 */
	const lyricsUnverified = $derived(isAutoTranscribed(lyricsProvenance));
	/*
	 * GATED ON THERE BEING WORDS: `chosenCandidate` is independent of whether an artifact is on disk, so without
	 * the gate the card prints "Auto-transcribed" over a completely empty stage. A ref that exists but fails to
	 * FETCH still labels; the overlay owns that outcome.
	 */
	const lyricsSourceLabel = $derived(mediaOf(current)?.lyricsRef ? provenanceLabel(lyricsProvenance) : null);
	/*
	 * Declared below `lyricsProvenance` because it DEPENDS on it: reading `settings` alone answered the
	 * granularity of ONE song from a fleet-wide setting, so a line-only song under the default word-level
	 * `syncMode` got the word treatment and no marker. `?.timing` rather than the candidate object, because that
	 * field IS the per-song granularity.
	 */
	const lyricsStyle = $derived(resolveLyricsPresentation(settings, lyricsProvenance?.timing));
	/*
	 * The join address as a person reads it off a wall: no scheme, no query, no bare trailing slash. The QR
	 * still encodes the full room-scoped URL and the attract panel prints the code as its own largest element.
	 */
	const attractJoinUrl = $derived(joinAddressLabel(data.joinUrl));
	/*
	 * `data.joinOrigin` comes from the request host, so opening /tv ON the serving machine puts a loopback
	 * address on the wall and every scan fails silently. An operator notice replaces the working-looking QR.
	 */
	const joinUnreachable = $derived(isUnreachableJoinOrigin(data.joinOrigin));

	/*
	 * Which ONE transient treatment is on screen. As independent `{#if}` blocks at one z-index with `inset: 0`
	 * and NON-EXCLUSIVE conditions, two full-screen panels paint over each other. Precedence: error, waiting,
	 * next, then loading as the FALLBACK for a missed preload, where `screen` derives `playing` over a
	 * not-yet-loaded element.
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
	 * THE ATTRACT PHRASE: a shuffled bag reseeded per room, advanced every 8s, no repeat until the set has
	 * shown. Seeded from the room code so a room's rotation is deterministic.
	 *
	 * REDUCED MOTION stops it TWO independent ways, either sufficient: the clock never starts and the
	 * crossfade is a CSS animation gated on `no-preference`. Never a Svelte transition directive.
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

		// Called on mount and on every OS preference change, so a mid-session toggle stops or starts the
		// cycle without a reload.
		const apply = () => {
			clearInterval(timer);
			timer = undefined;
			if (prefersReducedMotion) {
				// Hold ONE phrase for the session: no clock, no crossfade.
				attractPhrase = reducedMotionPhrase(phraseSeed);
				return;
			}
			// The crossfade replays via the `{#key attractPhrase}` remount, animated only under no-preference.
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
		The stage background, beneath both player slots. First child so document order matches paint order.
	-->
	<div class="stage-bg" class:shown={!isAttract} style="background: {stageBg}">
		<!--
			INSIDE the stage layer, not a sibling, so the visualizer inherits the ONE visibility gate and the one
			crossfade already proven for backgrounds. `stageBg` is its black floor, so an unpainted first frame is
			black rather than transparent.
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
		onpitchblocked={() => (pitchBlocked = true)}
		onpitchrouted={() => (pitchBlocked = false)}
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
		onpitchblocked={() => (pitchBlocked = true)}
		onpitchrouted={() => (pitchBlocked = false)}
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
			NOBODY HAS JOINED. A fixed `Karaoke` label above a rotating phrase, so the label always tells a stranger
			what they are looking at and the rotation never shifts the column. The join sentence is BROKEN across the
			type ladder, because one long sentence at ten feet is the failure mode.
		-->
		<div class="attract">
			<div class="brand"><Icon name="mic" /> <span class="grad">Encore</span></div>
			<div class="asplit-l">
				<div class="phrase-kick">Karaoke</div>
				<!--
					FIXED height, so a one-line and a two-line phrase do not move the column. The crossfade is a CSS
					animation gated on no-preference, replayed by the `{#key}` remount; under reduce the cycle never ticks
					AND the animation is media-gated off. Never a Svelte transition directive.
				-->
				<div class="phrase-box">
					{#key attractPhrase}
						<div class="phrase-line">{attractPhrase}</div>
					{/key}
				</div>
			</div>
			<div class="asplit-r">
				<!--
					The QR renders in EVERY state, reachable or not; `JoinBadge` appends a one-line notice instead.
					Replacing the whole panel dropped the typed path with it, so the one screen that could still be joined
					by hand offered neither the address nor the code.
				-->
				<!-- QR first: scanning types nothing, so it is the fast path and owns the top of the panel. -->
				<JoinBadge
					qrDataUrl={data.qrDataUrl}
					joinUrl={data.joinUrl}
					placement="hero"
					size="var(--tv-attract-qr)"
					unreachable={joinUnreachable}
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
			roomCode={data.roomCode}
		/>
	{:else}
		<!--
			WHO IS SINGING — bottom-left, plain TEXT rather than a card: a filled panel over the room's chosen
			background amputates the feature they picked. `--tv-chrome-h` is MEASURED from this element, so the class
			name and the ResizeObserver binding stay.
		-->
		<div class="lower-third" bind:this={lowerThirdEl}>
			<span class="ls-name"
				><span class="ls-dot" style="--singer: {currentSingerColor ?? 'var(--accent2)'}"></span>{singerName(
					current?.singerId
				)}</span
			>
			<!--
				Artist only when a confident parse produced one — never the uploader. The separator carries its own NBSP,
				because Svelte collapses the leading space next to a tag boundary.
			-->
			<span class="ls-song"
				>{nowPlayingDisplay.title}{#if nowPlayingDisplay.artist}<span class="ls-artist"
						>{'\u00a0· '}{nowPlayingDisplay.artist}</span
					>{/if}</span
			>
			<!-- The sounding key + how far it is transposed, when the process found a trustworthy one. -->
			{#if keyLine}
				<span class="ls-key">{keyLine}</span>
			{/if}
			<!--
				WHERE THESE WORDS CAME FROM. The reel's amber tint carries the meaning; this line only names why the
				words look different. In flow inside this block it cannot overlap anything.
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
			WHOSE TURN IS NEXT — top-right and PERMANENT: the song-intro card is gone in seconds, so someone waiting
			their turn had nothing to look at all song. Offset in vh, so the clearance holds at any resolution.
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
		<JoinBadge
			qrDataUrl={data.qrDataUrl}
			joinUrl={data.joinUrl}
			placement="corner"
			unreachable={joinUnreachable}
			roomCode={data.roomCode}
		/>
	{/if}

	<!--
		Transient states, ONE at a time. Each keeps its own mark, colour family and eyebrow, so a viewer can tell
		a failure from a normal song change at a glance.
	-->
	{#if transient === 'next' && introEntry}
		{@const m = mediaOf(introEntry)}
		{@const d = songDisplay(m)}
		<!-- Next up — accent family. The SINGER is the hero: the one thing the room needs to know is who to
		     look at, so the song is secondary. -->
		<div class="interstitial takeover state-next">
			<!-- "Now singing" for the opener; "Next up" once the night is under way. "Next up" for the very first
			     song of the evening is untrue — there is no previous song it follows. -->
			<div class="up-label">{openedOnce && introEntry.id !== current?.id ? 'Next up' : 'Now singing'}</div>
			<div class="up-name hero-name">{singerName(introEntry.singerId)}</div>
			<!-- Artist inline, and ONLY when a confident parse produced one — never the uploader. -->
			<div class="up-song">
				{d.title}{#if d.artist}<span class="up-artist-inline">{'\u00a0· '}{d.artist}</span>{/if}
			</div>
		</div>
	{:else if transient === 'error'}
		<!-- Skipping — danger family. Names what is GOING and what REPLACES it in the same breath, so the room
		     is never left wondering whose turn it now is. --danger exists precisely so this cannot be read as
		     an affirmative event. -->
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
		<!-- Still processing — warn family. A WAIT, not a failure: a bounded 3-step progress makes it read as
		     finite, in words from process-phrasing (the ONE guest-facing vocabulary, shared with the phone).
		     THE TV KNOWS ONLY A COARSE "processing" STATE, because per-media tracking was deliberately stripped
		     from it, so it feeds the total mapping a representative mid-process step rather than inventing the
		     tracking it was purpose-built not to hold. -->
		{@const processMedia = mediaOf(current)}
		{@const proc = processStep('separating')}
		<div class="interstitial takeover state-waiting">
			<div class="state-mark"><Icon name="flame" /></div>
			<div class="up-label">{processStageLabel('queued')}</div>
			<div class="up-song hero-song">{songDisplay(processMedia).title}</div>
			<!-- Every step label is a fixed guest word, not a worker stage, and exactly one step is current for
			     every status. -->
			<div class="process-bar"><i style="width: {proc.fraction}"></i></div>
			<div class="process-steps">
				{#each PROCESS_STEPS as label, i (label)}
					<span class:step-current={i === proc.index} class:step-done={i < proc.index}>{label}</span>
				{/each}
			</div>
		</div>
	{:else if transient === 'loading'}
		<!--
			The MISSED-PRELOAD path: `onEnded` could not swap and set `loading` with `current` still set, so `screen`
			derives `playing` over a not-yet-loaded element. Held until the visible player reports ready, in the
			affirmative treatment because a song IS coming.
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
		THE JOIN BLOCK SURVIVES EVERY TAKEOVER, dimmed, in the same slot as during playback: a song change is
		exactly when a new guest looks up. The identical corner component, so the slot does not move.
	-->
	{#if transient}
		<div class="takeover-join">
			<JoinBadge
				qrDataUrl={data.qrDataUrl}
				joinUrl={data.joinUrl}
				placement="corner"
				unreachable={joinUnreachable}
				roomCode={data.roomCode}
			/>
		</div>
	{/if}

	AUTOPLAY BLOCKED. Full-screen at the top of the stack so a tap anywhere lands on it, though recovery does not depend
	on hitting it — TvPlayer arms a document-wide listener. ALSO GATED ON `!isAttract`: the latch's only writers are
	per-slot props, so when the room DRAINS both players unmount and neither can fire again, and the scrim would sit over
	an empty lobby for good above the join QR. Gating the RENDER rather than clearing the latch is deliberate — the block
	is still real.
	{#if autoplayBlocked && !isAttract}
		<button
			type="button"
			class="autoplay-hint"
			onclick={() => {
				// FREE RIDER: this tap is a real gesture in the TV's own document, so it carries the activation
				// `requestFullscreen()` needs. Best-effort, and it never blocks the music recovery, which TvPlayer's
				// own gesture listener performs. The hotkey and the corner button are the real path.
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

	A TRANSPOSE IS WAITING FOR ONE TAP. A BUTTON, because the tap IS the remedy: it authorises WebAudio for the document
	and TvPlayer's always-armed listener re-drives the pending shift on the same gesture. Not the full-stage treatment —
	the music is playing fine, so this says what is stuck without covering it.
	{#if pitchBlocked && !autoplayBlocked && !isAttract}
		<button
			type="button"
			class="pitch-hint"
			onclick={() => {
				// The click IS the activation. Clearing optimistically is safe: if the retry does not route, the
				// next pitch effect pass raises it again.
				pitchBlocked = false;
			}}
			aria-label="Tap to let this TV change the key"
		>
			<span class="ph-head">Tap to <span class="grad">change the key</span></span>
			<span class="ph-sub">This TV needs one tap before ± can shift the song</span>
		</button>
	{/if}

	<!--
		PLAYBACK FAILED — an error a tap CANNOT lift, so this is NOT a button: a plain on-screen say that the
		room is silent, the only operator-visible trace of a failure whose sole prior signal was a console warn.
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

	FULLSCREEN corner button, self-hiding so it is not permanent chrome on a wall, pinned TOP-right BELOW Up-next because
	it shares that z-tier with the lower-third, the join QR and Up-next. The mark is an INLINE SVG, not a codepoint:
	`icons.test.ts` bans a functional control whose drawing the platform picks, and there is no fullscreen mark in
	icons.ts to reuse.
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
	 * THE TV TYPE FLOOR — THE ONE DECLARATION. Every --tv-* tier in app.css is a `rem` multiple of THIS root, so
	 * it MUST live on `:root`: a font-size on `.tv` would not re-root its descendants. `:global(:root)` inside
	 * THIS component rather than app.css, because a Svelte stylesheet is injected only while the component is
	 * mounted — so the floor applies to the /tv document ALONE, where a global `:root` would re-root the phone's
	 * --ph-* ladder to ~19px and regress SC 1.4.4.
	 *
	 * `max(2.7vh, 20px)`: the vh term scales with the panel, the 20px term is the windowed legibility floor.
	 * --ui-scale is TYPED, so a non-numeric write falls back to 1 instead of poisoning the clamp() and dropping
	 * the whole font-size declaration, which would silently remove the floor.
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
	 * STAGE Z-INDEX SCHEME: one monotonic scale, anchored on the reel (6), which the sibling LyricsOverlay owns.
	 * Two unrelated layers sharing a tier leaves paint order to DOM order, so a reorder can silently push a
	 * transient behind the chrome. The table is in docs/FRONTEND.md#the-stage-and-its-stacking-order.
	 *
	 * The type and safe-area tokens live in app.css, so the same components size correctly in the /components
	 * gallery. Safe area matters because a fixed 40-48px offset sits inside the overscan region many sets apply.
	 */
	.tv {
		position: fixed;
		inset: 0;
		/* Pure black floor UNDER the stage — a contrast-critical letterbox, not a themeable surface. */
		background: #000;
		overflow: hidden;
	}
	/*
	 * The same opacity curve the player slots use, so the lobby-to-stage handover matches the crossfade
	 * already in the gapless swap instead of hard-cutting.
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
	 * THE ATTRACT SPLIT PANEL. Two columns, not a centred stack, so the phrase can be a large left-aligned
	 * statement and the join block a self-contained panel a guest scans or transcribes from.
	 */
	.attract {
		position: absolute;
		inset: 0;
		z-index: var(--z-tv-screen);
		background: radial-gradient(80% 60% at 30% 30%, var(--stage-glow) 0%, var(--bg) 70%);
	}
	/* The wordmark, pinned top-left at the safe-area inset. Its offset from the edge is what proves the
	   stage chrome clears the overscan region — the e2e stageBrand anchor reads this. */
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
	/* Left column: fixed label above the rotating phrase, vertically centred at the title-safe inset. */
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
	/* `Karaoke` never rotates: it is the only thing telling a stranger what they are looking at. */
	.phrase-kick {
		font-size: var(--tv-name);
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--accent-ink);
	}
	/*
	 * FIXED height for exactly --tv-phrase-lines lines, so a one-line and a two-line phrase never move the
	 * label above or the panel beside it. Height = phrase font-size * line-height * lines, so the 1.03
	 * line-height here is what the box height is computed from and the two must agree.
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
	 * THE CROSSFADE — opacity only, and a CSS animation gated on no-preference, replaying because
	 * `{#key attractPhrase}` remounts `.phrase-line` each tick. NEVER a Svelte transition directive:
	 * motion.test.ts bans those because the transition runtime never consults the media query. Under
	 * `reduce` this block does not apply AND the JS clock never starts, so the phrase is simply held.
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
	 * Right column: the flat-filled join panel. QR, then the typed path broken across the ladder, with the
	 * ROOM CODE as the largest element because it is the thing being transcribed.
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
		/* right/top/bottom are real screen edges, so content is inset from them with the overscan token. The
		   left edge is the INTERIOR 2px border, NOT a screen edge, so it takes a plain gutter — charging
		   --tv-safe-x on both sides stole ~192px of a 600px panel and clipped the join address. */
		padding: var(--tv-safe-y) var(--tv-safe-x) var(--tv-safe-y) var(--space-4xl);
		text-align: center;
		overflow: hidden;
	}
	.join-text {
		display: flex;
		flex-direction: column;
		align-items: center;
		width: 100%;
		min-width: 0;
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
		 * An address is ONE unbreakable token, so SHRINKING beats breaking: it never wraps (no overflow-wrap; the
		 * ratified-states guard pins the size AND the absence of an escape hatch). What makes it FIT is the PANEL
		 * WIDTH — --tv-attract-right is sized from a measured 23-char address plus the overscan padding.
		 */
		font-size: var(--tv-name);
		font-weight: 800;
		font-variant-numeric: tabular-nums;
		line-height: var(--lh-tight);
	}
	/* THE LARGEST ELEMENT ON THE ATTRACT SCREEN: the room code is what a guest types. */
	.jt-code {
		font-size: var(--tv-code);
		font-weight: 900;
		letter-spacing: 0.11em;
		/* Tracking adds its space after the LAST glyph too, and this is centred as a shrink-to-fit flex item,
		   so the box is half a letter-space wider than the glyphs. One letter-space of left padding re-centres
		   them. */
		padding-left: 0.11em;
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
		/* CAPPED, or a long title or singer name grows rightward into the join QR at bottom-right. 46vw leaves
		   the QR its corner on every aspect ratio. */
		position: absolute;
		left: var(--tv-safe-x);
		bottom: var(--tv-safe-y);
		z-index: var(--z-tv-card);
		display: flex;
		flex-direction: column;
		max-width: 46vw;
		gap: var(--space-3xs);
		/*
		 * NO CARD — see the markup note. Legibility comes from BOTH a blurred text-shadow AND a text-stroke. The
		 * STROKE is load-bearing: a shadow tuned against black disappears against a bright field of similar
		 * luminance (the singer name measured 1.10:1 on white), and `paint-order: stroke fill` draws the dark
		 * outline BEHIND the glyph. Width in `em`, so it reads the same at 720p and 4K.
		 */
		text-shadow: 0 2px 14px rgba(0, 0, 0, 0.9);
		-webkit-text-stroke: 0.04em var(--scrim-strong);
		paint-order: stroke fill;
	}
	/* The singer's own colour as a DOT rather than a fill: their identity everywhere else in the app,
	   carried at a size that cannot compete with the words. */
	.ls-dot {
		display: inline-block;
		width: 0.52em;
		height: 0.52em;
		border-radius: 50%;
		margin-right: 0.42em;
		vertical-align: baseline;
		/* --singer, not an inline background: the colour must stay composable (a glow, a border, a gradient
		   stop), and singer-color.test.ts enforces the custom-property form. */
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
	 * Clamp the title to two lines, or an UNPARSED long raw title grows the block upward without bound.
	 * -webkit-line-clamp is the only cross-browser two-line clamp and needs the -webkit box display and
	 * hidden overflow to take effect.
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
	 * Secondary to the title, so dimmer. As an INLINE span nested in .ls-song it must NOT carry
	 * overflow/text-overflow/white-space of its own: the first two are inert on a non-replaced inline element
	 * while `white-space: nowrap` DOES apply and turns a long joined credit into one unbreakable run that is
	 * hard-clipped mid-word. Truncation belongs to .ls-song's 2-line clamp.
	 */
	.ls-artist {
		font-size: var(--tv-body);
		color: var(--ink-dim);
		font-weight: 500;
	}
	/* Metadata, not a heading: dimmed like the eyebrow so it sits under the title quietly. */
	.ls-key {
		font-size: var(--tv-label);
		color: var(--ink-dim);
		font-weight: 600;
		letter-spacing: 0.04em;
		opacity: 0.82;
		margin-top: var(--space-3xs);
	}
	/*
	 * The provenance label. Neutral dim by default, because it is a SOURCE tag and not a warning — a
	 * trustworthy source must not read as one. Not uppercase and not letter-spaced: the tracked-out version
	 * of this string is precisely what read as debris.
	 */
	.ls-source {
		font-size: var(--tv-label);
		color: var(--ink-dim);
		font-weight: 700;
	}
	/*
	 * A machine's guess joins the caution family, matching the reel's amber tint. Still provenance-only —
	 * the colour is the same honesty signal, never a confidence score.
	 */
	.ls-source.ls-asr {
		color: var(--warn);
	}

	/*
	 * UP NEXT — top-right, dim and small: it answers "am I soon?" for the one person who needs it and must
	 * not compete with the words for anyone else. Offset below the connection dot with a vh term, so the
	 * clearance scales with the panel instead of being correct only at 1080p.
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
		 * A SCRIM, not a wash: an opaque wash blanks the room's chosen backdrop for every song change — the
		 * black-flash the background layer is gated to avoid, undone one layer up. Dark where the words go, clear at
		 * the edges, so the state reads as something happening ON the stage rather than a different screen.
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
	/* Inline artist suffix on a takeover song line, riding the title rather than owning a row. */
	.up-artist-inline {
		color: var(--ink-dim);
	}
	/* Large enough to be the first thing read, since it is what distinguishes these states. */
	.state-mark {
		font-size: var(--tv-hero);
		line-height: var(--lh-none);
		margin-bottom: var(--space-2xs);
	}

	/*
	 * FULL-SCREEN TAKEOVERS: one colour family each, drawn as a LEFT BORDER plus a same-direction gradient,
	 * left-aligned from the title-safe x. Colour is NEVER the only carrier — each also keeps its own eyebrow,
	 * and error/processing their own mark.
	 */
	.takeover {
		align-items: flex-start;
		justify-content: center;
		text-align: left;
		padding-left: var(--tv-safe-x);
		border-left: var(--tv-takeover-border) solid transparent;
	}
	/* Next up — accent family, with the singer name as the hero. --accent is used as a NON-TEXT
	   border/fill, which is what it is certified for; the text here is --ink / --accent2, never --accent. */
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
	 * Skipping — danger family, with a distinct eyebrow too, so colour is not the only carrier. The border,
	 * gradient and mark make a skip unmistakable without a near-opaque wash, which would hide the join block
	 * that must stay visible through it.
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
	/* What replaces the skipped song, so the room never wonders whose turn it now is. */
	.up-replaces {
		font-size: var(--tv-name);
		color: var(--ink-dim);
		margin-top: 1.4vh;
	}

	/* Still processing — warn family. Title is the hero; a bounded 3-step bar says the wait is finite. */
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
	.process-bar {
		width: var(--tv-process-bar-w);
		height: var(--tv-process-bar-h);
		border-radius: var(--radius-pill);
		background: var(--track-bg);
		margin-top: 3vh;
		overflow: hidden;
	}
	.process-bar i {
		display: block;
		height: 100%;
		background: var(--warn);
	}
	.process-steps {
		display: flex;
		gap: var(--space-4xl);
		margin-top: 2vh;
		font-size: var(--tv-small);
		color: var(--ink-dim);
	}
	.process-steps .step-current {
		color: var(--warn);
		font-weight: 700;
	}
	.process-steps .step-done {
		color: var(--ink);
	}
	/*
	 * THE JOIN BLOCK SURVIVES EVERY TAKEOVER, dimmed. Wraps the IDENTICAL corner JoinBadge the playing state
	 * uses, so the bottom-right slot does not move and only the opacity changes. The composited --ink-dim run
	 * inside it still clears 3:1 at the --tv-small size. Sits above the takeover so it is never painted over.
	 */
	.takeover-join {
		position: absolute;
		inset: 0;
		z-index: var(--z-tv-status);
		opacity: 0.72;
		pointer-events: none;
	}

	/*
	 * Connection telemetry, pulled INSIDE the safe area: a TV may clip a corner, and at 12px anyone who did
	 * see it read it as a stuck pixel.
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
	.status.on {
		background: var(--ok);
		box-shadow: 0 0 0 5px color-mix(in srgb, var(--ok) 18%, transparent);
	}

	/*
	 * On the persistent-chrome tier: above the reel and the slots so it stays tappable during a song, below the
	 * transient overlays so those cover it. `pointer-events` drops with the fade, so a hidden button cannot eat
	 * a tap meant for the stage. The clamp's floor is `var(--tap)`, named rather than restated.
	 */
	.fs-btn {
		position: absolute;
		right: var(--tv-safe-x);
		/* TOP-right, BELOW the whole "Up next" block: `.upnext` shares this right edge AND this z-tier, and
		   `.fs-btn` is later in the DOM, so anchoring level with it painted over the Up-next readout. The offset
		   uses `.upnext`'s MEASURED height, because its title wraps and a fixed offset fails when it grows. */
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
	 * The autoplay affordance. A full-screen button so a tap ANYWHERE authorises playback, sitting above
	 * every other layer. A <button>, not a <div>: it is keyboard-focusable, it announces itself, and a keydown
	 * is one of the gestures TvPlayer listens for.
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

	/*
	 * THE KEY-IS-STUCK PILL. Not `inset: 0` like the affordance above, and that is the design difference: that
	 * one exists because the room is SILENT, so covering the stage costs nothing. Here the song plays and only
	 * the transpose is stuck. TOP-CENTRE is the one free strip. Sized off the TV type ladder rather than a
	 * viewport term, because the `.tv` root is already vh-scaled.
	 */
	.pitch-hint {
		position: absolute;
		top: var(--tv-safe-y);
		left: 50%;
		transform: translateX(-50%);
		z-index: var(--z-tv-interstitial);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.3em;
		min-height: 44px;
		max-width: 60vw;
		padding: 0.7em 1.4em;
		border: 0;
		border-radius: 999px;
		cursor: pointer;
		color: var(--ink);
		text-align: center;
		background: color-mix(in srgb, var(--bg) 88%, transparent);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
	}
	.ph-head {
		font-size: var(--tv-body);
		font-weight: 650;
		line-height: var(--lh-snug, 1.2);
	}
	.ph-sub {
		font-size: var(--tv-small);
		color: var(--ink-dim);
	}
	.ah-mark {
		display: grid;
		place-items: center;
		width: clamp(64px, 12vmin, 160px);
		height: clamp(64px, 12vmin, 160px);
		border-radius: 50%;
		background: color-mix(in srgb, var(--accent) 26%, transparent);
		/* Sized off the ROOT ladder, so it tracks the floor down on a short panel and stays inside the
		   vmin-scaled circle. */
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
	 * The silent-room panel: a transient full-screen overlay on the interstitial tier reporting an
	 * unrecoverable playback failure. NOT interactive — informational, so no button and no cursor.
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
		/* Sized off the ROOT ladder, so it tracks the floor down on a short panel and stays inside the
		   vmin-scaled circle. */
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
