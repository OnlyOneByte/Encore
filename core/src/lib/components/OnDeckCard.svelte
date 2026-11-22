<script lang="ts">
	/* "ON DECK": the card a singer sees on /queue while the song before theirs plays. It sets the key and guide their
	   song will START in (the entry's preset, applied by the server at song start), and offers "Not yet" once.
	   PRESENTATIONAL: the route owns the queue ops and the heads-up timing. The key row and the guide slider are the
	   "Singing now" card's own controls, so the two cards cannot drift into two ways of saying the same thing. */
	import { MAX_KEY_SHIFT, type SongProfile } from '$lib/contract';
	import { songFacts } from '$lib/song-facts';
	import GuidingTrack from '$lib/components/GuidingTrack.svelte';
	import RangeBar from '$lib/components/RangeBar.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { Button } from '$lib/components/ui/button';

	interface Props {
		title: string;
		artist?: string | null;
		profile: SongProfile | null;
		keyShift: number;
		guidePct: number;
		guideAvailable: boolean;
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
		title,
		artist,
		profile,
		keyShift,
		guidePct,
		guideAvailable,
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
</script>

<section class={['deck', 'your-turn', { 'heads-up': headsUp }]} style="--singer:{singerColor}" aria-label="On deck">
	<p class="eyebrow">
		<!-- role=status so the switch to "You're next" is spoken; it changes once per turn, not every second. -->
		<span role="status">{headsUp ? "You're next — grab the mic" : 'On deck'}</span>
		{#if timeLeft && !headsUp}<span class="left">{timeLeft}</span>{/if}
	</p>
	<h2 class="title">
		{title}{#if artist}<span class="artist">&nbsp;— {artist}</span>{/if}
	</h2>

	{#if facts.keyOriginal && facts.keyShifted}
		<p class="facts">
			{facts.keyOriginal}<Icon name="arrow-right" /><span class="k-sound">{facts.keySounding}</span>
		</p>
	{/if}

	<div class="ctl">
		<span class="control-label">{facts.keyLabel}</span>
		<div class="keys">
			<Button
				size="tap"
				variant="keycap"
				disabled={keyShift <= -MAX_KEY_SHIFT}
				aria-label="Lower by one semitone"
				onclick={() => onkey(keyShift - 1)}><Icon name="minus" /></Button
			>
			<Button
				size="tap"
				variant="keycap"
				disabled={keyShift >= MAX_KEY_SHIFT}
				aria-label="Raise by one semitone"
				onclick={() => onkey(keyShift + 1)}><Icon name="plus" /></Button
			>
		</div>
	</div>

	<GuidingTrack pct={guidePct} available={guideAvailable} oninput={onguideinput} oncommit={onguidecommit} />

	<RangeBar profile={profile} keyShift={keyShift} />

	{#if notYetName}
		<Button variant="outline" size="block" onclick={onnotyet}>Not yet — let {notYetName} go first</Button>
	{/if}
</section>

<style>
	/* The "Singing now" card's dress, so the two read as one family on the same screen. */
	.deck {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		padding: var(--space-2xl);
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--card-tint);
		box-shadow:
			var(--shadow-sm),
			inset 0 1px 0 var(--edge-hi);
	}
	/* The heads-up is the singer's OWN colour: the one signal on the phone that is unmistakably "you". The surface is
	   app.css `.your-turn`, shared with the "You're up" sheet. */
	.heads-up {
		border-color: var(--singer);
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
		color: var(--accent-ink);
	}
	.heads-up .eyebrow {
		color: var(--ink);
	}
	.left {
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

	/* Opt-in, as ColourRing does it: the fade into the heads-up only for those who have not asked for less motion. */
	@media (prefers-reduced-motion: no-preference) {
		.deck {
			transition:
				background-color var(--motion-slow) ease,
				border-color var(--motion-slow) ease;
		}
		/* The eyebrow's ink moves with the card, or it snaps to --ink on the first frame while the surface fades. */
		.eyebrow {
			transition: color var(--motion-slow) ease;
		}
	}
</style>
