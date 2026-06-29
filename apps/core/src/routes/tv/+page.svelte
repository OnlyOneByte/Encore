<script lang="ts">
	import { onMount } from 'svelte';
	import type { ServerEvent, QueueEntry } from '@encore/shared';

	let { data } = $props();

	let entries = $state<QueueEntry[]>([]);
	let connected = $state(false);

	// "up next" ticker — derived from the live queue (first few queued entries)
	const upNext = $derived(entries.filter((e) => e.status === 'queued').slice(0, 6));

	onMount(() => {
		const proto = location.protocol === 'https:' ? 'wss' : 'ws';
		const ws = new WebSocket(`${proto}://${location.host}/ws?role=tv`);
		ws.onopen = () => {
			connected = true;
			ws.send(JSON.stringify({ type: 'hello', lastRev: 0 }));
		};
		ws.onclose = () => (connected = false);
		ws.onmessage = (ev) => {
			const e: ServerEvent = JSON.parse(ev.data);
			if (e.type === 'queue:sync') entries = e.entries;
		};
		return () => ws.close();
	});
</script>

<div class="tv">
	<div class="brand">🎤 <span class="grad">Encore</span></div>

	<div class="join">
		<div class="qr-wrap">
			<img src={data.qrDataUrl} alt="Scan to join" width="320" height="320" />
		</div>
		<div class="join-copy">
			<h1>Scan to join the party</h1>
			<p class="url">{data.joinUrl}</p>
			<p class="hint">Pick a name, queue a song, grab the mic.</p>
		</div>
	</div>

	<div class="ticker">
		<span class="ticker-label">Up next</span>
		{#if upNext.length === 0}
			<span class="ticker-empty">Nobody's queued yet — be the first ✨</span>
		{:else}
			<div class="ticker-track">
				{#each upNext as e (e.id)}
					<span class="chip">#{e.rotationSeq + 1} · {e.mediaId}</span>
				{/each}
			</div>
		{/if}
	</div>

	<div class="status" class:on={connected}></div>
</div>

<style>
	.tv {
		position: fixed;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 48px;
		background: radial-gradient(80% 60% at 50% 30%, #1b1430 0%, var(--bg) 70%);
		overflow: hidden;
	}
	.brand {
		position: absolute;
		top: 40px;
		left: 48px;
		font-weight: 800;
		font-size: 2rem;
	}
	.grad {
		background: var(--grad);
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}
	.join {
		display: flex;
		align-items: center;
		gap: 56px;
	}
	.qr-wrap {
		padding: 20px;
		background: #fff;
		border-radius: 28px;
		box-shadow: var(--shadow);
		/* gentle breathing so the attract screen feels alive */
		animation: breathe 4s ease-in-out infinite;
	}
	.qr-wrap img {
		display: block;
		border-radius: 8px;
	}
	@keyframes breathe {
		0%, 100% { transform: scale(1); }
		50% { transform: scale(1.03); }
	}
	.join-copy h1 {
		font-size: 3rem;
		margin: 0 0 12px;
		max-width: 9ch;
		line-height: 1.05;
	}
	.url {
		font-size: 1.4rem;
		color: var(--accent2);
		margin: 0 0 16px;
		font-variant-numeric: tabular-nums;
	}
	.hint {
		font-size: 1.2rem;
		color: var(--ink-dim);
		margin: 0;
	}
	.ticker {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		display: flex;
		align-items: center;
		gap: 18px;
		padding: 20px 48px;
		background: linear-gradient(transparent, rgba(18, 18, 29, 0.9));
	}
	.ticker-label {
		font-size: 0.85rem;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		color: var(--ink-dim);
		white-space: nowrap;
	}
	.ticker-empty {
		font-size: 1.2rem;
		color: var(--ink-dim);
	}
	.ticker-track {
		display: flex;
		gap: 12px;
		overflow: hidden;
	}
	.chip {
		padding: 8px 16px;
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: 999px;
		font-size: 1.1rem;
		white-space: nowrap;
	}
	.status {
		position: absolute;
		top: 48px;
		right: 48px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--ink-dim);
	}
	.status.on {
		background: var(--ok);
		box-shadow: 0 0 0 4px rgba(51, 214, 166, 0.18);
	}
</style>
