<script lang="ts">
	/* "YOUR SONG DIDN'T PLAY": the singer's half of a song the TV could not play (proposal 11), shown on any tab in the
	   slot "You're up" uses, and in its place if that one is still up. It stays until the singer acts or closes it: the
	   turn is held until they do, so a sheet that timed out would leave them believing their song was coming.
	   PRESENTATIONAL: the layout owns when it shows and what each button does. */
	import { KEEP_YOUR_SPOT, YOUR_SONG_DIDNT_PLAY } from '$lib/phrasing/turn-phrasing';
	import { Button } from '$lib/components/ui/button';
	import Icon from '$lib/ui/Icon.svelte';

	interface Props {
		title: string;
		singerColor: string;
		/** Absent once the same song has failed twice: only Pick another is offered. */
		onretry?: () => void;
		pickAnotherHref: string;
		onpick: () => void;
		ondismiss: () => void;
		/** The sheet's measured height, so the layout can stack a toast above it rather than over it. */
		height?: number;
	}
	let { title, singerColor, onretry, pickAnotherHref, onpick, ondismiss, height = $bindable(0) }: Props = $props();
</script>

<!-- Not a dialog: it takes no focus and blocks nothing. The layout's live region announces it; the words stay readable
	here, because unlike "You're up" this sheet stays, and a screen reader that finds its buttons must find why. -->
<div
	class="didnt-play your-turn rise-in"
	style="--singer:{singerColor}"
	role="group"
	aria-label={YOUR_SONG_DIDNT_PLAY}
	data-testid="song-didnt-play"
	bind:clientHeight={height}
>
	<div class="head">
		<p class="who"><span class="dot"></span>{YOUR_SONG_DIDNT_PLAY}</p>
		<Button variant="ghost" size="icon" aria-label="Close" onclick={ondismiss}><Icon name="close" /></Button>
	</div>
	<p class="song">{title}</p>
	<!-- One filled button: Try again while it is offered, else Pick another (redesign step 6, #1156). -->
	<div class="next">
		{#if onretry}
			<Button size="tap" data-testid="didnt-play-retry" onclick={onretry}>Try again</Button>
		{/if}
		<Button
			size="tap"
			variant={onretry ? 'ghost' : 'default'}
			data-testid="didnt-play-pick"
			href={pickAnotherHref}
			onclick={onpick}>Pick another</Button
		>
	</div>
	<p class="keep">{KEEP_YOUR_SPOT}</p>
</div>

<style>
	/* The "You're up" sheet's box and place (YoureUp.svelte), so one replaces the other without a jump. */
	.didnt-play {
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
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-xs);
		/* The close button's tap box is taller than the line: let it overhang the padding rather than push the title. */
		margin-block: calc(-1 * var(--space-xs));
	}
	/* At 320 the line wraps: `balance` breaks it "Your song / didn't play" instead of leaving "play" alone, and the dot
	   sits on the FIRST line, centred on its line box (`1lh`), not between the two. */
	.who {
		display: flex;
		align-items: flex-start;
		gap: var(--space-xs);
		margin: 0;
		min-width: 0;
		font-size: var(--ph-text-lg);
		font-weight: 700;
		color: var(--ink);
		text-wrap: balance;
	}
	.dot {
		flex: 0 0 auto;
		width: 0.6em;
		height: 0.6em;
		margin-block-start: calc((1lh - 0.6em) / 2);
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
	.next {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}
	.keep {
		margin: 0;
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
	}
</style>
