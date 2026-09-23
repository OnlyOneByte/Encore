<script lang="ts">
	// One media surface (slot A or B). Plays the separated instrumental through an <audio> and reports
	// ready/ended up so the GaplessController can orchestrate the swap.
	//
	// <audio> AND NOT <video>, because there is no picture: `playbackRef` resolves to the separated
	// instrumental, so this element never had a video track — the old <video> existed only to be neutralised
	// with CSS. <audio> is also the more permissive element for codec support (WebKit documents FLAC there),
	// which removes a class of "decodes, advances, makes no sound".
	//
	// THE GUIDING TRACK IS ONE FILE THROUGH THIS ONE ELEMENT: a 4-channel mix, channels 0/1 the instrumental
	// and 2/3 the isolated vocals, pulled apart by a `PitchShiftGraph(el, { split: true })` that gives each
	// pair its own gain. One decoder means one playhead, so guide drift is unrepresentable rather than
	// governed. A song with no mix offers no guide (`guidePath` → `none`).
	//
	// The second-element path was DELETED, not disabled: it held a vocals stem in its own <audio> against the
	// instrumental with a drift governor, and that governor compared reported `currentTime`, which EXCLUDES
	// output latency — so it converged on "aligned" using a signal that does not describe what the ear hears.
	// Rooms heard a late guide that never self-healed.
	//
	// THE ONE RULE THAT MUST NOT BE BROKEN: a 4-channel file must never reach an element that is not routed
	// through a running split graph. Played natively the browser DOWNMIXES it, summing the isolated vocals
	// into the instrumental at full volume. `guide-mix-src.ts` owns that gate; read it before touching the src.
	import { playbackRef, isPlayable, guidePath } from '$lib/contract';
	import type { PlaybackSnapshot } from './catalog';
	import { untrack } from 'svelte';
	import { resumeSeekTarget, seekPlan } from './playhead-sync';
	import { masterSrcPlan, wantsEagerGraph, mixGateFor } from './guide-mix-src';
	import { nextVideoSrc } from './video-src';
	import { transportFor, slotHoldsSong, songToken } from './transport';
	import { PitchShiftGraph, needsShift } from './pitch-shift';
	interface Props {
		// A `PlaybackSnapshot`, not a live `Media`. The brand makes this a compiler boundary: the
		// page cannot hand this slot a catalog record that a process can still change underneath it, so the
		// player observes a song's fields as they were when the slot was assigned and at no other time.
		media: PlaybackSnapshot | null;
		// The id of the QUEUE ENTRY this slot is playing — NOT the media/song id. A song queued
		// twice is two entries with distinct client-minted ids but ONE media record, so `media.id` and the
		// resolved src are byte-identical across the advance from turn 1 to turn 2. The transport re-arm
		// keys on this entry id (see the `slotHoldsSong` token below) so a same-song advance still produces
		// an `idle -> play` edge; without it turn 2 never calls play() and the room goes silent at 0. It is
		// intentionally SEPARATE from the `PlaybackSnapshot` brand, which carries server catalog truth only
		// and must not be widened with per-turn identity.
		entryId?: string | null;
		visible: boolean;
		active: boolean; // is this the playing slot (vs the hidden pre-warming slot)
		playing?: boolean; // playback:state.isPlaying — pause/resume from the phone
		seekSec?: number; // playback:state.positionSec — jump the video when the phone seeks
		// Bumped by every `playback:state` (server `rev`). Tracked by the seek effect so a restart
		// whose reported position EQUALS the last one still re-takes the seek decision — a restart
		// under the jump threshold writes 0 over 0, which a `$state` (strict `===`) never notifies,
		// so `seekSec` alone would leave the effect asleep and the song would not restart.
		seekRev?: number;
		keyShift?: number; // ± semitones for a file song — selects the keyed instrumental
		guideLevel?: number; // 0..1 — how loud the original vocals sit under the instrumental
		// The MASTER instrumental level (0..1), the loudness-normalization pulldown. Resolved by
		// the TV route from the room's `loudnessNormalization` toggle, this song's measured loudness, and
		// the library median (see loudness-normalization.ts). 1 = untouched, which is the whole existing
		// library and every song when the feature is off / below floor / unmeasured. Attenuate-only:
		// never above 1. Applied at BOTH the native (`master.volume`) and routed (`masterGraph.setGain`)
		// sites, exactly like the guide level, because WebAudio capture bypasses `.volume` once a shift
		// exists.
		masterLevel?: number;
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
		// `ended` events — the honest counterpart to the room's `playing` INTENT prop. Fires ONLY
		// from the active+visible slot (like `onautoplayblocked`) so the hidden pre-warming slot, which is
		// deliberately paused, cannot report the room as stopped. The page feeds this to `lyricsAdvancing`
		// so the reel freezes when the element is not advancing (autoplay refused, or media not playable)
		// even though the server still says the room intends to play.
		onplayingchange?: (playing: boolean) => void;
		// The instrumental refused to start with an error that a gesture CANNOT lift (a decode failure, an
		// AbortError from a real src change) — the room will be silent and, unlike a NotAllowedError, no tap
		// recovers it. The only prior trace was a TV-console warn nobody at a party reads, so the page needs
		// this to render an on-screen "the room is silent" state. Fires ONLY from the active+visible slot
		// (like `onautoplayblocked`) so the hidden pre-warming slot cannot raise a phantom failure. `reason`
		// is the error name, for the operator-facing surface.
		onplaybackfailed?: (reason: string) => void;
		/*
		 * A TRANSPOSE WAS ASKED FOR AND COULD NOT ROUTE. A browser only lets an AudioContext reach `running` once
		 * the page has user activation; with none, `PitchShiftGraph` deliberately degrades — it closes the context
		 * and leaves the element on its native output, audible but UNSHIFTED — because capturing the element into a
		 * suspended graph is permanent silence for the whole room.
		 *
		 * That degradation had no reader, so on a TV that autoplays correctly (and therefore never gets the tap
		 * `autoplayBlocked` would have invited) every press of ± did nothing and said nothing. Fires ONLY from the
		 * active+visible slot, so the hidden slot cannot raise a phantom hint.
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

	// The lazily-built pitch-shift graph for the master element. ONE graph, because there is ONE element:
	// the guide rides inside the master's own file as channels 2/3, so the split graph that pulls the
	// pairs apart is this same graph in `split` mode. A second `guideGraph` existed only while the guide
	// was a second <audio>.
	// Declared here so both the volume effect and the shift-wiring effect below reference the same
	// instance. Not $state — nothing renders off it; it is an imperative WebAudio handle.
	let masterGraph: PitchShiftGraph | undefined;
	/**
	 * Has this song's split-graph routing attempt SETTLED? Two jobs in one flag: it is the reactive signal the src
	 * effect needs (`masterGraph.isRouted`/`.isSplit` are plain getters and cannot wake an effect, so without it
	 * the mix would be built, become safe to play, and never be played), and it is the `pending` half of
	 * `MixGate` — while false the src effect commits NOTHING on a mix song, which is what stops the src being
	 * decided twice and rewritten on a playing element (see `guide-mix-src.ts`).
	 *
	 * Reset per SONG, not per graph: a new song must re-take the decision, and a slot whose graph already exists
	 * settles again on the next flush.
	 */
	let mixSettled = $state(false);

	// The guide is pitch-shifted by the SAME amount as the instrumental, because it IS the instrumental's
	// file: one worklet shifts all four channels at one ratio, so the guide cannot fall out of key with
	// what is playing and the level applies unchanged at any shift. (It was once force-muted at any
	// non-zero keyShift, when the guide was a separate key-0 stem and mixing it under a transposed
	// instrumental was musically wrong — that muted the guide exactly when a singer most wanted it.)
	const effectiveGuide = $derived(Math.max(0, Math.min(1, guideLevel)));

	// The master instrumental's applied level — the loudness-normalization pulldown, clamped to
	// [0,1] here as a second guard even though the route already clamps it. Attenuate-only: this is 1
	// for the whole existing library and rises no higher, so a song is only ever pulled DOWN.
	const effectiveMasterLevel = $derived(Math.max(0, Math.min(1, masterLevel)));

	/**
	 * WHICH guide this song offers — one 4-channel mix, or none (`guidePath` in shared).
	 *
	 * There is no longer a second-element alternative: `guidePath` answers `mix` or `none`, so a song
	 * without a mix plays with no guiding track at all rather than falling back to a second decoder that
	 * could not be held in time. See `guide-level.ts` for why that path was deleted instead of tuned.
	 */
	const guidePlan = $derived(media ? guidePath(media) : ({ kind: 'none' } as const));

	// ── readiness ──────────────────────────────────────────────────────────────
	// The slot is ready for a gapless swap when its MASTER can play — which is now the whole story. It
	// used to also wait on a `guideSettled` latch (ready / errored / timed out after
	// GUIDE_READY_TIMEOUT_MS), because a second <audio> carrying the vocals could still be buffering when
	// the master was good to go, and starting then meant silence where the guide should be. The guide
	// lives inside the master's own file now, so a master that can play is a guide that can play: there is
	// no second buffer to wait for, nothing to time out, and no way for the two to disagree.
	let masterReady = $state(false);
	// the last room position from `playback:state`, HELD so a cold mount can take it on the
	// master's `canplay` — the element does not exist when the frame arrives on a reload. Applied ONCE
	// per element load, and ONLY on the ACTIVE, playable slot (see `applyResume`'s guard). NOT reactive:
	// a plain variable, read only inside the untracked `applyResume`, so it never itself re-triggers the
	// seek effect. What keeps a STALE target off the next song is NOT clearing this variable — it is the
	// server: a song advance publishes `positionSec: 0` with a fresh `rev` (EPHEMERAL_RESET, player.ts)
	// BEFORE `emitNowPlaying`, so the incoming song re-stashes a target of 0, not the outgoing position
	// (the earlier changes protection lives there, at the source).
	let resumeTarget: number | undefined;
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
	// The ENTRY the element last SETTLED on, shadowing `currentSrc` and written in lockstep with it by
	// the assign effect. `currentSrc` alone cannot tell turn 2 of a song from turn 1 — the src is
	// byte-identical — so the transport reader compares the entry-scoped `slotHoldsSong` token, and this
	// is its `held` half. Cleared on the same unmount that clears `currentSrc` so a remounted element
	// reads a fresh `held:null`.
	let currentEntryId = $state<string | null>(null);

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

	// A new song in this slot forgets the previous one's readiness; without this a re-warmed slot never reports
	// ready again and the gapless swap stalls.
	//
	// GUARDED ON THE ID *VALUE*, not on the `media` signal. `media`'s object identity churns constantly — any
	// queue mutation makes the TV route rebuild its catalog, so the slot receives a new object with identical
	// fields for the song already playing. Svelte tracks the signal, so this re-ran on every one of those and
	// reset a mid-song slot: readiness latches cleared (and `canplaythrough` will NOT fire again on an element
	// that has loaded, so `onready` was spent forever) and the pitch graphs were torn down under a transposed
	// song. Comparing the id STRING makes "same song, new object" a no-op.
	//
	// The teardown is imperative rather than an effect cleanup for the same reason: a returned cleanup runs
	// before EVERY re-run, so it fired on all that churn too.
	$effect(() => {
		const id = media?.id ?? null;
		if (id === resetForId) return;
		resetForId = id;
		// Per-song graph handling. A PitchShiftGraph binds a PERMANENT MediaElementAudioSourceNode to its
		// element: once captured the element outputs ONLY through the graph, and detach() frees the context but
		// CANNOT restore the native path. So the reset strategy matches the element's LIFETIME, not the media's.
		//
		// The MASTER outlives a song change (its `{#if}` is `media && isPlayable(media)`), so we must NOT detach
		// its graph here — doing so left the already-captured element feeding a disconnected node and the
		// instrumental went silent until a keyShift rebuilt one. `setShift(0)` instead: on a routed graph that
		// keeps the chain intact and posts ratio 1, and on an un-built graph it is a documented no-op. Teardown
		// happens where the element genuinely dies — component destroy, and the `if (!master)` effect for a
		// drained room that unmounts the <audio>.
		void masterGraph?.setShift(0);
		// Same in-place re-apply for the master's normalization level: a song change resets the
		// graph in place (not detached), and a graph defaults its gain to 1, so re-assert the pulldown
		// here — the new song's level is resolved by the route and arrives as `effectiveMasterLevel`.
		masterGraph?.setGain(effectiveMasterLevel);
		// And the GUIDE pair's gain, which is a gain on this same graph now. A freshly built graph
		// defaults `desiredGuideGain` to 0, and a song change re-takes the routing decision, so the room's
		// level has to be re-asserted here or a mix song plays with a silent guide until the slider moves.
		masterGraph?.setGuideGain(effectiveGuide);
		masterReady = false;
		// A new song re-takes the mix decision from scratch. Cleared here rather than left latched because a
		// non-mix song must not inherit the previous song's `routed`, and a mix song following a mix song
		// still has to re-evaluate (the graph's mode is fixed, but `guidePath` may differ). A slot whose
		// graph already exists re-settles on the very next flush, so the cost is one flush, not a stall.
		mixSettled = false;
		prewarmedFired = false;
		visibleReadyFired = false;
		// NOTE: `currentSrc` is NOT cleared on a song CHANGE here (this effect keys on the id value, and the
		// element is still mounted and holding the old src) — clearing it on every identity churn is what
		// reloaded the playing song, because the assign effect then rewrote a byte-identical src and
		// `HTMLMediaElement.src` reloads and resets currentTime to 0 even when the string is unchanged.
		// Only the ASSIGN effect was converted to compare against what the ELEMENT holds
		// (`master.getAttribute('src')`); the TRANSPORT reader at the `slotHoldsSrc(currentSrc, …)` derived
		// still reads this shadow, so it CAN go stale across a remount — and it did, across exactly the
		// drain-then-re-add-the-same-song remount. That stale case is handled by the dedicated
		// unmount effect above (`if (!master) currentSrc = ''`), which clears the shadow when the element is
		// GONE — distinct from this per-song-change reset, where the element is still present.
	});

	// Component destroy: release whatever is still wired. Its own effect, with no tracked dependencies,
	// so it never re-runs and its cleanup means exactly "this slot is going away".
	$effect(() => {
		return () => {
			masterGraph?.detach();
			masterGraph = undefined;
		};
	});

	// Buffer settled. Report it as a pre-warm signal on ANY slot — the controller ignores it unless the
	// id is the one it is warming (the visible slot's call is a no-op). This is what lets the hidden
	// slot advertise a gapless-ready next song.
	$effect(() => {
		if (masterReady && !prewarmedFired) {
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
		if (visible && masterReady && !visibleReadyFired) {
			visibleReadyFired = true;
			onready?.();
		}
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
			// an earlier change + an earlier change: the element must be holding THIS ENTRY's src, not merely SOME src, and not merely
			// SOME turn of this song. `currentSrc`/`currentEntryId` shadow the previous entry across a change
			// (never cleared, only rewritten on a playable pass by the assign effect below), so the OLD
			// `!!currentSrc` stayed stale-true and the transport kept the same `'play'` value — a memoized
			// derived whose value does not change never re-runs the effect, so nothing replayed play() after
			// the new src landed. an earlier change fixed the two-DIFFERENT-songs case by comparing the resolved src; an earlier change
			// is the two-turns-of-the-SAME-song case, where the resolved src is byte-identical, so the src
			// comparison alone still reads stale-true. Comparing the entry-scoped `songToken` gives an
			// `idle -> play` value edge exactly when the assign effect records the new entry — without
			// rewriting a byte-identical src (which the per-song-change note above warns reloads the song).
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

	// A DRAINED room UNMOUNTS the master, and `currentSrc` is a component-level shadow that OUTLIVES it. Re-adding
	// the SAME song resolves to the byte-identical string, so `slotHoldsSrc(currentSrc, …)` read `true` on a
	// FRESH, src-less element: the transport derived `'play'` on its first pass, `tryPlayMaster()` ran before the
	// assign effect wrote the src, and that write aborted the pending play() — the room stayed silent while every
	// surface said it was playing. Clearing the shadow on unmount makes a remounted element read `hasSrc:false`, so
	// the transport takes a genuine `idle -> play` edge once the new src lands. Tracking the BINDING's presence is
	// the reactive signal that a remount happened; a bare `master` attribute read registers no dependency.
	$effect(() => {
		if (!master) {
			currentSrc = '';
			currentEntryId = null;
			// The element is GONE (a drained room unmounts the <audio> behind {#if media && isPlayable(media)}),
			// so the master's pitch graph now holds a PERMANENT MediaElementSource on a dead element. Release
			// it AND drop the reference: detach() alone frees the context but leaves `masterGraph` truthy, so the
			// build site's `!masterGraph` guard stays false forever and the NEXT song's fresh element is never
			// captured — the instrumental transposes on song 1, then stops for the rest of the page's life while
			// the phones still read `Key · +N` (the master counterpart of the guide's an earlier change release). This is
			// the element's own death, NOT the per-song reset: a song CHANGE keeps the element and must NOT
			// detach, which is why this lives here and not in the reset effect above.
			masterGraph?.detach();
			masterGraph = undefined;
		}
	});

	/**
	 * Play the master, tracking whether the browser's autoplay policy refused it. This is the ONE place that
	 * resolves a `master.play()` promise, so it is the one place that can tell "the room will be silent" from "the
	 * room is silent UNTIL a tap": a NotAllowedError is the latter, and on a TV wall that gesture may never come,
	 * so it raises `autoplayBlocked` rather than logging and giving up. Any other rejection is not
	 * gesture-liftable and is logged.
	 *
	 * CRITICALLY it touches ONLY the plain element — no AudioContext, no MediaElementSource. That capture is
	 * PERMANENT (see pitch-shift.ts), so eagerly wrapping the element to "solve" autoplay would commit all room
	 * audio to WebAudio forever.
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
			} else if (master && master.paused) {
				// A NON-NotAllowedError rejection (an AbortError from a src assignment racing the play(), a
				// decode stumble) that LEAVES THE ELEMENT PAUSED is not terminal: the room believes it is
				// playing, so silence here is a dead end, not a settled state. Treating it as final is
				// what left a re-queued just-ended song silent with no `.autoplay-hint` and no armed listener,
				// so two real taps on the TV changed nothing. Arm the SAME recovery the NotAllowedError path
				// uses — the gesture listener re-attempts `tryPlayMaster()`, which now succeeds because the
				// element is holding its src by the time a gesture arrives (the shadow-clear on remount removed
				// the src-less first pass that caused the abort). Naming the reason is still worth doing.
				console.warn(`[tv] the instrumental was interrupted (${name}) — arming a tap to restart the music`);
				if (!autoplayBlocked) {
					autoplayBlocked = true;
					if (active && visible) onautoplayblocked?.();
				}
			} else {
				// A rejection that did NOT leave the element paused (the src really did change out from under a
				// genuine interruption, so a later pass will play the new song) is not this bug — log it and let
				// the transport effect's own re-run handle the new src. The room is not stuck.
				console.warn(`[tv] the instrumental refused to start (${name}) — the room will be silent`);
				if (active && visible) onplaybackfailed?.(name);
			}
		}
	}

	/**
	 * Re-drive a transpose that could not route for want of user activation.
	 *
	 * Called from the gesture listener below, which is the only moment an AudioContext can become
	 * resumable. A ± press before any tap builds a graph, fails to resume, and degrades to
	 * audible-but-unshifted; none of the pitch effect's tracked deps change when the wall is finally
	 * tapped, so without this the song never shifts however many times the guest presses.
	 *
	 * Cheap and safe to call on every gesture: `setShift` on an already-routed graph just re-posts the
	 * ratio to the worklet, and the `needsShift` guard keeps the keyShift-0 invariant intact — at 0 we
	 * build nothing, touch no AudioContext, and capture no element.
	 */
	async function retryPitchAfterGesture(): Promise<void> {
		if (!needsShift(keyShift)) return;
		if (!masterGraph) return;
		await masterGraph.setShift(keyShift).catch(() => {});
		if (!active || !visible) return;
		if (masterGraph.isRouted) onpitchrouted?.();
	}

	// Recovery from a blocked autoplay, AND the one chance a pending transpose has of routing. A gesture
	// ANYWHERE on the page authorises playback and WebAudio for this document, so the master's play() is
	// re-attempted SYNCHRONOUSLY inside the handler — it must share the gesture's task to consume the
	// activation.
	//
	// THE LISTENER IS ARMED UNCONDITIONALLY, and that is the fix. Gated on `autoplayBlocked` it existed only on
	// a TV whose autoplay had been REFUSED, so a correctly-autoplaying TV had no gesture listener at all, its
	// AudioContext could never be resumed, and the ± buttons were permanently dead with no error anywhere. The
	// autoplay half still runs only while the latch is up (read at gesture time, not as a dependency), because
	// calling play() on every tap would restart a room someone deliberately paused; the pitch half runs on any
	// gesture, which is the event it was missing.
	//
	// It builds no graph of its own: `tryPlayMaster` is a bare element.play(), so the keyShift===0 invariant —
	// no AudioContext unless a shift is actually applied — is untouched.
	$effect(() => {
		if (typeof window === 'undefined') return;
		const onGesture = () => {
			// Read the latch HERE rather than in the effect body: that is what lets the listener stay
			// armed on a TV that never raised it, while keeping the play() nudge exclusive to a TV that
			// genuinely was blocked.
			if (autoplayBlocked) {
				void tryPlayMaster();
				// A gesture is also the ONLY thing that can make an AudioContext resumable, so it is the only
				// chance a mix song has to get its split graph after a pre-gesture attempt was refused. Without
				// this the first song of every TV session loses its guide permanently: the eager build runs at
				// mount (context suspended → `denied`), and none of the pitch effect's tracked deps change when
				// the wall is finally tapped, so nothing ever re-attempts. Re-open the gate first so the src
				// effect re-takes its decision once the retry settles.
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
		// `capture` so it sees the gesture even if something downstream stops propagation. Passive: we
		// never preventDefault. Not `once`, and no longer torn down on a latch change either — removal is
		// the effect cleanup's job, which now means unmount, so a pending transpose can still take a
		// gesture that arrives long after any autoplay question was settled.
		const opts: AddEventListenerOptions = { capture: true, passive: true };
		window.addEventListener('pointerdown', onGesture, opts);
		window.addEventListener('keydown', onGesture, opts);
		return () => {
			window.removeEventListener('pointerdown', onGesture, opts);
			window.removeEventListener('keydown', onGesture, opts);
		};
	});

	// NO SECOND TRANSPORT, and no pre-roll lock-on. Both lived here to drive a guide <audio> that had to
	// mirror the master's play/pause and be seeked onto the master's playhead at the moment it became
	// audible. The guide is now channels 2/3 of the master's own file, so it starts, stops, seeks and
	// ends with the master by construction — there is no second element to arm, no decoder spin-up to
	// out-run, and no "the guide is playing while the master sits paused" state to keep the two effects
	// agreeing about.

	// The level itself — the whole "how loud are the original vocals" knob. ONE site now: the guide is a
	// channel pair inside the master, so its level is a gain on the master's split graph. There is no
	// element `.volume` half any more, because there is no second element — and no dual-site risk of the
	// two disagreeing. Set unconditionally: `setGuideGain` remembers the value on a graph that is not
	// split or not yet built, and the build applies whatever is remembered, which is what keeps the
	// room's level from being lost in the window before the graph exists.
	$effect(() => {
		masterGraph?.setGuideGain(effectiveGuide);
	});

	// The MASTER instrumental's level — the loudness-normalization pulldown. Exactly the guide's
	// dual-site shape and for the same reason: `.volume` governs the native path, and once a transpose
	// routes the master through WebAudio its `.volume` is bypassed so `masterGraph.setGain` must carry
	// the same level. The shift-wiring effect below re-applies it after (re)building the graph, because
	// a freshly built PitchShiftGraph defaults desiredGain to 1 (the an earlier change carry lands the value at
	// construction, but a level set BEFORE the graph existed still needs this effect's write).
	$effect(() => {
		if (master) master.volume = effectiveMasterLevel;
		masterGraph?.setGain(effectiveMasterLevel);
	});

	// Reposition on a real JUMP — a restart, a scrub, a skip, or a reconnect whose position has moved on.
	//
	// ONE-LINE DEPENDENCY SET, ON PURPOSE. The body is a named function so this effect's tracked reads are the two
	// lines you can see. Everything the decision NEEDS — the elements, the snapshot, the slot's activity — is an
	// INPUT, read inside `applySeek` through `untrack`, never a reason to re-take the decision.
	//
	// THE BUG THIS CLOSES: `media` used to be read here as a tracked dependency, so ANY fresh Media identity
	// re-applied `seekSec` — the position from the last playback COMMAND, stale by design. A process for an
	// unrelated song churned the catalog and the playing song's playhead was yanked back to wherever the last
	// pause left it. Not to 0, to an earlier part, which is why four fixes aimed at the src path all missed it.
	// The snapshot seam in `catalog.ts` closes the same class at the source; both, deliberately.
	$effect(() => {
		// Dependency 1: the position a playback COMMAND asked for.
		const target = seekSec;
		// Dependency 2: the server `rev`, bumped by every `setPlayback` (restart, pause, seek, key…) but
		// never by position telemetry (`setPosition` leaves rev alone and does not broadcast). Tracking it
		// re-takes the seek decision on a restart-to-0 from under the jump threshold — which writes 0 over
		// 0 and so notifies nothing through `seekSec` alone — WITHOUT reopening telemetry-chasing.
		// A bare read is enough to register the dep in runes mode.
		void seekRev;
		if (target === undefined) return;
		// The COLD-MOUNT hold lives inside `applySeek`, with the element read it depends on. Keeping it
		// there is what lets this effect's dependency set stay exactly "what a playback command asked
		// for" — see the playhead-isolation guard, which bans every catalog/element/slot identifier from
		// this body precisely because one of them being read here is the bug described above.
		applySeek(target);
	});

	/**
	 * Apply a seek target to the master. Called ONLY by the effect above.
	 *
	 * Every read in here is `untrack`ed, and that is the invariant rather than tidiness: an input to the decision
	 * must never become a trigger for it. `media` is the one that caused a real playhead-yanking defect.
	 *
	 * ONE ELEMENT MOVES, because there is one element. This used to seek the guide to `target + offset` as well,
	 * since leaving it to the drift governor meant a whole-song discontinuity closed at a 2% tempo trim. The guide
	 * travels inside one file now, so a jump repositions it for free.
	 *
	 * Only a jump (> SEEK_JUMP_SEC from where we are) acts, so the ~4Hz telemetry and pause/resume do not fight
	 * the playhead.
	 */
	function applySeek(seekTarget: number): void {
		const el = untrack(() => master);
		/*
		 * THE COLD-MOUNT HOLD, and the fix for a playhead that jumped backwards at random.
		 *
		 * With NO element there is nothing to seek, so the position is held for the master's `canplay`: on a reload
		 * mid-song the <audio> does not exist yet (it is gated on `nowplaying:changed`, which the server sends
		 * AFTER this `playback:state`) and telemetry never bumps `rev` to re-wake the effect, so without the hold
		 * the room's position is lost.
		 *
		 * With an element the hold must be CLEARED, and that is the half that was missing. The stash was
		 * unconditional, on the premise that `canplay` will not fire again on the warm path — it does, every time
		 * `readyState` rises back to HAVE_FUTURE_DATA (after any seek that empties the buffer, after every
		 * underrun). Meanwhile the plan below declines the live telemetry position as sub-threshold, so nothing
		 * cleared the stash: the target stayed armed at the playhead as of the last command, and the next decode
		 * hiccup applied it — resuming seconds EARLIER. The guide slider re-arms it ~8×/second while dragging,
		 * which is what made a deterministic bug look like random pausing.
		 */
		resumeTarget = el ? undefined : seekTarget;
		const snap = untrack(() => media);
		const isActive = untrack(() => active);
		if (!el || !snap || !isPlayable(snap) || !isActive) return;
		if (!seekPlan(el.currentTime, seekTarget)) return;
		el.currentTime = seekTarget;
	}

	/**
	 * Resume the master to the room's position on a COLD MOUNT, called at the moment the master can actually play
	 * rather than at effect time before the element exists. On a reload mid-song the `playback:state` frame
	 * carrying the position arrives before the <audio> is mounted, so the seek effect fired against a null master
	 * and dropped the target; the held `resumeTarget` is that dropped position, taken here against a fresh
	 * playhead where the seek is a primed-buffer flush.
	 *
	 * The decision is `resumeSeekTarget`, NOT `seekPlan`: a cold-mounted element has no playhead to protect, so
	 * the room's position is a RESUME rather than a jump subject to the telemetry-vs-scrub threshold.
	 *
	 * GUARDED LIKE `applySeek`, and consumed only on the path that applies: the prewarming slot reaches `canplay`
	 * too, so without the guard it would park the NEXT song's element at the outgoing song's position. The guard
	 * makes the inactive slot a no-op WITHOUT consuming the target. What keeps a stale target off the next song is
	 * the server publishing `positionSec: 0` on advance, so the incoming song re-stashes 0.
	 */
	function applyResume(): void {
		const el = untrack(() => master);
		const target = resumeTarget;
		if (target === undefined || !el) return;
		// Mirror applySeek's full guard — the resume path had only `!el`, and that is the regression the
		// cold-mount fix opened. The prewarming (hidden, INACTIVE) slot is handed the next song's media
		// and DOES reach `canplay` (onprewarmed rides masterReady off canplaythrough at any visibility),
		// so a playback command carrying a non-zero position (a guest scrub, a pause/resume) is stashed
		// in BOTH slots. applySeek early-returns on the inactive slot; applyResume must too, or it parks
		// the NEXT song's element at the outgoing song's position, and on advance setPosition writes that
		// stale playhead as the incoming song's room position on every phone — the earlier changes shape. Do
		// NOT consume resumeTarget here: the slot may legitimately become active later (it advances into
		// the visible role), and its real element load must still be able to take the position.
		const snap = untrack(() => media);
		const isActive = untrack(() => active);
		if (!snap || !isPlayable(snap) || !isActive) return;
		const plan = resumeSeekTarget(el.currentTime, target);
		if (plan.seek) el.currentTime = plan.target;
		// Consume it: one resume per element load, only on the path that actually applied it. The guide
		// re-aligns on its OWN `canplay` against wherever the master now sits, so it is not driven here.
		resumeTarget = undefined;
	}

	// ── pitch shift (the ± semitone transpose, made audible) ─────────────────────────────────────────
	//
	// ONE graph per element, built LAZILY on the first non-zero shift. See pitch-shift.ts for the full trap
	// write-up; what is enforced here:
	//
	//   • keyShift 0 → no graph is constructed, so the audio path is byte-for-byte the plain element. This must
	//     never regress: a broken shift is bad, killing all room audio is catastrophic.
	//   • only the ACTIVE slot shifts. The hidden slot is paused, and a MediaElementSource is a PERMANENT
	//     capture, so wrapping it early would commit it to WebAudio before it is playing, for no benefit.
	//
	//     THE GUIDE MIX IS THE ONE EXCEPTION, deliberately: a mix song's src is withheld until its graph is
	//     confirmed, so waiting for the slot to become active would land the gapless seam on a song that then has
	//     to build a graph and re-decide its src — the mid-song rewrite `guide-mix-src.ts` exists to prevent.
	//     The cost is accepted: a second context and worklet per room, and a permanent capture of an element
	//     that might never play.
	//   • the graph resumes its own context; if it cannot, it degrades to audible-but-unshifted rather than to
	//     silence.
	$effect(() => {
		// Read reactive deps up front so the effect re-runs when any of them change.
		const shift = active ? keyShift : 0;
		const v = master;
		if (!v) return;
		// GUIDE-MIX SONGS BUILD EAGERLY, and in SPLIT mode. Their guiding track does not exist until the
		// splitter runs, so unlike a transpose there is nothing to wait for — `wantsEagerGraph` names that
		// inversion. Everything else keeps the LAZY graph, which is load-bearing: at keyShift 0 a plain song
		// touches no WebAudio at all, so a broken graph cannot cost the room its audio.
		//
		// `mixSettled` is flipped on EVERY outcome, success or not, because it gates the src: a mix song
		// commits no src at all until the attempt has finished, so an attempt that never settles would leave
		// the room silent. The three settling paths below are exhaustive — an existing graph (nothing to
		// wait for), a resolved build, and a rejected build.
		if (wantsEagerGraph(guidePlan)) {
			if (!masterGraph) masterGraph = new PitchShiftGraph(v, { split: true });
			masterGraph.setGuideGain(effectiveGuide);
			if (masterGraph.isRouted) {
				// Already routed — either this song's build finished, or a PRIOR song in this slot built a
				// graph whose mode is now fixed. Settle immediately and let `mixGateFor` judge whether that
				// graph is actually a split one; a leftover non-split graph resolves to `denied`, so the mix
				// is withheld and the room gets the instrumental with no guide rather than a downmix.
				if (!mixSettled) mixSettled = true;
			} else {
				void masterGraph
					.ensureRouted()
					.catch(() => {})
					.finally(() => {
						// Settle on success AND on failure. `mixGateFor` reads the graph's own state, so this
						// only has to say "the attempt is over" — it must never itself decide the src.
						mixSettled = true;
					});
			}
		}
		// Master. Only ever build the graph once there is a real shift to apply; setShift(0) on an
		// un-built graph is a documented no-op.
		if (needsShift(shift) && !masterGraph) masterGraph = new PitchShiftGraph(v);
		// REPORT THE OUTCOME. `setShift` resolves whether or not the graph could route, and a graph that
		// could not (no user activation yet → suspended AudioContext → deliberate degrade to the element's
		// native output) leaves the song audible but UNSHIFTED. Nothing read that before, which is why a
		// dead ± button had no symptom beyond "it does nothing". Telling the page lets it ask for the tap
		// that would fix it, and `retryPitchAfterGesture` above is what makes that tap work.
		const applied = masterGraph?.setShift(shift);
		if (applied) {
			void applied
				.catch(() => {})
				.then(() => {
					// Only the slot the viewer is looking at may raise a hint, like `onautoplayblocked`.
					if (!active || !visible) return;
					if (!needsShift(shift)) {
						// Back at concert pitch — nothing is pending, so retract any hint.
						onpitchrouted?.();
					} else if (masterGraph && !masterGraph.isRouted) {
						onpitchblocked?.();
					} else {
						onpitchrouted?.();
					}
				});
		} else if (!needsShift(shift) && active && visible) {
			// No graph at all and no shift wanted: the keyShift-0 invariant path. Nothing is pending.
			onpitchrouted?.();
		}
		// Re-apply the master's normalization level: the level effect above owns it, but its tracked deps
		// are `master`/`effectiveMasterLevel` only — `masterGraph` is a plain variable, so that effect does
		// NOT re-run when a transpose builds the graph here. Without this, an attenuated song jumps to FULL
		// volume the first time anyone transposes. Reading `effectiveMasterLevel` here also re-runs this
		// effect on a level change, so the graph's gain tracks the pulldown whether the graph is built
		// before or after it.
		masterGraph?.setGain(effectiveMasterLevel);
		// And the GUIDE pair's gain, for the same reason and on the same graph. A freshly built
		// PitchShiftGraph defaults `desiredGuideGain` to 0 (deliberately — see pitch-shift.ts: the worst
		// case of a missed call must be a guide nobody hears, never one that drowns the singer), so a
		// transpose that (re)builds the graph has to re-assert the room's level here. Reading
		// `effectiveGuide` also makes this effect re-run when the knob moves.
		masterGraph?.setGuideGain(effectiveGuide);
		// The guide needs no shift of its own: it is channels 2/3 of this same element, so ONE worklet
		// shifts all four channels at one ratio and the pair cannot fall out of key with the instrumental.
		// A second graph on a second element used to do this, and keeping the two ratios equal was a
		// standing obligation rather than a property.
	});

	function fileSrc(m: PlaybackSnapshot): string {
		// The SINGLE separated instrumental — no per-key files. Transposition happens in the browser, so the src
		// never depends on keyShift and cannot 404 on a variant nothing rendered. `playbackRef` is the separated
		// instrumental; `sourceRef` is the ORIGIN and is never played.
		//
		// ON A GUIDE-MIX SONG this may be the 4-channel mix, but ONLY once the split graph has captured the element
		// and confirmed a running context — `masterSrcPlan` owns that rule. Played natively a 4-channel file is
		// DOWNMIXED, summing the isolated vocals into the instrumental at full volume, so until routed we hold the
		// plain instrumental: a room that cannot run WebAudio plays with no guide rather than with vocals on top.
		// `mixGateFor` folds in BOTH halves — routed AND split — because asking `isRouted` alone let a leftover
		// non-split graph from an earlier transpose take the mix and downmix it.
		const plan = masterSrcPlan(guidePlan, playbackRef(m), mixGateFor(masterGraph, mixSettled));
		// `plan.mixed` is the src's own claim about what it is. Asserting it against the graph turns a
		// disagreement into a loud, findable failure instead of a room full of full-volume vocals: the two
		// are derived from the same gate, so they can only diverge if someone edits one of them alone.
		if (plan.mixed && !(masterGraph?.isSplit && masterGraph.isRouted)) {
			console.error('[tv] refusing a 4-channel src with no split graph — this would downmix the vocals');
			return `/media/${playbackRef(m)}`;
		}
		return plan.ref ? `/media/${plan.ref}` : '';
	}

	/**
	 * The src the element currently holds, tracked so we assign it ONLY when the resolved string
	 * actually changes.
	 *
	 * Bug A: an unrelated process finishing rebroadcasts a full `queue:sync`, and the TV route rebuilds
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
		// a next-up process reaching a stage rebroadcasts `queue:sync`, the TV rebuilds its media
		// catalog, and for a churn pass or two the PLAYING slot's `media` prop can read momentarily null
		// (a `mediaOf(current)` miss) or not-yet-`isPlayable`. The element only EXISTS while `media &&
		// isPlayable(media)`, so a song that genuinely leaves UNMOUNTS it and this effect short-circuits
		// on `if (!master) return`. Reaching here with `master` still bound but `playable` false is
		// therefore always that transient churn — one microtask ahead of Svelte tearing the element down.
		const playable = !!media && isPlayable(media);
		// Read the settled signal so this effect re-runs when the routing attempt finishes. See
		// `mixSettled` — the graph's getters cannot wake an effect, and while this is false `masterSrcPlan`
		// deliberately commits no src at all on a mix song rather than committing one it will have to
		// rewrite.
		void mixSettled;
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
		// reloaded it to 0. Both are the an earlier change reset. When nothing is playable we keep the current song
		// exactly as the element holds it; the genuine clear on a real song departure is the {#if}
		// unmount, not this effect.
		// Write the entry shadow in LOCKSTEP with the src shadow: the transport reader compares an
		// entry-scoped token, so recording the src without the entry it belongs to would leave turn 2's
		// `held` token half-stale and reintroduce the silent-second-turn edge. A not-playable churn pass
		// leaves BOTH untouched, exactly as it leaves `currentSrc`, so the still-playing entry is kept.
		if (playable) {
			currentSrc = resolved;
			currentEntryId = entryId;
		}
	});

	// THE DRIFT GOVERNOR IS GONE. It ran on the master's ~4Hz `ontimeupdate` and nudged the guide
	// element's `playbackRate` toward the master's playhead. Nothing replaces it, because with one decoder
	// there is no relative drift to correct: the guide is the same samples, from the same clock, as the
	// instrumental. See `playhead-sync.ts` for why the governor could never have worked from script.
</script>

<!--
	The two crossfading slots share one box, so which of them is on top IS the crossfade. Written as the
	named tiers rather than 2 and 1 so the pair reads against the rest of the stage ladder in app.css — a bare integer here says nothing about what it sits above.
-->
<div class="slot" class:visible={visible} style="z-index:{visible ? 'var(--z-tv-video-active)' : 'var(--z-tv-video)'}">
	{#if media && isPlayable(media)}
		<!--
			THE MASTER, and now the ONLY media element. An <audio>, not a <video> — see the note at the top
			of this file. It owns the clock: play/pause, currentTime, `ended`, and the position telemetry
			that the lyrics overlay and the room's progress bar both run on — and, on a guide-mix song, it
			carries the guiding track inside itself as channels 2/3.
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
