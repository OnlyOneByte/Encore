<script lang="ts">
	// A search result row: thumb + title + sub + add button. Ported from docs/mocks.
	interface Props {
		title: string;
		sub: string;
		processing?: boolean;
		onadd?: () => void;
		// M7-C7: optional "make karaoke" (stem-separation) request for this song.
		onmake?: () => void;
	}
	let { title, sub, processing = false, onadd, onmake }: Props = $props();
</script>

<div class="result card" onclick={() => onadd?.()} role="button" tabindex="0"
	onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && onadd?.()}>
	<div class="thumb"></div>
	<div class="meta">
		<div class="t">{title}{#if processing}<span class="sparkle"> ✨</span>{/if}</div>
		<div class="s">{sub}</div>
	</div>
	{#if onmake}
		<button class="make" title="Make karaoke (strip vocals)"
			onclick={(e) => { e.stopPropagation(); onmake?.(); }}>✨ Karaoke</button>
	{/if}
	<button class="add" onclick={(e) => { e.stopPropagation(); onadd?.(); }}>＋ Turn</button>
</div>

<style>
	.result {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px;
		margin-bottom: 8px;
		cursor: pointer;
		transition: transform 0.12s ease, background 0.12s ease;
	}
	.result:active { transform: scale(0.98); background: var(--card2); }
	.thumb {
		width: 64px; height: 44px; border-radius: 8px; flex: 0 0 auto;
		background: linear-gradient(135deg, #2c2c44, #1c1c2c); position: relative;
	}
	.thumb::after { content: '▶'; position: absolute; inset: 0; display: grid; place-items: center; color: #fff8; font-size: 0.8rem; }
	.meta { min-width: 0; }
	.t { font-weight: 600; font-size: 0.95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.sparkle { color: var(--warn); }
	.s { font-size: 0.8rem; color: var(--ink-dim); }
	.add {
		margin-left: auto; flex: 0 0 auto; border: 0; border-radius: 10px; padding: 9px 12px;
		font-weight: 700; font-size: 0.85rem; background: var(--grad); color: #fff; cursor: pointer;
	}
	.add:active { transform: scale(0.94); }
	.make {
		flex: 0 0 auto; border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px;
		font-weight: 700; font-size: 0.8rem; background: var(--card2); color: var(--warn); cursor: pointer;
	}
	.make:active { transform: scale(0.94); }
	/* when there's no make button, the add button still pushes to the right */
	.make + .add { margin-left: 8px; }
</style>
