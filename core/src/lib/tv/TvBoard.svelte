<!--
  THE UP NEXT BOARD (proposal 34): a copy set to Up next, for a kitchen or a hallway. Who is singing, the next turns in
  their colours, and a big QR with the room code. It never shows lyrics, so its drift from the TV does not matter.
  docs/FRONTEND.md#up-next.
-->
<script lang="ts">
	type Turn = { id: string; name: string; color?: string; title: string };

	let {
		now,
		next,
		qrDataUrl,
		roomCode
	}: { now: Turn | null; next: Turn[]; qrDataUrl: string; roomCode: string | null } = $props();
</script>

<div class="board">
	<div class="turns">
		{#if now}
			<p class="label">Singing now</p>
			<p class="now" style:background={now.color}>{now.name}{now.title ? ` - ${now.title}` : ''}</p>
		{/if}
		{#if next.length}
			<ol aria-label="Up next">
				{#each next as t (t.id)}
					<li>
						<span class="dot" style:background={t.color} aria-hidden="true"></span>
						<b>{t.name}</b>
						<span class="title">{t.title}</span>
					</li>
				{/each}
			</ol>
		{/if}
	</div>
	<div class="join">
		<img class="qr" src={qrDataUrl} alt="Scan to sing" />
		<p class="scan">Scan to sing</p>
		{#if roomCode}<p class="code">{roomCode}</p>{/if}
	</div>
</div>

<style>
	.board {
		position: absolute;
		inset: var(--tv-safe-y) var(--tv-safe-x);
		z-index: var(--z-tv-card);
		display: grid;
		grid-template-columns: 1fr auto;
		align-items: center;
		gap: var(--tv-space-4xl);
	}
	.turns {
		min-width: 0;
	}
	.label {
		margin: 0;
		color: var(--ink-dim);
		font-size: var(--tv-name);
		font-weight: 700;
	}
	.now {
		display: inline-block;
		max-width: 100%;
		margin: var(--tv-space-lg) 0 0;
		padding: var(--tv-space-2xs) var(--tv-space-lg);
		border-radius: var(--round-pill);
		/* A singer colour is a light stop (OKLCH L 0.7), so the page's ground is its ink. */
		color: var(--bg);
		font-size: var(--tv-name);
		font-weight: 800;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	ol {
		margin: var(--tv-space-4xl) 0 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: flex;
		align-items: baseline;
		gap: var(--tv-space-lg);
		padding: var(--tv-space-lg) 0;
		border-top: 1px solid var(--role-rule);
		font-size: var(--tv-name);
		white-space: nowrap;
		overflow: hidden;
	}
	li b {
		font-weight: 800;
	}
	.dot {
		flex: none;
		align-self: center;
		width: 0.5em;
		height: 0.5em;
		border-radius: 50%;
	}
	.title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--ink-dim);
		font-size: var(--tv-body);
		font-weight: 600;
	}
	.join {
		text-align: center;
		color: var(--ink-dim);
	}
	.qr {
		display: block;
		width: 24vw;
		max-width: 60vh;
		aspect-ratio: 1;
		padding: var(--tv-space-lg);
		border-radius: var(--tv-space-lg);
		background: #fff;
		image-rendering: pixelated;
	}
	.scan {
		margin: var(--tv-space-lg) 0 0;
		font-size: var(--tv-body);
		font-weight: 700;
	}
	.code {
		margin: var(--tv-space-lg) 0 0;
		color: var(--ink);
		font-size: var(--tv-name);
		font-weight: 800;
		letter-spacing: 0.08em;
	}
	/* A phone reading along: the QR goes under the turns. */
	@media (max-aspect-ratio: 1/1) {
		.board {
			grid-template-columns: 1fr;
			align-content: center;
		}
		.qr {
			width: 50vw;
			margin: 0 auto;
		}
	}
</style>
