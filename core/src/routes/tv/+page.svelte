<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { invalidateAll } from '$app/navigation';
	import type { ServerEvent, QueueEntry, Media, PublicSinger } from '$lib/contract';
	import {
		chosenCandidate,
		isPlayable,
		effectiveSongIntroMs,
		SKIP_NOTICE_MS,
		TV_FULL_CLOSE_CODE,
		TV_REMOVED_CLOSE_CODE
	} from '$lib/contract';
	import { GaplessController, type EndStatus, type Slot } from '$lib/tv/gapless';
	import { telemetryFrame } from '$lib/tv/telemetry';
	import TvPlayer from '$lib/tv/TvPlayer.svelte';
	import LyricsOverlay from '$lib/tv/LyricsOverlay.svelte';
	import Reactions from '$lib/tv/Reactions.svelte';
	import TvAttract from '$lib/tv/TvAttract.svelte';
	import TvNowBar, { observeBlockSize } from '$lib/tv/TvNowBar.svelte';
	import TvTakeover, { type TakeoverKind } from '$lib/tv/TvTakeover.svelte';
	import TvAudioNotice from '$lib/tv/TvAudioNotice.svelte';
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
	import { ClockOffset, clientNow, type TvClock } from '$lib/tv/copy-clock';
	import TvLobby from '$lib/tv/TvLobby.svelte';
	import JoinBadge from '$lib/tv/JoinBadge.svelte';
	import TvCopyChip, { copyLine } from '$lib/tv/TvCopyChip.svelte';
	import {
		tvScreen,
		lobbyRoster,
		lobbyOverdue,
		statusOverdue,
		isUnreachableJoinOrigin,
		lyricsAdvancing
	} from '$lib/tv/screen';
	import { joinAddressLabel } from '$lib/tv/join-address';
	import { keepScreenAwake } from '$lib/tv/wake-lock';
	import { stuckTurnsLines } from '$lib/phrasing/process-phrasing';
	import { NOW_SINGING, UP_NEXT } from '$lib/phrasing/turn-phrasing';
	import { waitingTurns } from '$lib/readiness';
	import {
		mergeCatalog,
		syncLoudnessLevels,
		snapshot,
		processIsTerminal,
		pruneLiveStatus,
		seedLiveStatus,
		type PlaybackSnapshot
	} from '$lib/tv/catalog';
	import { makePhraseBag, reducedMotionPhrase, seedFromString, ATTRACT_PHRASES } from '$lib/tv/phrases';

	let { data } = $props();

	let entries = $state<QueueEntry[]>([]);
	let singers = $state<Map<string, PublicSinger>>(new Map());
	let mediaCatalog = $state<Map<string, Media>>(new Map());
	// The last `media:status` per media — the lobby's ONLY use of it, so it never reaches the catalog or a playhead.
	let liveStatus = $state<Map<string, Extract<ServerEvent, { type: 'media:status' }>>>(new Map());
	// Whether anything connected can make karaoke (`queue:sync`'s `canMake`), so the lobby says so before anyone picks.
	let canMake = $state(true);
	let connected = $state(false);
	// ONE TV PER ROOM: whether this screen holds the room's seat (`tv:seat`); null until the server says, which it does
	// on connect. A COPY (`false`) shows the same stage, muted and sending no telemetry, so it can neither end the song
	// nor move the playhead, and it offers "Make this the TV". Silent while null too, so a copy never blips on load.
	let seatMine = $state<boolean | null>(null);
	const isCopy = $derived(seatMine === false);
	// Whether the seat's screen is live (`tv:seat`'s `tvOnline`), so a copy never points at a TV that is gone.
	let tvOnline = $state(true);
	// A copy's view of the TV's clock: its last `tv:clock`, and its offset to core from `tv:ping`. See copy-clock.ts.
	let tvClock = $state<TvClock | null>(null);
	const clockOffset = new ClockOffset();
	let offsetMs = $state<number | null>(null);
	const follow = $derived(isCopy && tvClock && offsetMs !== null ? { clock: tvClock, offsetMs } : null);
	// The page's ONE live region for the seat, mounted empty with the page, so only its text changes and it is heard.
	let seatAnnounce = $state('');
	const SEAT_ANNOUNCE_MS = 4000;
	let seatAnnounceTimer: ReturnType<typeof setTimeout> | undefined;
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
	// The entry the controller has the visible slot on. A natural end with a missed preload moves it to `upNext` a
	// server round trip BEFORE `current` follows, so it is how the loading card tells its song from the one that ended.
	let stageEntryId = $state<string | null>(null);
	let visible = $state<Slot>('A');
	let positionSec = $state(0);
	let durationSec = $state(0);
	let skipNotice = $state('');
	// Autoplay was REFUSED and the room is silent until a gesture a TV wall never produces. Active+visible only.
	let autoplayBlocked = $state(false);
	// A transpose is waiting for one tap. Distinct from `autoplayBlocked`: here the music plays perfectly and
	// only the key is stuck, and it is the only way anyone learns of it — the graph degrades silently.
	let pitchBlocked = $state(false);
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
	// The `rev` of the server's advance onto a song the TV had already started itself; see the `playback:state` handler.
	let caughtUpRev = -1;
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
	const masterLevel = $derived({ A: resolveMasterLevel(slotMedia.A), B: resolveMasterLevel(slotMedia.B) });
	const SLOTS: Slot[] = ['A', 'B'];

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
		const { visible: visibleSlot, visibleEntryId } = ctl.assignment();
		visible = visibleSlot;
		tvState = ctl.state;
		stageEntryId = visibleEntryId;
		// The controller's view, not the raw pair: right after a natural end `current` is still the song that just ended.
		const { visible: onScreen, hidden: warming } = ctl.slotEntries(current, upNext);
		// SNAPSHOT HERE, and only here: `syncSlots` runs on explicit lifecycle transitions alone.
		slotMedia = bySlot(visibleSlot, snapshot(mediaOf(onScreen)), snapshot(mediaOf(warming)));
		// The entry id travels with its snapshot into the SAME slot, so the per-entry transport re-arm sees a distinct id.
		slotEntryId = bySlot(visibleSlot, onScreen?.id ?? null, warming?.id ?? null);
	}

	function applyNowPlaying(cur: QueueEntry | null, next: QueueEntry | null) {
		// A pair naming the entry the TV already ended predates the server's processing of that `ended` (#1001):
		// applying it reloads the finished song over the next. The end is re-sent so one lost on a closed socket still
		// advances the room; the server drops the duplicate by its entry stamp. Re-sent AS SENT: a lost `failed` re-sent
		// as `ended` would mark the dead turn sung and skip the hold.
		if (cur && ctl.isBehind(cur.id)) {
			sendTelemetry(ctl.endedStatus, cur.id);
			return;
		}
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
		// ONE HANDOFF, ONE CARD: after a natural end the card already went up for this entry, and is still up as the hold or,
		// once the hold is over on a missed preload, as the loading card. A slow round trip lands the confirm in the
		// second, and re-entering there showed a second card with a second hold after a gap of lyrics.
		const alreadyIntroduced = (tvState === 'interstitial' || tvState === 'loading') && introEntry?.id === cur?.id;
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
	 * The stamp is the entry the reporting SLOT holds, not `current`: after a natural end the TV plays `upNext` one
	 * server frame early, so `current` still names the song that ended and the server would drop song 2's frames as
	 * stale — a song 2 that will not play then never advances the room.
	 */
	function sendTelemetry(status: string, entryId: string | null, positionSec = 0) {
		if (seatMine !== true) return;
		ws?.send(telemetryFrame(status, entryId ? { id: entryId } : null, positionSec), { quiet: true });
	}

	/** A FLASH, not a state: the takeover clears itself, so nothing has to remember to retract it. */
	/** Who REPLACES the skipped song, captured with the text: the advance lands mid-notice and moves `upNext` on. */
	let skipNext = $state<QueueEntry | null>(null);
	/** When the notice clears, so the next singer's intro card can follow it rather than run out unseen beneath it. */
	let skipNoticeUntil = 0;
	function flashSkipNotice(message: string, skippedId: string | null = current?.id ?? null) {
		skipNotice = message;
		// Never the skipped song itself: in the missed preload window that is `upNext`, and its replacement isn't known yet.
		skipNext = upNext && upNext.id !== current?.id && upNext.id !== skippedId ? upNext : null;
		skipNoticeUntil = Date.now() + SKIP_NOTICE_MS;
		// ONE handle, cleared on every flash: the dwell belongs to the TEXT, not to the first notice. Otherwise a
		// second skip inherits the first's deadline — with the 2500ms intro hold between two dead files the second
		// notice got the ~1500ms left of SKIP_NOTICE_MS (and near-zero when a worker fails a batch, where the
		// terminal statuses land together), blanking mid-read and taking the whole takeover with it.
		clearTimeout(skipNoticeTimer);
		skipNoticeTimer = setTimeout(() => {
			skipNotice = '';
			// The song a failure held starts NOW, with its card: the server paused it so every screen waits together.
			if (resumeAfterNotice) {
				resumeAfterNotice = false;
				// Stamped with the held song, the one the visible slot now carries; the server drops any other stamp.
				sendTelemetry('resume', ctl.currentId);
			}
		}, SKIP_NOTICE_MS);
	}
	let resumeAfterNotice = false;

	/** The song won't play (TvPlayer's one `onfailed`). The room moves on like an end, and the room is told WHOSE song
	 *  it was — never the browser's reason, and never anyone's fault. `failedId` is the entry the failing SLOT holds:
	 *  in the missed preload window that is `upNext`, while `current` still names the song that ended before it. */
	function onVisibleFailed(failedId: string | null) {
		const failed = [current, upNext].find((e) => e && e.id === failedId) ?? null;
		flashSkipNotice(`${singerName(failed?.singerId)}'s song wouldn't play`, failedId);
		// The server holds the next song paused for the notice. Pause it here too, before the swap starts it: the
		// server's paused frame is a round trip away, and the next singer's song would play under the notice until then.
		// THE TV only: a copy's `failed` and `resume` are dropped, so a copy that paused here would stay paused.
		if (seatMine === true) isPlaying = false;
		// `failed`, not `ended`: the server keeps the turn queued in its spot instead of marking it sung. ONE frame —
		// a second would advance the server twice and eat a turn.
		onVisibleEnded(failedId, 'failed');
		resumeAfterNotice = true;
	}

	/**
	 * Captured at each entry into the interstitial rather than derived from `upNext`: `nowplaying:changed` can
	 * land mid-intro and advance both, so deriving it names the song AFTER next.
	 */
	let introEntry = $state<QueueEntry | null>(null);
	/** The session has shown at least one song, so the next intro is a transition rather than an opener. */
	let openedOnce = $state(false);

	/** `endedId` is the entry the ending slot held; see `sendTelemetry`. */
	function onVisibleEnded(endedId: string | null = current?.id ?? null, status: EndStatus = 'ended') {
		const next = ctl.onEnded(upNext, status);
		tvState = next;
		sendTelemetry(status, endedId);
		if (next === 'interstitial') {
			introEntry = upNext;
			holdSongIntro();
		} else if (next === 'loading' && upNext && upNext.id !== endedId && openedOnce && songIntroMs > 0) {
			// Missed the preload window: the visible slot starts `upNext` now, so its card goes up with its audio rather
			// than a round trip later in `applyNowPlaying`. Not when `upNext` IS what ended: the server's frame is behind.
			introEntry = upNext;
			ctl.enterInterstitial();
			holdSongIntro();
		}
		syncSlots();
	}

	/**
	 * The TV came up into a song the room is already partway through (a reload, a second TV): `hello` sends the
	 * server's playhead before `nowplaying:changed`, and the evening's first song starts at 0. The card is for a change
	 * of singer, and there is none here.
	 */
	const resuming = $derived(!openedOnce && seekSec > 0);

	/** The opening song gets an intro too: `onEnded` reaches the interstitial only via a gapless swap. */
	function onFirstSongReady() {
		if (openedOnce || !current) return;
		// Read before `openedOnce` flips it. Set it on EVERY first ready, the intro off included: left false, `resuming`
		// read any mid-song command's playhead as a reload and held back the loading card all evening.
		const cameUpMidSong = resuming;
		openedOnce = true;
		if (cameUpMidSong || songIntroMs === 0) return;
		introEntry = current;
		ctl.enterInterstitial();
		tvState = ctl.state;
		holdSongIntro();
	}

	/** Hold on the intro card, then let the song start. 0 = the intro is switched off; hard-cut. */
	function holdSongIntro() {
		clearTimeout(interstitialTimer);
		clearTimeout(exitLeadTimer);
		cardLeaving = false;
		cardGone = false;
		exitLeadAt = null;
		if (songIntroMs === 0) {
			ctl.onInterstitialDone(); // pure gapless hard-cut
			tvState = ctl.state;
			return;
		}
		// A skip notice outranks the card, so the hold starts when the notice clears: the card follows it, seen. The lead
		// below is measured from that start too.
		const noticeLeft = skipNotice ? Math.max(0, skipNoticeUntil - Date.now()) : 0;
		// The card's exit fade STARTS ahead of the hold's end, by its own `--motion-base` plus the reel's `--motion-fast`
		// arrival: the card has gone, and the reel is up, by the time the song starts, so the first line is readable
		// when it was when the card cut and nobody loses it. The extra `--motion-fast` is slack too: a lead timer or a
		// `transitionend` a frame late on a busy TV still lands before the song. Only when the hold's end starts the song
		// (over a slot still loading the card stays up), and not under reduced motion, where there is no fade and the
		// card cuts at the hold's end as before.
		// A SHORT hold gets no lead: the card must first finish its `--motion-slow` fade-in and then stay fully readable
		// for READABLE_BEAT_MS, or a 500 ms intro never shows at all. It exits at the hold's end instead, as the cut did.
		const leadMs = prefersReducedMotion ? 0 : cssTimeMs('--motion-base') + cssTimeMs('--motion-fast');
		const roomToLead = songIntroMs - leadMs >= cssTimeMs('--motion-slow') + READABLE_BEAT_MS;
		exitLeadAt = leadMs > 0 && roomToLead ? Date.now() + noticeLeft + songIntroMs - leadMs : null;
		if (exitLeadAt !== null) exitLeadTimer = setTimeout(leadExitIfDue, noticeLeft + songIntroMs - leadMs);
		interstitialTimer = setTimeout(() => {
			exitLeadAt = null;
			ctl.onInterstitialDone();
			tvState = ctl.state;
		}, noticeLeft + songIntroMs);
	}
	/** How long a handoff card stays fully readable, at least, before a led exit. shortcut: a fixed beat, not a token
	 *  (it is a reading time, not a motion); make it a setting if hosts ask for a different one. */
	const READABLE_BEAT_MS = 600;
	let exitLeadTimer: ReturnType<typeof setTimeout> | undefined;
	/** When the current hold's exit lead is due (`Date.now()` ms); null with none. */
	let exitLeadAt: number | null = null;
	/** Start the led exit once it is due AND the hold's end would start the song. Run by the lead timer, and again when
	 *  the visible slot becomes ready: a skip's card goes up over a slot still loading, which is often ready only
	 *  after the lead was due. A fade that starts late just finishes a moment into the song; nothing cuts it.
	 *  Reduced motion is guarded by `layerShown`, which keeps the card up even when it switches on after the lead. */
	function leadExitIfDue() {
		if (exitLeadAt !== null && ctl.introEndsInSong && Date.now() >= exitLeadAt) cardLeaving = true;
	}
	/** The intro card is fading out ahead of its hold's end; see `holdSongIntro`. */
	let cardLeaving = $state(false);
	/** ...and that fade has finished, so the reel may come up for the hold's last moment (it does not advance yet). */
	let cardGone = $state(false);
	/** A `<time>` custom property of :root (`0.25s`, `250ms`) in ms; 0 when it is not set. */
	function cssTimeMs(name: string): number {
		const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
		const n = parseFloat(v);
		return Number.isFinite(n) ? (v.endsWith('ms') ? n : n * 1000) : 0;
	}

	// Mounted only on the stage branch, so between songs this is undefined and a late reaction is simply dropped.
	let reactions = $state<Reactions | undefined>();

	function handleEvent(e: ServerEvent) {
		if (e.type === 'room:reacted') reactions?.add(e);
		if (e.type === 'tv:clock') tvClock = { entryId: e.entryId, positionSec: e.positionSec, serverAt: e.serverAt };
		if (e.type === 'tv:pong') {
			clockOffset.add(e.t0, e.serverAt, clientNow());
			offsetMs = clockOffset.offsetMs;
		}
		if (e.type === 'tv:seat') {
			// Every CHANGE of answer is said, in the page's one live region: "now the TV" when the seat moves here, and
			// the copy's line when this screen becomes a copy (on load too, since the region was mounted empty) or when the
			// TV drops or comes back. Cleared once read, so the next change is announced again, however soon it comes.
			if (e.mine ? seatMine === false : seatMine !== false || e.tvOnline !== tvOnline) {
				seatAnnounce = e.mine ? 'This screen is now the TV' : copyLine(e.tvOnline);
				clearTimeout(seatAnnounceTimer);
				seatAnnounceTimer = setTimeout(() => (seatAnnounce = ''), SEAT_ANNOUNCE_MS);
			}
			seatMine = e.mine;
			tvOnline = e.tvOnline;
			// A claim at a song boundary: this screen's song ended while it was a copy (so it sent nothing), and the old TV
			// heard `mine:false` before its own `ended`. Nobody has told the server, which would sit on the finished song.
			// Say it now; if the old TV's `ended` got there first, the server drops this one by its entry stamp.
			if (e.mine && current && ctl.isBehind(current.id)) sendTelemetry('ended', current.id);
		}
		if (e.type === 'queue:sync') {
			entries = e.entries;
			liveStatus = pruneLiveStatus(liveStatus, e.entries);
			if (e.singers) singers = new Map(e.singers.map((s) => [s.id, s]));
			// The ONLY writer of `mediaCatalog`, and it takes a FULL server list, so no partial local edit is expressible.
			// That list is the QUEUED songs only. A song queued after this sync arrives with the NEXT one: the gap
			// resync one add's two patches trigger, or the 15 s heartbeat (see `mergeCatalog`).
			if (e.media) mediaCatalog = mergeCatalog(mediaCatalog, e.media);
			libraryLoudnessLevels = syncLoudnessLevels(libraryLoudnessLevels, e);
			// An OMITTED `online` means "no info", not "nobody here", and must not blank a roster we hold.
			if (e.online) online = e.online;
			if (e.away) away = e.away;
			if (e.canMake !== undefined) canMake = e.canMake;
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
		// The same stale window: the old song's position would seek the next song to where the finished one ended.
		if (e.type === 'playback:state' && !ctl.isBehind(e.state.currentEntryId)) {
			isPlaying = e.state.isPlaying;
			// The server advancing to the song the TV already started: its 0 is that start, and an exact 0 is a restart
			// that replays one round trip of the song. The fresh target must still land, because it is what clears a held
			// resume off the next song (docs/FRONTEND.md#wake-lock-and-reload-resume). NaN does both: `seekPlan` and
			// `resumeSeekTarget` refuse a non-finite target, so the held resume is cleared and nothing seeks. Keyed on the
			// frame's `rev`: the server can publish the same state twice, after the pair has already ended the catch-up.
			// Any other rev forgets it, so after a server restart (rev starts again at 0) only a collision on the very
			// first frame can reuse it.
			if (e.rev !== caughtUpRev) caughtUpRev = -1;
			if (ctl.isCatchingUp(e.state.currentEntryId)) caughtUpRev = e.rev;
			seekSec = e.rev === caughtUpRev ? Number.NaN : e.state.positionSec;
			seekRev = e.rev;
			backgroundOverride = e.state.background;
			guideOverride = e.state.guideLevel;
			keyShift = e.state.keyShift;
		}
		// NEVER writes the catalog: writing it from here is how a process for one song reached the playhead of another. The
		// READY flip is server-driven. The lobby's `liveStatus` is the one thing recorded, and nothing on stage reads it.
		if (e.type === 'media:status') {
			// Copy-then-assign, as with `singers` below: the assignment is what publishes it.
			// eslint-disable-next-line svelte/prefer-svelte-reactivity
			liveStatus = new Map(liveStatus).set(e.mediaId, e);
			heardSinceReconnect?.add(e.mediaId);
			// A terminal process never becomes playable and `enterWaiting()` sets no timer, so the party would stare at
			// "Making the karaoke" forever.
			const stuck = processIsTerminal(e);
			if (stuck && tvState === 'waiting' && current && current.mediaId === e.mediaId) {
				const who = singerName(current.singerId);
				flashSkipNotice(`Couldn't make the karaoke for ${who}'s song - skipping`);
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

	// What the room was already told before this TV loaded — above all `unservable`, which the server says once.
	// Best effort: without it the lobby is as before, and the next live status corrects it.
	// On a RE-connect the snapshot replaces what was held from before the drop, except what a frame has said since.
	// A read that a later re-connect overtook (a flapping socket) neither seeds nor clears: the later read owns the set,
	// as on the phone (RoomLink.refreshLibrary).
	const seedFromLibrary = (reconnect = false) => {
		const heard = heardSinceReconnect;
		const superseded = () => reconnect && heardSinceReconnect !== heard;
		return fetch('/api/library')
			.then((r) => (r.ok ? r.json() : null))
			.then((j) => {
				if (j && !superseded())
					liveStatus = seedLiveStatus(liveStatus, j.processing ?? [], j.noMakerFailed ?? [], {
						reconnect,
						heard: heard ?? undefined
					});
			})
			.catch(() => {})
			.finally(() => {
				if (reconnect && !superseded()) heardSinceReconnect = null;
			});
	};
	let wasConnected = false;
	// Plain, not $state: only the seed reads it. The songs a frame has spoken for since the socket came back.
	let heardSinceReconnect: Set<string> | null = null;

	onMount(() => {
		ws = new WsClient({
			// ONE TV PER ROOM: `role=tv` plus the resolved room code. See docs/FRONTEND.md#the-tv-socket.
			url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=tv${data.roomCode ? `&room=${encodeURIComponent(data.roomCode)}` : ''}`,
			// The TV holds NO queue rev of its own — it never handles queue:patch and adopts each queue:sync wholesale.
			// -1, not 0, so EVERY patch reads as a gap and fetches a sync: with 0 the room's rev-1 patch was the one it
			// let through unread, so the first song queued after a boot never reached the TV lobby.
			getLastRev: () => -1,
			onConnectionChange: (c, closeCode) => {
				// Removed by the host, or one screen too many: stop redialling and say so (`shutOut` below).
				if (closeCode === TV_REMOVED_CLOSE_CODE || closeCode === TV_FULL_CLOSE_CODE) {
					shutOut = closeCode === TV_REMOVED_CLOSE_CODE ? 'removed' : 'full';
					ws?.close();
				}
				// A RE-connect re-seeds: frames sent while the socket was down (a core restart) are lost, and the
				// lobby must say what a reload would.
				if (c && wasConnected) {
					// eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain bookkeeping, never rendered
					heardSinceReconnect = new Set();
					void seedFromLibrary(true);
				}
				if (c) wasConnected = true;
				connected = c;
			},
			onEvent: handleEvent
		});
		// Playback continues through a socket drop; WsClient only re-establishes the control channel.
		ws.open();
		void seedFromLibrary();
		return () => ws?.close();
	});

	// A screen the host removed, or one too many for the room: the socket is closed for good until it is opened again.
	let shutOut = $state<'removed' | 'full' | null>(null);
	const shutOutLine = $derived(
		shutOut === 'removed' ? 'This screen was removed' : 'This room has all the screens it can show'
	);
	// Said in the page's one live region, which is mounted before any of it.
	$effect(() => {
		if (shutOut) seatAnnounce = shutOutLine;
	});

	// A copy tells core how far it runs from the TV, for the host's Screens page: the latest measure, every 2 s at most.
	const DRIFT_REPORT_MS = 2_000;
	let driftSentAt = 0;
	function reportDrift(ms: number) {
		const now = clientNow();
		if (!isCopy || now - driftSentAt < DRIFT_REPORT_MS) return;
		driftSentAt = now;
		ws?.send({ type: 'tv:drift', ms }, { quiet: true });
	}

	// A copy times its offset to core: a short burst on connect fills the min-RTT window, then one ping every 30 s.
	const PING_BURST = 5;
	const PING_BURST_GAP_MS = 250;
	const PING_EVERY_MS = 30_000;
	$effect(() => {
		if (!isCopy || !connected) return;
		let sent = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const ping = () => {
			ws?.send({ type: 'tv:ping', t0: clientNow() }, { quiet: true });
			sent++;
			timer = setTimeout(ping, sent < PING_BURST ? PING_BURST_GAP_MS : PING_EVERY_MS);
		};
		ping();
		return () => clearTimeout(timer);
	});

	// The lower third's and "Up next"'s rendered heights, MEASURED by TvNowBar and handed back here.
	let measuredCardPx = $state<number | null>(null);
	let measuredUpnextPx = $state<number | null>(null);
	// Null before the first measure -> undefined style -> app.css's static fallback stands.
	const chromeBandStyle = $derived(
		measuredCardPx === null ? undefined : `--tv-chrome-h: calc(var(--tv-safe-y) + ${Math.ceil(measuredCardPx)}px)`
	);
	// And the corner join card, which the reaction lane stands directly above: it is NOT part of the chrome band (the
	// lower-third is), and the two heights drift apart independently, so the lane clears whichever is taller.
	let cornerEl = $state<HTMLElement | undefined>();
	let measuredCornerPx = $state<number | null>(null);
	$effect(() => observeBlockSize(cornerEl, (px) => (measuredCornerPx = px)));
	let copySlotEl = $state<HTMLElement | undefined>();
	let measuredChipPx = $state<number | null>(null);
	$effect(() => observeBlockSize(copySlotEl, (px) => (measuredChipPx = px)));
	const upnextPx = $derived(
		isCopy && measuredChipPx !== null ? Math.max(measuredUpnextPx ?? 0, measuredChipPx) : measuredUpnextPx
	);

	// A copy's chip on the stage shows for a while after the screen opens and after a tap or a key, then gets out of
	// the room's way (tenet 6). The lobby and attract keep it, and so does a copy whose TV has gone.
	const CHIP_OPEN_MS = 20_000;
	const CHIP_WAKE_MS = 10_000;
	let chipAwake = $state(true);
	// The press that wakes a sleeping chip must not also claim: a touch tap's click is hit-tested after the chip is
	// back, and a double click's second half lands on it. So a claim this soon after waking is dropped.
	const CLAIM_AFTER_WAKE_MS = 500;
	let chipWokeAt = -Infinity;
	function claimUnlessJustWoken() {
		if (performance.now() - chipWokeAt < CLAIM_AFTER_WAKE_MS) return;
		ws?.send({ type: 'tv:claim' });
	}
	$effect(() => {
		if (!isCopy) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const awake = (ms: number) => {
			chipAwake = true;
			clearTimeout(timer);
			timer = setTimeout(() => (chipAwake = false), ms);
		};
		const wake = () => {
			if (chipAsleep) chipWokeAt = performance.now();
			awake(CHIP_WAKE_MS);
		};
		const opts: AddEventListenerOptions = { capture: true, passive: true };
		awake(CHIP_OPEN_MS);
		window.addEventListener('pointerdown', wake, opts);
		window.addEventListener('keydown', wake, opts);
		return () => {
			clearTimeout(timer);
			window.removeEventListener('pointerdown', wake, opts);
			window.removeEventListener('keydown', wake, opts);
		};
	});
	const tvStyle = $derived(
		[
			chromeBandStyle,
			// The full-screen button clears whichever is taller of "Up next" and the copy chip standing in its place.
			upnextPx === null ? undefined : `--tv-upnext-h: ${Math.ceil(upnextPx)}px`,
			measuredCornerPx === null ? undefined : `--tv-corner-h: ${Math.ceil(measuredCornerPx)}px`,
			// The lyrics give the reaction lane its width (plus a gap) on each side, only while the lane can show.
			settings.room.tvReactions ? '--tv-reaction-reserve: calc(var(--tv-reaction-w) + var(--tv-space-lg))' : undefined
		]
			.filter(Boolean)
			.join('; ') || undefined
	);

	const screen = $derived(
		tvScreen({ playerState: tvState, current, entries, inRoomCount: online.length + away.length })
	);
	const chipAsleep = $derived(isCopy && !chipAwake && tvOnline && screen !== 'lobby' && screen !== 'attract');
	// "Up next" comes back once the chip's fade is over, so the two never draw text on text.
	let chipFadedOut = $state(false);
	$effect(() => {
		if (!chipAsleep) {
			chipFadedOut = false;
			return;
		}
		const t = setTimeout(() => (chipFadedOut = true), prefersReducedMotion ? 0 : cssTimeMs('--motion-base'));
		return () => clearTimeout(t);
	});

	// `isPlayable`, not `readyToSing`: the same question the PLAYER asks, so the lobby cannot call something processing
	// that the player would happily start.
	const pending = $derived(
		entries.filter((e) => {
			const m = mediaOf(e);
			return !m || !isPlayable(m);
		})
	);
	// Songs still being made and past their estimate (`statusOverdue`), so the lobby says what the singer's phone
	// says rather than "this takes a minute". Only `pending` songs count: a ready one is overdue no longer. A
	// `SvelteSet`: one id flips at a time, in place.
	const overdueMedia = new SvelteSet<string>();
	const overdue = $derived(lobbyOverdue(pending, overdueMedia));
	function noteOverdue(mediaId: string, isOverdue: boolean): void {
		if (isOverdue) overdueMedia.add(mediaId);
		else overdueMedia.delete(mediaId);
	}
	// THE PHONE'S OWN CARD KINDS, folded: counting every unplayable turn as "processing" kept the lobby on "Making
	// karaoke… this takes a minute" under turns the server had already failed or found no maker for.
	const waiting = $derived(
		waitingTurns(
			entries.filter((e) => e.status === 'queued'),
			(id) => mediaCatalog.get(id),
			(id) => liveStatus.get(id),
			canMake
		)
	);
	const stuck = $derived(stuckTurnsLines(waiting, singerName));
	const isAttract = $derived(screen === 'attract' || screen === 'lobby');
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
	// The override wins when set; `null` defers to the room.
	const resolvedBackground = $derived(backgroundOverride ?? tvBackgroundStyle);
	const stageBg = $derived(
		stageBackgroundCss(resolvedBackground, tvBackgroundColor, currentSingerColor, tvBackgroundDim)
	);
	// ADVANCE needs BOTH dimensions: the room INTENDS to play AND the master element is actually running.
	// `isPlaying` alone stays true through a phone pause and an autoplay refusal — the room silent while the reel
	// sweeps on wall-clock. VISIBILITY still rides `lyricsActive`.
	const lyricsPlaying = $derived(lyricsAdvancing(screen, tvState, isPlaying, masterAdvancing));
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

	// The entry the stage is loading, which the loading card names. After a natural end with a missed preload it is
	// `upNext`, while `current` is still the singer who just finished until the server confirms (IN-03).
	const stageEntry = $derived([current, upNext].find((e) => !!e && e.id === stageEntryId) ?? null);
	// ONE derived value, because as independent `{#if}` blocks at one z-index with `inset: 0` and non-exclusive
	// conditions two full-screen panels paint over each other. `loading` is the FALLBACK for a missed preload,
	// where `screen` derives `playing` over a not-yet-loaded element.
	const transient = $derived.by((): TakeoverKind | null => {
		if (skipNotice) return 'error';
		if (tvState === 'waiting') return 'waiting';
		if (tvState === 'interstitial' && introEntry) return 'next';
		if (tvState === 'loading' && stageEntry && !resuming) return 'loading';
		return null;
	});
	// The card the takeover layer holds. It OUTLIVES `transient` by the exit fade, so the room watches the words it was
	// reading fade into the song rather than an empty scrim, and is dropped once that fade ends (`ontransitionend`), so
	// the next takeover mounts fresh and an alert announces again. With no fade running on the layer (reduced motion, or a
	// takeover gone before it ever painted) there is nothing to wait for, and no `transitionend` would come.
	// `skipNotice` clears with its takeover, so the notice's words are held the same way.
	// SSR-safe: matchMedia does not exist during load. Defaults to full motion; corrected on mount. Declared here, above
	// the takeover layer's derived state that reads it.
	let prefersReducedMotion = $state(false);
	let heldKind = $state<typeof transient>(null);
	let heldNotice = $state('');
	let takeoverLayer = $state<HTMLDivElement>();
	// The "no fade running" read waits a microtask: `transient` can clear from inside a child's effect (TvPlayer's
	// `onready` ends a missed-preload card), and in that flush this effect runs BEFORE the layer's class drops `shown`,
	// so the exit transition does not exist yet and the card would unmount on its fade's first frame.
	const dropHeldUnlessFading = () => {
		if (!transient && takeoverLayer?.getAnimations().length === 0) heldKind = null;
		if (heldKind === null) cardLeaving = cardGone = false;
	};
	$effect(() => {
		if (transient) heldKind = transient;
		else queueMicrotask(dropHeldUnlessFading);
		// The early exit belongs to the intro card's hold alone: a notice over it cancels it. Its END does not, until the
		// held card is dropped: `cardGone` keeps the reel up across the hold's end, or it would unmount for one flush
		// and replay its arrival.
		if (transient && transient !== 'next') cardLeaving = cardGone = false;
	});
	$effect(() => {
		if (skipNotice) heldNotice = skipNotice;
	});
	// The overlay is live only while a song is actually on screen, and not while a card is still fading out over it:
	// a real lyric line is as wide as the card's, so the two would draw text on text for the whole exit. The reel
	// comes in once the card has gone (LyricsOverlay fades it in): for an intro card whose exit was led ahead of its
	// hold (`cardGone`) that is the hold's last `--motion-fast`, so the line is up when the song starts (the reel does
	// not advance until it plays); otherwise just after the card's fade. Not under the missed-preload card either
	// (#999's rule): `screen` says `playing` there.
	const lyricsActive = $derived(
		screen === 'playing' &&
			(tvState !== 'interstitial' || (cardGone && !prefersReducedMotion)) &&
			transient !== 'loading' &&
			!(heldKind !== null && !transient && !cardGone)
	);
	const cardKind = $derived(transient ?? heldKind);
	// Up, unless the intro card is already fading out ahead of its hold's end (`cardLeaving`).
	// Reduced motion switched on mid-lead puts the card back until the hold's end, where it cuts out as on main.
	const layerShown = $derived(!!transient && !(cardLeaving && !prefersReducedMotion && transient === 'next'));
	// The card's words are painted at all: up, or still fading out (a led exit until `cardGone`, any other until the
	// held card drops). The lower third waits for this, so the room never reads one name twice.
	const cardPainted = $derived(transient ? layerShown || !cardGone : heldKind !== null);
	// "Now singing" and the missed-preload card are ONE card: the same words for the same entry, so `next` -> `loading`
	// changes nothing on screen. `loading` is the MISSED-PRELOAD path, held until the visible player reports ready (a
	// song IS coming), and names `stageEntry`, the entry the visible player is loading toward. Either way "Up next" only
	// in the beat before the server confirms the swap; the entry that IS current is "Now singing".
	const handoff = $derived.by(() => {
		const entry = cardKind === 'next' ? introEntry : cardKind === 'loading' ? stageEntry : null;
		return entry ? { entry, label: entry.id !== current?.id ? UP_NEXT : NOW_SINGING } : null;
	});
	// What the card SAYS. A change of words while the layer is up re-mounts the lines, so only they rise in again and
	// the scrim stays; the same words in another state are the same key, so nothing moves.
	const cardWords = $derived(
		handoff
			? `${handoff.label}|${handoff.entry.id}`
			: cardKind === 'error'
				? `error|${skipNotice || heldNotice}`
				: cardKind
	);
	// Seeded from the room code, so a room's phrase rotation is deterministic.
	// See docs/FRONTEND.md#the-attract-and-lobby-idles.
	const phraseSeed = $derived(seedFromString(data.roomCode || 'encore-attract'));
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
	{#each SLOTS as slot (slot)}
		<TvPlayer
			media={slotMedia[slot]}
			entryId={slotEntryId[slot]}
			visible={visible === slot && !isAttract}
			active={visible === slot}
			playing={isPlaying}
			seekSec={seekSec}
			seekRev={seekRev}
			keyShift={keyShift}
			guideLevel={seatMine ? guideLevel : 0}
			masterLevel={seatMine ? masterLevel[slot] : 0}
			silent={!seatMine}
			follow={follow}
			ondrift={reportDrift}
			onready={() => {
				ctl.onVisibleReady();
				tvState = ctl.state;
				onFirstSongReady();
				leadExitIfDue();
			}}
			onprewarmed={() => {
				// `slotEntryId`, NOT `slotMedia.id`. GaplessController compares this against `#warmingId`, which it
				// sets from `upNext.id` — an ENTRY id — and its own field comment says so. `snapshot(m)` returns
				// `{...m}`, so `slotMedia[slot].id` is the MEDIA id and never matched: `#readyId` stayed unset,
				// `isNextReady()` was permanently false, and every song change took the cold-load branch and threw
				// away the slot it had just pre-warmed. Measured cost: ~740ms of dead air at each boundary.
				ctl.onHiddenReady(slotEntryId[slot] ?? '');
				tvState = ctl.state;
			}}
			onended={() => onVisibleEnded(slotEntryId[slot])}
			onfailed={() => onVisibleFailed(slotEntryId[slot])}
			onposition={(s, d) => {
				positionSec = s;
				durationSec = d;
				sendTelemetry('playing', slotEntryId[slot], s);
			}}
			onautoplayblocked={() => (autoplayBlocked = true)}
			onpitchblocked={() => (pitchBlocked = true)}
			onpitchrouted={() => (pitchBlocked = false)}
			onautoplayrecovered={() => (autoplayBlocked = false)}
			onplayingchange={(p) => (masterAdvancing = p)}
		/>
	{/each}

	<LyricsOverlay
		lyricsRef={mediaOf(current)?.lyricsRef}
		songKey={current?.id}
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
		<TvAttract
			qrDataUrl={data.qrDataUrl}
			joinUrl={data.joinUrl}
			joinLabel={attractJoinUrl}
			roomCode={data.roomCode}
			unreachable={joinUnreachable}
			phrase={attractPhrase}
		/>
	{:else if screen === 'lobby'}
		<!-- People ARE here, nothing queued — name them and say what we're waiting for -->
		<TvLobby
			qrDataUrl={data.qrDataUrl}
			joinUrl={data.joinUrl}
			roster={roster.shown}
			overflow={roster.overflow}
			pendingCount={waiting.making}
			overdue={overdue}
			stuck={stuck}
			unreachable={joinUnreachable}
			roomCode={data.roomCode}
			join={isCopy ? copyChip : undefined}
		/>
	{:else}
		<TvNowBar
			name={singerName(current?.singerId)}
			color={currentSingerColor}
			media={mediaOf(current)}
			keyShift={keyShift}
			progressStyle={tvProgressStyle}
			positionSec={positionSec}
			durationSec={durationSec}
			underCard={layerShown}
			cardPainted={cardPainted}
			next={upNext && upNext.id !== current?.id
				? { name: singerName(upNext.singerId), color: singers.get(upNext.singerId)?.color, media: mediaOf(upNext) }
				: null}
			oncardsize={(px) => (measuredCardPx = px)}
			onupnextsize={(px) => (measuredUpnextPx = px)}
			yieldUpnext={isCopy && !(chipAsleep && chipFadedOut)}
		/>
		{#if settings.room.tvReactions}
			<Reactions bind:this={reactions} />
		{/if}
		<!-- The join QR stays reachable mid-song, bottom-right (the only free corner), on a TV-shaped copy too: every
		     screen in the room is a place to scan from. Hidden while `.takeover-join` shows the dimmed copy;
		     `visibility` keeps the lane's box. -->
		<div class={['stage-join', { 'under-card': !!transient, 'on-copy': isCopy }]}>
			<JoinBadge
				qrDataUrl={data.qrDataUrl}
				joinUrl={data.joinUrl}
				placement="corner"
				roomCode={data.roomCode}
				bind:cornerEl={cornerEl}
			/>
		</div>
	{/if}

	<TvTakeover
		shown={layerShown}
		cardWords={cardWords}
		handoff={handoff}
		cardKind={cardKind}
		notice={skipNotice || heldNotice}
		skipNext={skipNext}
		current={current}
		liveStatus={liveStatus}
		mediaOf={mediaOf}
		singerName={singerName}
		bind:layer={takeoverLayer}
		ontransitionend={(e) => {
			// Not on `transitioncancel`: Chromium fires it on every mid-flight reversal of the fade-in, while the reversed
			// fade is still running. A fade that never ran is the deferred no-fade check's.
			if (e.target !== e.currentTarget) return;
			if (!transient) heldKind = null;
			else if (cardLeaving && !layerShown) cardGone = true;
		}}
	/>

	<!--
		THE JOIN BLOCK SURVIVES EVERY TAKEOVER, dimmed, in the same slot as during playback: a song change is
		exactly when a new guest looks up. The identical corner component, so the slot does not move.
	-->
	{#if transient}
		<div class="takeover-join">
			<JoinBadge qrDataUrl={data.qrDataUrl} joinUrl={data.joinUrl} placement="corner" roomCode={data.roomCode} />
		</div>
	{/if}

	<TvAudioNotice
		bind:autoplayBlocked={autoplayBlocked}
		bind:pitchBlocked={pitchBlocked}
		isAttract={isAttract}
		onfullscreen={toggleFullscreen}
	/>

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

	<p class="vh" role="status">{seatAnnounce}</p>
	<!-- In the lobby the chip stands in the QR's place, in the lobby's own flow, so it covers none of its lines. Mid-song
	     it stands where "Up next" does, top-right; in attract (nobody here yet), in attract's free band. -->
	{#snippet copyChip()}
		<TvCopyChip tvOnline={tvOnline} onclaim={claimUnlessJustWoken} />
	{/snippet}
	{#if isCopy && screen !== 'lobby'}
		<div class={['copy-slot', { 'on-attract': screen === 'attract', asleep: chipAsleep }]} bind:this={copySlotEl}>
			{@render copyChip()}
		</div>
	{/if}

	{#if shutOut}
		<div class="shut-out">
			<p class="shut-line">{shutOutLine}</p>
			<p class="shut-sub">
				{shutOut === 'removed'
					? 'The host took it off the Screens page. It can come back.'
					: 'Close one of them, then open this one again.'}
			</p>
			<button type="button" class="shut-again" onclick={() => location.reload()}>Open again</button>
		</div>
	{/if}

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
	/* ONE TV PER ROOM: a copy's chip, top-right, in "Up next"'s place (which yields while the chip shows). */
	.copy-slot {
		position: absolute;
		right: var(--tv-safe-x);
		top: calc(var(--tv-safe-y) + 2.6vh);
		z-index: var(--z-tv-affordance);
		max-width: calc(100vw - 2 * var(--tv-safe-x));
	}
	/* Attract has its own QR and an empty bottom band. */
	.copy-slot.on-attract {
		top: auto;
		bottom: var(--tv-safe-y);
	}
	/* Out of the room's way mid-song: unreachable as well as unseen, so a first tap wakes it and cannot claim. */
	.copy-slot.asleep {
		opacity: 0;
		visibility: hidden;
		pointer-events: none;
	}
	@media (prefers-reduced-motion: no-preference) {
		/* Waking, `visibility` flips at once and only opacity moves; sleeping, it holds until the fade is done. */
		.copy-slot {
			transition: opacity var(--motion-base) var(--ease-out);
		}
		.copy-slot.asleep {
			transition:
				opacity var(--motion-base) ease-in,
				visibility var(--motion-base);
		}
	}
	/* A phone reading along: the bottom band is the lower third (mid-song) or the roster and the room code (lobby), and
	   the right edge is the reactions lane, so the chip goes TOP-LEFT, kept clear of the lane's column at every width.
	   p10-tv-copy.spec.ts measures it against all three at 390 and 320. */
	@media (max-aspect-ratio: 1/1) {
		.copy-slot {
			top: var(--tv-safe-y);
			left: var(--tv-safe-x);
			right: auto;
			bottom: auto;
			max-width: calc(100vw - 2 * var(--tv-safe-x) - var(--tv-reaction-w) - var(--tv-space-lg));
		}
		/* Attract on a phone: the wordmark and the QR fill the top, and the bottom band is empty. */
		.copy-slot.on-attract {
			top: auto;
			bottom: var(--tv-safe-y);
		}
		/* A phone reading along has already joined, and the corner card does not fit beside the lower third there. */
		.stage-join.on-copy {
			display: none;
		}
	}
	/* `contents`, so the corner card keeps the stage as its containing block; `visibility` inherits into it. */
	.stage-join {
		display: contents;
	}
	.stage-join.under-card {
		visibility: hidden;
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

	/* A removed (or one-too-many) screen covers its stale stage: nothing behind it is live any more. */
	.shut-out {
		position: absolute;
		inset: 0;
		z-index: calc(var(--z-tv-affordance) + 1);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--tv-space-lg);
		padding: var(--tv-safe-y) var(--tv-safe-x);
		background: var(--role-ground);
		color: var(--role-ink);
		text-align: center;
	}
	.shut-line {
		font-size: var(--tv-name);
		font-weight: 800;
	}
	.shut-sub {
		font-size: var(--tv-body);
		color: var(--role-ink-dim);
	}
	.shut-again {
		margin-top: var(--tv-space-lg);
		padding: var(--tv-space-2xs) var(--tv-space-4xl);
		border: 0;
		border-radius: var(--round-pill);
		background: var(--role-ink);
		color: var(--role-ground);
		font: inherit;
		font-size: var(--tv-body);
		font-weight: 700;
		cursor: pointer;
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
</style>
