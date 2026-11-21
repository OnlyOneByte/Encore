<script module lang="ts">
	/** With no tap for this long the tray gives the strip back to the transport. */
	export const CHEER_TRAY_MS = 6_000;
</script>

<script lang="ts">
	/* THE ONE THING THE AUDIENCE'S PHONE CAN DO WHILE SOMEONE ELSE SINGS THAT CANNOT INTERFERE WITH THE SONG. Every
	   other control on the dock moves the playhead; these only reach the TV, as a disc rising up its right edge.
	   The strip shows this tray IN ITS OWN ROW, in place of the title and transport, when the guest taps the Cheer
	   key: four reactions and ✕, one var(--tap) tall like the row it replaces, so the dock never changes height. */
	import { REACTIONS, type ReactionKind } from '$lib/contract';
	import Icon from '$lib/ui/Icon.svelte';
	import ReactionGlyph from '$lib/ui/ReactionGlyph.svelte';

	let {
		singerName,
		onreact,
		onclose
	}: { singerName: string | null; onreact: (kind: ReactionKind) => void; onclose: () => void } = $props();

	function send(kind: ReactionKind) {
		// The same 8 ms tick /queue and /library give a tap that changes nothing on this screen.
		if (navigator.vibrate) navigator.vibrate(8);
		onreact(kind);
	}

	/* FOCUS MOVES IN ON OPEN: the tray mounts in place of the Cheer key that was just tapped, and that key's focus
	   would otherwise fall to <body>. Found inside its own bound root, so it depends on nothing in the page. */
	let tray = $state<HTMLElement | undefined>();
	$effect(() => tray?.querySelector('button')?.focus());
</script>

<div class="cheers rise-in" role="group" aria-label="Cheer for {singerName ?? 'the singer'}" bind:this={tray}>
	{#each REACTIONS as r (r.id)}
		<button class="cheer" onclick={() => send(r.id)} aria-label={r.label}>
			<span class="pic"><ReactionGlyph kind={r.id} /></span>
		</button>
	{/each}
	<button class="close" onclick={onclose} aria-label="Close">
		<Icon name="close" />
	</button>
</div>

<style>
	/* Fills the strip's row; ✕ is one tap square, the four reactions share the rest. */
	.cheers {
		flex: 1 1 auto;
		min-width: 0;
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr)) var(--tap);
		gap: var(--space-xs);
		align-items: center;
	}

	.cheer,
	.close {
		height: var(--tap);
		display: grid;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: var(--radius-pill);
		background: var(--card2);
		color: var(--ink);
	}

	.pic {
		width: calc(var(--tap) / 2);
		height: calc(var(--tap) / 2);
	}

	@media (prefers-reduced-motion: no-preference) {
		/* A press is a transform, so it touches no layout. */
		.cheer {
			transition: transform var(--motion-fast) ease-out;
		}
		.cheer:active {
			transform: scale(0.9);
		}
	}
</style>
