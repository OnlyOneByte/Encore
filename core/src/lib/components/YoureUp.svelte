<script lang="ts">
	/* "YOU'RE UP": the phone's half of the handoff moment, shown on any tab while the TV holds its "Now singing" card
	   for the same singer. It finishes the On deck card's job: that one warns you while the song before plays; this
	   says the song is now yours, which a skip can make true with no warning at all. PRESENTATIONAL: the layout owns
	   when it shows and for how long. Three words and a title, in your colour, then it goes. */
	import { YOURE_UP } from '$lib/phrasing/turn-phrasing';
	import { Button } from '$lib/components/ui/button';

	interface Props {
		title: string;
		singerColor: string;
		ondismiss: () => void;
	}
	let { title, singerColor, ondismiss }: Props = $props();
</script>

<!-- role=status, not a dialog: it takes no focus and blocks nothing, and it is spoken once when it appears. -->
<div class="youre-up pop-in" role="status" style="--singer:{singerColor}">
	<p class="who"><span class="dot" aria-hidden="true"></span>{YOURE_UP}</p>
	<p class="song">{title}</p>
	<Button class="ok" onclick={ondismiss}>OK</Button>
</div>

<style>
	/* Above the dock, the On deck heads-up's dress: the singer's colour mixed into the card surface, so the text keeps
	   its contrast on every singer colour. */
	.youre-up {
		position: fixed;
		inset-inline: var(--space-lg);
		inset-block-end: calc(var(--dock-h, 0px) + var(--space-lg));
		z-index: var(--z-dock);
		max-width: 420px;
		margin-inline: auto;
		display: grid;
		gap: var(--space-xs);
		padding: var(--space-2xl);
		border: 1px solid var(--singer);
		border-radius: var(--radius-sm);
		background: color-mix(in srgb, var(--singer) 22%, var(--card-tint));
		box-shadow:
			var(--shadow-sm),
			inset 0 1px 0 var(--edge-hi);
	}
	.who {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		margin: 0;
		font-size: var(--ph-text-lg);
		font-weight: 700;
		color: var(--ink);
	}
	.dot {
		width: 0.6em;
		height: 0.6em;
		border-radius: 50%;
		background: var(--singer);
	}
	.song {
		margin: 0;
		font-size: var(--ph-text-md);
		color: var(--ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.youre-up :global(.ok) {
		justify-self: center;
		min-width: 8ch;
	}
</style>
