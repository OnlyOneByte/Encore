<script lang="ts">
	// Live score badge (TV), driven by score:update. Extracted from the TV page so the exact rendered
	// component is previewable in the /components gallery.
	interface Props {
		score: number; // 0..100 rolling accuracy
		hits: number;
		total: number;
	}
	let { score, hits, total }: Props = $props();

	const band = $derived.by(() => {
		if (score >= 90) return { label: 'PERFECT', color: 'var(--score-perfect)' };
		if (score >= 75) return { label: 'GREAT', color: 'var(--score-great)' };
		if (score >= 50) return { label: 'GOOD', color: 'var(--score-good)' };
		return { label: 'KEEP GOING', color: 'var(--score-low)' };
	});
</script>

<div class="score-badge" style="--sc:{band.color}">
	<div class="score-label">{band.label}</div>
	<div class="score-num">{score}</div>
	<div class="score-sub">{hits}/{total} on pitch</div>
</div>

<style>
	.score-badge {
		position: absolute;
		top: 40px;
		right: 40px;
		z-index: 7;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 14px 26px;
		border-radius: 20px;
		background: rgba(11, 11, 18, 0.72);
		border: 2px solid var(--sc);
		backdrop-filter: blur(8px);
		box-shadow: 0 0 32px color-mix(in srgb, var(--sc) 45%, transparent);
	}
	.score-label {
		font-size: 0.85rem;
		font-weight: 800;
		letter-spacing: 0.18em;
		color: var(--sc);
	}
	.score-num {
		font-size: 4rem;
		font-weight: 900;
		line-height: 1;
		color: #fff;
		font-variant-numeric: tabular-nums;
		text-shadow: 0 2px 16px rgba(0, 0, 0, 0.6);
	}
	.score-sub {
		font-size: 0.9rem;
		color: var(--ink-dim);
	}
</style>
