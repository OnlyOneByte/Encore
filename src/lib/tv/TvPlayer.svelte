<script lang="ts">
	// One media surface (slot A or B). Plays the separated instrumental and reports ready/ended up so the
	// GaplessController can orchestrate the swap. See docs/FRONTEND.md#the-stage-and-its-stacking-order.
	//
	// <audio> AND NOT <video>: `playbackRef` resolves to the separated instrumental, which has no video track,
	// and <audio> is the more permissive element for codec support.
	//
	// THE ONE RULE THAT MUST NOT BE BROKEN: the guiding track is channels 2/3 of this ONE element's 4-channel
	// file, and such a file must never reach an element that is not routed through a running split graph, or the
	// browser downmixes it and sums the vocals in at full volume. `guide-mix-src.ts` owns that gate.
	import { playbackRef, isPlayable, guidePath } from '$lib/contract';
	import type { PlaybackSnapshot } from './catalog';
	import { untrack } from 'svelte';
	import { resumeSeekTarget, seekPlan } from './playhead-sync';
	import { masterSrcPlan, wantsEagerGraph, mixGateFor } from './guide-mix-src';
	import { nextVideoSrc } from './video-src';
	import { transportFor, slotHoldsSong, songToken } from './transport';
	import { PitchShiftGraph, needsShift } from './pitch-shift';
	interface Props {
		// A `PlaybackSnapshot`, not a live `Media`. The brand makes this a compiler boundary, so the page
		// cannot hand this slot a catalog record a process can still change underneath it.
		media: PlaybackSnapshot | null;
		// The id of the QUEUE ENTRY, NOT the media/song id: a song queued twice is two entries over ONE media
		// record, so `media.id` and the resolved src are byte-identical across the advance. The transport
		// re-arms on THIS, and without it turn 2 never calls play() and the room goes silent at 0.
		entryId?: string | null;
		visible: boolean;
		active: boolean; // is this the playing slot (vs the hidden pre-warming slot)
		playing?: boolean; // playback:state.isPlaying — pause/resume from the phone
		seekSec?: number; // playback:state.positionSec — jump the video when the phone seeks
		// The server `rev`, tracked by the seek effect so a restart whose reported position EQUALS the last one
		// still re-takes the decision — a restart under the threshold writes 0 over 0, which notifies nothing.
		seekRev?: number;
		keyShift?: number; // ± semitones for a file song — selects the keyed instrumental
		guideLevel?: number; // 0..1 — how loud the original vocals sit under the instrumental
		// The loudness-normalization pulldown, resolved by the route. ATTENUATE-ONLY: never above 1. Applied at
		// BOTH the native and routed sites, because WebAudio capture bypasses `.volume`.
		masterLevel?: number;
		// Gating on visibility is load-bearing: the hidden slot buffers a whole song ahead, so reporting here
		// flips the room to `playing` over the visible slot's black frame.
		onready?: () => void;
		// Fires when the buffer settles REGARDLESS of visibility — the gapless pre-warm signal. The controller
		// only acts on it when the id matches the slot it is warming, so the visible slot's call is a no-op.
		onprewarmed?: () => void;
		onended?: () => void;
		onerror?: () => void; // dead/unplayable media — caller should skip
		onposition?: (sec: number, dur: number) => void;
		// Autoplay was REFUSED and the room is silent until a gesture, which a TV wall never produces on its
		// own. Active+visible only, so the hint tracks the room the viewer is looking at.
		onautoplayblocked?: () => void;
		// A gesture (or a later transport re-attempt) got the instrumental playing after a block — the
		// page can retract the hint.
		onautoplayrecovered?: () => void;
		// Whether the MASTER element is actually running — the honest counterpart to the room's `playing`
		// INTENT. Active+visible only, so the paused hidden slot cannot report the room as stopped. Feeds
		// `lyricsAdvancing`, so the reel freezes when the element is not advancing.
		onplayingchange?: (playing: boolean) => void;
		// An error a gesture CANNOT lift, so the page renders an on-screen state rather than leaving only a
		// console warn nobody at a party reads. Active+visible only.
		onplaybackfailed?: (reason: string) => void;
		/*
		 * A TRANSPOSE WAS ASKED FOR AND COULD NOT ROUTE. With no user activation `PitchShiftGraph` degrades to
		 * audible-but-UNSHIFTED, because capturing into a suspended graph is permanent silence. Without a reader,
		 * a TV that autoplays correctly answers every ± press with nothing. Active+visible only.
		 */
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
		onready,
		onprewarmed,
		onended,
		onerror,
		onposition,
		onautoplayblocked,
		onautoplayrecovered,
		onplayingchange,
		onplaybackfailed,
		onpitchblocked,
		onpitchrouted
	}: Props = $props();

	let master: HTMLAudioElement | undefined = $state();

	// ONE graph, because there is ONE element: the guide rides inside the master's own file, so the split
	// graph IS this graph in `split` mode. Not $state — an imperative WebAudio handle.
	let masterGraph: PitchShiftGraph | undefined;
	/**
	 * Has this song's split-graph routing attempt SETTLED? Two jobs: it is the REACTIVE signal the src effect
	 * needs (`isRouted`/`isSplit` are plain getters and cannot wake an effect), and it is `MixGate`'s
	 * `pending` half — while false the src effect commits NOTHING on a mix song, which is what stops the src
	 * being decided twice and rewritten on a playing element. Reset per SONG, not per graph.
	 */
	let mixSettled = $state(false);

	// The guide is shifted by the SAME amount as the instrumental because it IS the instrumental's file:
	// one worklet, four channels, one ratio, so the guide cannot fall out of key with what is playing.
	const effectiveGuide = $derived(Math.max(0, Math.min(1, guideLevel)));

	// Clamped here as a second guard even though the route already clamps. Attenuate-only: a song is only
	// ever pulled DOWN.
	const effectiveMasterLevel = $derived(Math.max(0, Math.min(1, masterLevel)));

	/** WHICH guide this song offers — one 4-channel mix, or none. No second-element alternative. */
	const guidePlan = $derived(media ? guidePath(media) : ({ kind: 'none' } as const));

	// READINESS. The slot is ready for a gapless swap when its MASTER can play, which is the whole story:
	// the guide lives inside the master's own file, so a master that can play is a guide that can play.
	let masterReady = $state(false);
	// HELD so a cold mount can take it on the master's `canplay` — the element does not exist when the frame
	// arrives on a reload. NOT reactive: read only inside the untracked `applyResume`, so it never re-triggers
	// the seek effect. What keeps a STALE target off the next song is the SERVER publishing `positionSec: 0`
	// with a fresh `rev`. See docs/FRONTEND.md#wake-lock-and-reload-resume.
	let resumeTarget: number | undefined;
	// Two latches, because a slot that buffers WHILE HIDDEN and is later swapped in must still fire onready
	// then, which one shared latch would already have spent.
	let prewarmedFired = $state(false);
	let visibleReadyFired = $state(false);
	// The src the element holds, as the reactive signal the transport effect gates on. The AUTHORITATIVE
	// copy is the element's own `src` attribute — see the assign effect.
	let currentSrc = $state<string>('');
	// Written in LOCKSTEP with `currentSrc`: that alone cannot tell turn 2 of a song from turn 1, since the
	// src is byte-identical, so the transport compares the entry-scoped token and this is its `held` half.
	let currentEntryId = $state<string | null>(null);

	// A plain <audio> in a page that never received a gesture is refused under the default policy — exactly
	// the case a set-and-forget TV wall is in. Drives the gesture listener below AND the page's hint.
	let autoplayBlocked = $state(false);

	// The song this slot has already reset for. A PLAIN variable: guard bookkeeping, nothing renders off it.
	let resetForId: string | null | undefined;

	// GUARDED ON THE ID *VALUE*, not on the `media` signal, whose object identity churns on any queue mutation.
	// Keying on the signal reset a MID-SONG slot: latches cleared — and `canplaythrough` will NOT fire again on
	// a loaded element, so `onready` was spent forever — and the graph was torn down under a transposed song.
	// The teardown is imperative for the same reason: a cleanup runs before EVERY re-run.
	$effect(() => {
		const id = media?.id ?? null;
		if (id === resetForId) return;
		resetForId = id;
		// Per-song graph handling follows the ELEMENT's lifetime, not the media's, because the capture is
		// PERMANENT and detach() cannot restore the native path. The MASTER outlives a song change, so its graph
		// must NOT be detached here — that leaves the captured element feeding a disconnected node. `setShift(0)`
		// keeps the chain intact and is a no-op on an un-built graph.
		void masterGraph?.setShift(0);
		// A song change resets the graph IN PLACE and a graph defaults its gain to 1, so re-assert the pulldown.
		masterGraph?.setGain(effectiveMasterLevel);
		// And the GUIDE pair's gain on that same graph: a fresh graph defaults `desiredGuideGain` to 0, so
		// without this a mix song plays with a silent guide until the slider moves.
		masterGraph?.setGuideGain(effectiveGuide);
		masterReady = false;
		// A new song re-takes the mix decision from scratch: a non-mix song must not inherit the previous
		// song's `routed`, and `guidePath` may differ between two mix songs. Costs one flush, not a stall.
		mixSettled = false;
		prewarmedFired = false;
		visibleReadyFired = false;
		// NOT cleared on a song CHANGE: the element still holds the old src, and clearing makes the assign
		// effect rewrite a byte-identical src, which RELOADS and resets currentTime to 0. The stale-across-a-
		// remount case is handled by the `if (!master)` effect, which fires only when the element is GONE.
	});

	// Component destroy. Its own effect with NO tracked dependencies, so it never re-runs and its cleanup
	// means exactly "this slot is going away".
	$effect(() => {
		return () => {
			masterGraph?.detach();
			masterGraph = undefined;
		};
	});

	// Buffer settled. Reported on ANY slot; the controller ignores it unless the id is the one it is
	// warming, which is what lets the hidden slot advertise a gapless-ready next song.
	$effect(() => {
		if (masterReady && !prewarmedFired) {
			prewarmedFired = true;
			onprewarmed?.();
		}
	});

	// Because it also depends on `visible`, a slot that settled while hidden fires this the moment a swap
	// makes it visible — and never from the hidden slot, which would flip the room over a black frame.
	$effect(() => {
		if (visible && masterReady && !visibleReadyFired) {
			visibleReadyFired = true;
			onready?.();
		}
	});

	/**
	 * The transport for this slot — ONE decision. `currentSrc` is the load-bearing input: `play()` before the
	 * src is assigned is undone by the assignment itself, so the transport must depend on the src having
	 * LANDED rather than racing the effect that assigns it.
	 */
	const transport = $derived(
		transportFor({
			// THIS ENTRY's src, not merely SOME turn of this song: the shadows survive a change, so a src-only
			// comparison stays true and the memoized transport never re-fires its effect. The entry-scoped token
			// gives an `idle -> play` edge WITHOUT rewriting a byte-identical src.
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

	// Only once the element is actually HOLDING its media. The src is assigned from an effect declared BELOW
	// this one, so without the `hasSrc` gate this calls play() on a src-less element; the assignment's load
	// algorithm then sets `paused` back to true and rejects with AbortError, and nothing re-runs this effect,
	// so the master sits paused at 0 forever with no sound, no `ontimeupdate` and no telemetry.
	$effect(() => {
		if (!master) return;
		if (transport === 'idle') return;
		if (transport === 'pause') {
			master.pause();
			return;
		}
		// A refusal must degrade to a silent room, never a stalled song, and never SILENTLY: a NotAllowedError
		// is exactly the state a gesture can lift, so it arms the recovery path rather than ending there.
		void tryPlayMaster();
	});

	// A DRAINED room UNMOUNTS the master and the shadows OUTLIVE it. Re-adding the SAME song resolves to the
	// byte-identical string, so a src-only comparison read `true` on a FRESH, src-less element and the write
	// aborted the pending play(). Tracking the BINDING's presence is the reactive signal; reading an
	// attribute off `master` registers no dependency.
	$effect(() => {
		if (!master) {
			currentSrc = '';
			currentEntryId = null;
			// The element is GONE, so the graph holds a PERMANENT capture on a dead element. Release it AND drop the
			// reference: detach() alone leaves `masterGraph` truthy, so the `!masterGraph` build guard never fires
			// again and the NEXT song's element is never captured. This is the ELEMENT's death, not a song change.
			masterGraph?.detach();
			masterGraph = undefined;
		}
	});

	/**
	 * The ONE place that resolves a `master.play()` promise, so the one place that can tell "the room will be
	 * silent" from "silent UNTIL a tap".
	 *
	 * CRITICALLY it touches ONLY the plain element — no AudioContext, no MediaElementSource. That capture is
	 * PERMANENT, so eagerly wrapping the element to "solve" autoplay commits all room audio to WebAudio.
	 */
	async function tryPlayMaster(): Promise<void> {
		if (!master) return;
		try {
			await master.play();
			// Guarded on the latch, so a normal successful play does not spam the callback.
			if (autoplayBlocked) {
				autoplayBlocked = false;
				onautoplayrecovered?.();
			}
		} catch (err: unknown) {
			const name = err instanceof Error ? err.name : String(err);
			if (name === 'NotAllowedError') {
				// Recoverable by a gesture, so latch rather than treat as final. Announced only from the slot the
				// viewer is looking at, so the paused hidden slot cannot raise a phantom hint.
				if (!autoplayBlocked) {
					autoplayBlocked = true;
					console.warn('[tv] autoplay was blocked (NotAllowedError) — waiting for a tap to start the music');
					if (active && visible) onautoplayblocked?.();
				}
			} else if (master && master.paused) {
				// A rejection that LEAVES THE ELEMENT PAUSED is not terminal: the room believes it is playing, so
				// silence is a dead end. Arm the SAME gesture recovery — by then the element is holding its src.
				console.warn(`[tv] the instrumental was interrupted (${name}) — arming a tap to restart the music`);
				if (!autoplayBlocked) {
					autoplayBlocked = true;
					if (active && visible) onautoplayblocked?.();
				}
			} else {
				// A rejection that did NOT leave the element paused is a genuine interruption, so a later pass plays
				// the new song. The room is not stuck.
				console.warn(`[tv] the instrumental refused to start (${name}) — the room will be silent`);
				if (active && visible) onplaybackfailed?.(name);
			}
		}
	}

	/**
	 * Re-drive a transpose that could not route for want of user activation. A gesture is the only moment an
	 * AudioContext becomes resumable, and none of the pitch effect's tracked deps change when the wall is
	 * finally tapped. The `needsShift` guard keeps the keyShift-0 invariant.
	 */
	async function retryPitchAfterGesture(): Promise<void> {
		if (!needsShift(keyShift)) return;
		if (!masterGraph) return;
		await masterGraph.setShift(keyShift).catch(() => {});
		if (!active || !visible) return;
		if (masterGraph.isRouted) onpitchrouted?.();
	}

	// Recovery from a blocked autoplay AND the one chance a pending transpose has of routing. A gesture anywhere
	// authorises playback and WebAudio for this document, so play() is re-attempted SYNCHRONOUSLY inside the
	// handler — it must share the gesture's task to consume the activation.
	//
	// THE LISTENER IS ARMED UNCONDITIONALLY. Gated on `autoplayBlocked` it existed only on a TV whose autoplay
	// had been REFUSED, so a correctly-autoplaying TV had no listener, its context could never resume, and ± was
	// permanently dead with no error anywhere. The autoplay half still runs only while the latch is up (read at
	// gesture time, not as a dependency); the pitch half runs on ANY gesture.
	$effect(() => {
		if (typeof window === 'undefined') return;
		const onGesture = () => {
			// Read the latch HERE, not in the effect body: that is what keeps the listener armed on a TV that
			// never raised it while keeping the play() nudge exclusive to one that was blocked.
			if (autoplayBlocked) {
				void tryPlayMaster();
				// A mix song's only chance at a split graph after a pre-gesture refusal; without it the first song of
				// every TV session loses its guide permanently. Re-open the gate first so the src effect re-decides.
				if (masterGraph && !masterGraph.isRouted && wantsEagerGraph(guidePlan)) {
					mixSettled = false;
					void masterGraph
						.ensureRouted()
						.catch(() => {})
						.finally(() => {
							mixSettled = true;
						});
				}
			}
			// The pitch retry runs on ANY gesture, blocked or not — a TV that autoplayed fine still needs
			// this one tap before WebAudio will run, and it is the only reason this listener is armed there.
			void retryPitchAfterGesture();
		};
		// `capture` so it sees the gesture even if something downstream stops propagation; passive because we
		// never preventDefault; NOT `once`, so a pending transpose can still take a late gesture.
		const opts: AddEventListenerOptions = { capture: true, passive: true };
		window.addEventListener('pointerdown', onGesture, opts);
		window.addEventListener('keydown', onGesture, opts);
		return () => {
			window.removeEventListener('pointerdown', onGesture, opts);
			window.removeEventListener('keydown', onGesture, opts);
		};
	});

	// ONE site, because the guide is a channel pair inside the master. Set UNCONDITIONALLY: the value is
	// remembered on a graph that is not yet built and applied when it is, so the level cannot be lost.
	$effect(() => {
		masterGraph?.setGuideGain(effectiveGuide);
	});

	// BOTH sites: `.volume` governs the native path, and once a transpose routes the master through WebAudio
	// its `.volume` is bypassed, so `setGain` must carry the same level.
	$effect(() => {
		if (master) master.volume = effectiveMasterLevel;
		masterGraph?.setGain(effectiveMasterLevel);
	});

	// Reposition on a real JUMP — a restart, a scrub, a skip, or a reconnect whose position has moved on.
	//
	// ONE-LINE DEPENDENCY SET, ON PURPOSE. Everything the decision NEEDS is an INPUT, read inside `applySeek`
	// through `untrack`, never a reason to re-take it: reading `media` here as a tracked dependency made ANY
	// fresh Media identity re-apply the position from the last playback COMMAND, so an unrelated song's
	// processing yanked the playing song's playhead back to where the last pause left it.
	$effect(() => {
		// Dependency 1: the position a playback COMMAND asked for.
		const target = seekSec;
		// Bumped by every `setPlayback` but NEVER by position telemetry, so tracking it re-takes the decision
		// on a restart-to-0 from under the threshold without reopening telemetry-chasing.
		void seekRev;
		if (target === undefined) return;
		// The COLD-MOUNT hold lives inside `applySeek`, with the element read it depends on, which is what keeps
		// this dependency set to exactly "what a playback command asked for".
		applySeek(target);
	});

	/**
	 * Apply a seek target to the master. Called ONLY by the effect above. Every read in here is `untrack`ed,
	 * and that is the INVARIANT rather than tidiness: an input to the decision must never become a trigger
	 * for it. Only a jump clearing `SEEK_JUMP_SEC` acts, so telemetry does not fight the playhead.
	 */
	function applySeek(seekTarget: number): void {
		const el = untrack(() => master);
		/*
		 * THE COLD-MOUNT HOLD. With NO element there is nothing to seek, so the position is held for the master's
		 * `canplay`. With an element the hold MUST be cleared: `canplay` fires again on every warm re-buffer, and
		 * the plan below declines live telemetry as sub-threshold, so a retained stash gets applied by the next
		 * decode hiccup and resumes seconds EARLIER. See docs/FRONTEND.md#wake-lock-and-reload-resume.
		 */
		resumeTarget = el ? undefined : seekTarget;
		const snap = untrack(() => media);
		const isActive = untrack(() => active);
		if (!el || !snap || !isPlayable(snap) || !isActive) return;
		if (!seekPlan(el.currentTime, seekTarget)) return;
		el.currentTime = seekTarget;
	}

	/**
	 * Resume to the room's position on a COLD MOUNT, taken when the master can actually play rather than at
	 * effect time before the element exists. The decision is `resumeSeekTarget`, NOT `seekPlan`: a
	 * cold-mounted element has no playhead to protect, so the room's position is a RESUME rather than a jump
	 * subject to the telemetry-vs-scrub threshold.
	 */
	function applyResume(): void {
		const el = untrack(() => master);
		const target = resumeTarget;
		if (target === undefined || !el) return;
		// Mirror applySeek's full guard: the prewarming (hidden, INACTIVE) slot DOES reach `canplay`, so without
		// it the next song's element is parked at the outgoing position and setPosition writes that stale
		// playhead to every phone. Do NOT consume `resumeTarget` — the slot may become active later.
		const snap = untrack(() => media);
		const isActive = untrack(() => active);
		if (!snap || !isPlayable(snap) || !isActive) return;
		const plan = resumeSeekTarget(el.currentTime, target);
		if (plan.seek) el.currentTime = plan.target;
		// Consume it: ONE resume per element load, only on the path that actually applied it.
		resumeTarget = undefined;
	}

	// PITCH SHIFT. ONE graph per element, built LAZILY on the first non-zero shift; see pitch-shift.ts and the
	// doc for the full trap. Enforced HERE: at keyShift 0 no graph is constructed, so the audio path is the plain
	// element; only the ACTIVE slot shifts, because the capture is permanent and the hidden slot is paused; and
	// THE GUIDE MIX IS THE ONE EXCEPTION, because withholding its src until the graph is confirmed would
	// otherwise land the gapless seam on a song that still has to build one.
	$effect(() => {
		// Read reactive deps up front so the effect re-runs when any of them change.
		const shift = active ? keyShift : 0;
		const v = master;
		if (!v) return;
		// GUIDE-MIX SONGS BUILD EAGERLY, in SPLIT mode: their guiding track does not exist until the splitter runs.
		// `mixSettled` flips on EVERY outcome because it gates the src — an attempt that never settles leaves the
		// room silent — and the three settling paths below are exhaustive.
		if (wantsEagerGraph(guidePlan)) {
			if (!masterGraph) masterGraph = new PitchShiftGraph(v, { split: true });
			masterGraph.setGuideGain(effectiveGuide);
			if (masterGraph.isRouted) {
				// Already routed, possibly by a PRIOR song whose graph mode is now fixed. Settle and let `mixGateFor`
				// judge: a leftover non-split graph resolves to `denied`, so the mix is withheld rather than downmixed.
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
		// Only ever build once there is a real shift to apply; setShift(0) on an un-built graph is a no-op.
		if (needsShift(shift) && !masterGraph) masterGraph = new PitchShiftGraph(v);
		// REPORT THE OUTCOME. `setShift` resolves whether or not the graph could route, and one that could not
		// leaves the song audible but UNSHIFTED. Telling the page lets it ask for the tap that would fix it.
		const applied = masterGraph?.setShift(shift);
		if (applied) {
			void applied
				.catch(() => {})
				.then(() => {
					// Only the slot the viewer is looking at may raise a hint.
					if (!active || !visible) return;
					if (!needsShift(shift)) {
						// Back at concert pitch: nothing is pending.
						onpitchrouted?.();
					} else if (masterGraph && !masterGraph.isRouted) {
						onpitchblocked?.();
					} else {
						onpitchrouted?.();
					}
				});
		} else if (!needsShift(shift) && active && visible) {
			// No graph and no shift wanted: the keyShift-0 invariant path. Nothing is pending.
			onpitchrouted?.();
		}
		// HERE too: the level effect's deps are `master` and `effectiveMasterLevel` only, and `masterGraph` is a
		// plain variable, so an attenuated song would jump to FULL volume on the first ±.
		masterGraph?.setGain(effectiveMasterLevel);
		// And the GUIDE pair's gain, for the same reason: a fresh graph defaults `desiredGuideGain` to 0 (see
		// pitch-shift.ts — the worst case of a missed call must be a guide nobody hears).
		masterGraph?.setGuideGain(effectiveGuide);
		// The guide needs no shift of its own: ONE worklet shifts all four channels at one ratio, so the pair
		// cannot fall out of key with the instrumental.
	});

	function fileSrc(m: PlaybackSnapshot): string {
		// The SINGLE separated instrumental — no per-key files, because transposition happens in the browser, so the
		// src never depends on keyShift. On a GUIDE-MIX song this may be the 4-channel mix, but only once the split
		// graph has captured the element and confirmed a running context. `mixGateFor` folds in BOTH halves — routed
		// AND split — because `isRouted` alone let a leftover non-split graph take the mix and downmix it.
		const plan = masterSrcPlan(guidePlan, playbackRef(m), mixGateFor(masterGraph, mixSettled));
		// `plan.mixed` is the src's own claim. Asserting it against the graph turns a disagreement into a loud
		// failure instead of a room full of full-volume vocals.
		if (plan.mixed && !(masterGraph?.isSplit && masterGraph.isRouted)) {
			console.error('[tv] refusing a 4-channel src with no split graph — this would downmix the vocals');
			return `/media/${playbackRef(m)}`;
		}
		return plan.ref ? `/media/${plan.ref}` : '';
	}

	/**
	 * Assign the src ONLY when the resolved STRING changes. Catalog churn rebuilds the media objects, so a
	 * markup binding re-evaluates on identity alone and reassigns — and assigning `HTMLMediaElement.src`
	 * RELOADS the resource and resets `currentTime` to 0 even when the URL is byte-identical.
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
		// Compare against what the ELEMENT ACTUALLY HOLDS. The attribute is authoritative and cannot go stale; a
		// shadow failed both ways — cleared while the element still held its src (reloading the playing song to 0)
		// and retained across a remount (leaving a fresh element silent). `getAttribute` round-trips because every
		// src assigned here is root-relative; `master.src` returns an absolutised URL.
		const decision = nextVideoSrc(master.getAttribute('src') ?? '', resolved, playable);
		if (decision.changed) master.src = decision.src;
		// A NOT-PLAYABLE pass must leave BOTH shadows AND the element's src untouched: clearing `currentSrc` tells
		// the transport the still-playing song has no src and stops it. The genuine clear is the {#if} unmount. The
		// two shadows are written in LOCKSTEP, because a half-stale entry token reintroduces the silent second turn.
		if (playable) {
			currentSrc = resolved;
			currentEntryId = entryId;
		}
	});
</script>

<!--
	The two crossfading slots share one box, so which of them is on top IS the crossfade. Named tiers rather
	than bare integers, so the pair reads against the rest of the stage ladder in app.css.
-->
<div class="slot" class:visible={visible} style="z-index:{visible ? 'var(--z-tv-video-active)' : 'var(--z-tv-video)'}">
	{#if media && isPlayable(media)}
		<!--
			THE MASTER, and the ONLY media element. An <audio>, not a <video> — see the note at the top of this
			file. It owns the clock: play/pause, currentTime, `ended`, and the position telemetry the lyrics overlay
			and the room's progress bar both run on.
		-->
		<audio
			bind:this={master}
			preload="auto"
			oncanplaythrough={() => (masterReady = true)}
			oncanplay={() => applyResume()}
			onplay={() => active && visible && onplayingchange?.(true)}
			onpause={() => active && visible && onplayingchange?.(false)}
			onended={() => {
				if (active && visible) onplayingchange?.(false);
				onended?.();
			}}
			onerror={() => active && visible && onerror?.()}
			ontimeupdate={() => {
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
		transition: opacity var(--motion-base) ease; /* crossfade on swap — opacity only, GPU-composited */
		pointer-events: none;
	}
	.slot.visible {
		opacity: 1;
	}
	/*
	 * The master carries no picture, so it is hidden outright rather than sized and letterboxed.
	 *
	 * `display: none` on an <audio> element does NOT stop it playing — unlike a <video>, there is no render
	 * surface for the compositor to skip.
	 */
	audio {
		display: none;
	}
</style>
