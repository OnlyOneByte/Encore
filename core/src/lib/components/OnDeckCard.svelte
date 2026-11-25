<script lang="ts">
	/* YOUR CARD on /queue (redesign steps 5 and 5b): the Spotlight, filled in your colour. "You're next" while the song
	   before yours plays, setting the key and guide it will START in (the entry's preset), with "Not yet" once; then
	   "You're up" while it plays, the same rows driving the live song. ONE BOX FOR BOTH MOMENTS: the route keeps this one
	   instance across the handoff and both moments draw the same rows, so the card never changes height when your song
	   starts (#1154). PRESENTATIONAL: the route owns the queue ops, the commands and the heads-up timing. */
	import { MAX_KEY_SHIFT, type SongProfile } from '$lib/contract';
	import { YOURE_UP } from '$lib/phrasing/turn-phrasing';
	import { songFacts } from '$lib/song-facts';
	import Spotlight from '$lib/ui/Spotlight.svelte';
	import GuideSegments from '$lib/ui/GuideSegments.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { Button } from '$lib/components/ui/button';
	import { keyStepName } from '$lib/phrasing/row-action-names';
	import { resolve } from '$app/paths';

	interface Props {
		/** 'up' once your song is the one playing: the same card, now on the live song. */
		moment?: 'on-deck' | 'up';
		/** The turn the card is for: a guide pick never carries onto the next one. */
		entryId: string;
		title: string;
		artist?: string | null;
		profile: SongProfile | null;
		keyShift: number;
		/** The guide level shown, 0..1. */
		guideLevel: number | null;
		guideAvailable: boolean;
		/** False when the room turned key shift off: the keycaps stay in place, disabled. */
		keyAvailable?: boolean;
		/** Up only: the song whose details and lyrics page opens from the slot "Not yet" holds on deck. */
		detailsId?: string | null;
		/** Who sings before you, for "After Maya". */
		afterName?: string | null;
		/** "~2 min"; absent when the current song's length is unknown. */
		timeLeft?: string | null;
		/** The last stretch of the song before: the card says so. */
		headsUp: boolean;
		singerColor: string;
		/** Who "Not yet" lets go first; absent hides the button (spent, or nobody ready behind). */
		notYetName?: string | null;
		onkey: (next: number) => void;
		/** Returns false when the pick never reached the wire. */
		onguide: (level: number) => boolean | void;
		onnotyet: () => void;
	}
	let {
		moment = 'on-deck',
		entryId,
		title,
		artist,
		profile,
		keyShift,
		guideLevel,
		guideAvailable,
		keyAvailable = true,
		detailsId = null,
		afterName,
		timeLeft,
		headsUp,
		singerColor,
		notYetName,
		onkey,
		onguide,
		onnotyet
	}: Props = $props();

	const facts = $derived(songFacts(profile, keyShift));
	const up = $derived(moment === 'up');
	const keyWords = $derived(
		[facts.keyShifted ? `${facts.keyOriginal} → ${facts.keySounding}` : facts.keyOriginal, facts.rangeText]
			.filter(Boolean)
			.join(' · ')
	);
	const meta = $derived(up ? 'Your song' : headsUp ? 'Grab the mic' : afterName ? `After ${afterName}` : 'On deck');
	/* The height it had on deck holds once it is up: a wrapped "Not yet" at 320 would otherwise make the up card
	   shorter and pull everything under it up at the handoff. */
	let box = $state<HTMLElement>();
	let height = $state(0);
	let deckHeight = $state(0);
	$effect(() => {
		if (!up) deckHeight = height;
	});
	// "Not yet" leaves at the handoff; focus on it would drop to <body>, so it goes to the card's first live key.
	let refocus = false;
	$effect.pre(() => {
		if (up) refocus = !!box?.querySelector('.foot')?.contains(document.activeElement);
	});
	$effect(() => {
		if (up && refocus) box?.querySelector<HTMLElement>('.keys button:enabled')?.focus();
		refocus = false;
	});
</script>

<div
	class={['deck', { 'heads-up': headsUp || up, up }]}
	bind:this={box}
	bind:offsetHeight={height}
	style:min-height={up && deckHeight ? `${deckHeight}px` : undefined}
>
	<Spotlight
		moment="on-deck"
		label={up ? 'Your song' : 'On deck'}
		colour={singerColor}
		title={up ? YOURE_UP : 'You’re next'}
		meta={meta}
		metaEnd={timeLeft && !headsUp && !up ? timeLeft : ''}
	>
		<!-- Spoken once per switch; the headline above is not a live region. -->
		<span class="vh" role="status">{up ? YOURE_UP : headsUp ? 'You’re next — grab the mic' : ''}</span>
		<p class="song">
			{title}{#if artist}<span class="artist">&nbsp;— {artist}</span>{/if}
		</p>

		<div class="row ctl">
			<!-- The key words are always a line, so a key tap changes words rather than adding a row. -->
			<span class="lab">
				<span class="control-label">{facts.keyLabel}</span>
				<small>{keyWords || 'Original'}</small>
			</span>
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

		<div class="row">
			<span class="control-label">Guide</span>
			<GuideSegments level={guideLevel} scope={entryId} disabled={!guideAvailable} onpick={onguide} />
		</div>

		<!-- One reserved slot, so neither moment is a row taller: "Not yet" on deck, the song's details once it plays. -->
		<div class="foot">
			{#if up}
				{#if detailsId}
					<a class="more" href={resolve('/song/[mediaId]', { mediaId: detailsId })}
						>Song details and lyrics <Icon name="chevron-right" /></a
					>
				{/if}
			{:else if notYetName}
				<button type="button" class="notyet" onclick={onnotyet}>Not yet — let {notYetName} go first</button>
			{/if}
		</div>
	</Spotlight>
</div>

<style>
	/* Everything on the fill takes the stop's certified ink (`--on-spot`), the keycaps' boundary too, and the dim lines
	   are it at 80%, the floor that clears 4.5:1 on all 48 stops. On the section, where Spotlight sets --on-spot. */
	.deck :global(.spotlight) {
		--ink: var(--on-spot);
		--ink-dim: color-mix(in srgb, var(--on-spot) 80%, var(--spot));
		--control-line: var(--on-spot);
		--line-strong: color-mix(in srgb, var(--on-spot) 50%, var(--spot));
		--ring: var(--on-spot);
	}

	.song {
		margin: 0;
		font-size: var(--type-title);
		font-weight: 600;
		line-height: var(--lh-tight);
	}
	.artist {
		font-weight: 400;
		color: var(--ink-dim);
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--step-12);
		min-height: 56px;
		margin-top: var(--step-8);
	}
	.row + .row {
		margin-top: 0;
		border-top: 1px solid color-mix(in srgb, var(--on-spot) 14%, transparent);
	}
	.lab small {
		display: block;
		font-size: var(--type-meta);
		font-weight: 600;
		color: var(--ink-dim);
	}
	.keys {
		display: flex;
		gap: var(--step-8);
	}

	.foot {
		display: flex;
		justify-content: center;
		min-height: var(--tap);
		margin-top: var(--step-8);
	}
	.notyet {
		min-height: var(--tap);
		padding: 0 var(--step-8);
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		font-weight: 700;
		text-decoration: underline;
		text-underline-offset: 3px;
		cursor: pointer;
	}
	.more {
		display: flex;
		align-items: center;
		gap: var(--step-4);
		min-height: var(--tap);
		font-weight: 700;
		color: inherit;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.notyet:focus-visible,
	.more:focus-visible {
		outline-color: var(--on-spot);
	}
</style>
