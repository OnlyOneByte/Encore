<script lang="ts">
	/*
	 * Test harness for NowPlayingDrawer's rendered content.
	 *
	 * WHY IT STILL EXISTS, AFTER ITS ORIGINAL TWO REASONS BOTH WENT AWAY. It first existed because the
	 * thing under test was a SNIPPET prop (`controls`), and the route passed it as a `{#snippet}` block
	 * in markup — building one in the test file instead would have exercised a different code path.
	 * NowPlayingDrawer takes no snippet: it renders the guiding track, the key row, the range
	 * visualizer and lyrics re-selection itself, from props. It then existed for OPEN STATE, and flipped
	 * `open` false -> true in an `$effect` so every test drove the real closed -> open transition the
	 * band triggered.
	 *
	 * BOTH REASONS ARE GONE, AND THE SECOND ONE DID NOT SURVIVE AS A NAME CHANGE. The band and the
	 * drawer are ONE permanently-mounted sheet with two snap points now, so there is no closed state
	 * and no transition: `open` defaults true, never changes, and the content is in the document from
	 * mount. An `openOnMount` prop modelled a state the component no longer has, which is worse than no
	 * harness — it would have kept reading as though a closed arm were being exercised.
	 *
	 * WHAT REPLACES IT IS THE SNAP POINT. `activeSnapPoint` is the only handle anything has on
	 * collapsed-versus-pulled-up: `'80px'` is the band strip alone on screen, `0.82` is the sheet pulled
	 * up. It is a `$bindable` the app OWNS (vaul writes it back on every drag), so this harness owns it
	 * the same way and a test can place the sheet by passing a value in.
	 *
	 * WHAT A SNAP POINT DOES **NOT** CHANGE, and the test file says this at the one arm that depends on
	 * it: which elements are MOUNTED. A snap-pointed sheet keeps its whole body in the document and
	 * translates it below the fold, so placing the sheet at `'80px'` renders exactly the same tree as
	 * `0.82`. Which of the two is on SCREEN is a transform offset — a LAYOUT-rung claim (XR-VER-01),
	 * measured in `tests/e2e/probes/`, not here.
	 *
	 * Not shipped: nothing in the app imports it. It sits beside its test, mirroring
	 * `lib/tv/playback-common-actions.harness.svelte`.
	 */
	import type { ComponentProps } from 'svelte';
	import NowPlayingDrawer from '$lib/components/NowPlayingDrawer.svelte';

	interface Props extends Omit<ComponentProps<typeof NowPlayingDrawer>, 'activeSnapPoint'> {
		/**
		 * Where to place the sheet: `'80px'` (collapsed to the band) or `0.82` (pulled up). The values are
		 * vaul's own — it identifies a snap point by VALUE, not by index — so a test passes the same
		 * literals `NowPlayingDrawer`'s `snapPoints` array carries.
		 */
		activeSnapPoint?: number | string | null;
	}
	let { activeSnapPoint = 0.82, ...rest }: Props = $props();
</script>

<NowPlayingDrawer bind:activeSnapPoint {...rest} />
