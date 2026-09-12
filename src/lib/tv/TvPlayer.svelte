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
	import { playbackRef, isPlayable, guideOffsetSec } from '$lib/contract';	import type { PlaybackSnapshot } from './catalog';
	import { untrack } from 'svelte';
	import { guideCorrection, prerollSeekTarget, resumeSeekTarget, seekPlan } from './guide-sync';
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
		onplaybackfailed
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

	// The master instrumental's applied level — the loudness-normalization pulldown, clamped to
	// [0,1] here as a second guard even though the route already clamps it. Attenuate-only: this is 1
	// for the whole existing library and rises no higher, so a song is only ever pulled DOWN.
	const effectiveMasterLevel = $derived(Math.max(0, Math.min(1, masterLevel)));

	const guideRef = $derived(media?.vocalsRef ?? null);
	/**
	 * The measured guide/instrumental offset in SECONDS — the ZERO POINT the guide is aligned to.
	 *
	 * `guide-sync.ts` compares playheads and is blind to any offset baked into the decoded audio, so a
	 * stem shifted in its samples reads as in-time while the ears hear it early or late. This carries the
	 * measured shift so the guide is aligned to `master.currentTime + guideOffsetSecValue` at all three
	 * sites (pre-roll, jump, drift). It is 0 for a song with no measured offset (guideOffsetSec maps
	 * absent → 0), so the whole existing library is held EXACTLY as today; only a song with a stored
	 * non-zero offset is shifted. The offset arrives as an INPUT to the pure policy functions — never a
	 * new branch inside guide-sync.ts.
	 */
	const guideOffsetSecValue = $derived(media ? guideOffsetSec(media) : 0);
	/**
	 * Mount-worthiness, split from level-gating (§3 of an earlier change). The guide <audio> stays mounted
	 * whenever THIS song CAN have a guide — a guide ref exists and the song is playable — regardless of
	 * the current level. It deliberately does NOT read `effectiveGuide`: the guide-level slider is
	 * `step="1"` from `min="0"`, so dragging it through the left end used to flip a level-gated mount
	 * false-then-true and UNMOUNT/REMOUNT the element mid-song, re-paying the pre-roll lock-on (the
	 * `canplay` alignment) on every pass through 0. Keeping the element mounted through 0 means passing
	 * through 0 gates the audio to silent (see the level effect: `vocals.volume`/`guideGraph.setGain`)
	 * without ever tearing the buffered/aligned element down.
	 */
	const guideMountable = $derived(!!guideRef && !!media && isPlayable(media));
	/**
	 * Level-gating for READINESS, kept on the ORIGINAL condition (`effectiveGuide > 0`) — trap an earlier change of
	 * an earlier change. This is what keeps the default free: the feature ships at 0, and a room that never turns it
	 * on must NOT wait on `guideSettled` before announcing ready, i.e. must not pay to decode a second
	 * stream in silence just to leave `loading`. So the ready-report effects below gate on `wantsGuide`
	 * (level > 0), NOT on `guideMountable`. A room that DOES set a default pays one extra preload per
	 * slot — exactly what it asked for.
	 */
	const wantsGuide = $derived(guideMountable && effectiveGuide > 0);

	// ── readiness ──────────────────────────────────────────────────────────────
	// The slot is ready for a gapless swap only when everything it will play can play. Announcing on
	// the master alone would start a song whose guide had not buffered — silence where the guide should
	// be, for the first seconds of every song. `guideSettled` means "stop waiting": ready, failed, or
	// timed out.
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
		// context but CANNOT restore the native path (`createMediaElementSource` in `PitchShiftGraph.build`
		// is an irreversible capture; the permanence is documented on `PitchShiftGraph.detach`). So the reset strategy has
		// to match each element's LIFETIME, not the media's:
		//
		//   • MASTER lives as long as `media && isPlayable(media)` — the <audio bind:this={master}> below
		//     sits behind that {#if} (NOT mounted unconditionally: a drained room UNMOUNTS it, which is what
		//     an earlier change turns on). Detaching its graph on a song change left the persistent, already-captured
		//     element feeding a disconnected node: the instrumental went silent and stayed silent until a
		//     keyShift rebuilt a graph on it. We must NOT detach it. Instead reset it to
		//     ratio 1 via setShift(0): on a routed graph that keeps source→node→gain→destination intact
		//     and merely posts ratio 1 (`PitchShiftGraph.setShift` posts the ratio to the worklet via
		//     `postMessage`), so the element stays audible on the new song;
		//     on an un-built graph it is a documented no-op. Teardown happens where the element GENUINELY
		//     dies: the destroy effect below on component teardown, AND the `if (!master)` element-unmount
		//     effect that releases the master graph when a drained room unmounts the <audio>. A song
		//     CHANGE keeps the element mounted, so it must NOT detach here.
		//   • GUIDE lives as long as its <audio> element is MOUNTED — which is exactly as long as
		//     `guideMountable` holds ({#if guideMountable && guideRef} below; mount-worthiness is a
		//     playable song WITH a guide ref, INDEPENDENT of the level — an earlier change). The earlier model here
		//     said the guide is "remounted for the NEW song" and so detached its graph on every song
		//     change. That is FALSE for the common case: a SKIP changes the song IN PLACE in
		//     the visible slot (gapless.ts onNowPlaying keeps the same slot and only its src changes), and
		//     `guideMountable` is true for both the skipped and the next song, so Svelte keeps the SAME
		//     <audio> element. Its MediaElementSource is a PERMANENT capture, so detach() there left the
		//     still-captured element feeding a released, disconnected context = SILENT guide until a
		//     keyShift built a fresh graph on it (the same shape as an earlier change on the master). So the guide
		//     gets the master's treatment on a song change: reset IN PLACE with setShift(0) (transparent on
		//     a routed graph, a no-op on an un-built one) and re-apply the room level with
		//     setGain(effectiveGuide) — the re-apply is NOT optional, a graph defaults its gain to 1
		//     (pitch-shift.ts) which is the an earlier change defect. We do NOT detach and do NOT drop the reference
		//     here, so we keep the pre-roll lock-on earlier changes protect. detach() moves to where the element
		//     GENUINELY dies: the destroy effect below, PLUS a dedicated effect that releases the graph
		//     when `guideMountable` goes false (a ref-less or non-playable next song unmounts the <audio>).
		void masterGraph?.setShift(0);
		void guideGraph?.setShift(0);
		guideGraph?.setGain(effectiveGuide);
		// Same in-place re-apply for the master's normalization level: a song change resets the
		// graph in place (not detached), and a graph defaults its gain to 1, so re-assert the pulldown
		// here for the same reason the guide does — the new song's level is resolved by the route and
		// arrives as `effectiveMasterLevel`.
		masterGraph?.setGain(effectiveMasterLevel);
		masterReady = false;
		guideSettled = false;
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
			guideGraph?.detach();
			masterGraph = undefined;
			guideGraph = undefined;
		};
	});

	// The guide's element genuinely dies when `guideMountable` goes false — a ref-less or
	// non-playable next song unmounts the <audio> ({#if guideMountable && guideRef} below). THAT is
	// where the guide graph's permanent MediaElementSource is actually gone and its context must be
	// released, so detach() lives here rather than on every song change (see the per-song reset above:
	// a song-to-song skip keeps `guideMountable` true and the SAME element, so detaching there was the
	// an earlier change silence bug). Guarded on the mount-worthiness VALUE, not the media signal, so identity
	// churn on the same mounted state is a no-op; runs once more on destroy via cleanup order, which
	// the destroy effect above already handles idempotently (detach() is best-effort).
	let guideDetachedForUnmount = false;
	$effect(() => {
		if (guideMountable) {
			guideDetachedForUnmount = false;
			return;
		}
		if (guideDetachedForUnmount) return;
		guideDetachedForUnmount = true;
		guideGraph?.detach();
		guideGraph = undefined;
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

	// A DRAINED room UNMOUNTS the master. The `<audio bind:this={master}>` below sits behind
	// `{#if media && isPlayable(media)}`, so when the queue empties the element is destroyed and `master`
	// binds to `undefined` — but `currentSrc` is a component-level shadow that OUTLIVES it. Re-adding the
	// SAME song then resolves `fileSrc(media)` to the byte-identical string, and the transport's
	// `slotHoldsSrc(currentSrc, …)` reads `true` on a FRESH, src-less element. The derived is then
	// `'play'` on its first pass, `tryPlayMaster()` runs before the assign effect has written the src, and
	// that write aborts the pending play(); since the derived value never changed, the effect never re-ran
	// and the room stayed silent while every surface said it was playing. Clear the shadow on the unmount
	// so a remounted element reads `hasSrc:false` and the transport takes a genuine `idle -> play` edge
	// once the assign effect lands the new src. This is NOT the an earlier change not-playable churn pass (the element
	// is still bound there and the current song must be kept) — this fires only when the element is GONE.
	// A bare `master` attribute read would register no reactive dependency, which is why the shadow exists;
	// tracking the binding's presence is the reactive signal that a remount happened.
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
				// Same fixed-target lock-on as the transport path: seek to the master playhead sampled NOW,
				// never to a moving reference the guide flush would fall behind.
				alignGuidePreroll();
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

	// The guide mirrors the master's transport exactly — the SAME `transport` value, computed once by the
	// derived above, so both effects take the same edge at the same time. This is only literally true once
	// that value actually MOVES on a real transport change: before an earlier change a same-song advance produced no
	// value edge for the master (its `hasSrc` stayed stale-true), so the master effect did not re-run while
	// the guide's own start path (its `canplay` / preroll) still could, and the guide could run while the
	// master sat paused at 0 — the mismatch an earlier change measured. With the transport now re-armed per ENTRY the
	// value takes a genuine `idle -> play` edge and both effects re-run together, so the shared-`transport`
	// claim holds. A rejected play() is swallowed the same way the master's is: an autoplay refusal on the
	// guide must degrade to a silent guide, never to a stalled song.
	$effect(() => {
		if (!vocals || !master) return;
		if (transport === 'play') {
			// Start from neutral tempo and preserve pitch; the governor re-derives any trim it needs
			// from real drift, and a tempo trim must never become a pitch shift on a sung vocal (set
			// explicitly -- the default is not uniform across browsers).
			vocals.playbackRate = 1;
			vocals.preservesPitch = true;
			// The ALIGNMENT is deliberately NOT taken here. Aligning at effect time and then calling
			// play() lets the guide decoder spin-up (~150-250ms) run the master forward before the
			// first guide frame emerges, so the guide enters that far behind and the governor spends
			// ~15s per e-fold crawling it back -- the 'starts late and stays late' defect.
			// The lock-on is re-taken on the guide canplay, against the master playhead AT THAT MOMENT,
			// by alignGuidePreroll below; we also take it here so a pause->play on an already-primed
			// buffer (whose canplay will not fire again) still locks on.
			alignGuidePreroll();
			vocals.play().catch(() => {});
		} else {
			vocals.pause();
			vocals.playbackRate = 1;
		}
	});

	/**
	 * Lock the guide onto the master CURRENT playhead -- the pre-roll alignment, and the fix.
	 *
	 * Called at the moment the guide can actually play (its canplay) and on a transport arm, never at
	 * effect time before the buffer exists. The decision is prerollSeekTarget in guide-sync.ts: it reads
	 * the master playhead into a fixed local target and seeks the guide to THAT, so the guide is never
	 * assigned master.currentTime inline (a moving target the decoder flush would outrun). A guide
	 * already inside GUIDE_PREROLL_ALIGN_SEC is left untouched -- no decoder flush for nothing.
	 */
	function alignGuidePreroll(): void {
		if (!vocals || !master) return;
		// The zero point is the master playhead PLUS the measured offset: a stem shifted in its
		// decoded samples must lock on to `master + offset`, not to `master`, or it starts that far out of
		// time and the governor spends ~15s per e-fold crawling it back. `guideOffsetSecValue` is 0 for the
		// whole existing library, so this is byte-for-byte today's pre-roll for a song with no offset.
		const plan = prerollSeekTarget(vocals.currentTime, master.currentTime + guideOffsetSecValue);
		if (plan.seek) vocals.currentTime = plan.target;
		// Neutral tempo so the governor starts from real drift; pitch preserved for the sung vocal.
		vocals.playbackRate = 1;
		vocals.preservesPitch = true;
	}

	// The level itself — the whole "how loud are the original vocals" knob. Set on the element for the
	// native (unshifted) path AND on the guide graph, because once the guide is routed through WebAudio
	// for a shift the element's `volume` is bypassed and only the graph's gain governs it.
	$effect(() => {
		if (vocals) vocals.volume = effectiveGuide;
		guideGraph?.setGain(effectiveGuide);
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
	// ONE-LINE DEPENDENCY SET, ON PURPOSE (— read this before adding a read to it).
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
	// process for an unrelated song churned the catalog, the playing song's playhead was yanked back to
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
		// 0 and so notifies nothing through `seekSec` alone — WITHOUT reopening telemetry-chasing.
		// A bare read is enough to register the dep in runes mode.
		void seekRev;
		if (target === undefined) return;
		// hold this position for the master's `canplay`. On a cold mount (a reload mid-song) the
		// <audio> does not exist yet — it is gated on `nowplaying:changed`, which the server sends AFTER
		// this `playback:state` — so `applySeek` below early-returns on a null master and the target is
		// lost, and telemetry never bumps `rev` to re-wake this effect. Stashing it lets `applyResume`
		// take it once the element can play. `applySeek` still runs for the WARM path (a live scrub with
		// an element already mounted), where `canplay` will not fire again.
		resumeTarget = target;
		applySeek(target);
	});

	/**
	 * Apply a seek target to both elements, from one plan. Called ONLY by the effect above.
	 *
	 * Every read in here is `untrack`ed. That is not incidental tidiness — it is the invariant: an
	 * input to the decision must never become a trigger for it. `vocals` is the original case (the guide
	 * MOUNTING would otherwise re-run the seek and yank the master to a stale position); `media`,
	 * `master` and `active` are the same argument, and `media` is the one that caused an earlier change.
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
		// The guide's zero point is `seekTarget + offset`, the master's is `seekTarget`. seekPlan
		// takes ONE target for both, so the guide half is expressed by shifting the guide's playhead the
		// other way: `guide - offset` compared to `seekTarget` is exactly `guide` compared to
		// `seekTarget + offset`. This keeps seekPlan a pure single-target function and leaves the master's
		// decision (`el.currentTime` vs `seekTarget`) untouched. `guideOffsetSecValue` is 0 for the whole
		// existing library, so a no-offset song's jump is byte-for-byte today's.
		const offset = untrack(() => guideOffsetSecValue);
		const guideSecForPlan = guideEl ? guideEl.currentTime - offset : NaN;
		const plan = seekPlan(el.currentTime, guideSecForPlan, seekTarget);
		if (!plan.master) return;
		el.currentTime = seekTarget;
		if (guideEl) {
			if (plan.guide) guideEl.currentTime = seekTarget + offset;
			// Back to neutral tempo. Any trim still on the element was derived from the drift that
			// existed BEFORE the jump, so carrying it across corrects a drift that no longer exists; the
			// governor re-derives whatever it needs from real drift on its next tick.
			guideEl.playbackRate = 1;
		}
	}

	/**
	 * Resume the master to the room's position on a COLD MOUNT — the fix, and the master's
	 * counterpart to `alignGuidePreroll`.
	 *
	 * Called at the moment the master can actually play (its `canplay`), never at effect time before
	 * the element exists — which is the whole point: on a reload mid-song the `playback:state` frame
	 * carrying the room's position arrives before the `<audio>` is mounted (the element is gated on the
	 * `nowplaying:changed` that the server sends one frame later), so the seek effect fired against a
	 * null master and dropped the target. The held `resumeTarget` is that dropped position; this takes
	 * it here, against the fresh master's playhead (≈0), where the seek is a primed-buffer flush.
	 *
	 * The decision is `resumeSeekTarget`, NOT `seekPlan`: a cold-mounted element has no playhead to
	 * protect, so the room's position is a RESUME, not a jump subject to the telemetry-vs-scrub
	 * threshold (a resume 1s in would otherwise read as sub-threshold telemetry and be dropped). See
	 * `resumeSeekTarget` for the full argument.
	 *
	 * GUARDED LIKE `applySeek`, and consumed only on the path that applies. The prewarming (hidden)
	 * slot reaches `canplay` too, so without the `active`/playable guard it would park the NEXT song's
	 * element at the outgoing song's position — and on advance `setPosition` writes that back as the
	 * incoming song's room position, the earlier changes shape. The guard makes the inactive slot a no-op
	 * WITHOUT consuming the target, so the slot can still resume when it legitimately becomes active.
	 * What keeps a stale target off the next song is not this function clearing the variable — it is the
	 * server publishing `positionSec: 0` on advance (EPHEMERAL_RESET, player.ts) before `emitNowPlaying`,
	 * so the incoming song re-stashes 0.
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
		// Re-apply the master's normalization level, same shape as the guide's an earlier change re-apply
		// below: the level effect above owns it, but its tracked deps are `master`/`effectiveMasterLevel`
		// only — `masterGraph` is a plain variable, so that effect does NOT re-run when a transpose
		// builds the graph here. Without this, an attenuated song jumps to FULL volume the first time
		// anyone transposes. Reading `effectiveMasterLevel` here also re-runs this effect on a level
		// change, so the graph's gain tracks the pulldown whether the graph is built before or after it.
		masterGraph?.setGain(effectiveMasterLevel);
		// Guide, when it is mounted. Shifting it by the SAME amount is what lets us keep it audible under
		// a transposed instrumental instead of muting it.
		if (g) {
			if (needsShift(shift) && !guideGraph) guideGraph = new PitchShiftGraph(g);
			guideGraph?.setShift(shift);
			// Re-apply the room's guide level. The gain effect above owns the level, but its
			// tracked deps are `vocals` and `effectiveGuide` only — `guideGraph` is a plain variable, so
			// that effect does NOT re-run when a transpose builds (or, post-an earlier change, rebuilds) the graph here.
			// A freshly built PitchShiftGraph defaults desiredGain to 1 (pitch-shift.ts), so without this
			// the isolated vocals jump to FULL volume the first time anyone transposes and stay there.
			// Reading `effectiveGuide` here also makes this effect re-run on a level change, so the graph's
			// gain tracks the knob whether the graph is built before or after the level is set.
			guideGraph?.setGain(effectiveGuide);
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

	/**
	 * The drift governor. Runs on the master's existing ~4Hz `ontimeupdate` rather than its own timer,
	 * so the guide is corrected against the clock that actually drives the room.
	 *
	 * It corrects with `playbackRate`, not `currentTime`: see `guide-sync.ts` for why seeking here is
	 * what made the guide crackle.
	 */
	function syncGuide(): void {
		if (!vocals || !master || vocals.seeking) return;
		// The zero point the guide is held at is `master + offset`: the offset is the guide's
		// measured place relative to the instrumental, so drift is `guide - (master + offset)` and a
		// reseek lands the guide at `master + offset`. `guideOffsetSecValue` is 0 for the whole existing
		// library, so a no-offset song's drift governor is byte-for-byte today's. guideCorrection stays a
		// pure policy function — the offset is folded into its `masterSec` input, never a branch inside it.
		const zero = master.currentTime + guideOffsetSecValue;
		const correction = guideCorrection(vocals.currentTime, zero);
		if (correction.kind === 'reseek') vocals.currentTime = zero;
		// Assign only on a real change: writing playbackRate is not free on every element.
		if (vocals.playbackRate !== correction.rate) vocals.playbackRate = correction.rate;
	}
</script>

<!--
	The two crossfading slots share one box, so which of them is on top IS the crossfade. Written as the
	named tiers rather than 2 and 1 so the pair reads against the rest of the stage ladder in app.css — a bare integer here says nothing about what it sits above.
-->
<div class="slot" class:visible={visible} style="z-index:{visible ? 'var(--z-tv-video-active)' : 'var(--z-tv-video)'}">
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
				syncGuide();
			}}
		></audio>
		{#if guideMountable && guideRef}
			<!-- The guiding track: the isolated vocals, following the master. Never the position source
			     for anything — telemetry, lyrics and progress all read the instrumental. -->
			<audio
				bind:this={vocals}
				src={`/media/${guideRef}`}
				preload="auto"
				oncanplaythrough={() => (guideSettled = true)}
				oncanplay={() => {
					// take the pre-roll lock-on HERE, when the guide buffer is primed and the master
					// playhead is where it will be when audio emerges -- not at effect time before decode.
					if (transport === 'play') {
						alignGuidePreroll();
						vocals?.play().catch(() => {});
					}
				}}
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
