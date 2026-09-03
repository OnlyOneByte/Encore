<script lang="ts">
	// One media surface (slot A or B). Renders the separated instrumental in a <video>.
	// Reports ready/ended up so the GaplessController can orchestrate the swap.
	import { keyedMediaRef, playbackRef, isPlayable, type Media } from '@encore/shared';
	interface Props {
		media: Media | null;
		visible: boolean;
		active: boolean; // is this the playing slot (vs the hidden pre-warming slot)
		playing?: boolean; // playback:state.isPlaying — pause/resume from the phone
		seekSec?: number; // playback:state.positionSec — jump the video when the phone seeks
		keyShift?: number; // ± semitones for a file song — selects the keyed instrumental
		onready?: () => void;
		onended?: () => void;
		onerror?: () => void; // dead/unplayable media — caller should skip
		onposition?: (sec: number, dur: number) => void;
	}
	let { media, visible, active, playing = true, seekSec, keyShift = 0, onready, onended, onerror, onposition }: Props = $props();

	let video: HTMLVideoElement | undefined = $state();

	// keep <video> play/pause in sync with slot state AND the paused/playing command from the phone
	$effect(() => {
		if (!video || !media || !isPlayable(media)) return;
		if (active && visible && playing) video.play().catch(() => {});
		else video.pause();
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
</script>

<div class="slot" class:visible style="z-index:{visible ? 2 : 1}">
	{#if media && isPlayable(media)}
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			bind:this={video}
			src={fileSrc(media)}
			preload="auto"
			oncanplaythrough={() => onready?.()}
			onended={() => onended?.()}
			onerror={() => active && visible && onerror?.()}
			ontimeupdate={() => video && onposition?.(video.currentTime, video.duration)}
		></video>
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
		background: #000;
	}
</style>
