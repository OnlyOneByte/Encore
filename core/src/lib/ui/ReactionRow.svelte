<script lang="ts">
	/* THE ONE THING THE AUDIENCE'S PHONE CAN DO WHILE SOMEONE ELSE SINGS THAT CANNOT INTERFERE WITH THE SONG. Every
	   other control on the dock moves the playhead; these only reach the TV, as a disc rising up its right edge.
	   The caller renders this only when a song is on and it is not yours, so the singer's own phone never shows it. */
	import { REACTIONS, type ReactionKind } from '$lib/contract';

	let { singerName, onreact }: { singerName: string | null; onreact: (kind: ReactionKind) => void } = $props();

	function send(kind: ReactionKind) {
		// The same 8 ms tick /queue and /library give a tap that changes nothing on this screen.
		if (navigator.vibrate) navigator.vibrate(8);
		onreact(kind);
	}
</script>

<div class="cheers" role="group" aria-label="Cheer for {singerName ?? 'the singer'}">
	{#each REACTIONS as r (r.id)}
		<button class="cheer" onclick={() => send(r.id)} aria-label={r.label}>
			<span aria-hidden="true">{r.emoji}</span>
		</button>
	{/each}
</div>

<style>
	/* The strip's own surface, so the row reads as part of the dock rather than a second bar stacked on it. */
	.cheers {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: var(--space-xs);
		padding: var(--space-xs) var(--space-lg) 0;
		background: var(--card);
		border-top: 1px solid var(--line);
	}

	.cheer {
		min-height: var(--tap);
		display: grid;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: var(--radius-pill);
		background: var(--card2);
		font-size: var(--ph-text-xl);
		line-height: var(--lh-none);
	}

	@media (prefers-reduced-motion: no-preference) {
		/* A press is a transform, so the feedback never touches layout. */
		.cheer {
			transition: transform var(--motion-fast) ease-out;
		}
		.cheer:active {
			transform: scale(0.9);
		}
	}
</style>
