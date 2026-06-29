<script lang="ts">
	// One media surface (slot A or B). Renders YouTube iframe OR <video> per playMode.
	// Reports ready/ended up so the GaplessController can orchestrate the swap.
	import type { Media } from '@encore/shared';
	interface Props {
		media: Media | null;
		visible: boolean;
		active: boolean; // is this the playing slot (vs the hidden pre-warming slot)
		onready?: () => void;
		onended?: () => void;
		onerror?: () => void; // dead/unplayable media — caller should skip
		onposition?: (sec: number, dur: number) => void;
	}
	let { media, visible, active, onready, onended, onerror, onposition }: Props = $props();

	let video: HTMLVideoElement | undefined = $state();

	// keep <video> play/pause in sync with active state
	$effect(() => {
		if (!video || !media || media.playMode !== 'file') return;
		if (active && visible) video.play().catch(() => {});
		else video.pause();
	});

	function fileSrc(m: Media): string {
		return `/media/${m.sourceRef}`;
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
