<script lang="ts">
	/*
	 * Test harness for the now-playing drawer's LIVE controls and their honest degradation.
	 *
	 * WHAT IT USED TO BE, AND WHY BOTH OF ITS REASONS ARE GONE. It first wrapped `NowPlayingHero` for one
	 * measured reason: the hero took its controls as a SNIPPET prop, and building a snippet inside a
	 * `.test.ts` file exercises a different code path (`createRawSnippet` from the bare `svelte`
	 * specifier resolves to the SERVER runtime under `bun test`). `NowPlayingDrawer` takes no snippet —
	 * it renders `GuidingTrack`, the key row and the range itself — so that justification died with the
	 * hero. It then existed to own the EXPAND AFFORDANCE: a `data-testid="expand"` button standing in
	 * for the band's `onexpand`, so a test opened the drawer the way the app did (mounted closed, then
	 * flipped) rather than the way the app never did (born open).
	 *
	 * THAT SECOND REASON DID NOT SURVIVE AS A RENAME, IT INVERTED. The band and the drawer are ONE
	 * permanently-mounted sheet with two snap points now. `open` defaults TRUE, `+layout.svelte` has no
	 * `drawerOpen` and the band has no `onexpand`, so born-open is not a path the app never takes — it
	 * is the ONLY path. A button flipping `open` false → true modelled a transition the component no
	 * longer has, which is worse than no harness: it would keep reading as though a closed arm were
	 * being exercised when no closed arm exists.
	 *
	 * WHAT REPLACES IT IS THE SNAP POINT, PASSED IN. `activeSnapPoint` is the only handle anything has
	 * on collapsed-versus-pulled-up — `'80px'` is the band strip alone, a fraction near `0.82` is the
	 * sheet pulled up —
	 * and it is a `$bindable` the app OWNS, because vaul writes it back on every drag. So this harness
	 * binds it the same way and a test PLACES the sheet by passing a value, rather than by clicking an
	 * affordance. There is deliberately no button: pulling the sheet up is a DRAG that only vaul can
	 * perform, and a click-to-open button would model a gesture the app does not ship.
	 *
	 * WHY THE READOUT IS HERE, and why it is declared BEFORE the drawer. The drawer cannot be mounted on
	 * this rung at all (see the boundary arm in the test file — its own `bind:clientHeight` needs a
	 * `ResizeObserver` the mount rung refuses to install), so a test asserting the drawer's content is
	 * ABSENT needs some independent proof that the mount ran and reached the drawer. This element is it:
	 * it is created before the drawer's subtree, so it survives the drawer's throw, and it echoes the
	 * bound snap value so a test can see the placement it asked for actually arrived. It is a read-out
	 * of a bound prop, not a stand-in for an affordance.
	 *
	 * The fixture is a song that HAS a title and a length but NO isolated vocals stem, because that is
	 * the degraded arm — `guideEnabled` defaults false here on purpose.
	 *
	 * Not shipped: nothing in the app imports it.
	 */
	import NowPlayingDrawer from '$lib/components/NowPlayingDrawer.svelte';
	// The snap-0 value, IMPORTED: it was a literal '80px', and the band grew to 88 for headroom above the
	// header. vaul looks the active point up by strict string equality, so a stale literal here seats index -1.
	import { SNAP_BAND } from '$lib/sheet-snap';

	interface Props {
		/** Is a song playing? False is the idle arm, where no live control is owed at all. */
		hasSong?: boolean;
		/** Does the playing song have an isolated vocals stem? False is the degraded arm. */
		guideEnabled?: boolean;
		/**
		 * Where the sheet sits: `'80px'` (collapsed to the band) or the open fraction (pulled up). vaul's
		 * own values — it identifies a snap point by VALUE and not by index — so a test passes the values
		 * `NowPlayingDrawer`'s `snapPoints` array carries. Bound, because the component seats it itself on
		 * mount and vaul rewrites it on every drag.
		 *
		 * Snap 1 is DERIVED there rather than a literal: `min(0.82, (vh - 176) / vh)`, the clamp that keeps a
		 * pulled-up sheet off the page's own top-of-page controls on a short window. `0.82` is its ceiling,
		 * which is all a placement needs — the drawer cannot mount on this rung anyway.
		 */
		activeSnapPoint?: number | string | null;
	}
	let { hasSong = true, guideEnabled = false, activeSnapPoint = $bindable(SNAP_BAND) }: Props = $props();
</script>

<!--
	The liveness read-out. Ordered ahead of the drawer on purpose; see the header.
-->
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
