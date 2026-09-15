<script lang="ts">
	/*
	 * Test harness for NowPlayingDrawer's rendered content.
	 *
	 * WHY IT STILL EXISTS, AFTER ITS ORIGINAL REASON WENT AWAY. It used to exist because the thing
	 * under test was a SNIPPET prop (`controls`), and the route passed it as a `{#snippet}` block in
	 * markup — building one in the test file instead would have exercised a different code path.
	 * NowPlayingDrawer takes no snippet: it renders the guiding track, the key row, the range
	 * visualizer and lyrics re-selection itself, from props. So that reason is gone.
	 *
	 * What replaces it is OPEN STATE. A drawer renders its content only while open, and `open` is a
	 * `$bindable` the app OWNS (`+layout.svelte` holds `drawerOpen` and the band's `onexpand` flips
	 * it). This harness owns it the same way, and flips it from false to true in an `$effect` after
	 * mount rather than handing `open: true` straight to the component — so every test drives the real
	 * closed -> open transition the band triggers, and `openOnMount: false` gives the CLOSED arm a
	 * subject (a closed drawer must render nothing at all, which is the assertion that carries the old
	 * "collapsed disclosure hides its controls" guarantee — see the test file).
	 *
	 * Not shipped: nothing in the app imports it. It sits beside its test, mirroring
	 * `lib/tv/playback-common-actions.harness.svelte`.
	 */
	import type { ComponentProps } from 'svelte';
	import NowPlayingDrawer from '$lib/components/NowPlayingDrawer.svelte';

	interface Props extends Omit<ComponentProps<typeof NowPlayingDrawer>, 'open'> {
		/** false leaves the drawer CLOSED, which is the arm that asserts nothing renders. */
		openOnMount?: boolean;
	}
	let { openOnMount = true, ...rest }: Props = $props();

	let open = $state(false);
	$effect(() => {
		if (openOnMount) open = true;
	});
</script>

<NowPlayingDrawer bind:open {...rest} />
