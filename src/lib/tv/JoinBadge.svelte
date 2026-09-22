<!--
	JoinBadge — the join QR, in one of two placements.

	`hero` is the lobby/attract treatment: a big scannable QR that owns the middle of the screen.
	`corner` is the during-playback treatment: a compact card pinned bottom-right, so a latecomer
	who walks in mid-song can still get in without asking anyone to stop the music.

	Bottom-right is deliberate: the "Now singing" lower-third owns bottom-LEFT, so bottom-right is
	the corner that stays clear of it.
-->
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
		 * The rendered QR size. A NUMBER is pixels (back-compat, and correct for the fixed-geometry
		 * corner card). A STRING is any CSS length used verbatim — the TV hero passes a `vmin` token so
		 * the code grows with the panel on a 4K wall instead of dead-ending at a pixel cap while the
		 * canvas around it keeps scaling up. The `<img>` intrinsic width/height stay a plain number
		 * (`intrinsicPx`) for a sensible pre-CSS layout box; the CSS `--qr` governs the painted size.
		 */
		size?: number | string;
		/**
		 * The advertised join address is one no phone can reach (loopback / bare hostname). Render an
		 * operator notice naming the fix instead of a QR that looks fine but every scan fails silently.
		 */
		unreachable?: boolean;
		/**
		 * The room code, printed in the two treatments that carry no typed-path block of their own: the
		 * CORNER card and the UNREACHABLE notice.
		 *
		 * REPORTED TWICE, and both halves were the same omission. On localhost the notice replaced the QR
		 * outright, so the screen advertising an unroutable address offered no way in at all — yet the code
		 * is still perfectly typable by anyone who reaches the app on another address, which is exactly the
		 * situation an operator on a laptop is in. And mid-song the corner card carried the QR and the host
		 * but never the code, so a latecomer whose camera will not scan had nothing to transcribe.
		 *
		 * The HERO treatment deliberately ignores it: attract and the lobby print the code themselves, below
		 * the QR, as part of a sentence broken across the TV type ladder ("Go to X and enter room code Y").
		 * A second copy from in here would render it twice on the screen where it is largest — and since the
		 * unroutable case no longer replaces the hero with a card of its own, those two screens now print it
		 * in every state, which is what made this prop hero-irrelevant rather than hero-conditional.
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
	// The <img>'s intrinsic attribute box. It must be a number, and CSS --qr overrides the painted
	// size regardless — so for a CSS-length size we hand it a reasonable placeholder rather than 0.
	const intrinsicPx = $derived(typeof size === 'number' ? size : placement === 'corner' ? 88 : 320);

	// The full URL is too long to read across a room in the corner treatment; the host is enough
	// once the QR carries the real target.
	//
	// Through the shared helper now. This used to strip the SCHEME only, so the corner badge printed
	// `host:port/?room=CODE` — the redundant query the line above calls too long to read — while the
	// attract panel and the lobby each stripped it with their own regex. One function, three callers.
	const shortUrl = $derived(joinAddressLabel(joinUrl));
</script>

<!--
	THE UNROUTABLE-ADDRESS NOTICE — one line, beside a QR that still renders (ratified 2026-09-21).

	IT REPLACED A CARD, and the card is why this note is long. The advertised address being unreachable used
	to REPLACE the QR with a `--danger` panel: a headline, the address, a sentence, and a two-line fix
	instruction, sized `clamp(320px, 44vmin, 720px)` and centred where the code should have been. It was
	the right shape for the fault it described — a QR nobody can scan is a working-looking dead end — and
	the wrong shape for the screen, because on a loopback address the only person looking is the operator,
	who does not need a quarter of a wall to be told what they already configured.

	SO THE QR IS SHOWN NORMALLY AND THE FAULT IS A FOOTNOTE. The stated trade, on the record: a guest CAN
	now scan a code that will not resolve. That was the original card's whole reason for existing, and it is
	accepted deliberately — the address is only unroutable when nobody has set a party address, which in
	practice means a laptop showing this to itself.

	The fix clause is hidden in the CORNER treatment (see `.corner .badqr-fix`) rather than written twice:
	that card is a compact mid-song affordance in the safe area, and one string cannot drift from itself.
-->
{#snippet notice()}
	{#if unreachable}
		<!--
			THE `.badqr` FAMILY NAMES ARE KEPT ON PURPOSE, even though nothing about this is a card any more:
			`.badqr` is how the e2e contract, the party flow and the scaling probe all recognise "this screen is
			advertising an address no phone can reach" (SEL.badQr and friends). Renaming it would move four
			files for no gain. What DID retire with the card are its prose parts — `.badqr-b`, `.badqr-lead`,
			`.badqr-addr` — because a one-line notice has no body paragraph and no advertised address to print
			(attract and the lobby now print the real one directly below this).
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
		/* The QR needs a white quiet zone to scan reliably — this is scannability-critical, not a
		   themeable surface. Legitimate white literal, kept per the token sweep. */
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
	 * THE HERO SHRINK-WRAPS ITS TILE. `.qr` is a block with a white fill, so in a stretch context it spread
	 * to the panel's full width and painted a wide white slab with the code left-aligned inside it. The lobby
	 * never showed it because its `.stack` is `align-items: center`; the attract panel's column stretches,
	 * and until now the unroutable case replaced this whole treatment with a card — so the stretch was only
	 * ever on screen in the reachable state, where nobody had looked at 1920 wide.
	 *
	 * Centring here rather than in the two callers: the tile is this component's, and a caller that forgets
	 * would paint the slab again.
	 */
	.hero {
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	/* hero: breathes so it reads as a live invitation rather than a static poster */
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
	/* respect a reduced-motion preference — a pulsing TV element is exactly what that setting is for */
	@media (prefers-reduced-motion: reduce) {
		.hero .qr {
			animation: none;
		}
	}

	/* corner: pinned bottom-right, opposite the lower-third, below the score badge.
	   Scoped :not(.badqr) so this QR treatment's flex row does not reach the unreachable-join
	   ALERT, which reuses the `corner` class only for its pin (.badqr.corner re-declares the same
	   position/right/bottom/z-index). Without this the alert's three block children became
	   side-by-side flex columns and the fix instruction was squeezed off-screen. */
	.corner:not(.badqr) {
		position: absolute;
		right: var(--tv-safe-x);
		bottom: var(--tv-safe-y);
		z-index: var(--z-tv-card);
		display: flex;
		align-items: center;
		gap: var(--space-xl);
		/*
		 * NO PANEL. This was a bordered, blurred, near-opaque card — the last piece of furniture left on
		 * the stage after the now-singing card became plain text, and side by side the mismatch was the
		 * first thing an eyes-on frame showed: everything else had shed its surface and this had not.
		 *
		 * The QR keeps its own white tile because that is not decoration — a quiet zone is what makes a
		 * code scannable — and the text beside it gets the same text-shadow the rest of the stage uses,
		 * which works on TV browsers where `backdrop-filter` may never run at all.
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
	 * The corner card's code line. `--tv-body` rather than the attract screen's `--tv-code` (3.29rem): this
	 * card is a compact mid-song affordance pinned in the safe area beside a 88px QR, and the display tier
	 * that is right when the code OWNS the screen would push the card across the stage here. The value is
	 * bolder and in full ink so it still reads as the thing to transcribe.
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
	 * THE NOTICE. `--danger-ink` at the smallest TV tier, so it reads as a footnote to the QR rather than as
	 * a competing panel — which is the whole point of the change (see the markup note). No surface, no
	 * border, no max-width: there is no prose column left to wrap badly, which is what the card needed all
	 * of that for.
	 *
	 * `text-wrap: balance` rather than a width cap, for the one case the line is long: a narrow 720p panel.
	 * A cap in `ch` is what froze the old card two words wide (its own guard records the `ch`-against-a-16px-
	 * root trap), and a cap in vmin is a second axis to keep in step with the type scale.
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
	/*
	 * ITS OWN LINE, not a clause after a separator. As `state · remedy` on one wrapped line the mid-sentence
	 * `·` landed at the start of line two on a 720p panel, which reads as a bullet rather than as a join. Two
	 * lines say the same thing with no punctuation to misread — and the corner treatment hides this one, so
	 * the block only ever applies where there is room for it.
	 */
	.badqr-fix {
		display: block;
		font-weight: 500;
		color: var(--ink-dim);
	}
	/*
	 * The corner card is a compact mid-song affordance pinned in the safe area beside an 88px QR, and it is
	 * left-aligned. The state is worth stating there — a latecomer scanning a dead code gets no other
	 * explanation — but the remedy is not: nobody fixes an env var from the sofa mid-song.
	 */
	.corner .badqr {
		margin-top: 5px;
		text-align: left;
	}
	.corner .badqr-fix {
		display: none;
	}
</style>
