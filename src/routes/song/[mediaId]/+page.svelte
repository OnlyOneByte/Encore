<script lang="ts">
	/* Reachable for ANY song id, so the row is fetched from `/api/audit/[mediaId]` rather than read from the room catalog,
	   which only holds songs this room has touched. The link is still subscribed for the live key shift the audit row
	   cannot know. See docs/FRONTEND.md#the-song-page. */
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import {
		originalKeyLabel,
		soundingKeyLabel,
		rangeLabel,
		rangeOctaves,
		voiceBandSentence,
		songDisplay,
		chosenCandidate,
		hasNewerCandidateThanOverride,
		type Media
	} from '$lib/contract';
	import { room } from '$lib/stores/room';
	import PageHeader from '$lib/ui/PageHeader.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import RangeBar from '$lib/components/RangeBar.svelte';
	import LyricsReselect from '$lib/components/LyricsReselect.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Empty from '$lib/components/ui/empty';
	import { Toaster } from '$lib/components/ui/sonner';
	import { toast } from 'svelte-sonner';

	const mediaId = $derived(page.params.mediaId ?? '');

	let media = $state<Media | null>(null);
	let loading = $state(true);
	/** A load that failed, as distinct from a song that is genuinely unknown — the two read differently. */
	let loadError = $state<string | null>(null);
	let connected = $state(false);
	/** The room's live transpose, so the range readout agrees with what the TV is sounding right now. */
	let keyShift = $state(0);

	onMount(() => {
		const sync = () => {
			connected = room.connected;
			keyShift = room.playback.keyShift;
		};
		sync();
		const stop = room.subscribe(sync);
		void room.connect();
		void load();
		return stop;
	});

	async function load() {
		loading = true;
		loadError = null;
		try {
			const res = await fetch(`/api/audit/${encodeURIComponent(mediaId)}`);
			if (res.status === 404) {
				// Not an error: the id is simply not a song this server knows. The empty state says so.
				media = null;
				return;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			media = (await res.json()).media ?? null;
		} catch {
			loadError = "Couldn't load this song.";
			toast.error(loadError, { duration: 4000 });
		} finally {
			loading = false;
		}
	}

	const display = $derived(songDisplay(media ?? undefined));
	const profile = $derived(media?.songProfile ?? null);
	const keyOriginal = $derived(originalKeyLabel(profile));
	const keySounding = $derived(soundingKeyLabel(profile, keyShift));
	const keyShifted = $derived(keyShift !== 0 && keySounding !== null && keySounding !== keyOriginal);
	const rangeText = $derived(rangeLabel(profile, keyShift));
	const octaves = $derived(rangeOctaves(profile));
	const bandSentence = $derived(voiceBandSentence(profile, keyShift));
	const candidates = $derived(media?.lyricsCandidates ?? []);

	const heading = $derived(loading ? 'Song' : display.title || media?.title || 'Unknown song');
</script>

<!-- PageHeader is a SIBLING of `main`, so `--page-measure` has to live on this wrapper to reach it. -->
<div class="song-page">
	<PageHeader title={heading} back={{ href: '/', label: 'Back to the queue' }} />

	<main>
		<!-- Offline, the range readout may describe a transpose the TV has moved off, so say so. -->
		{#if !connected}
			<p class="offline-note" role="status" aria-live="polite">
				<Icon name="warning" /> Reconnecting…
			</p>
		{/if}

		{#if loading}
			<div class="facts" aria-busy="true" aria-label="Loading this song…">
				<Skeleton variant="line-short" />
				<Skeleton />
				<Skeleton />
			</div>
		{:else if loadError}
			<p class="load-error" role="alert">{loadError}</p>
		{:else if !media}
			<Empty.Root>
				<Empty.Header>
					<Empty.Description>No song with that id.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else}
			<section class="facts card" aria-label="Song details">
				{#if display.artist ?? media.artist}
					<p class="artist">{display.artist ?? media.artist}</p>
				{/if}

				{#if keyOriginal}
					<div class="fact">
						<span class="lab">Key</span>
						<span class="val">
							{keyOriginal}
							{#if keyShifted}
								<span class="arrow"><Icon name="arrow-right" /></span><span class="shifted">{keySounding}</span>
							{/if}
						</span>
					</div>
				{/if}

				{#if rangeText}
					<div class="fact">
						<span class="lab">Range</span>
						<span class="val"
							>{rangeText}{#if octaves !== null}<span class="oct">{octaves} oct</span>{/if}</span
						>
					</div>
					{#if bandSentence}<p class="band-sentence">{bandSentence}</p>{/if}
					<RangeBar profile={profile} keyShift={keyShift} />
				{:else}
					<!-- A singable song can have no measured range: the analysis needs a vocals stem. Say so, rather than drawing an
							empty strip that reads as "range = zero". -->
					<p class="band-sentence">No vocal range yet — that needs karaoke.</p>
				{/if}
			</section>

			<!-- Quick-select only: picking among the ranker's versions. Authoring one is a separate surface. -->
			{#if candidates.length}
				<!-- Bound out of the narrowed branch: a callback escapes Svelte's narrowing, so `media.id` inside one reads as
						possibly-null to the checker. -->
				{@const songId = media.id}
				<section class="lyrics" aria-label="Lyrics">
					<h2 class="grouphead">Lyrics</h2>
					<LyricsReselect
						candidates={candidates}
						chosenRef={chosenCandidate(media)?.ref}
						overrideRef={media.lyricsOverrideRef}
						newerExists={hasNewerCandidateThanOverride(media.lyricsCandidates, media.lyricsOverrideRef)}
						onpick={(ref) => void room.reselectLyrics(songId, { ref })}
						onpaste={(text) => void room.reselectLyrics(songId, { text })}
					/>
				</section>
			{/if}
		{/if}
	</main>
</div>

<Toaster position="bottom-center" offset="var(--dock-h, 0px)" style="--width: min(92vw, 420px);" />

<style>
	.song-page {
		/* Set the measure, or PageHeader falls back to the shell's cap and stops agreeing with the column under it. Prose
			   width, as on /settings: this is a labelled fact list, not a grid of rows. */
		--page-measure: var(--measure-prose);
	}
	main {
		flex: 1;
		max-width: var(--page-measure);
		margin-inline: auto;
		width: 100%;
		box-sizing: border-box;
		/* Reserves the band in normal flow; no env() term — the band carries the only one. */
		padding: var(--space-xs) var(--space-3xl) calc(var(--dock-h, 0px) + 28px);
	}
	.offline-note {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		margin: 0 0 var(--space-md);
		color: var(--warn);
		font-size: var(--ph-text-sm);
	}
	/* Dimmed by token, never by an ancestor opacity. */
	.load-error {
		margin: 0 0 var(--space-md);
		color: var(--warn);
		font-size: var(--ph-text-sm);
	}
	/* Surface, radius and border come from .card in app.css. */
	.facts {
		padding: var(--space-xl) var(--space-2xl) var(--space-lg);
		margin: 0 0 var(--space-md);
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}
	.artist {
		margin: 0;
		font-size: var(--ph-text-base);
		color: var(--ink-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.fact {
		display: flex;
		align-items: baseline;
		gap: var(--space-md);
		/* Wraps rather than truncating: both halves are short, and a clipped key is a wrong key. */
		flex-wrap: wrap;
	}
	.lab {
		font-size: var(--ph-text-2xs);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-dim);
		min-width: 0;
	}
	.val {
		display: inline-flex;
		align-items: center;
		gap: var(--space-sm);
		margin-left: auto;
		font-size: var(--ph-text-base);
		font-weight: 700;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
	.arrow {
		display: inline-grid;
		place-items: center;
		color: var(--ink-dim);
	}
	.shifted {
		color: var(--warn);
	}
	.oct {
		margin-left: var(--space-sm);
		font-size: var(--ph-text-xs);
		font-weight: 500;
		color: var(--ink-dim);
	}
	.band-sentence {
		margin: 0;
		font-size: var(--ph-text-xs);
		line-height: var(--lh-normal);
		color: var(--ink-dim);
	}
	.grouphead {
		font-size: var(--ph-text-2xs);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-dim);
		font-weight: 700;
		margin: var(--space-2xl) var(--space-2xs) var(--space-sm);
	}
	.lyrics {
		margin: 0;
	}

	@media (min-width: 768px) {
		main {
			display: grid;
			grid-template-columns: minmax(0, 1fr);
			align-content: start;
		}
	}
</style>
