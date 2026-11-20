<script lang="ts">
	/* The four reaction pictures, shared by the phone row and the TV lane so both draw the same thing. Bundled Noto
	   Emoji artwork (src/lib/assets/reactions/README.md), not emoji text: a TV with no emoji font drew empty boxes. */
	import type { ReactionKind } from '$lib/contract';
	import clap from '$lib/assets/reactions/clap.svg';
	import fire from '$lib/assets/reactions/fire.svg';
	import laugh from '$lib/assets/reactions/laugh.svg';
	import heart from '$lib/assets/reactions/heart.svg';

	const SRC: Record<ReactionKind, string> = { clap, fire, laugh, heart };

	let { kind }: { kind: ReactionKind } = $props();
</script>

<!-- Decorative: the button or the lane around it carries the name. -->
<img class="glyph" src={SRC[kind]} alt="" draggable="false" />

<style>
	.glyph {
		display: block;
		width: 100%;
		height: 100%;
	}
</style>
