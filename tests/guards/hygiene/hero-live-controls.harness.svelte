<script lang="ts">
	/*
	 * Test harness for the now-playing drawer's LIVE controls and their honest degradation. Not shipped.
	 *
	 * There is deliberately NO open/expand affordance: the band and the drawer are ONE permanently-mounted sheet with
	 * two snap points and `open` defaults TRUE, so a button flipping it would model a transition the component no
	 * longer has. A test PLACES the sheet by passing `activeSnapPoint`; pulling it up is a DRAG only vaul can perform.
	 *
	 * The read-out is declared BEFORE the drawer on purpose: the drawer cannot be mounted on this rung at all, so it
	 * survives the drawer's throw and lets a test see that the placement it asked for actually arrived. The fixture
	 * is a song that HAS a title and a length but NO isolated vocals stem — the degraded arm.
	 */
	import NowPlayingDrawer from '$lib/components/NowPlayingDrawer.svelte';
	import { SNAP_BAND } from '$lib/sheet-snap';

	interface Props {
		/** Is a song playing? False is the idle arm, where no live control is owed at all. */
		hasSong?: boolean;
		/** Does the playing song have an isolated vocals stem? False is the degraded arm. */
		guideEnabled?: boolean;
		/**
		 * Where the sheet sits: `'80px'` (collapsed to the band) or the open fraction. vaul's own values — it identifies
		 * a snap point by VALUE, not index — and BOUND, because the component seats it on mount and vaul rewrites it on
		 * every drag. Snap 1 is DERIVED there as `min(0.82, (vh - 176) / vh)`, so `0.82` is its ceiling.
		 */
		activeSnapPoint?: number | string | null;
	}
	let { hasSong = true, guideEnabled = false, activeSnapPoint = $bindable(SNAP_BAND) }: Props = $props();
</script>

<output data-testid="snap">{activeSnapPoint}</output>

<NowPlayingDrawer
	bind:activeSnapPoint={activeSnapPoint}
	title="Bohemian Rhapsody"
	artist="Queen Official"
	singerName="Maya"
	singerColor="#5cb8ff"
	elapsedSec={30}
	durationSec={120}
	isPlaying
	hasSong={hasSong}
	guideEnabled={guideEnabled}
/>
