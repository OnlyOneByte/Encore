<script lang="ts">
	/* THE ONE THING THE AUDIENCE'S PHONE CAN DO WHILE SOMEONE ELSE SINGS THAT CANNOT INTERFERE WITH THE SONG. Every
	   other control on the dock moves the playhead; these only reach the TV, as a disc rising up its right edge.
	   The caller renders this whenever a song is on. On the singer's own phone it is `resting`: the slot and its
	   surface stay, the buttons fade out and the group is inert, so the dock never changes height at the handoff. */
	import { REACTIONS, type ReactionKind } from '$lib/contract';
	import ReactionGlyph from '$lib/ui/ReactionGlyph.svelte';

	let {
		singerName,
		onreact,
		resting = false
	}: { singerName: string | null; onreact: (kind: ReactionKind) => void; resting?: boolean } = $props();

	function send(kind: ReactionKind) {
		// The same 8 ms tick /queue and /library give a tap that changes nothing on this screen.
		if (navigator.vibrate) navigator.vibrate(8);
		onreact(kind);
	}
</script>

<div
	class="cheers"
	class:resting={resting}
	role="group"
	aria-label="Cheer for {singerName ?? 'the singer'}"
	inert={resting}
>
	{#each REACTIONS as r (r.id)}
		<button class="cheer" onclick={() => send(r.id)} aria-label={r.label}>
			<span class="pic"><ReactionGlyph kind={r.id} /></span>
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

	/* --tap-lg, not --tap: the spec's 64 px, because these are hit in a burst, eyes on the TV. */
	.cheer {
		min-height: var(--tap-lg);
		display: grid;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: var(--radius-pill);
		background: var(--card2);
	}

	/* `visibility` too, so the faded buttons are not hit-tested or found by a locator; it switches at the END of the
	   fade out and at the start of the fade in, which is how a `visibility` transition interpolates. */
	.resting .cheer {
		opacity: 0;
		visibility: hidden;
	}

	.pic {
		width: calc(var(--tap-lg) / 2);
		height: calc(var(--tap-lg) / 2);
	}

	@media (prefers-reduced-motion: no-preference) {
		/* A press is a transform and resting is a fade, so neither touches layout. */
		.cheer {
			transition:
				transform var(--motion-fast) ease-out,
				opacity var(--motion-base) ease-out,
				visibility var(--motion-base);
		}
		.cheer:active {
			transform: scale(0.9);
		}
	}
</style>
