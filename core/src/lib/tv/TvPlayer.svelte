<script lang="ts">
	// One media surface (slot A or B). See docs/FRONTEND.md#the-stage-and-its-stacking-order.
	//
	// <audio> AND NOT <video>: `playbackRef` resolves to the separated instrumental, which has no video track,
	// and <audio> is the more permissive element for codec support.
	//
	// THE ONE RULE THAT MUST NOT BE BROKEN: the 4-channel guide mix must never reach an element that is not routed
	// through a running split graph, or the browser downmixes it and sums the vocals in at full volume.
	import { playbackRef, isPlayable, guidePath } from '$lib/contract';
	import type { PlaybackSnapshot } from './catalog';
	import { untrack } from 'svelte';
	import { resumeSeekTarget, seekPlan } from './playhead-sync';
	import { masterSrcPlan, wantsEagerGraph, mixGateFor } from './guide-mix-src';
	import { nextVideoSrc } from './video-src';
	import { transportFor, slotHoldsSong, songToken } from './transport';
	import { PitchShiftGraph, needsShift } from './pitch-shift';
	import { StallWatchdog, STALL_TICK_MS, unansweredPlayIsAutoplay } from './stall-watchdog';
	import {
		clientNow,
		followPlan,
		nextSeekLead,
		tvPositionAt,
		untrim,
		untrimWhenStale,
		type TvClock
	} from './copy-clock';
	interface Props {
		/** A `PlaybackSnapshot`, not a live `Media`: the brand makes this a compiler boundary. */
		media: PlaybackSnapshot | null;
		// The QUEUE ENTRY id, NOT the media id: a song queued twice is two entries over ONE media record, so `media.id`
		// and the src are byte-identical across the advance and turn 2 never calls play() without this.
		entryId?: string | null;
		visible: boolean;
		active: boolean; // is this the playing slot (vs the hidden pre-warming slot)
		playing?: boolean; // playback:state.isPlaying — pause/resume from the phone
		seekSec?: number; // playback:state.positionSec
		// Tracked by the seek effect, so a restart whose position EQUALS the last one still re-takes the decision: a
		// restart under the threshold writes 0 over 0, which notifies nothing.
		seekRev?: number;
		keyShift?: number; // ± semitones, applied in the browser
		guideLevel?: number; // 0..1 — how loud the original vocals sit under the instrumental
		/** ATTENUATE-ONLY. Applied at BOTH the native and routed sites, because WebAudio capture bypasses `.volume`. */
		masterLevel?: number;
		/**
		 * ONE TV PER ROOM: this screen is a COPY (or has not heard the seat's answer yet). The element is `muted`, since iOS
		 * Safari ignores `.volume`, and NO AudioContext is made or resumed: no split graph, no shift. A muted element may
		 * autoplay everywhere, so the copy still runs the clock the words follow. See docs/SERVER.md#the-tv-seat.
		 */
		silent?: boolean;
		/** A COPY's view of the TV's clock: when set, this slot trims its rate or seeks to follow it. The seat never gets one. */
		follow?: { clock: TvClock; offsetMs: number } | null;
		/** Each `follow` frame's measure, copy minus TV in ms, before it is corrected. */
		ondrift?: (ms: number) => void;
		/** Gated on VISIBILITY: the hidden slot buffers a song ahead, so firing there flips the room over a black frame. */
		onready?: () => void;
		/** The gapless pre-warm signal, fired REGARDLESS of visibility; the controller filters it by slot id. */
		onprewarmed?: () => void;
		onended?: () => void;
		/** The song won't play: a media error, or no progress while the room means to play (see stall-watchdog.ts).
		 *  ONCE per entry, active+visible only. The caller moves the room on. */
		onfailed?: () => void;
		onposition?: (sec: number, dur: number) => void;
		/** Autoplay was REFUSED; the room is silent until a gesture. Active+visible only. */
		onautoplayblocked?: () => void;
		/** Something got the instrumental playing after a block — the page can retract the hint. */
		onautoplayrecovered?: () => void;
		// Whether the MASTER is actually running — the honest counterpart to the room's `playing` INTENT. Active+visible
		// only, so the paused hidden slot cannot report the room as stopped.
		onplayingchange?: (playing: boolean) => void;
		// A transpose could not route: with no user activation the graph degrades to audible-but-UNSHIFTED, so without a
		// reader a TV that autoplays correctly answers every ± press with nothing.
		onpitchblocked?: () => void;
		/** The transpose is routing (or nothing is pending) — retract any hint raised above. */
		onpitchrouted?: () => void;
	}
	let {
		media,
		entryId = null,
		visible,
		active,
		playing = true,
		seekSec,
		seekRev,
		keyShift = 0,
		guideLevel = 0,
		masterLevel = 1,
		silent = false,
		follow = null,
		ondrift,
		onready,
		onprewarmed,
		onended,
		onfailed,
		onposition,
		onautoplayblocked,
		onautoplayrecovered,
		onplayingchange,
		onpitchblocked,
		onpitchrouted
	}: Props = $props();

	let master: HTMLAudioElement | undefined = $state();

	// ONE graph, because the capture is one per ELEMENT: the split graph IS this graph in `split` mode.
	let masterGraph: PitchShiftGraph | undefined;
	// Two jobs: the REACTIVE signal the src effect needs (`isRouted`/`isSplit` are plain getters and cannot wake an
	// effect), and `MixGate`'s `pending` half. Reset per SONG, not per graph.
	let mixSettled = $state(false);

	// One worklet, four channels, ONE ratio, so the guide cannot fall out of key with what is playing.
	const effectiveGuide = $derived(Math.max(0, Math.min(1, guideLevel)));

	// A second clamp even though the route clamps. Attenuate-only: a song is only ever pulled DOWN.
	const effectiveMasterLevel = $derived(Math.max(0, Math.min(1, masterLevel)));

	/** WHICH guide this song offers — one 4-channel mix, or none. No second-element alternative. */
	const guidePlan = $derived(media ? guidePath(media) : ({ kind: 'none' } as const));

	// The guide lives inside the master's own file, so a master that can play is a guide that can play.
	let masterReady = $state(false);
	// HELD so a cold mount can take it on `canplay` — the element does not exist when the frame arrives on a reload. NOT
	// reactive, so it never re-triggers the seek effect. See docs/FRONTEND.md#wake-lock-and-reload-resume.
	let resumeTarget: number | undefined;
	// TWO latches: a slot that buffers while hidden and is later swapped in must still fire onready, which one shared
	// latch would already have spent.
	let prewarmedFired = $state(false);
	let visibleReadyFired = $state(false);
	// The reactive signal the transport gates on; the AUTHORITATIVE copy is the element's own `src` attribute.
	let currentSrc = $state<string>('');
	// Written in LOCKSTEP with `currentSrc`, which alone cannot tell turn 2 from turn 1: the transport compares the
	// entry-scoped token, and this is its `held` half.
	let currentEntryId = $state<string | null>(null);

	// Drives the gesture listener below AND the page's hint: a page that never received a gesture is refused playback,
	// which is exactly the case a set-and-forget TV wall is in.
	let autoplayBlocked = $state(false);

	// The song this slot has already reset for. A PLAIN variable: guard bookkeeping, nothing renders off it.
	let resetForId: string | null | undefined;
	// ONE TV PER ROOM: this song's src was settled while SILENT (a copy), so it is the plain instrumental for the rest
	// of the song, even if this screen takes the seat: building the guide graph would switch the src to the guide mix,
	// and that reload restarts the song at 0:00 for the whole room. The guide joins at the next song. Plain: bookkeeping.
	let plainThisSong = false;
	// How far into a song a promoted screen still swaps its plain src for the guide mix: past the gapless swap and the
	// claim's round trip (the r8 probe landed at +300 ms), short of where a reload is a restart anyone would hear.
	const REDECIDE_WITHIN_SEC = 2;
	// `resumeTarget` was set by that re-decide, not by a cold mount: if the src it settles on is the one already
	// playing, nothing reloads and the hold must go. Plain: bookkeeping.
	let redecideResume = false;

	// GUARDED ON THE ID *VALUE*, not the `media` signal, whose identity churns on any queue mutation: keying on the
	// signal reset a MID-SONG slot, and `canplaythrough` will NOT fire again on a loaded element, so `onready` was spent
	// forever and the graph was torn down under a transposed song. The teardown is imperative for the same reason — a
	// cleanup runs before EVERY re-run.
	$effect(() => {
		const id = media?.id ?? null;
		if (id === resetForId) return;
		resetForId = id;
		// The MASTER outlives a song change, so its graph must NOT be detached here — that leaves the captured
		// element feeding a disconnected node. `setShift(0)` keeps the chain intact and no-ops on an un-built graph.
		void masterGraph?.setShift(0);
		// A graph defaults its gain to 1 and `desiredGuideGain` to 0, so BOTH levels must be re-asserted here or the song
		// plays at full volume with a silent guide.
		masterGraph?.setGain(effectiveMasterLevel);
		masterGraph?.setGuideGain(effectiveGuide);
		masterReady = false;
		// A new song re-takes the mix decision from scratch: a non-mix song must not inherit the previous `routed`.
		mixSettled = false;
		plainThisSong = false;
		// A re-decide's held position belongs to the song it was taken in, never the next one.
		if (redecideResume) resumeTarget = undefined;
		redecideResume = false;
		prewarmedFired = false;
		visibleReadyFired = false;
		// `currentSrc` is deliberately NOT cleared: the element still holds the old src, and clearing makes the assign
		// effect rewrite a byte-identical one, which RELOADS and resets currentTime to 0. The stale-across-a-remount case
		// belongs to the `if (!master)` effect, which fires only when the element is GONE.
	});

	// NO tracked dependencies, so it never re-runs and its cleanup means exactly "this slot is going away".
	$effect(() => {
		return () => {
			masterGraph?.detach();
			masterGraph = undefined;
		};
	});

	// Reported on ANY slot, which is what lets the hidden slot advertise a gapless-ready next song.
	$effect(() => {
		if (masterReady && !prewarmedFired) {
			prewarmedFired = true;
			onprewarmed?.();
		}
	});

	// Depending on `visible` too is what fires this when a slot that settled while hidden is swapped in.
	$effect(() => {
		if (visible && masterReady && !visibleReadyFired) {
			visibleReadyFired = true;
			onready?.();
		}
	});

	/**
	 * ONE decision, and `currentSrc` is the load-bearing input: a `play()` issued before the src is assigned is
	 * undone by the assignment itself, so the transport must depend on the src having LANDED.
	 */
	const transport = $derived(
		transportFor({
			// THIS ENTRY's src: the shadows survive a change, so a src-only comparison stays true and the memoized transport
			// never re-fires. The entry token gives an `idle -> play` edge with no src rewrite.
			hasSrc: slotHoldsSong(
				songToken(currentEntryId, currentSrc),
				songToken(entryId, media && isPlayable(media) ? fileSrc(media) : null)
			),
			playable: !!media && isPlayable(media),
			active,
			visible,
			playing
		})
	);

	// The src is assigned from an effect BELOW this one, so without the transport's `hasSrc` gate this plays a
	// src-less element: the assignment's load algorithm re-pauses it, nothing re-runs, and the master sits at 0.
	$effect(() => {
		if (!master) return;
		if (transport === 'idle') return;
		if (transport === 'pause') {
			master.pause();
			return;
		}
		void tryPlayMaster();
	});

	// A DRAINED room UNMOUNTS the master while the shadows OUTLIVE it, so re-adding the same song read `true` on a
	// FRESH, src-less element. Tracking the BINDING is the reactive signal; reading `master`'s attribute is not.
	$effect(() => {
		if (!master) {
			currentSrc = '';
			currentEntryId = null;
			// The ELEMENT's death, not a song change: release the permanent capture AND drop the reference, because
			// detach() alone leaves `masterGraph` truthy and the `!masterGraph` build guard never fires again.
			masterGraph?.detach();
			masterGraph = undefined;
		}
	});

	/**
	 * The ONE place that resolves a `master.play()` promise, so the one place that can tell "the room will be silent"
	 * from "silent UNTIL a tap". It touches ONLY the plain element — no AudioContext, no MediaElementSource, whose
	 * capture is permanent and would commit all room audio to WebAudio.
	 */
	async function tryPlayMaster(): Promise<void> {
		if (!master) return;
		// The song this play() is FOR. A rejection that arrives after the slot moved on to another song is that song's
		// load superseding it (the browser rejects the old promise with AbortError), not a failure of either song.
		const requestedSrc = master.getAttribute('src');
		const token = ++playToken;
		// One clock PER SONG: an earlier song's pending play() (its AbortError not settled yet) must not start this one's
		// 4 s early.
		if (playPendingSince === null || playPendingFor !== entryId) {
			playPendingSince = performance.now();
			playPendingFor = entryId;
		}
		try {
			await master.play();
			blockedUnanswered = false;
			// Guarded on the latch, so a normal successful play does not spam the callback.
			if (autoplayBlocked) {
				autoplayBlocked = false;
				onautoplayrecovered?.();
			}
		} catch (err: unknown) {
			const name = err instanceof Error ? err.name : String(err);
			/* SUPERSEDED, so nobody is told. Measured on every natural end: the slot's play() for the song being left
			   rejected with AbortError once the next song's src landed, the element was already playing the NEW song,
			   and "This song won't play" flashed over the "Now singing" card, filed against the new song. The play()
			   the new src triggers reports its own outcome. */
			if (master?.getAttribute('src') !== requestedSrc) return;
			if (name === 'NotAllowedError') {
				// Recoverable by a gesture, so latch rather than treat as final. Announced only from the slot on screen.
				if (!autoplayBlocked) {
					autoplayBlocked = true;
					console.warn('[tv] autoplay was blocked (NotAllowedError) - waiting for a tap to start the music');
					if (active && visible) onautoplayblocked?.();
				}
			} else {
				// ANY OTHER REJECTION IS THIS SONG'S, and a tap cannot lift it: arming "Tap anywhere" here asked a TV on the
				// wall for a gesture nobody makes. Nothing is decided from the rejection itself — if the element still
				// advances the song is playing, and if it does not, the stall watchdog reloads it once and then fails it.
				console.warn(`[tv] the instrumental refused to start (${name}) - watching whether it moves`);
				// A tap that has been SPENT and still cannot start this song makes it the song's problem, not the TV's: left
				// latched, the watchdog waited for a second tap forever over a dead file (UI review of #994, D2).
				if (autoplayBlocked) {
					autoplayBlocked = false;
					if (active && visible) onautoplayrecovered?.();
				}
			}
		} finally {
			if (token === playToken) playPendingSince = null;
		}
	}

	// ONE watchdog per slot, reset per ENTRY: a song queued twice is two turns, each with its own retry. Load-bearing:
	// the slot outlives its songs, so without the reset a slot that failed once stays failed for every later song on it.
	const watchdog = new StallWatchdog();
	let lastBuffered = 0;
	// Keyed on the id VALUE in a plain variable: the effect re-runs whenever a room update re-reads the prop, and a reset
	// on each of those restarted the count and granted a second retry, stretching the 8 s cap to ~15 s (UI review r2).
	let watchedEntryId: string | null | undefined;
	$effect(() => {
		if (entryId === watchedEntryId) return;
		watchedEntryId = entryId;
		watchdog.reset();
		lastBuffered = 0;
	});

	// A play() still unanswered, and whether anyone has touched this TV: see `unansweredPlayIsAutoplay`.
	let playToken = 0;
	let playPendingSince: number | null = null;
	let playPendingFor: string | null | undefined;
	let gestured = false;
	// The latch above was raised by an unanswered play(), which may never settle to clear it: the tap itself must.
	let blockedUnanswered = false;

	// A plain interval that READS state, so it tracks nothing and never re-arms; the slot's lifetime is its lifetime.
	$effect(() => {
		const timer = setInterval(checkStall, STALL_TICK_MS);
		return () => clearInterval(timer);
	});

	function checkStall(): void {
		const el = master;
		const now = performance.now();
		const unanswered =
			!!el &&
			unansweredPlayIsAutoplay({
				pendingForMs: playPendingSince === null ? null : now - playPendingSince,
				gestured,
				readyState: el.readyState,
				errored: !!el.error
			});
		if (unanswered && !autoplayBlocked) {
			autoplayBlocked = true;
			blockedUnanswered = true;
			console.warn('[tv] play() never answered on an untouched TV - treating it as autoplay refused');
			if (active && visible) onautoplayblocked?.();
		}
		const buffered = el && el.buffered.length ? el.buffered.end(el.buffered.length - 1) : 0;
		// Bytes arriving, OR the fetch still open with nothing yet: a slow first byte is not a hiccup either, and the
		// reload would restart it from zero (code review r2 of #994, F2).
		const downloading =
			buffered > lastBuffered ||
			(!!el && el.networkState === HTMLMediaElement.NETWORK_LOADING && el.readyState === HTMLMediaElement.HAVE_NOTHING);
		lastBuffered = buffered;
		const action = watchdog.tick({
			now,
			position: el?.currentTime ?? 0,
			// `play` already means active, visible, holding this entry's src, and not paused from a phone.
			watching: !!el && transport === 'play' && !el.ended,
			// The unanswered play() raised the latch above at the same 4 s mark, before this tick could retry or fail.
			waitingForTap: autoplayBlocked,
			errored: !!el?.error,
			downloading
		});
		if (action === 'retry' && el) {
			console.warn('[tv] the song has not moved - reloading it once');
			// The reload drops the playhead to 0; the cold-mount resume on `canplay` puts it back where it stuck.
			resumeTarget = el.currentTime;
			el.load();
			void tryPlayMaster();
		} else if (action === 'fail') {
			console.warn('[tv] the song would not play - moving the room on');
			onfailed?.();
		}
	}

	/**
	 * A gesture is the only moment an AudioContext becomes resumable, and none of the pitch effect's tracked deps
	 * change when the wall is finally tapped. The `needsShift` guard keeps the keyShift-0 invariant.
	 */
	async function retryPitchAfterGesture(): Promise<void> {
		// A COPY never shifts (or resumes a context) on a tap. Untested on its own: a copy has no graph to retry, so
		// `!masterGraph` below already returns, and no probe can make this guard alone the one that bites.
		if (silent) return;
		if (!needsShift(keyShift)) return;
		if (!masterGraph) return;
		await masterGraph.setShift(keyShift).catch(() => {});
		if (!active || !visible) return;
		if (masterGraph.isRouted) onpitchrouted?.();
	}

	// play() is re-attempted SYNCHRONOUSLY inside the handler, which must share the gesture's task to consume the
	// activation. THE LISTENER IS ARMED UNCONDITIONALLY: gated on `autoplayBlocked` it existed only on a TV whose
	// autoplay had been REFUSED, so a correctly-autoplaying TV could never resume its context and ± was permanently dead.
	$effect(() => {
		const onGesture = () => {
			gestured = true;
			// Read the latch HERE, not in the effect body: that is what keeps the listener armed on a TV that never
			// raised it while keeping the play() nudge exclusive to one that was blocked.
			if (autoplayBlocked) {
				void tryPlayMaster();
				// A mix song's only chance at a split graph after a pre-gesture refusal; without it the first song of
				// every TV session loses its guide permanently. Re-open the gate first so the src effect re-decides.
				if (masterGraph && !masterGraph.isRouted && wantsEagerGraph(guidePlan) && !silent && !plainThisSong) {
					mixSettled = false;
					void masterGraph
						.ensureRouted()
						.catch(() => {})
						.finally(() => {
							mixSettled = true;
						});
				}
			}
			if (blockedUnanswered) {
				blockedUnanswered = false;
				autoplayBlocked = false;
				if (active && visible) onautoplayrecovered?.();
			}
			// On ANY gesture, blocked or not: a TV that autoplayed fine still needs one tap before WebAudio will run.
			void retryPitchAfterGesture();
		};
		// `capture` so it sees the gesture even if something downstream stops propagation; passive because we never
		// preventDefault; NOT `once`, so a pending transpose can still take a late gesture.
		const opts: AddEventListenerOptions = { capture: true, passive: true };
		window.addEventListener('pointerdown', onGesture, opts);
		window.addEventListener('keydown', onGesture, opts);
		return () => {
			window.removeEventListener('pointerdown', onGesture, opts);
			window.removeEventListener('keydown', onGesture, opts);
		};
	});

	// ONE site, set UNCONDITIONALLY: an un-built graph remembers the value and applies it on construction.
	$effect(() => {
		masterGraph?.setGuideGain(effectiveGuide);
	});

	// BOTH sites: `.volume` governs the native path, and once a transpose routes the master through WebAudio its
	// `.volume` is bypassed, so `setGain` must carry the same level.
	$effect(() => {
		if (master) {
			master.volume = effectiveMasterLevel;
			master.muted = silent;
		}
		masterGraph?.setGain(effectiveMasterLevel);
	});

	// ONE-LINE DEPENDENCY SET, ON PURPOSE: everything else the decision needs is read inside `applySeek` through
	// `untrack`. Reading `media` here as a tracked dependency made ANY fresh Media identity re-apply the position
	// from the last playback COMMAND, so an unrelated song's processing yanked the playing playhead backwards.
	$effect(() => {
		const target = seekSec;
		// Bumped by every `setPlayback` but NEVER by position telemetry, so tracking it re-takes the decision on a
		// restart-to-0 from under the threshold without reopening telemetry-chasing.
		void seekRev;
		if (target === undefined) return;
		applySeek(target);
	});

	// A COPY ON THE TV'S CLOCK, re-taken on each `tv:clock` frame. Without `follow` (the seat, or a copy just promoted)
	// the rate goes back to 1, so the seat's own element stays the room's clock. See docs/FRONTEND.md#a-copy-on-the-tvs-clock.
	let followSeekVotes = 0;
	// How far ahead a seek aims, learned from where the last one landed: a slow device lands late.
	let followSeekLead = 0;
	let followSeeked = false;
	$effect(() => {
		const f = follow;
		const el = untrack(() => master);
		if (!el) return;
		if (!f) {
			untrim(el);
			el.preservesPitch = true;
			followSeekVotes = 0;
			return;
		}
		const snap = untrack(() => media);
		const following =
			untrack(() => active && entryId === f.clock.entryId) && !!snap && isPlayable(snap) && !el.paused && !el.seeking;
		if (!following || resumeTarget !== undefined) {
			untrim(el);
			return;
		}
		// Muted, so pitch is moot: plain resampling is the cheaper trim on a slow device.
		el.preservesPitch = false;
		const tvSec = tvPositionAt(f.clock, f.offsetMs, clientNow());
		ondrift?.((el.currentTime - tvSec) * 1000);
		if (followSeeked) {
			followSeekLead = nextSeekLead(followSeekLead, el.currentTime - tvSec);
			followSeeked = false;
		}
		const plan = followPlan(el.currentTime, tvSec, followSeekLead);
		if (plan.kind === 'rate') {
			followSeekVotes = 0;
			if (el.playbackRate !== plan.rate) el.playbackRate = plan.rate;
			// The next frame re-runs this and cancels it; with no next frame, the trim goes.
			return untrimWhenStale(el);
		}
		// Two frames in a row, so one late frame from before a room seek cannot bounce the words back.
		if (++followSeekVotes < 2) return untrimWhenStale(el);
		followSeekVotes = 0;
		untrim(el);
		el.currentTime = plan.toSec;
		followSeeked = true;
		watchdog.rebase();
	});

	/**
	 * Called ONLY by the seek effect above. Every read in here is `untrack`ed, and that is the INVARIANT rather than
	 * tidiness: an input to the decision must never become a trigger for it.
	 */
	function applySeek(seekTarget: number): void {
		const el = untrack(() => master);
		// THE COLD-MOUNT HOLD. With no element the position waits for `canplay`; with one the hold MUST be cleared, because
		// `canplay` fires again on every warm re-buffer and a retained stash resumes seconds EARLIER.
		resumeTarget = el ? undefined : seekTarget;
		const snap = untrack(() => media);
		const isActive = untrack(() => active);
		if (!el || !snap || !isPlayable(snap) || !isActive) return;
		if (!seekPlan(el.currentTime, seekTarget)) return;
		el.currentTime = seekTarget;
		// The ROOM moved the playhead, so the jump is neither the song moving nor sticking.
		watchdog.rebase();
	}

	/**
	 * The decision is `resumeSeekTarget`, NOT `seekPlan`: a cold-mounted element has no playhead to protect, so the
	 * room's position is a RESUME rather than a jump subject to the telemetry-vs-scrub threshold.
	 * See docs/FRONTEND.md#wake-lock-and-reload-resume.
	 */
	function applyResume(): void {
		const el = untrack(() => master);
		const target = resumeTarget;
		if (target === undefined || !el) return;
		// Mirror applySeek's full guard: the prewarming (hidden, INACTIVE) slot DOES reach `canplay`, so without it the next
		// song's element parks at the outgoing position. Do NOT consume `resumeTarget` — the slot may become active later.
		const snap = untrack(() => media);
		const isActive = untrack(() => active);
		if (!snap || !isPlayable(snap) || !isActive) return;
		const plan = resumeSeekTarget(el.currentTime, target);
		if (plan.seek) el.currentTime = plan.target;
		// Consume it: ONE resume per element load, only on the path that actually applied it.
		resumeTarget = undefined;
	}

	// PITCH SHIFT, enforced HERE: at keyShift 0 no graph is constructed, so the audio path is the plain element, and
	// only the ACTIVE slot shifts, because the capture is permanent and the hidden slot is paused.
	// See docs/FRONTEND.md#the-pitch-shift-graph.
	$effect(() => {
		// Read reactive deps up front so the effect re-runs when any of them change.
		const shift = active && !silent ? keyShift : 0;
		const v = master;
		if (!v) return;
		// SILENT (a copy, or a TV just demoted to one): no graph is built, routed or re-routed here, and none shifts.
		// With no graph a guide-mix song settles at once on the plain instrumental (the gate reads `denied`). A demoted TV
		// keeps the graph it has, at the levels the page gives a copy (0).
		// shortcut: a copy that takes the seat past a song's first REDECIDE_WITHIN_SEC keeps that plain src, so the guide
		// joins at the next song; reload the src at the room's position on promotion if anyone misses it.
		// LOAD-BEARING ORDER: the real TV is never caught by this. The server sends `tv:seat` in the socket's `open()`,
		// BEFORE the `hello` reply that brings the song, on the SAME socket, so a TV knows it holds the seat before its
		// <audio> exists. Send the song first (or on another channel) and every TV would start each night plain.
		if (silent) {
			if (!masterGraph) plainThisSong = true;
			if (!mixSettled) mixSettled = true;
			masterGraph?.setGain(effectiveMasterLevel);
			masterGraph?.setGuideGain(effectiveGuide);
			return;
		}
		// GUIDE-MIX SONGS ARE THE ONE EXCEPTION and build EAGERLY, in SPLIT mode: their guiding track does not exist until
		// the splitter runs. `mixSettled` gates the src and an attempt that never settles leaves the room silent, so the
		// three settling paths below must stay exhaustive.
		// Promoted with this slot only PRE-WARMING the next song (hidden and paused at 0): nobody is listening, so it
		// re-decides its mix now and the next song gets its guide. So does a slot that is PLAYING but has barely begun (a
		// claim at the gapless swap lands just after it): the reload costs the room well under a second, and its playhead
		// is held as the resume target so `canplay` puts the guide mix back there. Past that, the plain src stays. Only a
		// GUIDE-MIX song is worth that pause (nothing else would reload), and only on a page that has had a tap: with no
		// activation the context cannot run, and the gate would hold the song paused for the 10 s resume bound only to
		// settle plain (a 15 s grace hand-off to a copy nobody touched). `userActivation` absent: assume it can.
		// Untested on its own: every Playwright `evaluate`, locator query and trace snapshot gives the page a sticky
		// activation, so the suite cannot hold a page untapped; the r10 review probed it with tracing off and a
		// no-gesture autoplay policy, which `playwright.config.ts` does not run.
		const canRoute = wantsEagerGraph(guidePlan) && navigator.userActivation?.hasBeenActive !== false;
		if (plainThisSong && (!active || (canRoute && v.currentTime < REDECIDE_WITHIN_SEC))) {
			if (active) {
				resumeTarget = v.currentTime;
				redecideResume = true;
			}
			plainThisSong = false;
			mixSettled = false;
		}
		if (wantsEagerGraph(guidePlan) && !plainThisSong) {
			if (!masterGraph) masterGraph = new PitchShiftGraph(v, { split: true });
			masterGraph.setGuideGain(effectiveGuide);
			if (masterGraph.isRouted) {
				// Possibly routed by a PRIOR song, whose mode is now fixed: a leftover non-split graph resolves to `denied`, so
				// `mixGateFor` withholds the mix rather than downmixing it.
				if (!mixSettled) mixSettled = true;
			} else {
				void masterGraph
					.ensureRouted()
					.catch(() => {})
					.finally(() => {
						// Settle on success AND failure: this only says "the attempt is over", never what the src is.
						mixSettled = true;
					});
			}
		}
		// setShift(0) on an un-built graph is a no-op, so nothing is constructed until a real shift is asked for.
		if (needsShift(shift) && !masterGraph) masterGraph = new PitchShiftGraph(v);
		// `setShift` resolves whether or not the graph routed, and one that did not leaves the song audible but UNSHIFTED,
		// so the page is told and can ask for the tap that would fix it.
		const applied = masterGraph?.setShift(shift);
		if (applied) {
			void applied
				.catch(() => {})
				.then(() => {
					// Only the slot the viewer is looking at may raise a hint.
					if (!active || !visible) return;
					// A shift was asked for and the graph is there but did NOT route: audible, unshifted, and the tap
					// that would fix it is the only remedy. Everything else — no shift wanted, no graph, or a routed
					// one — is nothing pending.
					const stuck = needsShift(shift) && !!masterGraph && !masterGraph.isRouted;
					if (stuck) onpitchblocked?.();
					else onpitchrouted?.();
				});
		} else if (!needsShift(shift) && active && visible) {
			// No graph and no shift wanted: the keyShift-0 invariant path. Nothing is pending.
			onpitchrouted?.();
		}
		// BOTH levels here too: the level effect's deps are `master` and `effectiveMasterLevel` only and `masterGraph` is a
		// plain variable, so on the first ± an attenuated song jumps to FULL volume and a fresh graph's guide goes silent.
		masterGraph?.setGain(effectiveMasterLevel);
		masterGraph?.setGuideGain(effectiveGuide);
	});

	function fileSrc(m: PlaybackSnapshot): string {
		// No per-key files — transposition happens in the browser. On a GUIDE-MIX song this may be the 4-channel mix, but
		// only once the split graph has captured the element and confirmed a running context; `mixGateFor` folds in BOTH
		// halves, because `isRouted` alone let a leftover non-split graph take the mix and downmix it.
		const plan = masterSrcPlan(guidePlan, playbackRef(m), mixGateFor(masterGraph, mixSettled));
		// `plan.mixed` is the src's own claim. Asserting it against the graph turns a disagreement into a loud
		// failure instead of a room full of full-volume vocals.
		if (plan.mixed && !(masterGraph?.isSplit && masterGraph.isRouted)) {
			console.error('[tv] refusing a 4-channel src with no split graph - this would downmix the vocals');
			return `/media/${playbackRef(m)}`;
		}
		return plan.ref ? `/media/${plan.ref}` : '';
	}

	/**
	 * Assign the src ONLY when the resolved STRING changes: assigning `HTMLMediaElement.src` RELOADS the resource
	 * and resets `currentTime` to 0 even when the URL is byte-identical, and catalog churn rebuilds the media
	 * objects, so a markup binding would reassign on identity alone.
	 */
	$effect(() => {
		if (!master) return;
		// `playable` is the WHOLE condition the {#if} gates on, so reaching here with `master` still bound but
		// `playable` false is ALWAYS transient churn, never a song genuinely leaving.
		const playable = !!media && isPlayable(media);
		// Read the settled signal so this effect re-runs when the routing attempt finishes: the graph's getters
		// cannot wake an effect, and while this is false `masterSrcPlan` commits no src at all on a mix song.
		void mixSettled;
		const resolved = playable ? fileSrc(media) : '';
		// Compare against what the ELEMENT ACTUALLY HOLDS: the attribute is authoritative and cannot go stale, and
		// `getAttribute` round-trips because every src assigned here is root-relative, where `master.src` absolutises.
		const decision = nextVideoSrc(master.getAttribute('src') ?? '', resolved, playable);
		// An EMPTY src (a playable song whose mix decision is still pending) is NEVER assigned: `src = ''` raises
		// MEDIA_ELEMENT_ERROR "Empty src attribute", which reads as a dead file and skips the singer's song. The element
		// keeps what it has until the gate settles; the transport, keyed on `currentSrc`, holds it meanwhile. This is a
		// screen that took the seat mid-song, building the guide graph for its next song for the first time.
		// And while it is pending the element is PAUSED: what it holds is the PREVIOUS song (a skip onto a guide-mix song
		// whose slot has no routed graph yet), which would otherwise play on, rewound by the new song's seek, under the
		// new singer's card until the gate settles. Main dropped the new song outright in that case.
		if (decision.changed) {
			if (decision.src) {
				master.src = decision.src;
				// The reload now owns the held resume: its own `canplay` applies it.
				redecideResume = false;
			} else master.pause();
		} else if (redecideResume && resolved && mixSettled) {
			// The re-decide settled on the src the element already plays (routing degraded): nothing reloads, so the held
			// resume would wait for a later re-buffer's `canplay` and jump the song back to the claim. Drop it.
			redecideResume = false;
			resumeTarget = undefined;
		}
		// A NOT-PLAYABLE pass must leave BOTH shadows AND the element's src untouched: clearing `currentSrc` tells the
		// transport the still-playing song has no src. The two are written in LOCKSTEP, or a half-stale entry token
		// reintroduces the silent second turn.
		if (playable) {
			currentSrc = resolved;
			currentEntryId = entryId;
		}
	});
</script>

<!-- The two slots share one box, so which of them is on top IS the crossfade. -->
<div class={['slot', { visible }]} style="z-index:{visible ? 'var(--z-tv-video-active)' : 'var(--z-tv-video)'}">
	{#if media && isPlayable(media)}
		<!--
			THE MASTER, and the ONLY media element. It owns the clock: play/pause, currentTime, `ended`, and the
			position telemetry the lyrics overlay and the room's progress bar both run on.
		-->
		<!-- `onerror` skips the song only for an element that HOLDS a src. That is a BACKSTOP: nothing assigns an empty src
		     (the src effect above), so an error with none is never a dead file and must not end the singer's turn. -->
		<audio
			bind:this={master}
			muted={silent}
			preload="auto"
			oncanplaythrough={() => (masterReady = true)}
			oncanplay={() => applyResume()}
			onplay={() => active && visible && onplayingchange?.(true)}
			onpause={() => active && visible && onplayingchange?.(false)}
			onended={() => {
				if (active && visible) onplayingchange?.(false);
				onended?.();
			}}
			onerror={() => checkStall()}
			ontimeupdate={() => {
				// A resume is pending on the playing slot (a reload's first `timeupdate` reads 0 before `canplay` seeks it
				// back): saying 0 would flip the lyrics and send the room a position it never had.
				if (active && resumeTarget !== undefined) return;
				if (master) onposition?.(master.currentTime, master.duration);
			}}
		></audio>
	{/if}
</div>

<style>
	.slot {
		position: absolute;
		inset: 0;
		opacity: 0;
		pointer-events: none;
	}
	/* The swap CROSSFADE, opacity only and GPU-composited — and opt-in, so a reduced-motion stage hard-cuts between
	   slots instead. The cut is the honest degradation here: the gapless swap is already sample-accurate. */
	@media (prefers-reduced-motion: no-preference) {
		.slot {
			transition: opacity var(--motion-base) ease;
		}
	}
	.slot.visible {
		opacity: 1;
	}
	/* `display: none` on an <audio> element does NOT stop it playing — unlike a <video>, there is no render surface
	   for the compositor to skip, so the master can be hidden outright rather than sized and letterboxed. */
	audio {
		display: none;
	}
</style>
