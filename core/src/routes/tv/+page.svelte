<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { invalidateAll } from '$app/navigation';
	import type { ServerEvent, QueueEntry, Media, PublicSinger } from '$lib/contract';
	import { chosenCandidate, isPlayable, effectiveSongIntroMs, songDisplay } from '$lib/contract';
	import { keyShiftLabel } from '$lib/song-facts';
	import { GaplessController, type Slot } from '$lib/tv/gapless';
	import { telemetryFrame } from '$lib/tv/telemetry';
	import TvPlayer from '$lib/tv/TvPlayer.svelte';
	import LyricsOverlay from '$lib/tv/LyricsOverlay.svelte';
	import TvProgress from '$lib/tv/TvProgress.svelte';
	import Reactions from '$lib/tv/Reactions.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import {
		effectiveGuideLevel,
		hueOfColor,
		resolveLyricsPresentation,
		loudnessNormalizationGain,
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
		lobbyOverdue,
		statusOverdue,
		isUnreachableJoinOrigin,
		lyricsAdvancing,
		processStep,
		PROCESS_STEPS
	} from '$lib/tv/screen';
	import { joinAddressLabel } from '$lib/tv/join-address';
	import { keepScreenAwake } from '$lib/tv/wake-lock';
	import { processStageLabel } from '$lib/phrasing/process-phrasing';
	import { NOW_SINGING, UP_NEXT } from '$lib/phrasing/turn-phrasing';
	import {
		mergeCatalog,
		syncLoudnessLevels,
		snapshot,
		processIsTerminal,
		type PlaybackSnapshot
	} from '$lib/tv/catalog';
	import { makePhraseBag, reducedMotionPhrase, seedFromString, ATTRACT_PHRASES } from '$lib/tv/phrases';

	let { data } = $props();

	let entries = $state<QueueEntry[]>([]);
	let singers = $state<Map<string, PublicSinger>>(new Map());
	let mediaCatalog = $state<Map<string, Media>>(new Map());
	let connected = $state(false);
	// ONE TV PER ROOM: whether this screen holds the room's seat (`tv:seat`). A copy sends no telemetry, so it can
	// neither end the song nor move the playhead. False until the server says, which it does on connect.
	let seatMine = $state(false);
	// Singer ids with a live socket right now — NOT `singers`, which is every singer who ever joined.
	let online = $state<string[]>([]);
	// In the room but unreachable (a locked phone). Greyed, never erased: a dropped socket is not a departure.
	let away = $state<string[]>([]);
	/* ONE object, so a new setting needs no local, no effect line and no handler assignment. A WRITABLE `$derived`,
	   which is what the `$state` + `untrack` + re-adopting `$effect` this replaces was emulating: the socket still
	   assigns it below (`settings = e.settings`) and a load re-run still re-adopts `data`. Two things the effect form
	   got wrong — it landed one microtask LATE, so the stage rendered a frame against the previous settings, and
	   `$state` deep-proxied the whole settings object where `$derived` returns it as-is. */
	let settings = $derived(data.settings);
	const songIntroMs = $derived(effectiveSongIntroMs(settings.room));

	let current = $state<QueueEntry | null>(null);
	let upNext = $state<QueueEntry | null>(null);
	const ctl = new GaplessController();
	let tvState = $state(ctl.state);
	let visible = $state<Slot>('A');
	let positionSec = $state(0);
	let durationSec = $state(0);
	let skipNotice = $state('');
	// Autoplay was REFUSED and the room is silent until a gesture a TV wall never produces. Active+visible only.
	let autoplayBlocked = $state(false);
	// A transpose is waiting for one tap. Distinct from `autoplayBlocked`: here the music plays perfectly and
	// only the key is stuck, and it is the only way anyone learns of it — the graph degrades silently.
	let pitchBlocked = $state(false);
	// An error NO gesture can lift (decode failure, AbortError), so the page must SAY the room is silent.
	let playbackFailedReason: string | null = $state(null);
	/** The ENTRY that failed, so a `nowplaying` landing after the slot already swapped does not clear its own failure. */
	let playbackFailedFor: string | null = null;
	function onPlaybackFailed(reason: string, entryId: string | null): void {
		playbackFailedReason = reason;
		playbackFailedFor = entryId;
	}
	// The honest counterpart to `isPlaying`, which is the ROOM'S INTENT from the server: the room can intend
	// to play while the element does not, and the reel must freeze in exactly those cases.
	let masterAdvancing = $state(false);
	const tvProgressStyle = $derived(settings.room.tvProgressStyle);
	const tvBackgroundStyle = $derived(settings.room.tvBackgroundStyle);
	const tvBackgroundColor = $derived(settings.room.tvBackgroundColor);
	// The room's 0..1 stage dimmer — a LIGHTNESS control on the resolved colour, not a layer over video.
	const tvBackgroundDim = $derived(settings.room.tvBackgroundDim);
	// The visualizers build their palette by hue ARITHMETIC, so they need an ANGLE while the stored value is a
	// hex. `hueOfColor` is scale-free, so a dark stage colour keeps its hue instead of snapping to a wheel stop.
	const tvBackgroundHue = $derived(hueOfColor(tvBackgroundColor));
	const tvVisualizer = $derived(settings.room.tvVisualizer);
	let isPlaying = $state(true);
	let seekSec = $state(0);
	// Bumped by every playback command but NEVER by position telemetry, so the seek effect can track it to re-take its
	// decision on a restart whose position equals the last one.
	let seekRev = $state(0);
	// Per-song background override from playback:state. null = use the room default (the resting state).
	let backgroundOverride = $state<TvBackgroundStyle | null>(null);
	// Read raw, a null guide override is indistinguishable from "explicitly off" — the distinction that lets a room
	// default survive a song change.
	let guideOverride = $state<number | null>(null);
	const guideLevel = $derived(effectiveGuideLevel({ guideLevel: guideOverride }, settings.room.guideLevelDefault));
	// Transpose in semitones, HONOURED by shifting pitch in the browser — no pre-rendered variant to 404 on.
	let keyShift = $state(0);
	// THE SNAPSHOT SEAM. A live `Media` is not assignable here, so the only way a song reaches a player slot is
	// through `snapshot()` in `syncSlots()` — on an explicit playback transition and at no other time.
	let slotMedia = $state<{ A: PlaybackSnapshot | null; B: PlaybackSnapshot | null }>({
		A: null,
		B: null
	});
	// A song queued twice snapshots to byte-identical media, so only the ENTRY id tells the second turn from the first,
	// and the player re-arms its transport on it.
	let slotEntryId = $state<{ A: string | null; B: string | null }>({ A: null, B: null });

	// At PLAYBACK, not in the worker: a song's pulldown depends on the live library median, a property of the room's
	// whole catalog at play time. The server sends those levels on every sync (`loudnessLevelsOf`), because the sync's
	// media is only the queued songs.
	let libraryLoudnessLevels = $state<number[]>([]);
	// ATTENUATE-ONLY: never above 1, so the feature off / below the floor / unmeasured all resolve to unity.
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

	// The TV runs unattended for hours, so WsClient's watchdog for a socket that stops answering without firing `close`
	// matters most here.
	let ws: WsClient | undefined;
	let interstitialTimer: ReturnType<typeof setTimeout> | undefined;
	let skipNoticeTimer: ReturnType<typeof setTimeout> | undefined;

	function mediaOf(entry: QueueEntry | null): Media | null {
		return entry ? (mediaCatalog.get(entry.mediaId) ?? null) : null;
	}
	function singerName(id: string | undefined): string {
		return id ? (singers.get(id)?.displayName ?? 'Someone') : 'Someone';
	}

	/** The visible slot carries `current` and the hidden one pre-warms `upNext`, so ONE mapping serves both rows. */
	function bySlot<T>(visibleSlot: Slot, onVisible: T, onHidden: T): { A: T; B: T } {
		return visibleSlot === 'A' ? { A: onVisible, B: onHidden } : { A: onHidden, B: onVisible };
	}

	function syncSlots() {
		const visibleSlot = ctl.assignment().visible;
		visible = visibleSlot;
		tvState = ctl.state;
		// SNAPSHOT HERE, and only here: `syncSlots` runs on explicit lifecycle transitions alone.
		slotMedia = bySlot(visibleSlot, snapshot(mediaOf(current)), snapshot(mediaOf(upNext)));
		// The entry id travels with its snapshot into the SAME slot, so the per-entry transport re-arm sees a distinct id.
		slotEntryId = bySlot(visibleSlot, current?.id ?? null, upNext?.id ?? null);
	}

	function applyNowPlaying(cur: QueueEntry | null, next: QueueEntry | null) {
		// Compared BEFORE `current` is overwritten, and on the ENTRY id: a song queued twice is two entries over one media.
		const entryChanged = cur?.id !== current?.id;
		current = cur;
		upNext = next;
		// Re-anchor on the ENTRY CHANGE ONLY: the server calls `emitNowPlaying` at the tail of EVERY player
		// command, so without the guard the guide slider's ~8 commands/second re-pin the reel to the opening
		// line for the whole drag. Until the new element's first `timeupdate` the reel extrapolates from the
		// previous song's anchor.
		if (entryChanged) {
			positionSec = 0;
			durationSec = 0;
		}
		// Defensive (the server skips these via nextPlayable): a current with no instrumental shows WAITING, not black.
		const m = mediaOf(cur);
		if (cur && m && !isPlayable(m)) {
			ctl.enterWaiting();
			tvState = ctl.state;
			return;
		}
		ctl.onNowPlaying(cur, next);
		// ONE HANDOFF, however the last song ended. A natural end already raised the card in `onVisibleEnded`; a skip
		// or a removal arrives only here, and used to drop the next singer straight into their song with no card (UI-02).
		// It names `cur`, the entry ACTUALLY starting, never `upNext`. Not before the evening's first song, which
		// `onFirstSongReady` opens once it can play.
		// `alreadyIntroduced` only protects the hold TIMER: after a natural end the card is already up for this entry,
		// and re-entering would restart the hold and keep the card up one round trip longer. The card is right either way.
		const alreadyIntroduced = tvState === 'interstitial' && introEntry?.id === cur?.id;
		if (entryChanged && cur && openedOnce && songIntroMs > 0 && !alreadyIntroduced) {
			introEntry = cur;
			ctl.enterInterstitial();
			holdSongIntro();
		}
		syncSlots();
	}

	/**
	 * DROPPED SILENTLY when the socket is not open (`quiet`) — right for a ~4Hz stream whose next frame is 250ms
	 * away. What is NOT acceptable is THROWING out of `ontimeupdate`, which left the server never learning the
	 * playhead. Every frame carries the entry stamp the server's stale-frame guard needs.
	 */
	function sendTelemetry(status: string, positionSec = 0) {
		if (!seatMine) return;
		ws?.send(telemetryFrame(status, current, positionSec), { quiet: true });
	}

	/** A FLASH, not a state: the takeover clears itself, so nothing has to remember to retract it. */
	const SKIP_NOTICE_MS = 4000;
	function flashSkipNotice(message: string) {
		skipNotice = message;
		// ONE handle, cleared on every flash: the dwell belongs to the TEXT, not to the first notice. Otherwise a
		// second skip inherits the first's deadline — with the 2500ms intro hold between two dead files the second
		// notice got the ~1500ms left of SKIP_NOTICE_MS (and near-zero when a worker fails a batch, where the
		// terminal statuses land together), blanking mid-read and taking the whole takeover with it.
		clearTimeout(skipNoticeTimer);
		skipNoticeTimer = setTimeout(() => (skipNotice = ''), SKIP_NOTICE_MS);
	}

	function onVisibleError() {
		// Dead media is treated like ended so the room advances rather than hanging on black. Say so on screen:
		// several bad files in a row would otherwise just flash black across the room.
		flashSkipNotice('That song won’t play');
		// `onVisibleEnded()` sends the single `ended` frame; a second advances the server twice and eats a turn.
		onVisibleEnded();
	}

	/**
	 * Captured at each entry into the interstitial rather than derived from `upNext`: `nowplaying:changed` can
	 * land mid-intro and advance both, so deriving it names the song AFTER next.
	 */
	let introEntry = $state<QueueEntry | null>(null);
	/** The session has shown at least one song, so the next intro is a transition rather than an opener. */
	let openedOnce = $state(false);

	function onVisibleEnded() {
		// The failure belonged to the song that just ended.
		playbackFailedReason = null;
		const next = ctl.onEnded(upNext);
		tvState = next;
		sendTelemetry('ended');
		if (next === 'interstitial') {
			introEntry = upNext;
			holdSongIntro();
		}
		syncSlots();
	}

	/** The opening song gets an intro too: `onEnded` reaches the interstitial only via a gapless swap. */
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

	// Mounted only on the stage branch, so between songs this is undefined and a late reaction is simply dropped.
	let reactions = $state<Reactions | undefined>();

	function handleEvent(e: ServerEvent) {
		if (e.type === 'room:reacted') reactions?.add(e);
		if (e.type === 'tv:seat') seatMine = e.mine;
		if (e.type === 'queue:sync') {
			entries = e.entries;
			if (e.singers) singers = new Map(e.singers.map((s) => [s.id, s]));
			// The ONLY writer of `mediaCatalog`, and it takes a FULL server list, so no partial local edit is expressible.
			// That list is the QUEUED songs only. A song queued after this sync arrives with the NEXT one: the gap
			// resync one add's two patches trigger, or the 15 s heartbeat (see `mergeCatalog`).
			if (e.media) mediaCatalog = mergeCatalog(mediaCatalog, e.media);
			libraryLoudnessLevels = syncLoudnessLevels(libraryLoudnessLevels, e);
			// An OMITTED `online` means "no info", not "nobody here", and must not blank a roster we hold.
			if (e.online) online = e.online;
			if (e.away) away = e.away;
		}
		if (e.type === 'singer:presence') {
			online = e.online;
			away = e.away;
		}
		if (e.type === 'settings:changed') {
			settings = e.settings;
			// The join address is the ONE setting the TV cannot apply in place, because the QR is a server-rendered
			// image. An empty setting means "fall back", so compare RESOLVED to RESOLVED and re-run the load only
			// when the address actually moved.
			const nextOrigin = e.settings.global.joinOrigin || data.joinFallbackOrigin;
			if (nextOrigin !== data.joinOrigin) invalidateAll();
		}
		if (e.type === 'nowplaying:changed') applyNowPlaying(e.current, e.upNext);
		if (e.type === 'playback:state') {
			isPlaying = e.state.isPlaying;
			seekSec = e.state.positionSec;
			seekRev = e.rev;
			backgroundOverride = e.state.background;
			guideOverride = e.state.guideLevel;
			keyShift = e.state.keyShift;
		}
		// A pure decision with NO state of its own: writing the catalog from here is how a process for one song reached the
		// playhead of another. The READY flip is server-driven.
		if (e.type === 'media:status') {
			// A terminal process never becomes playable and `enterWaiting()` sets no timer, so the party would stare at
			// "Making the karaoke" forever.
			const stuck = processIsTerminal(e);
			if (stuck && tvState === 'waiting' && current && current.mediaId === e.mediaId) {
				const who = singerName(current.singerId);
				flashSkipNotice(`Couldn't make the karaoke for ${who}'s song — skipping`);
				onVisibleEnded();
			}
		}
		if (e.type === 'media:status') noteOverdue(e.mediaId, statusOverdue(e));
		// ONE upsert for both: a JOIN after the initial sync would otherwise leave the lower-third saying "Someone" for a
		// late joiner, and a RENAME would leave the roster chip and lower-third on the old name until the next full sync.
		if (e.type === 'singer:joined' || e.type === 'singer:updated') {
			// Copy-then-assign, not a `SvelteMap`: the `.set` lands on a Map nothing has read yet and the assignment is
			// what publishes it, so there is no missed update for a reactive Map to catch. Both writers of `singers` —
			// here and the `queue:sync` branch above — replace it wholesale, so a `SvelteMap` would only add a second
			// dependency layer under a `$state` that is already re-read on every reassignment.
			// eslint-disable-next-line svelte/prefer-svelte-reactivity
			singers = new Map(singers).set(e.singer.id, e.singer);
		}
		if (e.type === 'singer:left') {
			online = online.filter((id) => id !== e.singerId);
			away = away.filter((id) => id !== e.singerId);
		}
	}

	onMount(() => {
		ws = new WsClient({
			// ONE TV PER ROOM: `role=tv` plus the resolved room code. See docs/FRONTEND.md#the-tv-socket.
			url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=tv${data.roomCode ? `&room=${encodeURIComponent(data.roomCode)}` : ''}`,
			// The TV holds NO queue rev of its own — it never handles queue:patch and adopts each queue:sync wholesale.
			getLastRev: () => 0,
			onConnectionChange: (c) => (connected = c),
			onEvent: handleEvent
		});
		// Playback continues through a socket drop; WsClient only re-establishes the control channel.
		ws.open();
		return () => ws?.close();
	});

	/**
	 * ONE observer shape for both measured bands. `borderBoxSize` is the full rendered box the reel must clear;
	 * `offsetHeight` is the fallback where that form is unsupported. Returns the `$effect` cleanup, or `undefined`
	 * when there is nothing to observe — the caller's effect tracks the binding by passing it in.
	 */
	function observeBlockSize(el: HTMLElement | undefined, set: (px: number) => void): (() => void) | undefined {
		if (!el || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver((entries) => {
			for (const e of entries) {
				const box = e.borderBoxSize?.[0]?.blockSize;
				set(typeof box === 'number' ? box : el.offsetHeight);
			}
		});
		ro.observe(el);
		return () => ro.disconnect();
	}

	// MEASURED, not predicted: this card grows with its content, so a static sum UNDER-counts and covers the sung line.
	// The phone's dock is the same finding on the other surface — see the `--dock-h` note in src/routes/+layout.svelte,
	// where a token-arithmetic height was tried and came to 102px against a rendered 91.
	let lowerThirdEl = $state<HTMLElement | undefined>();
	let measuredCardPx = $state<number | null>(null);
	$effect(() => observeBlockSize(lowerThirdEl, (px) => (measuredCardPx = px)));
	// Null before the first measure -> undefined style -> app.css's static fallback stands.
	const chromeBandStyle = $derived(
		measuredCardPx === null ? undefined : `--tv-chrome-h: calc(var(--tv-safe-y) + ${Math.ceil(measuredCardPx)}px)`
	);

	// Same for "Up next": `.fs-btn` shares its z-tier and right edge and must clear the whole block, which GROWS when
	// the next title wraps.
	let upnextEl = $state<HTMLElement | undefined>();
	let measuredUpnextPx = $state<number | null>(null);
	$effect(() => observeBlockSize(upnextEl, (px) => (measuredUpnextPx = px)));
	const tvStyle = $derived(
		[
			chromeBandStyle,
			measuredUpnextPx === null ? undefined : `--tv-upnext-h: ${Math.ceil(measuredUpnextPx)}px`,
			// The lyrics give the reaction lane its width (plus a gap) on each side, only while the lane can show.
			settings.room.tvReactions ? '--tv-reaction-reserve: calc(var(--tv-reaction-w) + var(--tv-space-lg))' : undefined
		]
			.filter(Boolean)
			.join('; ') || undefined
	);

	const screen = $derived(
		tvScreen({ playerState: tvState, current, entries, inRoomCount: online.length + away.length })
	);

	// `isPlayable`, not `readyToSing`: the same question the PLAYER asks, so the lobby cannot call something processing
	// that the player would happily start.
	const pending = $derived(
		entries.filter((e) => {
			const m = mediaOf(e);
			return !m || !isPlayable(m);
		})
	);
	const pendingCount = $derived(pending.length);
	// Songs still being made and past their estimate (`statusOverdue`), so the lobby says what the singer's phone
	// says rather than "this takes a minute". Only `pending` songs count: a ready one is overdue no longer. A
	// `SvelteSet`: one id flips at a time, in place.
	const overdueMedia = new SvelteSet<string>();
	const overdue = $derived(lobbyOverdue(pending, overdueMedia));
	function noteOverdue(mediaId: string, isOverdue: boolean): void {
		if (isOverdue) overdueMedia.add(mediaId);
		else overdueMedia.delete(mediaId);
	}
	const isAttract = $derived(screen === 'attract' || screen === 'lobby');
	// A failure belongs to ONE song, so a drained room or a new current song drops it, unlike the autoplay block, which
	// is the TV's: kept, it sat over the next singer's song (or its waiting card, which never reports ready).
	// Keyed on the ID, a primitive: `current` is a fresh object on every sync, which would clear a live failure.
	// `playbackFailedFor` is plain (not `$state`), so setting a failure does not re-run this and clear it at once.
	const currentId = $derived(current?.id ?? null);
	$effect(() => {
		if (isAttract || currentId !== playbackFailedFor) playbackFailedReason = null;
	});
	// The WHOLE roster, no "+N more": Infinity caps nothing, and TvLobby steps the chip size down instead.
	const roster = $derived(lobbyRoster(online, away, singers, Infinity));

	// KEEP THE TV AWAKE for exactly the on-stage screens, or the OS screensaver blanks the room mid-song. `isAttract` is
	// read reactively, so the lock is released and re-taken as the room enters and leaves the stage.
	$effect(() => {
		if (isAttract) return;
		return keepScreenAwake();
	});

	/*
	 * `requestFullscreen()` needs TRANSIENT USER ACTIVATION in the TV's own document — a realtime message from a
	 * phone carries none — so every path is anchored to a real gesture ON the TV: the `f` key, the corner
	 * button, or the autoplay-recovery tap as a free rider.
	 */
	function toggleFullscreen() {
		if (typeof document === 'undefined' || !document.documentElement?.requestFullscreen) return;
		// Both promises can reject (a policy denial, no activation) — swallow rather than throw out of a handler.
		if (document.fullscreenElement) {
			document.exitFullscreen?.().catch(() => {});
		} else {
			document.documentElement.requestFullscreen().catch(() => {});
		}
	}

	// Starts TRUE so the corner button is discoverable when the stage first appears, then fades: a wall must not carry
	// permanent chrome.
	let controlsVisible = $state(true);
	const CONTROLS_IDLE_MS = 4000;
	$effect(() => {
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
			// A real keypress carries the activation `requestFullscreen()` needs. Modifier-free, so browser shortcuts stand.
			const t = e.target as HTMLElement | null;
			const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
			if (!typing && (e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
				toggleFullscreen();
			}
			wake();
		};
		// `capture` so the reveal sees the gesture even if something downstream stops propagation; never preventDefault.
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

	const currentSingerColor = $derived(current ? (singers.get(current.singerId)?.color ?? null) : null);
	/** `Key -2` while shifted, nothing at 0. Never the key's NAME: see `keyShiftLabel`. */
	const keyLine = $derived(keyShiftLabel(keyShift));
	// The override wins when set; `null` defers to the room.
	const resolvedBackground = $derived(backgroundOverride ?? tvBackgroundStyle);
	const stageBg = $derived(
		stageBackgroundCss(resolvedBackground, tvBackgroundColor, currentSingerColor, tvBackgroundDim)
	);
	// The overlay is live only while a song is actually on screen.
	const lyricsActive = $derived(screen === 'playing' && tvState !== 'interstitial');
	// ADVANCE needs BOTH dimensions: the room INTENDS to play AND the master element is actually running.
	// `isPlaying` alone stays true through a phone pause and an autoplay refusal — the room silent while the reel
	// sweeps on wall-clock. VISIBILITY still rides `lyricsActive`.
	const lyricsPlaying = $derived(lyricsAdvancing(screen, tvState, isPlaying, masterAdvancing));
	// Canonical title/artist when a confident parse produced them, NEVER the uploader. Artist is null when
	// there is nothing trustworthy, and the markup omits the line rather than inventing one.
	const nowPlayingDisplay = $derived(songDisplay(mediaOf(current)));
	// Null for a pre-candidate artifact — unknown provenance, asserted as neither verified nor not.
	const lyricsProvenance = $derived.by(() => {
		const m = mediaOf(current);
		return m ? chosenCandidate(m) : null;
	});
	// Declared below `lyricsProvenance` because it DEPENDS on it: `settings` alone answers the granularity of ONE
	// song from a fleet-wide value, and `?.timing` IS the per-song granularity.
	const lyricsStyle = $derived(resolveLyricsPresentation(settings, lyricsProvenance?.timing));
	const attractJoinUrl = $derived(joinAddressLabel(data.joinUrl));
	// `data.joinOrigin` comes from the request host, so opening /tv ON the serving machine puts a loopback
	// address on the wall and every scan fails silently. Attract and the lobby say so to the host; the stage never does.
	const joinUnreachable = $derived(isUnreachableJoinOrigin(data.joinOrigin));

	// ONE derived value, because as independent `{#if}` blocks at one z-index with `inset: 0` and non-exclusive
	// conditions two full-screen panels paint over each other. `loading` is the FALLBACK for a missed preload,
	// where `screen` derives `playing` over a not-yet-loaded element.
	const transient = $derived.by(() => {
		if (skipNotice) return 'error';
		if (tvState === 'waiting') return 'waiting';
		if (tvState === 'interstitial' && introEntry) return 'next';
		if (tvState === 'loading' && current) return 'loading';
		return null;
	});
	// Seeded from the room code, so a room's phrase rotation is deterministic.
	// See docs/FRONTEND.md#the-attract-and-lobby-idles.
	const phraseSeed = $derived(seedFromString(data.roomCode || 'encore-attract'));
	// SSR-safe: matchMedia does not exist during load. Defaults to full motion; corrected on mount.
	let prefersReducedMotion = $state(false);
	let attractPhrase = $state<string>(ATTRACT_PHRASES[0]);

	onMount(() => {
		const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
		prefersReducedMotion = mq?.matches ?? false;

		let timer: ReturnType<typeof setInterval> | undefined;

		// Re-applied on every OS preference change, so a mid-session toggle needs no reload.
		const apply = () => {
			clearInterval(timer);
			timer = undefined;
			if (prefersReducedMotion) {
				// Hold ONE phrase for the session: no clock, no crossfade.
				attractPhrase = reducedMotionPhrase(phraseSeed);
				return;
			}
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
	<!-- The stage background, beneath both player slots. First child so document order matches paint order. -->
	<div class={['stage-bg', { shown: !isAttract }]} style="background: {stageBg}">
		<!--
			INSIDE the stage layer, not a sibling, so the visualizer inherits the ONE visibility gate and the one
			crossfade already proven for backgrounds. `stageBg` is its black floor, so an unpainted first frame is
			black rather than transparent.
		-->
		{#if resolvedBackground === 'visualizer'}
			<VisualizerStage variant={tvVisualizer} hue={tvBackgroundHue} playing={!isAttract} />
		{/if}
	</div>
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
			// `slotEntryId`, NOT `slotMedia.id`. GaplessController compares this against `#warmingId`, which it
			// sets from `upNext.id` — an ENTRY id — and its own field comment says so. `snapshot(m)` returns
			// `{...m}`, so `slotMedia.A.id` is the MEDIA id and never matched: `#readyId` stayed unset,
			// `isNextReady()` was permanently false, and every song change took the cold-load branch and threw
			// away the slot it had just pre-warmed. Measured cost: ~740ms of dead air at each boundary.
			ctl.onHiddenReady(slotEntryId.A ?? '');
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
		onplaybackfailed={(reason) => onPlaybackFailed(reason, slotEntryId[visible])}
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
			// See slot A: an ENTRY id, because that is what `#warmingId` holds.
			ctl.onHiddenReady(slotEntryId.B ?? '');
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
		onplaybackfailed={(reason) => onPlaybackFailed(reason, slotEntryId[visible])}
	/>

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
		<!-- NOBODY HAS JOINED. See docs/FRONTEND.md#the-attract-and-lobby-idles. -->
		<div class="attract">
			<div class="brand"><Icon name="mic" /> <span class="grad-text">Encore</span></div>
			<div class="asplit-l">
				<!-- `Karaoke` never rotates: it is what tells a stranger what they are looking at. -->
				<div class="phrase-kick">Karaoke</div>
				<div class="phrase-box">
					{#key attractPhrase}
						<div class="phrase-line">{attractPhrase}</div>
					{/key}
				</div>
			</div>
			<div class="asplit-r">
				<!-- QR first: scanning types nothing, so it is the fast path and owns the top of the panel. -->
				<JoinBadge
					qrDataUrl={data.qrDataUrl}
					joinUrl={data.joinUrl}
					placement="hero"
					size="var(--tv-attract-qr)"
					unreachable={joinUnreachable}
				/>
				<!-- The typed path, BROKEN across the type ladder: one long sentence at ten feet is the failure mode. -->
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
			overdue={overdue}
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
			<!-- The separator carries its own NBSP: Svelte collapses the leading space next to a tag boundary. -->
			<span class="ls-song"
				>{nowPlayingDisplay.title}{#if nowPlayingDisplay.artist}<span class="ls-artist"
						>{'\u00a0· '}{nowPlayingDisplay.artist}</span
					>{/if}</span
			>
			<!-- No key NAME and no lyric SOURCE: the room cannot act on either. The singer reads both on the phone, and
				the reel's amber tint alone says the words are a guess. -->
			{#if keyLine}
				<span class="ls-key">{keyLine}</span>
			{/if}
			{#if tvProgressStyle === 'card'}
				<TvProgress style="card" elapsedSec={positionSec} durationSec={durationSec} />
			{/if}
		</div>
		{#if tvProgressStyle !== 'card'}
			<TvProgress style={tvProgressStyle} elapsedSec={positionSec} durationSec={durationSec} />
		{/if}
		<!-- PERMANENT, because the song-intro card is gone in seconds and someone waiting their turn needs it. -->
		{#if upNext && upNext.id !== current?.id}
			{@const nextMedia = mediaOf(upNext)}
			<div class="upnext" bind:this={upnextEl}>
				<span class="un-label">{UP_NEXT}</span>
				<span class="un-name"
					><span class="un-dot" style="--singer: {singers.get(upNext.singerId)?.color ?? 'var(--ink-dim)'}"
					></span>{singerName(upNext.singerId)}</span
				>
				<span class="un-song">{songDisplay(nextMedia).title}</span>
			</div>
		{/if}
		{#if settings.room.tvReactions}
			<Reactions bind:this={reactions} />
		{/if}
		<!-- The join QR stays reachable mid-song, bottom-right (the only free corner) -->
		<JoinBadge qrDataUrl={data.qrDataUrl} joinUrl={data.joinUrl} placement="corner" roomCode={data.roomCode} />
	{/if}

	<!-- Transient states, ONE at a time. See docs/FRONTEND.md#the-full-screen-takeovers. -->
	{#if transient === 'next' && introEntry}
		{@const m = mediaOf(introEntry)}
		{@const d = songDisplay(m)}
		<div class="interstitial takeover state-next">
			<!-- "Up next" only in the beat before the server confirms the swap; the entry that IS current is "Now singing". -->
			<div class="up-label">{introEntry.id !== current?.id ? UP_NEXT : NOW_SINGING}</div>
			<div class="up-name hero-name">{singerName(introEntry.singerId)}</div>
			<div class="up-song">
				{d.title}{#if d.artist}<span class="up-artist-inline">{'\u00a0· '}{d.artist}</span>{/if}
			</div>
		</div>
	{:else if transient === 'error'}
		<!-- Names what is GOING and what REPLACES it in one breath, so the room never wonders whose turn it is. -->
		<div class="interstitial takeover state-error" role="alert">
			<div class="state-mark"><Icon name="warning" /></div>
			<div class="up-label">Skipped</div>
			<div class="up-song">{skipNotice}</div>
			{#if upNext && upNext.id !== current?.id}
				<div class="up-replaces">
					{UP_NEXT} — {singerName(upNext.singerId)} · {songDisplay(mediaOf(upNext)).title}
				</div>
			{/if}
		</div>
	{:else if transient === 'waiting'}
		<!-- A WAIT, not a failure: a bounded 3-step progress makes it read as finite, in words from
		     process-phrasing (the ONE guest-facing vocabulary, shared with the phone). THE TV HOLDS ONLY A COARSE
		     "processing" state, so it feeds the total mapping a representative mid-process step rather than
		     inventing the per-media tracking it was purpose-built not to hold. -->
		{@const processMedia = mediaOf(current)}
		{@const proc = processStep('separating')}
		<div class="interstitial takeover state-waiting">
			<div class="state-mark"><Icon name="flame" /></div>
			<div class="up-label">{processStageLabel('queued')}</div>
			<div class="up-song hero-song">{songDisplay(processMedia).title}</div>
			<div class="process-bar"><i style="width: {proc.fraction}"></i></div>
			<div class="process-steps">
				{#each PROCESS_STEPS as label, i (label)}
					<span class={{ 'step-current': i === proc.index, 'step-done': i < proc.index }}>{label}</span>
				{/each}
			</div>
		</div>
	{:else if transient === 'loading'}
		<!--
			The MISSED-PRELOAD path, held until the visible player reports ready — affirmative, a song IS coming. It
			announces `current`, the entry the visible player is loading toward, so it reads the same display the
			lower-third does rather than deriving a second copy of it.
		-->
		<div class="interstitial takeover state-next">
			<div class="up-label">{NOW_SINGING}</div>
			<div class="up-name hero-name">{singerName(current?.singerId)}</div>
			<div class="up-song">
				{nowPlayingDisplay.title}{#if nowPlayingDisplay.artist}<span class="up-artist-inline"
						>{'\u00a0· '}{nowPlayingDisplay.artist}</span
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
			<JoinBadge qrDataUrl={data.qrDataUrl} joinUrl={data.joinUrl} placement="corner" roomCode={data.roomCode} />
		</div>
	{/if}

	<!--
		ALSO GATED ON `!isAttract`: the latch's only writers are per-slot props, so when the room DRAINS both players
		unmount and neither can fire again, leaving the scrim over an empty lobby for good above the join QR. Gating
		the RENDER rather than clearing the latch is deliberate — the block is still real.
	-->
	{#if autoplayBlocked && !isAttract}
		<button
			type="button"
			class="autoplay-hint"
			onclick={() => {
				// FREE RIDER: this tap is a real gesture in the TV's own document, so it carries the activation
				// `requestFullscreen()` needs. Best-effort, and it never blocks the music recovery, which TvPlayer's
				// own gesture listener performs.
				toggleFullscreen();
				autoplayBlocked = false;
			}}
			aria-label="Tap anywhere to start the music"
		>
			<span class="ah-mark"><Icon name="play" /></span>
			<span class="ah-head">Tap anywhere to <span class="grad-text">start the music</span></span>
		</button>
	{/if}

	<!--
		A BUTTON, because the tap IS the remedy: it authorises WebAudio for the document and TvPlayer's always-armed
		listener re-drives the pending shift on the same gesture.
	-->
	{#if pitchBlocked && !autoplayBlocked && !isAttract}
		<button
			type="button"
			class="pitch-hint"
			onclick={() => {
				// The click IS the activation. Clearing optimistically is safe: if the retry does not route, the next
				// pitch effect pass raises it again.
				pitchBlocked = false;
			}}
			aria-label="Tap to let this TV change the key"
		>
			<span class="ph-head">Tap to <span class="grad-text">change the key</span></span>
		</button>
	{/if}

	<!-- An error a tap CANNOT lift, so NOT a button: a plain on-screen say that the room is silent. GATED ON `!isAttract`
		as well as cleared there, so the frame before that effect runs cannot paint it over the join QR. The browser's
		reason is TvPlayer's console line, never the room's to read. -->
	{#if playbackFailedReason && !isAttract}
		<div class="silent-room" role="status" aria-live="polite">
			<span class="sr-mark"><Icon name="warning" /></span>
			<span class="sr-head">This song <span class="grad-text">won’t play</span></span>
		</div>
	{/if}

	<!--
		The mark is an INLINE SVG, not a codepoint: a functional control must not have its drawing picked by the platform,
		and there is no fullscreen mark in icons.ts to reuse.
	-->
	<button
		type="button"
		class={['fs-btn', { shown: controlsVisible }]}
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

	<div class={['status', { on: connected }]}></div>
</div>

<style>
	/*
	 * THE TV TYPE FLOOR — THE ONE DECLARATION, and it must be on `:root`, because every --tv-* tier in app.css is
	 * a `rem` multiple of it and a font-size on `.tv` would not re-root its descendants. `:global(:root)` from
	 * inside THIS component, not app.css: a Svelte stylesheet is injected only while its component is mounted, so
	 * the floor reaches the /tv document alone. See docs/FRONTEND.md#the-tv-type-floor.
	 */
	@property --ui-scale {
		syntax: '<number>';
		inherits: true;
		initial-value: 1;
	}
	:global(:root) {
		--ui-scale: 1;
		/* vh scales with the panel; 20px is the windowed legibility floor. */
		font-size: calc(max(2.7vh, 20px) * clamp(0.8, var(--ui-scale), 1.6));
	}
	/* Z-tiers: docs/FRONTEND.md#the-stage-and-its-stacking-order. Type and safe-area tokens live in app.css, so
	   the same components size correctly in the /components gallery. */
	.tv {
		position: fixed;
		inset: 0;
		/* Pure black floor UNDER the stage — a contrast-critical letterbox, not a themeable surface. */
		background: #000;
		overflow: hidden;
	}
	/* The same opacity curve the player slots use, so the lobby-to-stage handover matches the gapless crossfade. */
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
	.attract {
		position: absolute;
		inset: 0;
		z-index: var(--z-tv-screen);
		background: radial-gradient(80% 60% at 30% 30%, var(--stage-glow) 0%, var(--bg) 70%);
	}
	/* Its offset from the edge is what proves the stage chrome clears the overscan region — the e2e stageBrand
	   anchor reads this. */
	.brand {
		position: absolute;
		top: var(--tv-safe-y);
		left: var(--tv-safe-x);
		font-weight: 800;
		font-size: var(--tv-name);
		display: inline-flex;
		align-items: center;
		gap: var(--tv-space-lg);
	}
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
	.phrase-kick {
		font-size: var(--tv-name);
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--accent-ink);
	}
	/* FIXED height, so a one- and a two-line phrase never move the label above it. The 1.03 here is the same
	   line-height `.phrase-line` sets, and the two MUST agree or the box no longer holds whole lines. */
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
	/* A CUT, THEN A FADE-IN, replayed by the `{#key attractPhrase}` remount: the old line unmounts at once and the
	   new one fades in over 600 ms. Not a crossfade. 600 ms is a deliberate exception to the motion tokens: a slower
	   swap for a screen nobody is acting on. A CSS animation, NEVER a Svelte transition directive, which never
	   consults the media query. Under `reduce` this does not apply AND the clock is off. */
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
		/* Right/top/bottom are real screen edges and take the overscan token; the LEFT edge is the interior 2px
		   border, so it takes a plain gutter. Charging --tv-safe-x on both sides clips the join address. */
		padding: var(--tv-safe-y) var(--tv-safe-x) var(--tv-safe-y) var(--tv-space-4xl);
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
		/* An address is ONE unbreakable token: no overflow-wrap, because SHRINKING beats breaking. What makes it FIT
		   is --tv-attract-right, sized from a measured 23-char address plus the overscan padding. */
		font-size: var(--tv-name);
		font-weight: 800;
		font-variant-numeric: tabular-nums;
		line-height: var(--lh-tight);
	}
	.jt-code {
		font-size: var(--tv-code);
		font-weight: 900;
		letter-spacing: 0.11em;
		/* Tracking adds its space after the LAST glyph too, so a centred shrink-to-fit box is half a letter-space
		   wider than the glyphs. The padding must always equal the letter-spacing above it. */
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
		/* CAPPED at 46vw, or a long title grows rightward into the join QR at bottom-right. */
		position: absolute;
		left: var(--tv-safe-x);
		bottom: var(--tv-safe-y);
		z-index: var(--z-tv-card);
		display: flex;
		flex-direction: column;
		max-width: 46vw;
		gap: var(--tv-space-3xs);
		/* The STROKE is load-bearing, not decoration: a shadow tuned against black disappears against a bright field
		   of similar luminance (the singer name measured 1.10:1 on white). `paint-order: stroke fill` draws the
		   outline BEHIND the glyph; the default eats the thin parts. Width in `em`, so 720p and 4K read the same. */
		text-shadow: 0 2px 14px rgba(0, 0, 0, 0.9);
		-webkit-text-stroke: 0.04em var(--scrim-strong);
		paint-order: stroke fill;
	}
	/* A DOT rather than a fill: the singer's identity at a size that cannot compete with the words. */
	.ls-dot {
		display: inline-block;
		width: 0.52em;
		height: 0.52em;
		border-radius: 50%;
		margin-right: 0.42em;
		vertical-align: baseline;
		/* --singer as a custom property, never interpolated into `background`: color-mix needs the property to derive the
		   halo, and concatenating alpha onto the value only works for 6-digit hex. */
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
	/* Two lines, or an UNPARSED long raw title grows the block upward without bound. `-webkit-line-clamp` needs
	   the -webkit box display and hidden overflow beside it to take effect at all. */
	.ls-song {
		font-size: var(--tv-body);
		font-weight: 600;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
	}
	/* As an INLINE span inside .ls-song it must NOT carry white-space/overflow of its own: the overflow pair is
	   inert on an inline element, while `nowrap` DOES apply and hard-clips a long credit mid-word. */
	.ls-artist {
		font-size: var(--tv-body);
		color: var(--ink-dim);
		font-weight: 500;
	}
	.ls-key {
		font-size: var(--tv-label);
		/* One ink, not --ink-dim plus an 0.82 subtree alpha: the pair composited to a value no contrast check on
		   either half could see. Folded into the colour, where it is readable as the value it actually is. */
		color: color-mix(in srgb, var(--ink-dim) 82%, transparent);
		font-weight: 600;
		letter-spacing: 0.04em;
		margin-top: var(--tv-space-3xs);
	}

	/* Offset below the connection dot with a vh term, so the clearance scales instead of being right only at 1080p. */
	.upnext {
		position: absolute;
		right: var(--tv-safe-x);
		top: calc(var(--tv-safe-y) + 2.6vh);
		z-index: var(--z-tv-card);
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		/* The tightest rung of the TV ladder, not a flat 1px: 1px between three lines whose type is 58px at 4K is
		   not a gap, it is a collision. */
		gap: var(--tv-space-3xs);
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
		gap: var(--tv-space-lg);
		/* A SCRIM, not a wash: an opaque wash blanks the room's chosen backdrop for every song change — the exact
		   black flash the background layer's visibility band exists to avoid, undone one layer up. */
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
	.up-artist-inline {
		color: var(--ink-dim);
	}
	/* Large enough to be the first thing read, since it is what distinguishes these states. */
	.state-mark {
		font-size: var(--tv-hero);
		line-height: var(--lh-none);
		margin-bottom: var(--tv-space-2xs);
	}

	/* Colour is NEVER the only carrier: each takeover also keeps its own eyebrow, and error/processing a mark. */
	.takeover {
		align-items: flex-start;
		justify-content: center;
		text-align: left;
		padding-left: var(--tv-safe-x);
		border-left: var(--tv-takeover-border) solid transparent;
	}
	/* --accent as a NON-TEXT border/fill, which is what it is certified for; the text is --ink / --accent2. */
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
	.up-replaces {
		font-size: var(--tv-name);
		color: var(--ink-dim);
		margin-top: 1.4vh;
	}

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
		gap: var(--tv-space-4xl);
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
	/* Above the takeover, so it is never painted over. The composited --ink-dim run inside it still clears 3:1 at
	   this opacity and the --tv-small size. */
	.takeover-join {
		position: absolute;
		inset: 0;
		z-index: var(--z-tv-status);
		opacity: 0.72;
		pointer-events: none;
	}

	/* Pulled INSIDE the safe area: a TV may clip a corner, and at 12px anyone who saw it read it as a dead pixel.
	   Both terms are load-bearing: the px one IS that measured floor and is what binds BELOW 1080p (at 1080p the rem
	   term resolves to 16.03px, so nothing moves there), and the rem one is what stops a flat 16px dot from reading
	   as the dead pixel again on a 4K stage, where it would be 16px beside a 58px --tv-name. */
	.status {
		position: absolute;
		top: var(--tv-safe-y);
		right: var(--tv-safe-x);
		width: max(16px, 0.55rem);
		height: max(16px, 0.55rem);
		border-radius: 50%;
		background: var(--ink-dim);
		z-index: var(--z-tv-status);
	}
	.status.on {
		background: var(--ok);
		/* Same pair as the dot above, in the same proportion: a frozen 5px halo around a doubled dot is a rim. */
		box-shadow: 0 0 0 max(5px, 0.17rem) color-mix(in srgb, var(--ok) 18%, transparent);
	}

	/* `pointer-events` drops with the fade, so a hidden button cannot eat a tap meant for the stage. The clamp's
	   floor is `var(--tap)`, named rather than restated. */
	.fs-btn {
		position: absolute;
		right: var(--tv-safe-x);
		/* BELOW the whole "Up next" block: `.upnext` shares this right edge AND this z-tier and comes earlier in the
		   DOM, so anchoring level with it paints over the readout. Uses `.upnext`'s MEASURED height, because its
		   title wraps and a fixed offset fails the moment it grows. */
		top: calc(var(--tv-safe-y) + 2.6vh + var(--tv-upnext-h) + var(--tv-space-lg));
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
	/* Full-screen, so a tap ANYWHERE authorises playback. A <button>, not a <div>: it is keyboard-focusable, and a
	   keydown is one of the gestures TvPlayer listens for. */
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

	/* Deliberately NOT `inset: 0` like the affordance above: that one covers the stage because the room is silent,
	   while here the song plays fine and only the transpose is stuck. Sized off the TV type ladder rather than a
	   viewport term, because the `.tv` root is already vh-scaled. */
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
		min-height: var(--tap);
		max-width: 60vw;
		padding: 0.7em 1.4em;
		border: 0;
		border-radius: var(--radius-pill);
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
		line-height: var(--lh-snug);
	}
	.ah-mark {
		display: grid;
		place-items: center;
		/* BOX AND GLYPH ON ONE LADDER. As `clamp(64px, 12vmin, 160px)` the circle stopped growing at 160px while the
		   rem glyph inside it did not: at 4K the 2.881rem glyph is 168px in a 160px circle, so the mark overflowed
		   its own background. 4.4rem is the size that circle already had at 1080p (128px against 129.6px) and at
		   720p (88px against 86.4px), and it holds the 0.65 glyph-to-box ratio at every resolution and --ui-scale. */
		width: 4.4rem;
		height: 4.4rem;
		border-radius: 50%;
		background: color-mix(in srgb, var(--accent) 26%, transparent);
		font-size: 2.881rem;
	}
	.ah-head {
		font-size: var(--tv-hero);
		font-weight: 800;
		line-height: var(--lh-tight);
		text-shadow: 0 2px 12px rgba(0, 0, 0, 0.55);
	}
	/* NOT interactive — informational, so no button and no cursor: no tap can lift this failure. */
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
		/* Same one ladder as .ah-mark, for the same reason: a vmin box capped at 160px is overflowed by its own
		   2.881rem glyph at 4K. */
		width: 4.4rem;
		height: 4.4rem;
		border-radius: 50%;
		background: color-mix(in srgb, var(--warn) 26%, transparent);
		font-size: 2.881rem;
	}
	.sr-head {
		font-size: var(--tv-hero);
		font-weight: 800;
		line-height: var(--lh-tight);
		text-shadow: 0 2px 12px rgba(0, 0, 0, 0.55);
	}
</style>
