<script lang="ts">
	// A row in the rotation queue. Ported from docs/mocks.
	interface Props {
		seq: number; // 1-based display position
		title: string;
		singerName: string;
		singerColor: string;
		mine?: boolean;
		up?: boolean; // currently playing / next up (accent the seq bubble)
		subtitle?: string; // e.g. "now playing", "after Liam"
		pending?: boolean; // optimistic, not yet confirmed
		removable?: boolean; // show the remove affordance (mine, not currently playing)
		onremove?: () => void;
	}
	let {
		seq, title, singerName, singerColor, mine = false, up = false,
		subtitle = '', pending = false, removable = false, onremove
	}: Props = $props();
</script>

<div class="qrow card" class:mine class:up class:pending>
	<div class="seq">{seq}</div>
	<div class="meta">
		<div class="t">{title}</div>
		<div class="who">
			<i style="background:{singerColor}"></i>
			{singerName}{#if subtitle} · {subtitle}{/if}{#if pending} · <span class="adding">adding…</span>{/if}
		</div>
	</div>
	{#if removable && !pending}
		<button class="remove" aria-label="remove from queue" onclick={() => onremove?.()}>✕</button>
	{:else if !pending}
		<div class="grip">⋮⋮</div>
	{/if}
</div>

<style>
	.qrow {
		display: flex; align-items: center; gap: 12px; padding: 11px 12px; margin-bottom: 8px;
		animation: pop 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.3);
	}
	@keyframes pop { from { opacity: 0; transform: translateY(-6px) scale(0.97); } to { opacity: 1; transform: none; } }
	.mine { border-color: #3a3155; background: linear-gradient(var(--card), #1d1830); }
	.pending { opacity: 0.55; }
	.seq {
		width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center;
		font-size: 0.8rem; font-weight: 700; background: var(--card2); color: var(--ink-dim); flex: 0 0 auto;
	}
	.up .seq { background: var(--grad); color: #fff; }
	.meta { min-width: 0; }
	.t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.who { display: flex; align-items: center; gap: 7px; font-size: 0.78rem; color: var(--ink-dim); margin-top: 2px; }
	.who i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
	.adding { color: var(--warn); }
	.grip { margin-left: auto; color: #4a4a66; font-size: 1.1rem; cursor: grab; }
	.remove {
		margin-left: auto; flex: 0 0 auto; width: 30px; height: 30px; border-radius: 8px;
		border: 1px solid var(--line); background: var(--card2); color: var(--ink-dim);
		font-size: 0.85rem; cursor: pointer;
	}
	.remove:active { transform: scale(0.9); color: var(--accent2); }
</style>
