<script lang="ts">
	import Icon from '$lib/ui/Icon.svelte';

	/** The two taps a TV wall can need: one to start the music, one to let it change the key. */
	interface Props {
		/** Autoplay was REFUSED: the room is silent until a gesture. */
		autoplayBlocked: boolean;
		/** A transpose is waiting for one tap; the music plays. */
		pitchBlocked: boolean;
		isAttract: boolean;
		/** The tap's free rider; see the autoplay button. */
		onfullscreen: () => void;
	}

	let { autoplayBlocked = $bindable(), pitchBlocked = $bindable(), isAttract, onfullscreen }: Props = $props();
</script>

<!--
	ALSO GATED ON `!isAttract`: the latch's only writers are per-slot props, so when the room DRAINS both players
	unmount and neither can fire again, leaving the scrim over an empty lobby for good above the join QR. Gating
	the RENDER rather than clearing the latch is deliberate — the block is still real.
-->
{#if autoplayBlocked && !isAttract}
	<button
		type="button"
		class="autoplay-hint"
		onclick={() => {
			// FREE RIDER: this tap is a real gesture in the TV's own document, so it carries the activation
			// `requestFullscreen()` needs. Best-effort, and it never blocks the music recovery, which TvPlayer's
			// own gesture listener performs.
			onfullscreen();
			autoplayBlocked = false;
		}}
		aria-label="Tap anywhere to start the music"
	>
		<span class="ah-mark"><Icon name="play" /></span>
		<span class="ah-head">Tap anywhere to <span class="grad-text">start the music</span></span>
	</button>
{/if}

<!--
	A BUTTON, because the tap IS the remedy: it authorises WebAudio for the document and TvPlayer's always-armed
	listener re-drives the pending shift on the same gesture.
-->
{#if pitchBlocked && !autoplayBlocked && !isAttract}
	<button
		type="button"
		class="pitch-hint"
		onclick={() => {
			// The click IS the activation. Clearing optimistically is safe: if the retry does not route, the next
			// pitch effect pass raises it again.
			pitchBlocked = false;
		}}
		aria-label="Tap to let this TV change the key"
	>
		<span class="ph-head">Tap to <span class="grad-text">change the key</span></span>
	</button>
{/if}

<style>
	/* Full-screen, so a tap ANYWHERE authorises playback. A <button>, not a <div>: it is keyboard-focusable, and a
	   keydown is one of the gestures TvPlayer listens for. */
	.autoplay-hint {
		position: absolute;
		inset: 0;
		z-index: var(--z-tv-affordance);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2.2vh;
		padding: var(--tv-safe-y) var(--tv-safe-x);
		border: 0;
		cursor: pointer;
		color: var(--ink);
		text-align: center;
		background: color-mix(in srgb, var(--bg) 82%, transparent);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
	}

	/* Deliberately NOT `inset: 0` like the affordance above: that one covers the stage because the room is silent,
	   while here the song plays fine and only the transpose is stuck. Sized off the TV type ladder rather than a
	   viewport term, because the `.tv` root is already vh-scaled. */
	.pitch-hint {
		position: absolute;
		top: var(--tv-safe-y);
		left: 50%;
		transform: translateX(-50%);
		z-index: var(--z-tv-interstitial);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.3em;
		min-height: var(--tap);
		max-width: 60vw;
		padding: 0.7em 1.4em;
		border: 0;
		border-radius: var(--radius-pill);
		cursor: pointer;
		color: var(--ink);
		text-align: center;
		background: color-mix(in srgb, var(--bg) 88%, transparent);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
	}
	.ph-head {
		font-size: var(--tv-body);
		font-weight: 650;
		line-height: var(--lh-snug);
	}
	.ah-mark {
		display: grid;
		place-items: center;
		/* BOX AND GLYPH ON ONE LADDER. As `clamp(64px, 12vmin, 160px)` the circle stopped growing at 160px while the
		   rem glyph inside it did not: at 4K the 2.881rem glyph is 168px in a 160px circle, so the mark overflowed
		   its own background. 4.4rem is the size that circle already had at 1080p (128px against 129.6px) and at
		   720p (88px against 86.4px), and it holds the 0.65 glyph-to-box ratio at every resolution and --ui-scale. */
		width: 4.4rem;
		height: 4.4rem;
		border-radius: 50%;
		background: color-mix(in srgb, var(--accent) 26%, transparent);
		font-size: 2.881rem;
	}
	.ah-head {
		font-size: var(--tv-hero);
		font-weight: 800;
		line-height: var(--lh-tight);
		text-shadow: 0 2px 12px rgba(0, 0, 0, 0.55);
	}
</style>
