<script lang="ts">
	// One media surface (slot A or B). Renders the separated instrumental in a <video>.
	// Reports ready/ended up so the GaplessController can orchestrate the swap.
	//
	// THE GUIDING TRACK. A second, secondary <audio> carries the isolated vocals and FOLLOWS the
	// instrumental, with its volume set to the guide level. The instrumental stays the master: it keeps
	// owning play/pause, currentTime, `ended`, and every telemetry callback the gapless state machine
	// and the lyrics overlay run on. Nothing about the existing playback path changes, which is the
	// reason this is two media elements rather than a WebAudio graph — a graph buys sample-exact lock
	// and effects at the cost of rebuilding the part that already works.
	import { playbackRef, isPlayable, type Media } from '@encore/shared';
	import { guideCorrection } from './guide-sync';
	import { nextVideoSrc } from './video-src';
	import { PitchShiftGraph, needsShift } from './pitch-shift';
	interface Props {
		media: Media | null;
		visible: boolean;
		active: boolean; // is this the playing slot (vs the hidden pre-warming slot)
		playing?: boolean; // playback:state.isPlaying — pause/resume from the phone
		seekSec?: number; // playback:state.positionSec — jump the video when the phone seeks
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
	}
	let {
		media,
		visible,
		active,
		playing = true,
		seekSec,
		keyShift = 0,
		guideLevel = 0,
		onready,
		onprewarmed,
		onended,
		onerror,
		onposition
	}: Props = $props();

	let video: HTMLVideoElement | undefined = $state();
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

	/** Pre-roll alignment only. Before the guide is playing a seek costs nothing, so it stays a seek. */
	const GUIDE_PREROLL_ALIGN_SEC = 0.04;

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
	// The src the <video> currently holds; the assign effect below writes the element ONLY when this
	// changes (see that effect for why an unconditional binding restarts the song). Declared here with
	// the other slot state so the reset effect can clear it.
	let currentSrc = $state<string | null>(null);

	// A new song in this slot forgets the previous one's readiness. Without this a re-warmed slot never
	// reports ready again and the gapless swap stalls on it. This effect reads only `media?.id`, and
	// writes nothing it reads, so it cannot loop.
	//
	// It also drops `currentSrc` to null: the {#if} unmounts and remounts the <video> per song, so a
	// fresh element starts with no src, and a stale `currentSrc` from the previous element would make
	// the assign effect wrongly conclude "unchanged" and never write the new element's src.
	$effect(() => {
		void media?.id;
		masterReady = false;
		guideSettled = false;
		prewarmedFired = false;
		visibleReadyFired = false;
		currentSrc = null;
		// FIX: tear the pitch-shift graphs down PER SONG, not just on component destroy. A graph binds a
		// PERMANENT MediaElementAudioSourceNode to the <video>/<audio> the {#if} mounts for THIS media;
		// when media changes the {#if} unmounts that element and mounts a fresh one, but a graph left in
		// place is still wired to the destroyed element. The shift-wiring effect below would then see
		// `masterGraph` already set (`!masterGraph` false) and post setShift() to a dead node — silent on
		// the transposed song. Returning the teardown as this effect's cleanup runs it on the NEXT
		// media?.id change, before the shift-wiring effect rebuilds, so the new element gets its own
		// graph. This effect is registered before that one, so ordering is guaranteed. Component destroy
		// runs the same cleanup, which is why the old destroy-only teardown is gone.
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

	// keep <video> play/pause in sync with slot state AND the paused/playing command from the phone
	$effect(() => {
		if (!video || !media || !isPlayable(media)) return;
		if (active && visible && playing) video.play().catch(() => {});
		else video.pause();
	});

	// The guide mirrors the master's transport exactly. A rejected play() is swallowed the same way the
	// master's is: an autoplay refusal on the guide must degrade to a silent guide, never to a stalled
	// song.
	$effect(() => {
		if (!vocals || !video) return;
		if (active && visible && playing) {
			// Line it up BEFORE starting, so the guide does not enter a couple of seconds behind and get
			// dragged forward audibly by the first governor tick. A seek here is free — nothing is
			// audible yet — which is exactly why the governor below does not use one.
			if (Math.abs(vocals.currentTime - video.currentTime) > GUIDE_PREROLL_ALIGN_SEC) {
				vocals.currentTime = video.currentTime;
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

	// seek the <video> when the phone scrubs. Only a real JUMP (>1.5s from where we are) seeks —
	// so the ~4Hz position telemetry and pause/resume (which carry the current position) don't
	// fight the playhead. Guarded to the active playable slot.
	$effect(() => {
		if (!video || !media || !isPlayable(media) || seekSec === undefined) return;
		if (active && Math.abs(video.currentTime - seekSec) > 1.5) video.currentTime = seekSec;
	});

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
		const v = video;
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

	function fileSrc(m: Media): string {
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
		if (!video) return;
		// A slot with nothing playable resolves to '' and clears the element, matching the {#if} that
		// previously unmounted the <video> for unplayable media.
		const resolved = media && isPlayable(media) ? fileSrc(media) : '';
		const decision = nextVideoSrc(currentSrc, resolved);
		if (!decision.changed) return;
		currentSrc = decision.src;
		// Assigning '' would set the src to the document URL and trigger a spurious load/error; use
		// removeAttribute to genuinely clear it, mirroring an unmounted element.
		if (decision.src === '') video.removeAttribute('src');
		else video.src = decision.src;
	});

	/**
	 * The drift governor. Runs on the master's existing ~4Hz `ontimeupdate` rather than its own timer,
	 * so the guide is corrected against the clock that actually drives the room.
	 *
	 * It corrects with `playbackRate`, not `currentTime`: see `guide-sync.ts` for why seeking here is
	 * what made the guide crackle.
	 */
	function syncGuide(): void {
		if (!vocals || !video || vocals.seeking) return;
		const correction = guideCorrection(vocals.currentTime, video.currentTime);
		if (correction.kind === 'reseek') vocals.currentTime = video.currentTime;
		// Assign only on a real change: writing playbackRate is not free on every element.
		if (vocals.playbackRate !== correction.rate) vocals.playbackRate = correction.rate;
	}
</script>

<div class="slot" class:visible style="z-index:{visible ? 2 : 1}">
	{#if media && isPlayable(media)}
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			bind:this={video}
			preload="auto"
			oncanplaythrough={() => (masterReady = true)}
			onended={() => onended?.()}
			onerror={() => active && visible && onerror?.()}
			ontimeupdate={() => {
				if (video) onposition?.(video.currentTime, video.duration);
				syncGuide();
			}}
		></video>
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
	video {
		width: 100%;
		height: 100%;
		border: 0;
		object-fit: contain;
		/*
		 * TRANSPARENT, not #000. `object-fit: contain` letterboxes, and a make-karaoke song plays an
		 * instrumental with no video track at all — so this element's own background used to paint the
		 * whole screen black and would completely hide the room's stage background beneath it. The floor
		 * is `.tv`'s black on the TV page, so nothing regresses when a room chooses `off`.
		 */
		background: transparent;
	}
</style>
