<script lang="ts">
	import Icon from '$lib/ui/Icon.svelte';
	import JoinBadge from '$lib/tv/JoinBadge.svelte';

	/** NOBODY HAS JOINED. See docs/FRONTEND.md#the-attract-and-lobby-idles. */
	interface Props {
		qrDataUrl: string;
		joinUrl: string;
		/** The typed path's address, `joinAddressLabel(joinUrl)`. */
		joinLabel: string;
		roomCode?: string | null;
		/** A loopback / bare-hostname join address: the hero QR says so to the host. */
		unreachable: boolean;
		/** The rotating line, owned by /tv so its clock outlives this screen. */
		phrase: string;
	}

	let { qrDataUrl, joinUrl, joinLabel, roomCode = null, unreachable, phrase }: Props = $props();
</script>

<div class="attract">
	<div class="brand"><Icon name="mic" /> <span class="grad-text">Encore</span></div>
	<div class="asplit-l">
		<!-- `Karaoke` never rotates: it is what tells a stranger what they are looking at. -->
		<div class="phrase-kick">Karaoke</div>
		<div class="phrase-box">
			{#key phrase}
				<div class="phrase-line">{phrase}</div>
			{/key}
		</div>
	</div>
	<div class="asplit-r">
		<!-- QR first: scanning types nothing, so it is the fast path and owns the top of the panel. -->
		<JoinBadge
			qrDataUrl={qrDataUrl}
			joinUrl={joinUrl}
			placement="hero"
			size="var(--tv-attract-qr)"
			unreachable={unreachable}
		/>
		<!-- The typed path, BROKEN across the type ladder: one long sentence at ten feet is the failure mode. -->
		<div class="join-text">
			<div class="jt-step">Go to</div>
			<div class="jt-url">{joinLabel}</div>
			{#if roomCode}
				<div class="jt-step jt-code-step">and enter room code</div>
				<!-- THE LARGEST ELEMENT ON THE SCREEN (--tv-code): it is the thing being transcribed. -->
				<div class="jt-code">{roomCode}</div>
			{/if}
			<div class="jt-or">or scan the QR code</div>
		</div>
	</div>
</div>

<style>
	.attract {
		position: absolute;
		inset: 0;
		z-index: var(--z-tv-screen);
		background: radial-gradient(80% 60% at 30% 30%, var(--stage-glow) 0%, var(--bg) 70%);
	}
	/* Its offset from the edge is what proves the stage chrome clears the overscan region — the e2e stageBrand
	   anchor reads this. */
	.brand {
		position: absolute;
		top: var(--tv-safe-y);
		left: var(--tv-safe-x);
		font-weight: 800;
		font-size: var(--tv-name);
		display: inline-flex;
		align-items: center;
		gap: var(--tv-space-lg);
	}
	.asplit-l {
		position: absolute;
		left: var(--tv-safe-x);
		top: 0;
		bottom: 0;
		width: var(--tv-attract-left);
		display: flex;
		flex-direction: column;
		justify-content: center;
	}
	.phrase-kick {
		font-size: var(--tv-name);
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--accent-ink);
	}
	/* FIXED height, so a one- and a two-line phrase never move the label above it. The 1.03 here is the same
	   line-height `.phrase-line` sets, and the two MUST agree or the box no longer holds whole lines. */
	.phrase-box {
		height: calc(var(--tv-phrase) * 1.03 * var(--tv-phrase-lines));
		margin-top: 2vh;
		display: grid;
		align-content: center;
		overflow: hidden;
	}
	.phrase-line {
		font-size: var(--tv-phrase);
		font-weight: 900;
		line-height: 1.03;
	}
	/* A CUT, THEN A FADE-IN, replayed by the `{#key phrase}` remount: the old line unmounts at once and the
	   new one fades in over 600 ms. Not a crossfade. 600 ms is a deliberate exception to the motion tokens: a slower
	   swap for a screen nobody is acting on. A CSS animation, NEVER a Svelte transition directive, which never
	   consults the media query. Under `reduce` this does not apply AND the clock is off. */
	@media (prefers-reduced-motion: no-preference) {
		.phrase-box .phrase-line {
			animation: phrase-fade 0.6s ease-out;
		}
	}
	@keyframes phrase-fade {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	.asplit-r {
		position: absolute;
		right: 0;
		top: 0;
		bottom: 0;
		width: var(--tv-attract-right);
		background: var(--bg2);
		border-left: 2px solid var(--line);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 3.2vh;
		/* Right/top/bottom are real screen edges and take the overscan token; the LEFT edge is the interior 2px
		   border, so it takes a plain gutter. Charging --tv-safe-x on both sides clips the join address. */
		padding: var(--tv-safe-y) var(--tv-safe-x) var(--tv-safe-y) var(--tv-space-4xl);
		text-align: center;
		overflow: hidden;
	}
	.join-text {
		display: flex;
		flex-direction: column;
		align-items: center;
		width: 100%;
		min-width: 0;
	}
	.jt-step {
		font-size: var(--tv-body);
		color: var(--ink-dim);
		line-height: 1.3;
	}
	.jt-code-step {
		margin-top: 1.6vh;
	}
	.jt-url {
		/* An address is ONE unbreakable token: no overflow-wrap, because SHRINKING beats breaking. What makes it FIT
		   is --tv-attract-right, sized from a measured 23-char address plus the overscan padding. */
		font-size: var(--tv-name);
		font-weight: 800;
		font-variant-numeric: tabular-nums;
		line-height: var(--lh-tight);
	}
	.jt-code {
		font-size: var(--tv-code);
		font-weight: 900;
		letter-spacing: 0.11em;
		/* Tracking adds its space after the LAST glyph too, so a centred shrink-to-fit box is half a letter-space
		   wider than the glyphs. The padding must always equal the letter-spacing above it. */
		padding-left: 0.11em;
		color: var(--accent-ink);
		line-height: var(--lh-none);
		font-variant-numeric: tabular-nums;
		margin-top: 0.6vh;
	}
	.jt-or {
		font-size: var(--tv-small);
		color: var(--ink-dim);
		margin-top: 1.8vh;
	}
</style>
