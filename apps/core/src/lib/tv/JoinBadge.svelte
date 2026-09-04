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
		/** Pixel size of the QR image itself. */
		size?: number;
	}

	let { qrDataUrl, joinUrl, placement = 'hero', onlineCount = 0, size = placement === 'corner' ? 88 : 238 }: Props =
		$props();

	// The full URL is too long to read across a room in the corner treatment; the path is enough
	// once the QR carries the real target.
	const shortUrl = $derived(joinUrl.replace(/^https?:\/\//, ''));
</script>

{#if placement === 'corner'}
	<div class="corner" aria-label="Scan to join Encore">
		<div class="qr" style="--qr: {size}px"><img src={qrDataUrl} alt="QR code to join Encore" width={size} height={size} /></div>
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
		<div class="qr" style="--qr: {size}px"><img src={qrDataUrl} alt="QR code to join Encore" width={size} height={size} /></div>
	</div>
{/if}

<style>
	.qr {
		padding: 16px;
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

	/* corner: pinned bottom-right, opposite the lower-third, below the score badge */
	.corner {
		position: absolute;
		right: var(--tv-safe-x);
		bottom: var(--tv-safe-y);
		z-index: 7;
		display: flex;
		align-items: center;
		gap: 14px;
		padding: 12px 18px 12px 12px;
		border-radius: var(--radius);
		background: rgba(18, 18, 29, 0.82);
		border: 1px solid var(--line);
		box-shadow: var(--shadow);
		backdrop-filter: blur(6px);
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
</style>
