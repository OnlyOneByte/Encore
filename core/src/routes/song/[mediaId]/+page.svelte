<script lang="ts">
	/* Reachable for ANY song id, so the row is fetched from `/api/audit/[mediaId]` rather than read from the room catalog,
	   which only holds songs this room has touched. The link is still subscribed for the live key shift the audit row
	   cannot know. See docs/FRONTEND.md#the-song-page. */
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { songDisplay, chosenCandidate, hasNewerCandidateThanOverride, type Media } from '$lib/contract';
	import { room } from '$lib/stores/room';
	import { songFacts } from '$lib/song-facts';
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
		return stop;
	});

	/* AN EFFECT, NOT `onMount`, and that is a bug fix rather than a preference — the same trap `+layout.svelte`
	   documents above its `connect()`. A client-side navigation from one song to another REUSES this component, so
	   the `onMount` fetch never ran a second time and the PREVIOUS song's key, range and lyric candidates stayed on
	   screen under the new URL. Measured at 390x844 on the built app: arriving at a second song page left the
	   heading and the artist reading the FIRST song and fired exactly ONE `/api/audit/` request — permanently, with
	   no spinner to say so. THERE IS NO LONGER A SECOND WAY IN, and that is worth stating rather than quietly dropping:
	   this page used to be reachable mid-song from the now-playing sheet's details button, which lived in the root
	   layout and so was on this page too, re-targeting as the television advances. The sheet is deleted and the door
	   did not move to /queue (measured: `.more-slot a` resolves nowhere in the app), so /queue's now-playing card is the only route
	   here — which makes the stale-data defect above the only arrival case left to get right. `mediaId` is read
	   HERE and passed in rather than read inside `load()`, so the dependency sits at the effect site where it can be
	   seen — an `await` added in front of the fetch would otherwise silently unkey it. */
	$effect(() => {
		void load(mediaId);
	});

	async function load(id: string) {
		loading = true;
		loadError = null;
		// A 404 is an ANSWER — the id is simply not a song this server knows — so it leaves `row` null and `failed`
		// unset, and the empty state says so. Only a thrown error is a failed load.
		let row: Media | null = null;
		let failed: string | null = null;
		try {
			const res = await fetch(`/api/audit/${encodeURIComponent(id)}`);
			if (res.ok) row = (await res.json()).media ?? null;
			else if (res.status !== 404) throw new Error(`HTTP ${res.status}`);
		} catch {
			failed = "Couldn't load this song.";
		}
		/* ONE GUARDED COMMIT, because two navigations can resolve out of order: a response for the song we LEFT
		   landing on this one is the same wrong-song-under-this-URL defect the effect above fixes, and clearing
		   `loading` from a superseded run would show the stale body instead of the skeleton. Measured: a 1500ms
		   response for the song we left, arriving after a 100ms one for the song we are on, is discarded. */
		if (id !== mediaId) return;
		media = row;
		loadError = failed;
		loading = false;
		if (failed) toast.error(failed, { duration: 4000 });
	}

	const display = $derived(songDisplay(media ?? undefined));
	const profile = $derived(media?.songProfile ?? null);
	/* The same one call /queue's now-playing card makes — these two surfaces state the same facts and must agree word
	   for word. */
	const facts = $derived(songFacts(profile, keyShift));
	const keyOriginal = $derived(facts.keyOriginal);
	const keySounding = $derived(facts.keySounding);
	const keyShifted = $derived(facts.keyShifted);
	const rangeText = $derived(facts.rangeText);
	const octaves = $derived(facts.octaves);
	const bandSentence = $derived(facts.bandSentence);
	const candidates = $derived(media?.lyricsCandidates ?? []);

	const heading = $derived(loading ? 'Song' : display.title || media?.title || 'Unknown song');
</script>

<!-- PageHeader is a SIBLING of `main`, so `--page-measure` has to live on this wrapper to reach it. -->
<div class="song-page">
	<PageHeader title={heading} back={{ href: '/queue', label: 'Back to the queue' }} />

	<main>
		<!-- Offline, the range readout may describe a transpose the TV has moved off, so say so. -->
		{#if !connected}
			<p class="offline-note" role="status" aria-live="polite">
				<Icon name="warning" /> Reconnecting…
			</p>
		{/if}

		{#if loading}
			<div class="facts" role="status" aria-busy="true" aria-label="Loading this song…">
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
				<!-- No `class="lyrics"`: that selector is the TV overlay's e2e contract (tests/playwright/world/selectors.ts). -->
				<section aria-label="Lyrics">
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
		/* Reserves the dock in normal flow; no env() term — the tab bar inside it carries the only one. */
		padding: var(--space-xs) var(--space-2xl) calc(var(--dock-h, 0px) + 28px);
	}
	.offline-note {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		margin: 0 0 var(--space-md);
		color: var(--warn);
		font-size: var(--ph-text-sm);
	}
	/* Dimmed by token, never by an ancestor opacity. And --danger-ink, NOT the --warn three rules up: `.offline-note`
	   really does self-heal on the next backoff tick, a song that would not load does not, and one colour for both told a
	   guest to relax about the only thing on this page they had to act on. */
	.load-error {
		margin: 0 0 var(--space-md);
		color: var(--danger-ink);
		font-size: var(--ph-text-sm);
	}
	/* Surface, radius and border come from .card in app.css. Padding was `xl 2xl lg` (14/16/12) — a top 2px off its own bottom, on a rung app.css retired; `lg 2xl` is symmetric vertically and keeps the inline 16. */
	.facts {
		padding: var(--space-lg) var(--space-2xl);
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
		font-size: var(--ph-text-xs);
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
	/* THE LYRICS EYEBROW TAKES THE SECTION RUNG ON PURPOSE, and this page is the one host where that has to be written
	   down, because the arithmetic is not the arithmetic on `/`. `<section aria-label="Lyrics">` is a true SIBLING
	   SECTION of the `.facts` card above it, so app.css's shared `.grouphead` base — 24px top — is the right register
	   here and this file deliberately does NOT pin it back the way `/library`'s nested groupheads do.
	   What differs is whether the boundary COLLAPSES or SUMS. Below 768px `main` is a block box, the h2's top margin
	   collapses through the borderless, paddingless `<section>` and then against `.facts`' 10px bottom margin, so the
	   guest sees max(24, 10) = 24px. At and above 768px the arm below makes `main` a grid with no row-gap, margins do
	   not collapse across grid items, and the same boundary SUMS to 10 + 24 = 34px — the largest single boundary the
	   section rung produces anywhere in the app. That is accepted at width (a 560px prose measure has the room) and
	   clawed back on HEIGHT by the arm after it, because a 844x390 phone matches the grid arm and would otherwise
	   spend 34px of 390 on one gap. */
	@media (min-width: 768px) {
		main {
			display: grid;
			grid-template-columns: minmax(0, 1fr);
			align-content: start;
		}
	}
	/* The claw-back `/` and `/library` carry, on the same 480px threshold and with the same values, so a sideways phone
	   reads the same geometry on all three grouphead hosts: the section rung goes back to the group rung and the
	   boundary lands at 10 + 8 = 18px, since a 844x390 phone matches the grid arm above too and margins still do not
	   collapse. Order against that arm is NOT load-bearing — it sets `display` on `main`, this sets `margin` on the
	   eyebrow, so neither can out-cascade the other. What beats app.css's 0,1,0 `.grouphead` is the scoping hash: this
	   compiles to `.grouphead.svelte-13cl2pg`, 0,2,0, so it wins on specificity and not on bundle order. */
	@media (max-height: 480px) {
		.grouphead {
			margin: var(--space-sm) var(--space-2xs) var(--space-2xs);
		}
	}
</style>
