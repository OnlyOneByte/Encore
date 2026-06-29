<script lang="ts">
	// The live "make karaoke" progress card — the watching-not-waiting feel. Ported from docs/mocks.
	import type { MediaStatus } from '@encore/shared';
	interface Props {
		seq: number;
		title: string;
		singerName: string;
		singerColor: string;
		status: MediaStatus; // queued|downloading|separating|aligning|ready|failed
		pct: number;
	}
	let { seq, title, singerName, singerColor, status, pct }: Props = $props();

	const STAGES: { key: MediaStatus; label: string }[] = [
		{ key: 'queued', label: 'Queued' },
		{ key: 'downloading', label: 'Downloaded' },
		{ key: 'separating', label: 'Separating' },
		{ key: 'ready', label: 'Ready' }
	];
	const order = ['queued', 'downloading', 'separating', 'aligning', 'ready'];
	function state(key: MediaStatus): 'done' | 'now' | 'todo' {
		const cur = order.indexOf(status);
		const k = order.indexOf(key);
		if (k < cur) return 'done';
		if (k === cur) return 'now';
		return 'todo';
	}
	const stageLabel = $derived(
		status === 'downloading' ? 'Downloading…' :
		status === 'separating' ? 'Separating vocals…' :
		status === 'aligning' ? 'Aligning lyrics…' :
		status === 'ready' ? 'Ready ✓' : 'Queued…'
	);
</script>

<div class="qrow proc card">
	<div class="seq">{seq}</div>
	<div class="meta">
		<div class="t">{title} <span class="sparkle">✨</span></div>
		<div class="who"><i style="background:{singerColor}"></i> {singerName} · being prepared</div>
		<div class="bar"><i style="transform:scaleX({pct / 100})"></i></div>
		<div class="stage"><span>{stageLabel}</span><span>{pct}%</span></div>
		<div class="chips">
			{#each STAGES as s}
				<span class="chip {state(s.key)}">
					{#if state(s.key) === 'done'}✓ {/if}{#if state(s.key) === 'now'}● {/if}{s.label}
				</span>
			{/each}
		</div>
	</div>
</div>

<style>
	.qrow { display: flex; align-items: flex-start; gap: 12px; padding: 11px 12px; margin-bottom: 8px; }
	.proc { background: linear-gradient(var(--card), #201a2e); border-color: #3a2f55; }
	.seq { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-size: 0.8rem; font-weight: 700; background: var(--card2); color: var(--ink-dim); flex: 0 0 auto; }
	.meta { flex: 1; min-width: 0; }
	.t { font-weight: 600; }
	.sparkle { color: var(--warn); }
	.who { display: flex; align-items: center; gap: 7px; font-size: 0.78rem; color: var(--ink-dim); margin-top: 2px; }
	.who i { width: 10px; height: 10px; border-radius: 50%; }
	.bar { height: 6px; border-radius: 6px; background: #2a2440; overflow: hidden; margin-top: 9px; }
	/* GPU-composited fill: scaleX from the left edge, never animates layout width */
	.bar > i { display: block; height: 100%; width: 100%; background: var(--grad); border-radius: 6px; transform-origin: left center; transition: transform 0.4s ease; }
	.stage { display: flex; justify-content: space-between; font-size: 0.74rem; color: var(--warn); margin-top: 7px; }
	.chips { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
	.chip { font-size: 0.66rem; padding: 3px 8px; border-radius: 20px; background: #241f38; color: var(--ink-dim); }
	.chip.done { background: rgba(51, 214, 166, 0.16); color: var(--ok); }
	.chip.now { background: rgba(255, 184, 77, 0.16); color: var(--warn); }
</style>
