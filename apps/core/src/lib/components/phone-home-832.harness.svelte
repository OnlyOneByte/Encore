<script lang="ts">
	/*
	 * Test harness for NowPlayingHero's live-controls disclosure (issue #832).
	 *
	 * It exists because the thing under test is a SNIPPET prop, and the route passes it as a
	 * `{#snippet}` block in markup. Building one in the test file instead would exercise a different
	 * code path (and `createRawSnippet` imported from the bare `svelte` specifier resolves to the
	 * SERVER runtime under `bun test`, whose renderer the client mount cannot drive). So the harness
	 * passes a real markup snippet, the same way `+page.svelte` does.
	 *
	 * Not shipped: nothing in the app imports it. It sits beside its test, mirroring
	 * `lib/tv/playback-common-actions.harness.svelte`.
	 */
	import NowPlayingHero from './NowPlayingHero.svelte';

	interface Props {
		controlsSummary?: string | null;
		/** Idle-room arm: the disclosure must not render when there is no song to adjust. */
		hasSong?: boolean;
		singerName?: string | null;
		title?: string;
	}
	let {
		controlsSummary = null,
		hasSong = true,
		singerName = 'Maya',
		title = 'Bohemian Rhapsody'
	}: Props = $props();
</script>

<NowPlayingHero
	{title}
	{singerName}
	singerColor="#5cb8ff"
	byline="Queen Official · G major"
	elapsedSec={30}
	durationSec={120}
	isPlaying
	{hasSong}
	{controlsSummary}
>
	{#snippet controls()}
		<div class="stub-controls">
			<!-- A range input stands in for GuidingTrack: XR-PH-15's constraint is about where a range
			     input may live, so the stand-in has to actually be one. -->
			<input type="range" aria-label="Guide vocals" />
		</div>
	{/snippet}
</NowPlayingHero>
