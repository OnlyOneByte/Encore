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
	import { keyedMediaRef, playbackRef, isPlayable, type Media } from '@encore/shared';
	interface Props {
		media: Media | null;
		visible: boolean;
		active: boolean; // is this the playing slot (vs the hidden pre-warming slot)
		playing?: boolean; // playback:state.isPlaying — pause/resume from the phone
		seekSec?: number; // playback:state.positionSec — jump the video when the phone seeks
		keyShift?: number; // ± semitones for a file song — selects the keyed instrumental
		guideLevel?: number; // 0..1 — how loud the original vocals sit under the instrumental
		onready?: () => void;
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
		onended,
		onerror,
		onposition
	}: Props = $props();

	let video: HTMLVideoElement | undefined = $state();
	let vocals: HTMLAudioElement | undefined = $state();

	/**
	 * Snap the guide back to the master when it drifts past this. Two independent media elements are
	 * not sample-locked, and a nudge of a few tens of ms is inaudible on a vocal sitting under a
	 * backing track — whereas a full re-decode to lock them would not be.
	 */
	const DRIFT_TOLERANCE_SEC = 0.04;

	/**
	 * How long to wait for the guide to become playable before giving up on it for this slot.
	 *
	 * This exists because `onready` gates the gapless swap. Waiting for BOTH elements is correct — a
	 * slot whose guide has not buffered would start the song with silence where the guide should be —
	 * but waiting FOREVER would let one stalled audio fetch cost the room the song entirely. `onerror`
	 * covers a 404 or a decode failure; this covers a fetch that simply never resolves.
	 */
	const GUIDE_READY_TIMEOUT_MS = 4000;

	// The vocals stem is rendered at key 0 only, so a transposed song has no matching guide: mixing
	// key-0 vocals under a +2 instrumental is musically wrong, not merely imperfect. keyShift is not
	// yet wired on the TV (see ROADMAP), so today this is always 0 and the guide always applies —
	// but the guard belongs here, with the mixing, rather than being owed to whoever wires it.
	const effectiveGuide = $derived(keyShift !== 0 ? 0 : Math.max(0, Math.min(1, guideLevel)));

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
	let announced = $state(false);

	// A new song in this slot forgets the previous one's readiness. Without this a re-warmed slot never
	// reports ready again and the gapless swap stalls on it. This effect reads only `media?.id`, and
	// writes nothing it reads, so it cannot loop.
	$effect(() => {
		void media?.id;
		masterReady = false;
		guideSettled = false;
		announced = false;
	});

	$effect(() => {
		if (masterReady && (guideSettled || !wantsGuide) && !announced) {
			announced = true;
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
			// dragged forward audibly by the first governor tick.
			if (Math.abs(vocals.currentTime - video.currentTime) > DRIFT_TOLERANCE_SEC) {
				vocals.currentTime = video.currentTime;
			}
			vocals.play().catch(() => {});
		} else {
			vocals.pause();
		}
	});

	// The level itself — the whole "how loud are the original vocals" knob.
	$effect(() => {
		if (vocals) vocals.volume = effectiveGuide;
	});

	// seek the <video> when the phone scrubs. Only a real JUMP (>1.5s from where we are) seeks —
	// so the ~4Hz position telemetry and pause/resume (which carry the current position) don't
	// fight the playhead. Guarded to the active playable slot.
	$effect(() => {
		if (!video || !media || !isPlayable(media) || seekSec === undefined) return;
		if (active && Math.abs(video.currentTime - seekSec) > 1.5) video.currentTime = seekSec;
	});

	function fileSrc(m: Media): string {
		// resolve the keyed instrumental variant for the active slot (0 → the original file).
		// playbackRef is the separated instrumental; sourceRef is the ORIGIN and is never played.
		return `/media/${keyedMediaRef(playbackRef(m), active ? keyShift : 0)}`;
	}

	/**
	 * The drift governor. Runs on the master's existing ~4Hz `ontimeupdate` rather than its own timer,
	 * so the guide is corrected against the clock that actually drives the room.
	 */
	function syncGuide(): void {
		if (!vocals || !video || vocals.seeking) return;
		if (Math.abs(vocals.currentTime - video.currentTime) > DRIFT_TOLERANCE_SEC) {
			vocals.currentTime = video.currentTime;
		}
	}
</script>

<div class="slot" class:visible style="z-index:{visible ? 2 : 1}">
	{#if media && isPlayable(media)}
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			bind:this={video}
			src={fileSrc(media)}
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
