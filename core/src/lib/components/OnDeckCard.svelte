<script lang="ts">
	/* YOUR CARD on /queue (redesign step 5): "On deck" while the song before yours plays, setting the key and guide it
	   will START in (the entry's preset), with "Not yet" once; then "You're up" while it plays, the same rows driving the
	   live song. ONE BOX FOR BOTH MOMENTS: the route keeps this one instance across the handoff and both moments draw
	   the same rows, so the card never changes height when your song starts (#1154). PRESENTATIONAL: the route owns
	   the queue ops, the commands and the heads-up timing. */
	import { MAX_KEY_SHIFT, type SongProfile } from '$lib/contract';
	import { YOURE_UP } from '$lib/phrasing/turn-phrasing';
	import { songFacts } from '$lib/song-facts';
	import GuidingTrack from '$lib/components/GuidingTrack.svelte';
	import RangeBar from '$lib/components/RangeBar.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { Button } from '$lib/components/ui/button';
	import { keyStepName } from '$lib/phrasing/row-action-names';
	import { resolve } from '$app/paths';

	interface Props {
		/** 'up' once your song is the one playing: the same card, now on the live song. */
		moment?: 'on-deck' | 'up';
		title: string;
		artist?: string | null;
		profile: SongProfile | null;
		keyShift: number;
		guidePct: number;
		guideAvailable: boolean;
		/** False when the room turned key shift off: the keycaps stay in place, disabled. */
		keyAvailable?: boolean;
		/** Up only: the song whose details and lyrics page opens from the slot "Not yet" holds on deck. */
		detailsId?: string | null;
		/** "~2 min"; absent when the current song's length is unknown. */
		timeLeft?: string | null;
		/** The last stretch of the song before: the card takes the singer's colour and says so. */
		headsUp: boolean;
		singerColor: string;
		/** Who "Not yet" lets go first; absent hides the button (spent, or nobody ready behind). */
		notYetName?: string | null;
		onkey: (next: number) => void;
		onguideinput: (pct: number) => void;
		onguidecommit: (pct: number) => void;
		onnotyet: () => void;
	}
	let {
		moment = 'on-deck',
		title,
		artist,
		profile,
		keyShift,
		guidePct,
		guideAvailable,
		keyAvailable = true,
		detailsId = null,
		timeLeft,
		headsUp,
		singerColor,
		notYetName,
		onkey,
		onguideinput,
		onguidecommit,
		onnotyet
	}: Props = $props();

	const facts = $derived(songFacts(profile, keyShift));
	const up = $derived(moment === 'up');
	/* The height it had on deck holds once it is up: a wrapped "Not yet" or eyebrow at 320 would otherwise make the
	   up card shorter and pull the list under it up at the handoff. */
	let height = $state(0);
	let deckHeight = $state(0);
	$effect(() => {
		if (!up) deckHeight = height;
	});
</script>

<section
	class={['deck', 'your-turn', { 'heads-up': headsUp || up, up }]}
	style="--singer:{singerColor}"
	style:min-height={up && deckHeight ? `${deckHeight}px` : undefined}
	bind:offsetHeight={height}
	aria-label={up ? 'Your song' : 'On deck'}
>
	<p class="eyebrow">
		<!-- role=status so each switch is spoken; it changes once per turn, not every second. -->
		<span role="status">{up ? YOURE_UP : headsUp ? "You're next — grab the mic" : 'On deck'}</span>
		<!-- Always in the row, empty when it has nothing to say, so the clock coming and going moves nothing. -->
		<span class="left">{timeLeft && !headsUp && !up ? timeLeft : ''}</span>
	</p>
	<h2 class="title">
		{title}{#if artist}<span class="artist">&nbsp;— {artist}</span>{/if}
	</h2>

	<!-- The song's key and range, there whenever the key is known, so a key tap changes words in it and adds no row. -->
	{#if facts.keyOriginal}
		<p class="facts">
			<span class="k-orig">{facts.keyOriginal}</span>
			{#if facts.keyShifted}<Icon name="arrow-right" /><span class="k-sound">{facts.keySounding}</span>{/if}
			{#if facts.rangeText}<span class="k-range"> · {facts.rangeText}</span>{/if}
		</p>
	{/if}

	<div class="ctl">
		<span class="control-label">{facts.keyLabel}</span>
		<div class="keys">
			<Button
				size="tap"
				variant="keycap"
				disabled={!keyAvailable || keyShift <= -MAX_KEY_SHIFT}
				aria-label={keyStepName(-1, title)}
				onclick={() => onkey(keyShift - 1)}><Icon name="minus" /></Button
			>
			<Button
				size="tap"
				variant="keycap"
				disabled={!keyAvailable || keyShift >= MAX_KEY_SHIFT}
				aria-label={keyStepName(1, title)}
				onclick={() => onkey(keyShift + 1)}><Icon name="plus" /></Button
			>
		</div>
	</div>

	<GuidingTrack pct={guidePct} available={guideAvailable} oninput={onguideinput} oncommit={onguidecommit} />

	<RangeBar profile={profile} keyShift={keyShift} />

	<!-- One reserved slot, so neither moment is a row taller: "Not yet" on deck, the song's details once it plays. -->
	<div class="foot">
		{#if up}
			{#if detailsId}
				<a class="more" href={resolve('/song/[mediaId]', { mediaId: detailsId })}
					>Song details and lyrics <Icon name="chevron-right" /></a
				>
			{/if}
		{:else if notYetName}
			<Button variant="outline" size="block" onclick={onnotyet}>Not yet — let {notYetName} go first</Button>
		{/if}
	</div>
</section>

<style>
	/* THE SPOTLIGHT, in the singer's OWN colour from On deck through You're up: the screen's one lit surface, and the
	   one signal on the phone that is unmistakably "you". The surface is app.css `.your-turn`, shared with the "You're
	   up" sheet, so nothing changes colour at the handoff either. */
	.deck {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		padding: var(--space-2xl);
		border: 1px solid var(--singer);
		border-radius: var(--radius-sm);
		background: var(--your-turn-surface);
	}

	.eyebrow {
		display: flex;
		justify-content: space-between;
		gap: var(--space-md);
		margin: 0;
		font-size: var(--ph-text-xs);
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink);
	}
	/* A box as wide as its longest words ("under a minute", `minutesLeft`), the words starting at its left edge:
	   "~2 min" becoming that changes the text, and moves neither the box nor where the text starts. */
	.left {
		/* Capped at 40% of the row, so text doubled at 320 (P15) wraps here instead of pushing the card wide. */
		flex: 0 1 auto;
		min-width: min(15ch, 40%);
		font-variant-numeric: tabular-nums;
		text-transform: none;
		letter-spacing: normal;
		color: var(--ink-dim);
	}

	.title {
		margin: 0;
		font-size: var(--ph-text-lg);
		font-weight: 700;
		line-height: var(--lh-tight);
		color: var(--ink);
	}
	.artist {
		font-weight: 400;
		color: var(--ink-dim);
	}

	.facts {
		display: flex;
		align-items: center;
		gap: var(--space-2xs);
		margin: 0;
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
	}
	.k-sound {
		font-weight: 700;
		color: var(--ink);
	}

	.ctl {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-md);
	}
	.keys {
		display: flex;
		gap: var(--space-xs);
	}

	.foot {
		min-height: var(--tap);
	}
	/* A quiet trailing link, not a Button: it leaves the card rather than acting on it. */
	.more {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-xs);
		min-height: var(--tap);
		font-size: var(--ph-text-md);
		font-weight: 500;
		color: var(--ink);
		text-decoration: none;
	}
</style>
