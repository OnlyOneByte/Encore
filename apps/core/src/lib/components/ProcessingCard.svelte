<script lang="ts">
	import { SINGER_COLORS } from '@encore/shared';
	import Icon from '$lib/ui/Icon.svelte';
	// The live "make karaoke" progress card — the watching-not-waiting feel. Ported from docs/mocks.
	import type { MediaStatus } from '@encore/shared';
	interface Props {
		// Queue-slot number + the singer who asked for it. Both absent when the card renders OUTSIDE
		// the rotation list — a song cooking for someone else's turn still needs somewhere to show its
		// progress, and there is no slot or singer to attribute it to there.
		seq?: number;
		title: string;
		singerName?: string;
		singerColor?: string;
		/** The singer who queued this is in the room but unreachable (locked phone, pocket). */
		singerAway?: boolean;
		status: MediaStatus; // queued|downloading|separating|aligning|ready|failed
		pct: number;
		// A cooking song is still a QUEUE ENTRY, so it gets the same controls a ready row does: remove
		// (a 1-2 min cook is a long time to be stuck on a mis-tap) and reorder (deciding what's next is
		// exactly what you do while something cooks). All absent when the card renders outside the
		// rotation (no slot there to act on).
		onremove?: () => void;
		reorderable?: boolean;
		canUp?: boolean;
		canDown?: boolean;
		onup?: () => void;
		ondown?: () => void;
	}
	let {
		seq, title, singerName, singerColor = SINGER_COLORS[0], singerAway = false, status, pct,
		onremove, reorderable = false, canUp = false, canDown = false, onup, ondown
	}: Props = $props();

	const STAGES: { key: MediaStatus; label: string }[] = [
		{ key: 'queued', label: 'Queued' },
		{ key: 'downloading', label: 'Downloaded' },
		{ key: 'separating', label: 'Separating' },
		// `aligning` is a stage the worker really reports. Omitting it here rendered every chip as done
		// during it, so the card claimed the song was finished while it was still cooking.
		{ key: 'aligning', label: 'Lyrics' },
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
		status === 'ready' ? 'Ready' : 'Queued…'
	);
</script>

<div class="qrow proc card">
	<div class="seq">{#if seq}{seq}{:else}<Icon name="sparkle" />{/if}</div>
	<div class="meta">
		<div class="t">{title}<span class="sparkle"><Icon name="sparkle" /></span></div>
		<div class="who">
			<!-- Same away marker as QueueRow: a cook outlives its owner's attention span, and the room
			     should not learn the singer left only once the song reaches the front. -->
			{#if singerName}<i class:dim={singerAway} style="--singer:{singerColor}"></i> {singerName}{#if singerAway}<span class="away">· away</span>{/if} · being prepared{:else}being prepared{/if}
		</div>
		<div class="bar"><i style="transform:scaleX({pct / 100})"></i></div>
		<div class="stage"><span>{stageLabel}</span><span>{pct}%</span></div>
		<div class="chips">
			{#each STAGES as s}
				<span class="chip {state(s.key)}">
					{#if state(s.key) === 'done'}<Icon name="check" />{/if}{#if state(s.key) === 'now'}<span class="now-dot" aria-hidden="true"></span>{/if}{s.label}
				</span>
			{/each}
		</div>
	</div>
	{#if onremove || reorderable}
		<div class="actions">
			{#if reorderable}
				<button class="act" aria-label="move up" disabled={!canUp} onclick={() => onup?.()}><Icon name="arrow-up" /></button>
				<button class="act" aria-label="move down" disabled={!canDown} onclick={() => ondown?.()}><Icon name="arrow-down" /></button>
			{/if}
			{#if onremove}
				<button class="remove" aria-label="remove from queue" onclick={() => onremove?.()}><Icon name="close" /></button>
			{/if}
		</div>
	{/if}
</div>

<style>
	.qrow { display: flex; align-items: flex-start; gap: 12px; padding: 11px 12px; margin-bottom: 8px; }
	.proc { background: linear-gradient(var(--card), var(--card-tint)); border-color: var(--line-tint); }
	.seq { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-size: 0.8rem; font-weight: 700; background: var(--card2); color: var(--ink-dim); flex: 0 0 auto; }
	.meta { flex: 1; min-width: 0; }
	.t { font-weight: 600; }
	/* Spacing via margin, matching SongRow — one mechanism, not a literal space in one place and
	   CSS in the other. */
	.sparkle { color: var(--warn); display: inline-grid; place-items: center; vertical-align: -2px; margin-left: 5px; }
	.who { display: flex; align-items: center; gap: 7px; font-size: 0.78rem; color: var(--ink-dim); margin-top: 2px; }
	.who i.dim { opacity: 0.5; }
	.who .away { color: var(--warn); margin-left: 0.35em; }
	.who i { width: 10px; height: 10px; border-radius: 50%; background: var(--singer); }
	.bar { height: 6px; border-radius: 6px; background: var(--card-tint2); overflow: hidden; margin-top: 9px; }
	/* GPU-composited fill: scaleX from the left edge, never animates layout width */
	.bar > i { display: block; height: 100%; width: 100%; background: var(--grad); border-radius: 6px; transform-origin: left center; transition: transform 0.4s ease; }
	.stage { display: flex; justify-content: space-between; font-size: 0.74rem; color: var(--warn); margin-top: 7px; }
	/* Identical to QueueRow's: same 30px targets, same horizontal row, same press feedback — so the
	   controls don't visually reshuffle when a song finishes cooking and its card becomes a row. The
	   card is taller than a row, so they sit on the title line rather than centred. */
	.actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
	.act, .remove {
		/* 44px: these were 30px with 6px gaps, below the reliable-tap threshold. */
		width: 44px; height: 44px; border-radius: 10px; border: 1px solid var(--line);
		background: var(--card2); color: var(--ink-dim); font-size: 0.85rem; cursor: pointer;
	}
	.act:disabled { opacity: 0.35; cursor: default; }
	.act:not(:disabled):active { transform: scale(0.9); color: var(--ink); }
	.remove:active { transform: scale(0.9); color: var(--accent2); }
	.chips { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
	.chip { display: inline-flex; align-items: center; gap: 4px; font-size: 0.66rem; padding: 3px 8px; border-radius: 20px; background: var(--card-tint2); color: var(--ink-dim); }
	/* The "now" marker was a ● glyph; drawn instead so its size does not depend on a fallback font. */
	.now-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: 0 0 auto; }
	.chip.done { background: rgba(51, 214, 166, 0.16); color: var(--ok); }
	.chip.now { background: rgba(255, 184, 77, 0.16); color: var(--warn); }
</style>
