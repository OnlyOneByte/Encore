<script lang="ts">
	import { joinAddressLabel, UNREACHABLE_JOIN, UNREACHABLE_JOIN_FIX } from '$lib/tv/join-address';

	interface Props {
		/** Data-URL QR encoding the /join URL (built server-side in +page.server.ts). */
		qrDataUrl: string;
		/** The join URL, shown as text so people can type it if scanning fails. */
		joinUrl: string;
		placement?: 'hero' | 'corner';
		// A NUMBER is pixels, right for the fixed-geometry corner card; a STRING is any CSS length used verbatim, so the
		// TV hero can pass a `vmin` token and grow with a 4K panel instead of dead-ending at a pixel cap.
		size?: number | string;
		/** A loopback / bare-hostname join address: the HERO adds the host's notice beside the QR. The corner ignores it. */
		unreachable?: boolean;
		// Printed on the CORNER card, which has no typed-path block of its own. The HERO treatment deliberately IGNORES
		// it, because attract and the lobby print it themselves across the type ladder.
		roomCode?: string | null;
		/** The CORNER card's element, bound by /tv to measure the band the reaction lane must stand above. */
		cornerEl?: HTMLElement;
	}

	let {
		qrDataUrl,
		joinUrl,
		placement = 'hero',
		size = placement === 'corner' ? 88 : 238,
		unreachable = false,
		roomCode = null,
		cornerEl = $bindable()
	}: Props = $props();

	const qrLength = $derived(typeof size === 'number' ? `${size}px` : size);
	// The intrinsic attribute box must be a NUMBER and --qr overrides the painted size regardless, so a CSS-length
	// size gets a reasonable placeholder rather than 0.
	const intrinsicPx = $derived(typeof size === 'number' ? size : placement === 'corner' ? 88 : 320);

	// The host is enough once the QR carries the real target. Through the shared helper, so the callers cannot drift.
	const shortUrl = $derived(joinAddressLabel(joinUrl));
</script>

<!--
	`corner` is pinned bottom-RIGHT deliberately: the "Now singing" lower-third owns bottom-LEFT.

	THE UNROUTABLE-ADDRESS NOTICE is one line BESIDE a QR that still renders, and the STATED TRADE is that a guest can
	scan a code that will not resolve — accepted, because the address is only unroutable when nobody has set a party
	address, which in practice means a laptop showing this to itself. It is HERO-ONLY: attract and the lobby are the
	empty room where the host is setting up. Mid-song the room is watching and nobody fixes an address from the sofa,
	so the corner never shows it; /settings/server says it too, under the field that fixes it.
-->

{#if placement === 'corner'}
	<div class="corner" aria-label="Scan to join Encore" bind:this={cornerEl}>
		<div class="qr" style="--qr: {qrLength}">
			<img src={qrDataUrl} alt="QR code to join Encore" width={intrinsicPx} height={intrinsicPx} />
		</div>
		<div class="meta">
			<div class="u">{shortUrl}</div>
			<!-- The typed path, mid-song: a camera that will not scan leaves the code as the only way in. -->
			{#if roomCode}
				<div class="c">code <b>{roomCode}</b></div>
			{/if}
		</div>
	</div>
{:else}
	<div class="hero">
		<div class="qr" style="--qr: {qrLength}">
			<img src={qrDataUrl} alt="QR code to join Encore" width={intrinsicPx} height={intrinsicPx} />
		</div>
		{#if unreachable}
			<!--
				THE `.badqr` FAMILY NAMES ARE KEPT ON PURPOSE, even though nothing here is a card any more: it is how the e2e
				contract, the party flow and the scaling probe recognise "this screen advertises an address no phone can reach".
			-->
			<p class="badqr" role="status">
				<b class="badqr-t">{UNREACHABLE_JOIN}</b><span class="badqr-fix">{UNREACHABLE_JOIN_FIX}</span>
			</p>
		{/if}
	</div>
{/if}

<style>
	.qr {
		padding: var(--space-2xl);
		/* A white QUIET ZONE is what makes a code scan reliably — scannability-critical, so the white stays a literal. */
		background: #fff;
		border-radius: 22px;
		box-shadow: var(--shadow);
	}
	.qr img {
		display: block;
		width: var(--qr);
		height: var(--qr);
		border-radius: 6px;
	}

	/* THE HERO SHRINK-WRAPS ITS TILE: `.qr` is a block with a white fill, so in a STRETCH context it spreads to the
	   panel's full width and paints a wide white slab. Centred here, not in the callers, where one could forget. */
	.hero {
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	/* Breathes, so it reads as a live invitation rather than a static poster. OPT-IN, not declared-then-reset: a
	   pulsing TV element is exactly what Reduce Motion is for, and an `animation: none` reset is a declaration a
	   later rule can out-cascade — an animation never declared cannot come back. */
	@media (prefers-reduced-motion: no-preference) {
		.hero .qr {
			animation: breathe 4s ease-in-out infinite;
		}
	}
	@keyframes breathe {
		0%,
		100% {
			transform: scale(1);
		}
		50% {
			transform: scale(1.03);
		}
	}

	.corner {
		position: absolute;
		right: var(--tv-safe-x);
		bottom: var(--tv-safe-y);
		z-index: var(--z-tv-card);
		display: flex;
		align-items: center;
		/* The TV's other cluster gap — TvLobby's `.strip` — is this same rung, and this one was the retired `xl`, 2px
		   away from it for no reason either screen could show. One rung, so the stage reads one rhythm. */
		gap: var(--space-2xl);
		/* NO PANEL: the now-singing block is plain text, so the text here takes the same text-shadow the rest of the
		   stage uses, which works on TV browsers where `backdrop-filter` may never run. */
		text-shadow: 0 2px 14px rgba(0, 0, 0, 0.9);
	}
	.corner .qr {
		padding: 7px;
		border-radius: 10px;
		box-shadow: none;
	}
	.u {
		font-size: var(--tv-body);
		font-weight: 700;
	}
	/* `--tv-body`, not attract's `--tv-code`: this card sits in the safe area beside an 88px QR, and the display tier
	   that is right when the code OWNS the screen would push the card across the stage. */
	.c {
		font-size: var(--tv-body);
		color: var(--ink-dim);
		margin-top: 3px;
		letter-spacing: 0.04em;
	}
	.c b {
		color: var(--ink);
		font-weight: 800;
		letter-spacing: 0.12em;
	}

	/* `text-wrap: balance` rather than a width cap: a cap in `ch` froze the old card two words wide, and one in vmin is
	   a second axis to keep in step with the type scale. */
	.badqr {
		margin: 1.2vh 0 0;
		font-size: var(--tv-label);
		font-weight: 600;
		color: var(--danger-ink);
		text-align: center;
		text-wrap: balance;
	}
	.badqr-t {
		font-weight: 800;
	}
	/* ITS OWN LINE, not a clause after a separator: as `state · remedy` the mid-sentence `·` lands at the start of line
	   two on a 720p panel and reads as a bullet. */
	.badqr-fix {
		display: block;
		font-weight: 500;
		color: var(--ink-dim);
	}
</style>
