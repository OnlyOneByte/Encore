<script lang="ts">
	/*
	 * THE SONG PAGE — one song, everything a singer needs to decide about it before their turn.
	 *
	 * WHY A ROUTE AND NOT A SHEET. The drawer's "···" used to be planned as a second sheet stacked on the
	 * first, and that was rejected on a forward-looking argument rather than a stylistic one: lyrics
	 * timing and editing are going to become a comprehensive system, and a sheet that grows into a
	 * workspace is the wrong container to start it in. A chooser is not an editor. So the door opens onto
	 * a page, the browser's back gesture is the way out, and `/song/[mediaId]/lyrics` has somewhere to be.
	 *
	 * WHY IT SHARES AN ENDPOINT WITH /metrics/[mediaId]. `GET /api/audit/[mediaId]` already returns the
	 * full media row plus its attempt history — it is the one place that knows everything about how a song
	 * came to be. Two routes reading one endpoint is the deliberate shape (the ruling was: share the
	 * endpoint and the components, keep the routes separate), because the two surfaces answer different
	 * questions of the same data. /metrics asks "how was this made, and what did it cost"; this asks "can
	 * I sing it, and are the words right". A second endpoint would have been two answers to one question.
	 *
	 * NOT FROM THE ROOM LINK. The catalog only holds songs the room has touched, and this page is
	 * reachable for any song id — including one that is not queued, not playing, and processed on an
	 * earlier night. So it fetches. The link is still read for the LIVE facts the room owns and the audit
	 * row cannot know: the current key shift, so the range readout matches what the TV is sounding.
	 */
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

	/*
	 * The heading is the SONG, not the page's function. "Find a song" names what /find is for because a
	 * search box is a tool; this page is about one thing, and naming it "Song details" over the top of the
	 * title would put a label where the subject belongs.
	 */
	const heading = $derived(loading ? 'Song' : (display.title || media?.title || 'Unknown song'));
</script>

<!--
	The wrapper exists to carry `--page-measure`, which PageHeader reads. The header is a SIBLING of
	`main`, not a descendant, so declaring the measure on `main` would never reach it — the same shape
	`/settings` uses with `.settings-page`.
-->
<div class="song-page">
	<PageHeader title={heading} back={{ href: '/', label: 'Back to the queue' }} />

<main>
	<!-- Room state is a live claim, and a stale one on this page would let the range readout describe a
	     transpose the TV has since moved off. Says so rather than looking authoritative. -->
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

			<!--
				THE RANGE IS THE POINT OF THIS BLOCK. It is the one fact that answers "can I sing this", and it
				is shown in full here — label, octave span, the band sentence and the visualizer — because a
				page has the room the drawer does not. Same components, same helpers, more space.
			-->
			{#if rangeText}
				<div class="fact">
					<span class="lab">Range</span>
					<span class="val">{rangeText}{#if octaves !== null}<span class="oct">{octaves} oct</span>{/if}</span>
				</div>
				{#if bandSentence}<p class="band-sentence">{bandSentence}</p>{/if}
				<RangeBar {profile} {keyShift} />
			{:else}
				<!-- A song can be perfectly singable and have no measured range: the analysis needs a vocals
				     stem. Stating that beats an empty strip that reads as "range = zero". -->
				<p class="band-sentence">No vocal range yet — that needs karaoke.</p>
			{/if}
		</section>

		<!--
			LYRICS QUICK-SELECT, and quick-select is the whole scope here. Picking among the versions the
			ranker already found is a CHOICE and belongs on the overview; pasting or authoring a version is a
			different act with a different surface, and it lives at /song/[mediaId]/lyrics. That route does
			not exist yet, so there is no link to it — the same rule the band's handle and the drawer's own
			affordances follow: no destination, no door.
		-->
		{#if candidates.length}
			<!-- Bound out of the narrowed branch: an arrow function escapes Svelte's `{:else}` narrowing, so
			     `media.id` inside a callback is `possibly null` to the checker even though it cannot be. -->
			{@const songId = media.id}
			<section class="lyrics" aria-label="Lyrics">
				<h2 class="grouphead">Lyrics</h2>
				<LyricsReselect
					{candidates}
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
		/*
		 * A READING WIDTH, which this route shipped without. PageHeader caps its row on this token and
		 * falls back to the shell's cap when a route sets none — so on a desktop viewport the header
		 * aligned to one width while the column ran the full shell, the two visibly disagreed, and the
		 * range visualizer stretched to ~1300px. 560px matches /settings, the other route whose content is
		 * a labelled fact list rather than a grid of rows.
		 */
		--page-measure: 560px;
	}
	main {
		flex: 1;
		max-width: var(--page-measure);
		margin-inline: auto;
		width: 100%;
		box-sizing: border-box;
		/* Reserves the band in normal flow (XR-PH-12); no env() term — the band carries the only one. */
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
	/* Dimmed by token, never by an ancestor opacity — XR-PH-03. */
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
