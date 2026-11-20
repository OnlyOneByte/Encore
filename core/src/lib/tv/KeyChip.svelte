<script lang="ts">
	/* "Key −2" on the song-intro card, when the singer set the key in advance — so the room hears the change as
	   deliberate rather than as the track being wrong. Renders nothing at 0. */
	let { semitones }: { semitones: number } = $props();
</script>

{#if semitones}
	<div class="key-chip">Key {semitones > 0 ? '+' : '−'}{Math.abs(semitones)}</div>
{/if}

<style>
	.key-chip {
		margin-top: 2vh;
		padding: 0.3em 0.9em;
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-pill);
		font-size: var(--tv-name);
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--ink);
		background: color-mix(in srgb, var(--accent2) 18%, transparent);
	}
</style>
