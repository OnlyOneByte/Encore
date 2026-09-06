<script lang="ts">
	// One media surface (slot A or B). Plays the separated instrumental through an <audio>.
	// Reports ready/ended up so the GaplessController can orchestrate the swap.
	//
	// WHY <audio> AND NOT <video>. There is no picture to show. `playbackRef` resolves to exactly one
	// thing — the separated instrumental — so this element has never had a video track to render, and
	// the <video> it used to be existed only to be neutralised with CSS (letterboxed by
	// `object-fit: contain`, then forced transparent so its default black background stopped covering
	// the room's stage). A <video> is also the stricter element for codec support: browsers gate
	// container/codec pairs differently there than in <audio>, and WebKit in particular documents FLAC
	// for <audio>. Playing an audio-only stream through the audio element removes a whole class of
	// "decodes, advances, makes no sound" from the picture.
	//
	// THE GUIDING TRACK. A second, secondary <audio> carries the isolated vocals and FOLLOWS the
	// instrumental, with its volume set to the guide level. The instrumental stays the master: it keeps
	// owning play/pause, currentTime, `ended`, and every telemetry callback the gapless state machine
	// and the lyrics overlay run on. Nothing about the existing playback path changes, which is the
	// reason this is two media elements rather than a WebAudio graph — a graph buys sample-exact lock
	// and effects at the cost of rebuilding the part that already works.
	import { playbackRef, isPlayable } from '@encore/shared';
	import type { PlaybackSnapshot } from './catalog';
	import { untrack } from 'svelte';
	import { GUIDE_PREROLL_ALIGN_SEC, guideCorrection, seekPlan } from './guide-sync';
	import { nextVideoSrc } from './video-src';
	import { transportFor, slotHoldsSrc } from './transport';
	import { PitchShiftGraph, needsShift } from './pitch-shift';
	interface Props {
		// A `PlaybackSnapshot`, not a live `Media` (#396). The brand makes this a compiler boundary: the
		// page cannot hand this slot a catalog record that a cook can still change underneath it, so the
		// player observes a song's fields as they were when the slot was assigned and at no other time.
		media: PlaybackSnapshot | null;
		visible: boolean;
		active: boolean; // is this the playing slot (vs the hidden pre-warming slot)
		playing?: boolean; // playback:state.isPlaying — pause/resume from the phone
		seekSec?: number; // playback:state.positionSec — jump the video when the phone seeks
		// Bumped by every `playback:state` (server `rev`). Tracked by the seek effect so a restart
		// whose reported position EQUALS the last one still re-takes the seek decision — a restart
		// under the jump threshold writes 0 over 0, which a `$state` (strict `===`) never notifies,
		// so `seekSec` alone would leave the effect asleep and the song would not restart (#95).
		seekRev?: number;
		keyShift?: number; // ± semitones for a file song — selects the keyed instrumental
		guideLevel?: number; // 0..1 — how loud the original vocals sit under the instrumental
		// Fires ONLY while this slot is the visible one. Drives the controller's onVisibleReady, which
		// flips `loading` -> `playing`. Gating it on visibility is load-bearing: the hidden pre-warming
		// slot buffers a whole song ahead of time, so if it reported here it would flip the room to
		// `playing` over the visible slot's black frame (P1). Hidden readiness has its own callback.
		onready?: () => void;
		// Fires when the buffer is settled REGARDLESS of visibility — the gapless pre-warm signal. The
		// controller only acts on it when the id matches the slot it is warming, so the visible slot
		// calling this is a documented no-op.
		onprewarmed?: () => void;
		onended?: () => void;
		onerror?: () => void; // dead/unplayable media — caller should skip
		onposition?: (sec: number, dur: number) => void;
		// The instrumental's play() rejected with NotAllowedError — the browser's autoplay policy blocked
		// it and the room is silent until a user gesture authorises playback. A TV wall display registers
		// no gesture on its own, so the page surfaces an on-screen "tap to start" affordance in response.
		// This fires ONLY from the active+visible slot, so the hint tracks the room the viewer is looking
		// at rather than the hidden pre-warming slot (which is deliberately paused and would never block).
		onautoplayblocked?: () => void;
		// A gesture (or a later transport re-attempt) got the instrumental playing after a block — the
		// page can retract the hint.
		onautoplayrecovered?: () => void;
		// Whether the MASTER element is actually running right now, reported from its own `play`/`pause`/
		// `ended` events — the honest counterpart to the room's `playing` INTENT prop (#393). Fires ONLY
		// from the active+visible slot (like `onautoplayblocked`) so the hidden pre-warming slot, which is
		// deliberately paused, cannot report the room as stopped. The page feeds this to `lyricsAdvancing`
		// so the reel freezes when the element is not advancing (autoplay refused, or media not playable)
		// even though the server still says the room intends to play.
		onplayingchange?: (playing: boolean) => void;
	}
	let {
		media,
		visible,
		active,
		playing = true,
		seekSec,
		seekRev,
		keyShift = 0,
		guideLevel = 0,
		onready,
		onprewarmed,
		onended,
		onerror,
		onposition,
		onautoplayblocked,
		onautoplayrecovered,
		onplayingchange
	}: Props = $props();

	let master: HTMLAudioElement | undefined = $state();
	let vocals: HTMLAudioElement | undefined = $state();

	// Lazily-built pitch-shift graphs, one per element (master instrumental + optional guide vocals).
	// Declared here so both the volume effect and the shift-wiring effect below reference the same
	// instances. Not $state — nothing renders off them; they are imperative WebAudio handles.
	let masterGraph: PitchShiftGraph | undefined;
	let guideGraph: PitchShiftGraph | undefined;

	/**
	 * How the guide is held against the master — and specifically why it is NOT held with seeks.
	 *
	 * Two independent media elements are not sample-locked, so the guide is always drifting. The
	 * obvious correction — assign `vocals.currentTime` — is the wrong tool at this scale: setting
	 * `currentTime` flushes the decoder and re-primes the buffer, which is an audible discontinuity.
	 * Correcting a 40ms drift on the master's ~4Hz `timeupdate` therefore meant a decoder flush every
	 * few hundred ms, heard as a faint continuous crackle under the instrumental. The nudge was never
	 * the cheap half of that trade; it was the expensive half.
	 *
	 * The policy itself lives in `guide-sync.ts` as a pure function, so it can be tested without two
	 * real media elements. This component only applies the answer.
	 */

	/**
	 * Pre-roll alignment only. Before the guide is playing a seek costs nothing, so it stays a seek.
	 * The tolerance itself lives in `guide-sync.ts` — the same one the jump path re-aligns to, so the
	 * two cannot drift apart.
	 */

	/**
	 * How long to wait for the guide to become playable before giving up on it for this slot.
	 *
	 * This exists because `onready` gates the gapless swap. Waiting for BOTH elements is correct — a
	 * slot whose guide has not buffered would start the song with silence where the guide should be —
	 * but waiting FOREVER would let one stalled audio fetch cost the room the song entirely. `onerror`
	 * covers a 404 or a decode failure; this covers a fetch that simply never resolves.
	 */
	const GUIDE_READY_TIMEOUT_MS = 4000;

	// The vocals stem is rendered at key 0. It USED to be force-muted whenever keyShift !== 0, because
	// mixing key-0 vocals under a +2 instrumental is musically wrong — but muting it meant the singer
	// lost their guide the moment they transposed, which is exactly when a guide is most wanted. Now the
	// guide is pitch-shifted by the SAME amount as the instrumental (see the two PitchShiftGraphs below),
	// so it stays in key with what is playing and the level applies unchanged at any shift.
	const effectiveGuide = $derived(Math.max(0, Math.min(1, guideLevel)));

	const guideRef = $derived(media?.vocalsRef ?? null);
	/**
	 * The guide element is mounted only while it is actually wanted. That is what keeps the default
	 * free: the feature ships at 0, and a room that never turns it on must not pay to decode a second
	 * stream in silence. A room that DOES set a default pays one extra preload per slot — which is
	 * exactly what it asked for.
	 */
	const wantsGuide = $derived(!!guideRef && !!media && isPlayable(media) && effectiveGuide > 0);

	// ── readiness ──────────────────────────────────────────────────────────────
	// The slot is ready for a gapless swap only when everything it will play can play. Announcing on
	// the master alone would start a song whose guide had not buffered — silence where the guide should
	// be, for the first seconds of every song. `guideSettled` means "stop waiting": ready, failed, or
	// timed out.
	let masterReady = $state(false);
	let guideSettled = $state(false);
	// Two independent latches, because the two reports mean different things and fire on different
	// conditions. `prewarmedFired` guards the buffer-settled signal (any visibility, once per song);
	// `visibleReadyFired` guards the visible-ready signal (only while visible). They are separate
	// because a slot that buffers WHILE HIDDEN and is later swapped to visible must still fire
	// onready then — a single latch shared with the pre-warm report would already be spent, and the
	// room would flip to `playing` off a stale signal or (before this split) off the hidden slot.
	let prewarmedFired = $state(false);
	let visibleReadyFired = $state(false);
	// The src the element currently holds, tracked as the reactive signal the transport effect gates on
	// (the authoritative copy is the element's own `src` attribute — see the assign effect). Declared here
	// with the other slot state.
	let currentSrc = $state<string>('');

	// True while the master's play() has been REFUSED by the browser's autoplay policy (NotAllowedError)
	// and nothing has yet un-stuck it. A plain <audio> in a page that never received a user gesture is
	// refused under the default policy — which is exactly the case a set-and-forget TV wall is in — so
	// the room sits silent with no on-screen way back. This latch drives the one-shot gesture listener
	// below AND the page's "tap to start" hint (via onautoplayblocked). It is NOT $state's business to
	// know it is a TV: any refused autoplay, on any surface, arms the same recovery.
	let autoplayBlocked = $state(false);

	// The song this slot has already reset for. A PLAIN variable, not `$state`: it is the guard's own
	// bookkeeping and nothing renders off it.
	let resetForId: string | null | undefined;

	// A new song in this slot forgets the previous one's readiness. Without this a re-warmed slot never
	// reports ready again and the gapless swap stalls on it.
	//
	// GUARDED ON THE ID *VALUE*, not on the `media` signal — this is the second half of the pause bug.
	// `media` is a prop whose OBJECT IDENTITY churns constantly: any queue mutation anywhere in the room
	// (including the `queue:patch` that a pause itself produces) makes the TV route rebuild its media
	// catalog, so the slot receives a brand-new object with byte-identical fields for the song that is
	// already playing. Svelte tracks the signal, so this effect re-ran on every one of those and reset a
	// mid-song slot: readiness latches cleared (and `canplaythrough` will NOT fire again on an element
	// that has already loaded, so `onready`/`onprewarmed` were spent forever), and the pitch-shift graphs
	// torn down under a transposed song. Comparing the id STRING makes "same song, new object" a no-op,
	// which is exactly the distinction `video-src.ts` exists to draw one layer down.
	//
	// The teardown is imperative rather than an effect cleanup for the same reason: Svelte runs a
	// returned cleanup before EVERY re-run, so as a cleanup it fired on all that identity churn too. It
	// is now reached only on a genuine song change, plus once on destroy from the effect below.
	$effect(() => {
		const id = media?.id ?? null;
		if (id === resetForId) return;
		resetForId = id;
		// Per-song graph handling. A PitchShiftGraph binds a PERMANENT MediaElementAudioSourceNode to
		// its element: once captured, the element outputs ONLY through the graph, and detach() frees the
		// context but CANNOT restore the native path (pitch-shift.ts:492-497). So the reset strategy has
		// to match each element's LIFETIME, not the media's:
		//
		//   • MASTER lives as long as the SLOT — the <audio bind:this={master}> below is mounted
		//     unconditionally. Detaching its graph on a song change left the persistent, already-captured
		//     element feeding a disconnected node: the instrumental went silent and stayed silent until a
		//     keyShift rebuilt a graph on it (issue #477). We must NOT detach it. Instead reset it to
		//     ratio 1 via setShift(0): on a routed graph that keeps source→node→gain→destination intact
		//     and merely posts ratio 1 (pitch-shift.ts:150), so the element stays audible on the new song;
		//     on an un-built graph it is a documented no-op. Teardown happens only on slot unmount (the
		//     destroy effect below).
		//   • GUIDE lives as long as the SONG — its <audio> sits behind {#if wantsGuide && guideRef} and
		//     is remounted per song, so the previous graph's captured element is already gone. Detach the
		//     stale graph and drop the reference; the shift-wiring effect rebuilds against the fresh
		//     `vocals` element.
		void masterGraph?.setShift(0);
		guideGraph?.detach();
		guideGraph = undefined;
		masterReady = false;
		guideSettled = false;
		prewarmedFired = false;
		visibleReadyFired = false;
		// NOTE: `currentSrc` is deliberately NOT cleared here. It used to be, to cover a slot whose
		// element had been remounted (fresh element, no src, but a stale `currentSrc` claiming otherwise)
		// — and that clearing is what reloaded the playing song on every identity change, because the
		// assign effect then rewrote a byte-identical src and `HTMLMediaElement.src` reloads and resets
		// currentTime to 0 even when the string is unchanged. The assign effect now compares against what
		// the ELEMENT actually holds, so a remount is detected from the element itself and no shadow copy
		// can go stale.
	});

	// Component destroy: release whatever is still wired. Its own effect, with no tracked dependencies,
	// so it never re-runs and its cleanup means exactly "this slot is going away".
	$effect(() => {
		return () => {
			masterGraph?.detach();
			guideGraph?.detach();
			masterGraph = undefined;
			guideGraph = undefined;
		};
	});

	// Buffer settled. Report it as a pre-warm signal on ANY slot — the controller ignores it unless the
	// id is the one it is warming (the visible slot's call is a no-op). This is what lets the hidden
	// slot advertise a gapless-ready next song.
	$effect(() => {
		if (masterReady && (guideSettled || !wantsGuide) && !prewarmedFired) {
			prewarmedFired = true;
			onprewarmed?.();
		}
	});

	// Visible-ready. Fires only when THIS slot is the one on screen and its buffer is settled. Because
	// it also depends on `visible`, a slot that settled while hidden fires this the moment a gapless
	// swap makes it visible — exactly when the room should leave `loading` for `playing`. It never
	// fires from the hidden pre-warming slot, so a pre-buffered next song can no longer flip the room
	// to playing over the visible slot's black frame.
	$effect(() => {
		if (visible && masterReady && (guideSettled || !wantsGuide) && !visibleReadyFired) {
			visibleReadyFired = true;
			onready?.();
		}
	});

	// Give up on a guide that neither loads nor errors, so one stalled fetch cannot strand the slot.
	$effect(() => {
		if (!wantsGuide || guideSettled) return;
		const t = setTimeout(() => {
			guideSettled = true;
		}, GUIDE_READY_TIMEOUT_MS);
		return () => clearTimeout(t);
	});

	/**
	 * The transport for this slot — ONE decision, shared by the master and the guide.
	 *
	 * Shared deliberately: "the guide mirrors the master's transport exactly" is a claim two separate
	 * copies of the same condition can only keep by luck, and the version of that claim which drifted is
	 * how a silent master still produced an audible vocals-only mix. Derived, so both effects re-run on
	 * the same inputs at the same time.
	 *
	 * `currentSrc` is the load-bearing input. See `transport.ts`: `play()` before the src is assigned is
	 * undone by the assignment itself, so the transport must depend on the src having landed rather than
	 * racing the effect that assigns it.
	 */
	const transport = $derived(
		transportFor({
			// #374: the element must be holding THIS song's src, not merely SOME src. `currentSrc` holds
			// the previous song's URL across a change (it is never cleared, only rewritten on a playable
			// pass by the assign effect below), so `!!currentSrc` stayed stale-true and the transport kept
			// the same `'play'` value — a memoized derived whose value does not change never re-runs the
			// effect, so nothing replayed play() after the new src landed. Comparing to the resolved src
			// gives an `idle -> play` value edge exactly when the new src lands.
			hasSrc: slotHoldsSrc(currentSrc, media && isPlayable(media) ? fileSrc(media) : null),
			playable: !!media && isPlayable(media),
			active,
			visible,
			playing
		})
	);

	// Keep the master's play/pause in sync with slot state AND the paused/playing command from the
	// phone — but only once the element is actually HOLDING its media.
	//
	// THE BUG THIS CLOSES. The src is assigned from an effect declared BELOW this one, so this effect
	// used to run first and call `play()` on an element with no src. The assignment then invoked the
	// media load algorithm, which sets `paused` back to true and rejects the pending play() with
	// AbortError — swallowed by the `.catch`. Nothing re-ran this effect afterwards, so the master
	// stayed paused at 0 forever: no sound, no `ontimeupdate`, no telemetry, and a server position
	// frozen at 0 that the phone and the lyrics both read as "the beginning" on every pause.
	$effect(() => {
		if (!master) return;
		if (transport === 'idle') return;
		if (transport === 'pause') {
			master.pause();
			return;
		}
		// An autoplay refusal must degrade to a silent room, never to a stalled song — but it must not
		// degrade SILENTLY, and it must not degrade PERMANENTLY. Swallowing every rejection is what let the
		// AbortError above go unseen through two rounds of diagnosis, so name the reason; and a
		// NotAllowedError (the autoplay policy) is not terminal — it is exactly the state a user gesture
		// can lift, so it arms the recovery path (the gesture listener + the page hint) rather than ending
		// there. AbortError here still means a genuine interruption (a real src change), not the
		// self-inflicted one this effect used to cause.
		void tryPlayMaster();
	});

	/**
	 * Play the master, tracking whether the browser's autoplay policy refused it.
	 *
	 * This is the ONE place that resolves a `master.play()` promise, so it is the one place that can tell
	 * a genuine "the room will be silent" from a "the room is silent UNTIL a tap". A NotAllowedError is
	 * the latter: the platform blocked autoplay and only a user gesture can authorise playback. On a TV
	 * wall that gesture may never come on its own, so we raise `autoplayBlocked` (which surfaces the hint
	 * and arms the gesture listener) instead of logging and giving up. Any other rejection (AbortError
	 * from a real src change, a decode failure) is logged and left alone — those are not gesture-liftable.
	 *
	 * CRITICALLY, this touches ONLY the plain <audio> element. It constructs no AudioContext and no
	 * MediaElementSource — see pitch-shift.ts: a MediaElementSource is a PERMANENT capture, so eagerly
	 * wrapping the element to "solve" autoplay would commit all room audio to WebAudio forever. Resuming
	 * playback is a property of the element; the pitch graph stays built lazily on the first non-zero
	 * shift, exactly as before.
	 */
	async function tryPlayMaster(): Promise<void> {
		if (!master) return;
		try {
			await master.play();
			// It is playing. If we had been blocked, the room just recovered — retract the hint and tell
			// the page. Guarded on the latch so a normal successful play does not spam the callback.
			if (autoplayBlocked) {
				autoplayBlocked = false;
				onautoplayrecovered?.();
			}
		} catch (err: unknown) {
			const name = err instanceof Error ? err.name : String(err);
			if (name === 'NotAllowedError') {
				// Autoplay was blocked — recoverable by a gesture, so latch it rather than treat it as final.
				// Announce to the page only from the slot the viewer is actually looking at, so the hidden
				// pre-warming slot (paused, never really trying to play) cannot raise a phantom hint.
				if (!autoplayBlocked) {
					autoplayBlocked = true;
					console.warn('[tv] autoplay was blocked (NotAllowedError) — waiting for a tap to start the music');
					if (active && visible) onautoplayblocked?.();
				}
			} else {
				console.warn(`[tv] the instrumental refused to start (${name}) — the room will be silent`);
			}
		}
	}

	// Recovery from a blocked autoplay. A user gesture ANYWHERE on the page (a tap on the TV's own
	// touchscreen, a click from a paired remote, a keypress) authorises playback for this document, so on
	// such a gesture we re-attempt the master's play() SYNCHRONOUSLY inside the handler — the play() must
	// share the gesture's task to consume the user activation. The listener is NOT `once`: it is torn
	// down by this effect's cleanup, which runs when `autoplayBlocked` clears (a successful re-attempt
	// flips the latch inside tryPlayMaster). So a gesture that does NOT recover playback (rare, but a
	// second attempt is free) leaves the listener armed for the next one, while a recovery removes it and
	// a TV that recovered pays nothing thereafter. We re-align and re-start the guide too, so a recovered
	// master never leaves the guide silent behind it.
	//
	// It does NOT build a WebAudio graph: this is a bare element.play(), so the keyShift===0 invariant —
	// no AudioContext, no MediaElementSource unless a shift is actually applied — is untouched. A pending
	// non-zero shift is applied by the pitch-shift effect on its own inputs, independently of this retry.
	$effect(() => {
		if (!autoplayBlocked) return;
		if (typeof window === 'undefined') return;
		const onGesture = () => {
			void tryPlayMaster();
			// Bring the guide along if it is mounted and wanted — it obeys the same transport, but its own
			// play() was refused by the same policy, so it needs the same nudge.
			if (vocals && transport === 'play') {
				if (Math.abs(vocals.currentTime - (master?.currentTime ?? 0)) > GUIDE_PREROLL_ALIGN_SEC) {
					vocals.currentTime = master?.currentTime ?? 0;
				}
				vocals.playbackRate = 1;
				vocals.preservesPitch = true;
				vocals.play().catch(() => {});
			}
		};
		// `capture` so it sees the gesture even if something downstream stops propagation. Passive: we
		// never preventDefault. Not `once` — removal is the effect cleanup's job (fires when the block
		// clears), so a non-recovering gesture leaves the listener armed for the next attempt.
		const opts: AddEventListenerOptions = { capture: true, passive: true };
		window.addEventListener('pointerdown', onGesture, opts);
		window.addEventListener('keydown', onGesture, opts);
		return () => {
			window.removeEventListener('pointerdown', onGesture, opts);
			window.removeEventListener('keydown', onGesture, opts);
		};
	});

	// The guide mirrors the master's transport exactly — the SAME `transport` value, so it can never run
	// ahead of an instrumental that is not playing. A rejected play() is swallowed the same way the
	// master's is: an autoplay refusal on the guide must degrade to a silent guide, never to a stalled
	// song.
	$effect(() => {
		if (!vocals || !master) return;
		if (transport === 'play') {
			// Line it up BEFORE starting, so the guide does not enter a couple of seconds behind and get
			// dragged forward audibly by the first governor tick. A seek here is free — nothing is
			// audible yet — which is exactly why the governor below does not use one.
			if (Math.abs(vocals.currentTime - master.currentTime) > GUIDE_PREROLL_ALIGN_SEC) {
				vocals.currentTime = master.currentTime;
			}
			// Start from neutral; the governor re-derives any trim it still needs from real drift.
			vocals.playbackRate = 1;
			// A tempo trim must never become a pitch shift on a sung vocal. Set explicitly rather than
			// trusting the default, which is not uniform across browsers.
			vocals.preservesPitch = true;
			vocals.play().catch(() => {});
		} else {
			vocals.pause();
			vocals.playbackRate = 1;
		}
	});

	// The level itself — the whole "how loud are the original vocals" knob. Set on the element for the
	// native (unshifted) path AND on the guide graph, because once the guide is routed through WebAudio
	// for a shift the element's `volume` is bypassed and only the graph's gain governs it.
	$effect(() => {
		if (vocals) vocals.volume = effectiveGuide;
		guideGraph?.setGain(effectiveGuide);
	});

	// Reposition on a real JUMP — a restart, a scrub, a skip, or a reconnect whose position has moved on.
	// ONE-LINE DEPENDENCY SET, ON PURPOSE (#396 — read this before adding a read to it).
	//
	// The whole body is a named function so that this effect's tracked reads are the two lines you can
	// see, and auditable at a glance rather than by tracing which of a dozen reads happens to be
	// reactive. Everything the decision NEEDS — the elements, the snapshot, the slot's activity — is an
	// INPUT, read inside `applySeek` through `untrack`, never a reason to re-take the decision.
	//
	// THE BUG THIS CLOSES, and why the shape matters more than the fix. `media` used to be read here as
	// a tracked dependency (`if (!master || !media || !isPlayable(media) ...)`), so ANY fresh Media
	// identity re-ran this effect and re-applied `seekSec` — the position from the last playback
	// COMMAND, which is stale by design (position telemetry deliberately does not broadcast). When a
	// cook for an unrelated song churned the catalog, the playing song's playhead was yanked back to
	// wherever the last pause/seek/restart had left it. Not to 0 — to an earlier part, which is why four
	// fixes aimed at the src-assignment path (whose signature is "restarts from 0") all missed it.
	//
	// The snapshot seam in `catalog.ts` closes that independently, at the source. This closes it here,
	// at the consumer. Both, deliberately: a boundary and a scoped dependency set are two reasons the
	// class stays shut, and the reason the NEXT consumer wired into this component cannot re-open it.
	$effect(() => {
		// Dependency 1: the position a playback COMMAND asked for.
		const target = seekSec;
		// Dependency 2: the server `rev`, bumped by every `setPlayback` (restart, pause, seek, key…) but
		// never by position telemetry (`setPosition` leaves rev alone and does not broadcast). Tracking it
		// re-takes the seek decision on a restart-to-0 from under the jump threshold — which writes 0 over
		// 0 and so notifies nothing through `seekSec` alone (#95) — WITHOUT reopening telemetry-chasing.
		// A bare read is enough to register the dep in runes mode.
		void seekRev;
		if (target === undefined) return;
		applySeek(target);
	});

	/**
	 * Apply a seek target to both elements, from one plan. Called ONLY by the effect above.
	 *
	 * Every read in here is `untrack`ed. That is not incidental tidiness — it is the invariant: an
	 * input to the decision must never become a trigger for it. `vocals` is the original case (the guide
	 * MOUNTING would otherwise re-run the seek and yank the master to a stale position); `media`,
	 * `master` and `active` are the same argument, and `media` is the one that caused #396.
	 *
	 * BOTH ELEMENTS MOVE, FROM ONE PLAN. This used to reposition the master alone. The guide then kept
	 * playing from wherever it already was, and recovery fell to `syncGuide`'s governor — which is built
	 * for continuous drift and deliberately prefers a tempo trim to a seam, so it closed a whole-song
	 * discontinuity at 2% (a crawl) and never hard-resynced once the residual landed back inside the trim
	 * band. A jump is not drift: it is corrected the way the pre-roll is, with a seek on both elements at
	 * the same moment. The master already has a seam here, so the guide's costs nothing extra. `seekPlan`
	 * owns the two thresholds and the reason `guide` is gated on `master`.
	 *
	 * Only a jump (> SEEK_JUMP_SEC from where we are) acts, so the ~4Hz position telemetry and
	 * pause/resume (which carry the current position) don't fight the playhead.
	 */
	function applySeek(seekTarget: number): void {
		const el = untrack(() => master);
		const snap = untrack(() => media);
		const isActive = untrack(() => active);
		if (!el || !snap || !isPlayable(snap) || !isActive) return;
		// A guide that is not mounted has no playhead to compare; NaN reads as "needs the seek" and is
		// then skipped by the `guideEl` guard below, so the master's half of the plan is unaffected.
		const guideEl = untrack(() => vocals);
		const plan = seekPlan(el.currentTime, guideEl ? guideEl.currentTime : NaN, seekTarget);
		if (!plan.master) return;
		el.currentTime = seekTarget;
		if (guideEl) {
			if (plan.guide) guideEl.currentTime = seekTarget;
			// Back to neutral tempo. Any trim still on the element was derived from the drift that
			// existed BEFORE the jump, so carrying it across corrects a drift that no longer exists; the
			// governor re-derives whatever it needs from real drift on its next tick.
			guideEl.playbackRate = 1;
		}
	}

	// ── pitch shift (the ± semitone transpose, made audible) ─────────────────────────────────────────
	//
	// ONE graph per element (master instrumental + optional guide vocals), built LAZILY on the first
	// non-zero shift. See pitch-shift.ts for the full trap write-up; the short version enforced here:
	//
	//   • keyShift 0 -> we never construct a graph, so the audio path is byte-for-byte today's plain
	//     <video>/<audio>. This must never regress: a broken shift is bad, killing all room audio is
	//     catastrophic.
	//   • only the ACTIVE slot shifts. The hidden pre-warming slot is paused, and a MediaElementSource
	//     is a PERMANENT capture — so wrapping the hidden element early would commit it to WebAudio
	//     before it is even playing, for no benefit. keyShift is a room-wide value; when this slot
	//     becomes active the effect re-runs and applies it.
	//   • the graph resumes its own context; if it cannot (the wall was never clicked) it degrades to
	//     audible-but-unshifted rather than to silence — handled inside PitchShiftGraph.
	//
	// Graphs are created on demand and torn down per media change by the reset effect above (its
	// cleanup detaches them before this effect rebuilds against the fresh element), and on component
	// destroy.
	$effect(() => {
		// Read reactive deps up front so the effect re-runs when any of them change.
		const shift = active ? keyShift : 0;
		const v = master;
		const g = vocals;
		if (!v) return;
		// Master. Only ever build the graph once there is a real shift to apply; setShift(0) on an
		// un-built graph is a documented no-op.
		if (needsShift(shift) && !masterGraph) masterGraph = new PitchShiftGraph(v);
		masterGraph?.setShift(shift);
		// Guide, when it is mounted. Shifting it by the SAME amount is what lets us keep it audible under
		// a transposed instrumental instead of muting it.
		if (g) {
			if (needsShift(shift) && !guideGraph) guideGraph = new PitchShiftGraph(g);
			guideGraph?.setShift(shift);
		}
	});

	function fileSrc(m: PlaybackSnapshot): string {
		// The SINGLE separated instrumental — there are no per-key files any more. Transposition happens
		// in the browser via the PitchShiftGraph below, so the src never depends on keyShift and can
		// never 404 on a variant nothing rendered (the whole reason the TV used to ignore the shift).
		// playbackRef is the separated instrumental; sourceRef is the ORIGIN and is never played.
		return `/media/${playbackRef(m)}`;
	}

	/**
	 * The src the element currently holds, tracked so we assign it ONLY when the resolved string
	 * actually changes.
	 *
	 * Bug A: an unrelated cook finishing rebroadcasts a full `queue:sync`, and the TV route rebuilds
	 * its media catalog into fresh object identities — including the one currently playing. A markup
	 * binding `src={fileSrc(media)}` re-evaluates on that identity change and reassigns the element's
	 * src, and assigning `HTMLMediaElement.src` RELOADS the resource and resets `currentTime` to 0 even
	 * when the URL string is byte-identical. `fileSrc`/`playbackRef` are pure in the
	 * media's fields, so an unchanged song resolves to the same string and `nextVideoSrc` makes the
	 * assignment a no-op. The decision lives in `video-src.ts` so it can be tested without a real
	 * element; this effect only applies it.
	 */
	$effect(() => {
		if (!master) return;
		// `playable` is the WHOLE condition the {#if} around the <audio> gates on. It is the pivot of
		// #251: a next-up cook reaching a stage rebroadcasts `queue:sync`, the TV rebuilds its media
		// catalog, and for a churn pass or two the PLAYING slot's `media` prop can read momentarily null
		// (a `mediaOf(current)` miss) or not-yet-`isPlayable`. The element only EXISTS while `media &&
		// isPlayable(media)`, so a song that genuinely leaves UNMOUNTS it and this effect short-circuits
		// on `if (!master) return`. Reaching here with `master` still bound but `playable` false is
		// therefore always that transient churn — one microtask ahead of Svelte tearing the element down.
		const playable = !!media && isPlayable(media);
		const resolved = playable ? fileSrc(media) : '';
		// Compare against what the ELEMENT ACTUALLY HOLDS, not a shadow copy of it. `nextVideoSrc` is
		// documented in terms of "the string last assigned to the element", and the attribute IS that —
		// authoritatively, and with no way to go stale. A shadow variable had two failure modes this does
		// not: cleared while the element still held its src (which rewrote a byte-identical src and
		// reloaded the playing song to 0 — the pause bug), or retained across a remount (which left a
		// fresh, src-less element silent). `getAttribute` round-trips exactly because every src assigned
		// here is the same root-relative string; `master.src` would return an absolutised URL and never
		// compare equal.
		const decision = nextVideoSrc(master.getAttribute('src') ?? '', resolved, playable);
		if (decision.changed) master.src = decision.src;
		// A NOT-PLAYABLE pass must leave BOTH the element's src AND `currentSrc` untouched. Clearing
		// `currentSrc` to '' here would tell the transport effect the still-playing song has no src and
		// stop it (`hasSrc:false`); rewriting the src via the old '' -> removeAttribute -> reassign dance
		// reloaded it to 0. Both are the #251 reset. When nothing is playable we keep the current song
		// exactly as the element holds it; the genuine clear on a real song departure is the {#if}
		// unmount, not this effect.
		if (playable) currentSrc = resolved;
	});

	/**
	 * The drift governor. Runs on the master's existing ~4Hz `ontimeupdate` rather than its own timer,
	 * so the guide is corrected against the clock that actually drives the room.
	 *
	 * It corrects with `playbackRate`, not `currentTime`: see `guide-sync.ts` for why seeking here is
	 * what made the guide crackle.
	 */
	function syncGuide(): void {
		if (!vocals || !master || vocals.seeking) return;
		const correction = guideCorrection(vocals.currentTime, master.currentTime);
		if (correction.kind === 'reseek') vocals.currentTime = master.currentTime;
		// Assign only on a real change: writing playbackRate is not free on every element.
		if (vocals.playbackRate !== correction.rate) vocals.playbackRate = correction.rate;
	}
</script>

<div class="slot" class:visible style="z-index:{visible ? 2 : 1}">
	{#if media && isPlayable(media)}
		<!--
			THE MASTER. An <audio>, not a <video> — see the note at the top of this file. It owns the clock:
			play/pause, currentTime, `ended`, and the position telemetry that the lyrics overlay and the
			room's progress bar both run on.
		-->
		<audio
			bind:this={master}
			preload="auto"
			oncanplaythrough={() => (masterReady = true)}
			onplay={() => active && visible && onplayingchange?.(true)}
			onpause={() => active && visible && onplayingchange?.(false)}
			onended={() => {
				if (active && visible) onplayingchange?.(false);
				onended?.();
			}}
			onerror={() => active && visible && onerror?.()}
			ontimeupdate={() => {
				if (master) onposition?.(master.currentTime, master.duration);
				syncGuide();
			}}
		></audio>
		{#if wantsGuide && guideRef}
			<!-- The guiding track: the isolated vocals, following the master. Never the position source
			     for anything — telemetry, lyrics and progress all read the instrumental. -->
			<audio
				bind:this={vocals}
				src={`/media/${guideRef}`}
				preload="auto"
				oncanplaythrough={() => (guideSettled = true)}
				onerror={() => (guideSettled = true)}
			></audio>
		{/if}
	{/if}
</div>

<style>
	.slot {
		position: absolute;
		inset: 0;
		opacity: 0;
		transition: opacity 0.25s ease; /* crossfade on swap — opacity only, GPU-composited */
		pointer-events: none;
	}
	.slot.visible {
		opacity: 1;
	}
	/*
	 * The master carries no picture, so it is hidden outright rather than sized and letterboxed.
	 *
	 * `display: none` on an <audio> element does NOT stop it playing — unlike a <video>, there is no
	 * render surface for the compositor to skip. This replaces a `width/height/object-fit/background`
	 * block whose whole job was damage control: `object-fit: contain` letterboxed a stream with no video
	 * track, and the element's default background painted the entire screen black, hiding the room's
	 * stage background until it was forced transparent. None of that has anything to answer now.
	 */
	audio {
		display: none;
	}
</style>
