<script lang="ts">
	/*
	 * Test harness for NowPlayingDrawer's rendered content. Not shipped; it sits beside its test.
	 *
	 * There is no open state to drive — the band and the drawer are ONE permanently-mounted sheet with two snap
	 * points, so `open` defaults true and the content is in the document from mount. What a test places instead is
	 * `activeSnapPoint`, which does NOT change which elements are MOUNTED: a snap-pointed sheet keeps its whole body
	 * in the document and translates it below the fold, so `'80px'` renders the same tree as the open snap. Which of
	 * the two is on SCREEN is a transform offset, measured in `tests/e2e/probes/`.
	 */
	import type { ComponentProps } from 'svelte';
	import NowPlayingDrawer from '$lib/components/NowPlayingDrawer.svelte';

	interface Props extends Omit<ComponentProps<typeof NowPlayingDrawer>, 'activeSnapPoint'> {
		/**
		 * Where to place the sheet: `'80px'` (collapsed to the band) or the open fraction. vaul's own values — it
		 * identifies a snap point by VALUE, not index. Snap 1 is DERIVED in the component as
		 * `min(0.82, (vh - 176) / vh)`, so `0.82` is its ceiling, which is all a placement needs.
		 */
		activeSnapPoint?: number | string | null;
	}
	let { activeSnapPoint = 0.82, ...rest }: Props = $props();
</script>

<NowPlayingDrawer bind:activeSnapPoint={activeSnapPoint} {...rest} />
