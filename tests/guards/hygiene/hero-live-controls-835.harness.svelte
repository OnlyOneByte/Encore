<script lang="ts">
	/*
	 * Test harness for the hero's LIVE controls and their honest degradation (XR-PH-15).
	 *
	 * It exists for the same reason `phone-home-832.harness.svelte` does: the controls arrive as a
	 * SNIPPET prop, and building one in the test file exercises a different code path
	 * (`createRawSnippet` from the bare `svelte` specifier resolves to the SERVER runtime under
	 * `bun test`). So the snippet is real markup here, the way `+page.svelte` passes it.
	 *
	 * The difference from the harness is deliberate: this one mounts the REAL
	 * `GuidingTrack` rather than a stand-in range input, because the claim under test is about the
	 * relationship between the disabled control and the sentence explaining it — that the sentence is
	 * NOT inside the subtree `.gt.disabled` dims with `opacity` (XR-PH-03). A stub cannot carry that.
	 *
	 * Not shipped: nothing in the app imports it.
	 */
	import GuidingTrack from '$lib/components/GuidingTrack.svelte';
	import NowPlayingHero from '$lib/components/NowPlayingHero.svelte';

	interface Props {
		/** Does the playing song have an isolated vocals stem? False is the degraded arm. */
		available?: boolean;
		/** The sentence the route derives; null when there is nothing to explain. */
		controlsNote?: string | null;
		controlsSummary?: string | null;
		hasSong?: boolean;
	}
	let { available = false, controlsNote = null, controlsSummary = null, hasSong = true }: Props = $props();
</script>

<NowPlayingHero
	title="Bohemian Rhapsody"
	singerName="Maya"
	singerColor="#5cb8ff"
	byline="Queen Official · G major"
	elapsedSec={30}
	durationSec={120}
	isPlaying
	hasSong={hasSong}
	controlsSummary={controlsSummary}
	controlsNote={controlsNote}
>
	{#snippet controls()}
		<GuidingTrack pct={0} available={available} oninput={() => {}} oncommit={() => {}} />
	{/snippet}
</NowPlayingHero>
