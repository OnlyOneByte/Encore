<script lang="ts">
	/* "YOU'RE UP": the phone's half of the handoff moment, shown on any tab while the TV holds its "Now singing" card
	   for the same singer. It finishes the On deck card's job: that one warns you while the song before plays; this
	   says the song is now yours, which a skip can make true with no warning at all. PRESENTATIONAL: the layout owns
	   when it shows, for how long, and the live region it is announced from. Three words and a title, in your colour,
	   then it goes. */
	import { YOURE_UP } from '$lib/phrasing/turn-phrasing';
	import { Button } from '$lib/components/ui/button';

	interface Props {
		title: string;
		singerColor: string;
		ondismiss: () => void;
		/** The sheet's measured height, so the layout can stack a toast above it rather than over it. */
		height?: number;
	}
	let { title, singerColor, ondismiss, height = $bindable(0) }: Props = $props();
</script>

<!-- Not a dialog: it takes no focus and blocks nothing. The words are announced by the layout's live region, which
	holds them alone; this copy is for the eyes, so it is hidden from assistive tech rather than read twice. -->
<div class="youre-up your-turn rise-in" style="--singer:{singerColor}" bind:clientHeight={height}>
	<p class="who" aria-hidden="true"><span class="dot"></span>{YOURE_UP}</p>
	<p class="song" aria-hidden="true">{title}</p>
	<!-- The words above are hidden from assistive tech, so the button carries their context; it still starts with its
		visible label, so a voice command for "OK" finds it. -->
	<Button class="ok" aria-label="OK, dismiss {YOURE_UP}" onclick={ondismiss}>OK</Button>
</div>

<style>
	/* Above the dock, in the On deck heads-up's colour (app.css `.your-turn`). */
	.youre-up {
		position: fixed;
		inset-inline: var(--sheet-gutter);
		inset-block-end: calc(var(--dock-h, 0px) + var(--space-lg));
		z-index: var(--z-dock);
		max-width: var(--sheet-max);
		margin-inline: auto;
		display: grid;
		gap: var(--space-xs);
		padding: var(--space-2xl);
		border: 1px solid var(--singer);
		border-radius: var(--radius-sm);
		background: var(--your-turn-surface);
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
