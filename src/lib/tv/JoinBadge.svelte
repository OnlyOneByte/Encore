<script lang="ts">
	import { joinAddressLabel } from '$lib/tv/join-address';

	interface Props {
		/** Data-URL QR encoding the /join URL (built server-side in +page.server.ts). */
		qrDataUrl: string;
		/** The join URL, shown as text so people can type it if scanning fails. */
		joinUrl: string;
		placement?: 'hero' | 'corner';
		/** How many singers are in the room right now; shown on the corner card. Hidden when 0. */
		onlineCount?: number;
		/**
		 * A NUMBER is pixels, correct for the fixed-geometry corner card; a STRING is any CSS length used
		 * verbatim, so the TV hero can pass a `vmin` token and grow the code with the panel on a 4K wall instead
		 * of dead-ending at a pixel cap. The `<img>` intrinsic size stays a plain number for a sensible pre-CSS
		 * layout box; the CSS `--qr` governs the PAINTED size.
		 */
		size?: number | string;
		/**
		 * The advertised join address is one no phone can reach (loopback / bare hostname). Render an
		 * operator notice naming the fix instead of a QR that looks fine but every scan fails silently.
		 */
		unreachable?: boolean;
		/**
		 * The room code, printed in the two treatments that carry no typed-path block of their own: the CORNER
		 * card and the UNREACHABLE notice. Without it, the screen advertising an unroutable address offers no way
		 * in at all — yet the code is perfectly typable by anyone reaching the app on another address, which is
		 * the situation an operator on a laptop is in — and mid-song a latecomer whose camera will not scan has
		 * nothing to transcribe. The HERO treatment deliberately IGNORES it, because attract and the lobby print
		 * the code themselves as part of a sentence broken across the type ladder.
		 */
		roomCode?: string | null;
	}

	let {
		qrDataUrl,
		joinUrl,
		placement = 'hero',
		onlineCount = 0,
		size = placement === 'corner' ? 88 : 238,
		unreachable = false,
		roomCode = null
	}: Props = $props();

	// A number is pixels; a string is a raw CSS length. This is what --qr is set to.
	const qrLength = $derived(typeof size === 'number' ? `${size}px` : size);
	// The intrinsic attribute box must be a NUMBER, and --qr overrides the painted size regardless, so a
	// CSS-length size gets a reasonable placeholder rather than 0.
	const intrinsicPx = $derived(typeof size === 'number' ? size : placement === 'corner' ? 88 : 320);

	// The full URL is too long to read across a room; the host is enough once the QR carries the real
	// target. Through the shared helper, so the three callers cannot drift.
	const shortUrl = $derived(joinAddressLabel(joinUrl));
</script>

JoinBadge — the join QR in one of two placements. `hero` owns the middle of an idle screen; `corner` is a compact card
pinned bottom-right so a latecomer mid-song can get in without stopping the music. Bottom-RIGHT is deliberate: the "Now
singing" lower-third owns bottom-LEFT.

<!--
	THE UNROUTABLE-ADDRESS NOTICE — one line, beside a QR that STILL RENDERS. Replacing the QR with a panel
	was the right shape for the fault (a QR nobody can scan is a working-looking dead end) and the wrong
	shape for the screen: on a loopback address the only person looking is the operator.

	THE STATED TRADE, on the record: a guest CAN now scan a code that will not resolve. That is accepted
	deliberately — the address is only unroutable when nobody has set a party address, which in practice
	means a laptop showing this to itself.

	The fix clause is HIDDEN in the corner treatment rather than written twice, so one string cannot drift.
-->
{#snippet notice()}
	{#if unreachable}
		<!--
			THE `.badqr` FAMILY NAMES ARE KEPT ON PURPOSE, even though nothing about this is a card any more: it
			is how the e2e contract, the party flow and the scaling probe all recognise "this screen is
			advertising an address no phone can reach". Renaming it would move four files for no gain.
		-->
		<p class="badqr" class:corner={placement === 'corner'} class:hero={placement === 'hero'} role="status">
			<b class="badqr-t">No external IP set</b><span class="badqr-fix">Set the party address in Settings</span>
		</p>
	{/if}
{/snippet}

{#if placement === 'corner'}
	<div class="corner" aria-label="Scan to join Encore">
		<div class="qr" style="--qr: {qrLength}">
			<img src={qrDataUrl} alt="QR code to join Encore" width={intrinsicPx} height={intrinsicPx} />
		</div>
		<div class="meta">
			<div class="t">Scan to join</div>
			<div class="u">{shortUrl}</div>
			{@render notice()}
			<!-- The typed path, mid-song: a camera that will not scan leaves the code as the only way in. -->
			{#if roomCode}
				<div class="c">code <b>{roomCode}</b></div>
			{/if}
			{#if onlineCount > 0}
				<div class="n">● {onlineCount} {onlineCount === 1 ? 'singer' : 'singers'} in</div>
			{/if}
		</div>
	</div>
{:else}
	<div class="hero">
		<div class="qr" style="--qr: {qrLength}">
			<img src={qrDataUrl} alt="QR code to join Encore" width={intrinsicPx} height={intrinsicPx} />
		</div>
		{@render notice()}
	</div>
{/if}

<style>
	.qr {
		padding: var(--space-2xl);
		/* A white QUIET ZONE is what makes a code scan reliably — scannability-critical, not a themeable
				   surface, so the white stays a literal. */
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

	/*
		 * THE HERO SHRINK-WRAPS ITS TILE. `.qr` is a block with a white fill, so in a STRETCH context it spreads
		 * to the panel's full width and paints a wide white slab with the code left-aligned inside it. Centring
		 * here rather than in the two callers, because a caller that forgets would paint the slab again.
		 */
	.hero {
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	/* Breathes, so it reads as a live invitation rather than a static poster. */
	.hero .qr {
		animation: breathe 4s ease-in-out infinite;
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
	/* A pulsing TV element is exactly what this setting is for. */
	@media (prefers-reduced-motion: reduce) {
		.hero .qr {
			animation: none;
		}
	}

	/* Corner: pinned bottom-right, opposite the lower-third. Scoped `:not(.badqr)` so this QR treatment's
		   FLEX ROW does not reach the unreachable-join notice, which reuses the `corner` class only for its pin —
		   without the scope the notice's block children became side-by-side flex columns and the fix instruction
		   was squeezed off-screen. */
	.corner:not(.badqr) {
		position: absolute;
		right: var(--tv-safe-x);
		bottom: var(--tv-safe-y);
		z-index: var(--z-tv-card);
		display: flex;
		align-items: center;
		gap: var(--space-xl);
		/*
				 * NO PANEL: the now-singing block is plain text, so side by side a bordered blurred card was the last
				 * piece of furniture on the stage. The QR keeps its white tile because a quiet zone is not decoration,
				 * and the text beside it takes the same text-shadow the rest of the stage uses, which works on TV
				 * browsers where `backdrop-filter` may never run.
				 */
		text-shadow: 0 2px 14px rgba(0, 0, 0, 0.9);
	}
	.corner .qr {
		padding: 7px;
		border-radius: 10px;
		box-shadow: none;
	}
	.t {
		font-size: var(--tv-label);
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
	.u {
		font-size: var(--tv-body);
		font-weight: 700;
		margin-top: 3px;
	}
	/*
		 * The corner card's code line at `--tv-body`, not attract's `--tv-code`: this card is a compact mid-song
		 * affordance pinned in the safe area beside an 88px QR, and the display tier that is right when the code
		 * OWNS the screen would push the card across the stage. Bolder and in full ink instead.
		 */
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
	.n {
		font-size: var(--tv-label);
		color: var(--ok);
		margin-top: 5px;
		font-weight: 600;
	}

	/*
		 * THE NOTICE. `--danger-ink` at the smallest TV tier, so it reads as a FOOTNOTE to the QR rather than a
		 * competing panel. `text-wrap: balance` rather than a width cap, for the one case the line is long (a
		 * narrow 720p panel): a cap in `ch` froze the old card two words wide, and a cap in vmin is a second axis
		 * to keep in step with the type scale.
		 */
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
	/* ITS OWN LINE, not a clause after a separator: as `state · remedy` on one wrapped line the mid-sentence
		   `·` lands at the start of line two on a 720p panel and reads as a bullet rather than a join. */
	.badqr-fix {
		display: block;
		font-weight: 500;
		color: var(--ink-dim);
	}
	/* The STATE is worth stating on the corner card — a latecomer scanning a dead code gets no other
		   explanation — but the REMEDY is not: nobody fixes an env var from the sofa mid-song. */
	.corner .badqr {
		margin-top: 5px;
		text-align: left;
	}
	.corner .badqr-fix {
		display: none;
	}
</style>
