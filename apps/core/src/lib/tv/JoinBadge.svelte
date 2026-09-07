<!--
	JoinBadge — the join QR, in one of two placements.

	`hero` is the lobby/attract treatment: a big scannable QR that owns the middle of the screen.
	`corner` is the during-playback treatment: a compact card pinned bottom-right, so a latecomer
	who walks in mid-song can still get in without asking anyone to stop the music.

	Bottom-right is deliberate: the "Now singing" lower-third owns bottom-LEFT, so bottom-right is
	the corner that stays clear of it.
-->
<script lang="ts">
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
	}

	let {
		qrDataUrl,
		joinUrl,
		placement = 'hero',
		onlineCount = 0,
		size = placement === 'corner' ? 88 : 238,
		unreachable = false
	}: Props = $props();

	// A number is pixels; a string is a raw CSS length. This is what --qr is set to.
	const qrLength = $derived(typeof size === 'number' ? `${size}px` : size);
	// The <img>'s intrinsic attribute box. It must be a number, and CSS --qr overrides the painted
	// size regardless — so for a CSS-length size we hand it a reasonable placeholder rather than 0.
	const intrinsicPx = $derived(typeof size === 'number' ? size : placement === 'corner' ? 88 : 320);

	// The full URL is too long to read across a room in the corner treatment; the path is enough
	// once the QR carries the real target.
	const shortUrl = $derived(joinUrl.replace(/^https?:\/\//, ''));
</script>

{#if unreachable}
	<!--
		The join address is unroutable, so a QR would be a working-looking dead end. Say what is wrong
		and how to fix it, in the TV type scale so an operator reads it from the sofa. Same corner/ hero
		geometry as the QR it replaces, so the layout does not jump.
	-->
	<div class="badqr" class:corner={placement === 'corner'} class:hero={placement === 'hero'} role="alert">
		<div class="badqr-t">Join QR unavailable</div>
		<div class="badqr-b">
			<span class="badqr-lead">This screen is advertising</span>
			<b class="badqr-addr">{shortUrl}</b>
			<span class="badqr-lead">which no phone can reach.</span>
		</div>
		<div class="badqr-fix">Set the party address in Settings under Joining (or the ENCORE_PUBLIC_ORIGIN env var).</div>
	</div>
{:else if placement === 'corner'}
	<div class="corner" aria-label="Scan to join Encore">
		<div class="qr" style="--qr: {qrLength}">
			<img src={qrDataUrl} alt="QR code to join Encore" width={intrinsicPx} height={intrinsicPx} />
		</div>
		<div class="meta">
			<div class="t">Scan to join</div>
			<div class="u">{shortUrl}</div>
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
	</div>
{/if}

<style>
	.qr {
		padding: 16px;
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
	   side-by-side flex columns and the fix instruction was squeezed off-screen (#357). */
	.corner:not(.badqr) {
		position: absolute;
		right: var(--tv-safe-x);
		bottom: var(--tv-safe-y);
		z-index: 7;
		display: flex;
		align-items: center;
		gap: 14px;
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
	.n {
		font-size: var(--tv-label);
		color: var(--ok);
		margin-top: 5px;
		font-weight: 600;
	}

	/*
	 * The dead-QR notice. --danger family so it does not read as a normal invitation, TV type scale so
	 * it is legible from a sofa. `hero` centres it on the stage where the QR would have been; `corner`
	 * pins it to the same bottom-right safe-area slot as the corner QR so mid-song layout is stable.
	 */
	.badqr {
		border-radius: var(--radius);
		/* rgba(42,27,34,0.95) was --danger-bg at 95%. */
		background: color-mix(in srgb, var(--danger-bg) 95%, transparent);
		border: 1px solid var(--danger);
		box-shadow: var(--shadow);
	}
	.badqr.hero {
		/*
		 * Prose width, not a QR's. 34ch here resolved against this element's own 16px root font
		 * (~346px) — a column two words wide that never grew with the TV type — so the address was
		 * forced to break mid-token and the trailing clause orphaned its comma (#62). This is the same
		 * vmin axis the TV type scale rides, so the card grows on a 4K wall instead of dead-ending.
		 */
		max-width: clamp(320px, 44vmin, 720px);
		padding: 28px 34px;
		text-align: center;
	}
	.badqr.corner {
		position: absolute;
		right: var(--tv-safe-x);
		bottom: var(--tv-safe-y);
		z-index: 7;
		max-width: 30vw;
		padding: 14px 20px;
	}
	.badqr-t {
		font-size: var(--tv-name);
		font-weight: 800;
		color: var(--danger-ink);
		margin-bottom: 8px;
	}
	.badqr-b {
		font-size: var(--tv-body);
		color: var(--ink);
	}
	/* Each part on its own line: the sentence never wraps around the address, so the comma that used
	   to orphan onto its own line (#62) is gone with the clause it followed. */
	.badqr-lead {
		display: block;
	}
	.badqr-addr {
		display: block;
		margin: 2px 0;
		color: var(--danger-ink);
		/* A long advertised address still has to fit the card rather than push it wide. */
		overflow-wrap: anywhere;
	}
	.badqr-fix {
		font-size: var(--tv-label);
		color: var(--ink-dim);
		margin-top: 10px;
	}
</style>
