<script lang="ts">
	// One media surface (slot A or B). Renders YouTube iframe OR <video> per playMode.
	// Reports ready/ended up so the GaplessController can orchestrate the swap.
	import { keyedMediaRef, playbackRef, type Media } from '@encore/shared';
	interface Props {
		media: Media | null;
		visible: boolean;
		active: boolean; // is this the playing slot (vs the hidden pre-warming slot)
		playing?: boolean; // playback:state.isPlaying — pause/resume from the phone (M3-C6)
		seekSec?: number; // playback:state.positionSec — jump the video when the phone seeks (M3-C6)
		keyShift?: number; // ± semitones for a file song (M7-C9) — selects the keyed instrumental
		onready?: () => void;
		onended?: () => void;
		onerror?: () => void; // dead/unplayable media — caller should skip
		onposition?: (sec: number, dur: number) => void;
	}
	let { media, visible, active, playing = true, seekSec, keyShift = 0, onready, onended, onerror, onposition }: Props = $props();

	let video: HTMLVideoElement | undefined = $state();

	// keep <video> play/pause in sync with slot state AND the paused/playing command from the phone
	$effect(() => {
		if (!video || !media || media.playMode !== 'file') return;
		if (active && visible && playing) video.play().catch(() => {});
		else video.pause();
	});

	// seek the <video> when the phone scrubs. Only a real JUMP (>1.5s from where we are) seeks —
	// so the ~4Hz position telemetry and pause/resume (which carry the current position) don't
	// fight the playhead. Guarded to the active file slot.
	$effect(() => {
		if (!video || !media || media.playMode !== 'file' || seekSec === undefined) return;
		if (active && Math.abs(video.currentTime - seekSec) > 1.5) video.currentTime = seekSec;
	});

	function fileSrc(m: Media): string {
		// resolve the keyed instrumental variant for the active slot (0 → the original file).
		// playbackRef picks the separated instrumental for a cooked song, or the origin file key for
		// a plain local file — sourceRef alone is the ORIGIN and is no longer the thing to play.
		return `/media/${keyedMediaRef(playbackRef(m), active ? keyShift : 0)}`;
	}
	function ytEmbed(m: Media): string {
		// muted preload when hidden; autoplay+unmuted when active+visible
		const auto = active && visible ? 1 : 0;
		const mute = active && visible ? 0 : 1;
		return `https://www.youtube.com/embed/${m.sourceRef}?autoplay=${auto}&mute=${mute}&enablejsapi=1&controls=0`;
	}
</script>

<div class="slot" class:visible style="z-index:{visible ? 2 : 1}">
	{#if media}
		{#if media.playMode === 'file'}
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
		{:else}
			<iframe
				title={media.title}
				src={ytEmbed(media)}
				allow="autoplay; encrypted-media"
				onload={() => onready?.()}
			></iframe>
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
	video,
	iframe {
		width: 100%;
		height: 100%;
		border: 0;
		object-fit: contain;
		background: #000;
	}
</style>
