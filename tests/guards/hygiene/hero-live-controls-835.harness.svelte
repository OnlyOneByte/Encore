<script lang="ts">
	/*
	 * Test harness for the now-playing drawer's LIVE controls and their honest degradation (XR-PH-15).
	 *
	 * WHAT IT USED TO BE, AND WHY THAT REASON IS GONE. This harness wrapped `NowPlayingHero` and
	 * existed for one measured reason: the hero took its controls as a SNIPPET prop, and building a
	 * snippet inside a `.test.ts` file exercises a different code path (`createRawSnippet` from the
	 * bare `svelte` specifier resolves to the SERVER runtime under `bun test`). `NowPlayingDrawer`
	 * takes NO snippet — it renders `GuidingTrack`, the key row and the range itself — so that
	 * justification does not survive the move.
	 *
	 * WHY IT SURVIVES ANYWAY, with a different job: it owns the EXPAND AFFORDANCE. The drawer's `open`
	 * is `$bindable`, and in the app it is raised from outside — `+layout.svelte` holds `drawerOpen`
	 * and the band's `onexpand` sets it. Mounting the drawer with `open: true` from a test would
	 * exercise a path the app never takes (born-open), so the button below stands in for the band's
	 * pull handle and the drawer is opened the way it is really opened: mounted closed, then flipped.
	 * That distinction is the whole subject of the boundary arm in the test file.
	 *
	 * The fixture is a song that HAS a title and a length but NO isolated vocals stem, because that is
	 * XR-PH-15's degraded arm — `guideEnabled` defaults false here on purpose.
	 *
	 * Not shipped: nothing in the app imports it.
	 */
	import NowPlayingDrawer from '$lib/components/NowPlayingDrawer.svelte';

	interface Props {
		/** Is a song playing? False is the idle arm, where no live control is owed at all. */
		hasSong?: boolean;
		/** Does the playing song have an isolated vocals stem? False is the degraded arm. */
		guideEnabled?: boolean;
	}
	let { hasSong = true, guideEnabled = false }: Props = $props();

	/*
	 * Closed at mount, exactly as the app mounts it. `+layout.svelte` declares `let drawerOpen =
	 * $state(false)` and only the band's `onexpand` moves it.
	 */
	let open = $state(false);
</script>

<!--
	The band's `onexpand`, reduced to the one thing this harness needs from it. Not a `Drawer.Trigger`:
	the app has no trigger inside the drawer either — the band is a SIBLING that raises the intent, and
	a trigger here would test a composition the app does not ship.
-->
<button data-testid="expand" onclick={() => (open = true)}>expand</button>

<NowPlayingDrawer
	bind:open={open}
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
