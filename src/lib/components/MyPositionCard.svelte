<script lang="ts">
	/*
	 * The guest's own place in the rotation, in WORDS (XR-PH-09).
	 *
	 * "3rd — you're up after Sam, roughly 11 minutes" is direction A's core promise, and the reason it
	 * is a component rather than a string in the route is the DEGRADATION: the minutes clause is a
	 * claim, and a wrong one in a shared room is witnessed by everybody in it. So `words.wait` is
	 * `null` whenever any entry ahead has no resolvable length, and this card renders NOTHING in its
	 * place — no zero, no guess, no "calculating…" that never resolves.
	 *
	 * The ordinal is the lead numeral, matching the ratified mockup. It is NOT aria-hidden: "3rd" read
	 * before the sentence is exactly how the sentence is meant to start.
	 */
	import type { PositionWords } from '$lib/position-sentence';

	interface Props {
		/** The built sentence parts, or null when the guest has nothing queued (renders nothing). */
		words: PositionWords | null;
	}
	let { words }: Props = $props();
</script>

{#if words}
	<section class="mine card" aria-label="Your place in the queue">
		<span class="big">{words.ordinal}</span>
		<span class="lbl">
			<span class="lead">{words.lead}</span>
			<!-- The wait is a SEPARATE line and a separate element, so its absence is the absence of a
			     line rather than an empty span holding open a gap that reads as a missing value. -->
			{#if words.wait}<span class="wait">{words.wait}</span>{/if}
		</span>
	</section>
{/if}

<style>
	/* Surface, radius and border come from .card in app.css; the accent tint marks it as YOURS, the
	   same signal QueueRow's `.mine` uses, and for the same reason. */
	.mine {
		display: flex;
		align-items: center;
		gap: var(--space-lg);
		padding: var(--space-md) var(--space-xl);
		margin: 0 0 var(--space-md);
		border-color: var(--line-tint);
		background: linear-gradient(var(--card), var(--card-tint));
	}
	.big {
		flex: 0 0 auto;
		font-size: var(--ph-text-2xl);
		font-weight: 800;
		/* --accent2, NOT --accent. The mockup draws this numeral in the violet accent, but --accent
		   exists to be a BACKGROUND carrying --on-accent: as text it measures 3.38:1 on --card, under
		   AA. (The old --accent-strong was worse still at 3.52:1 and is now retired — XR-COL-11 —
		   so there is no darkened sibling to reach for either.) --accent2 is the family's text-safe
		   member and already this route's text accent (.range-peek, .browse-active): MEASURED 6.05:1 on
		   --card and 5.92:1 on the --card-tint this gradient ends at. */
		color: var(--accent2);
		font-variant-numeric: tabular-nums;
	}
	.lbl {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
		font-size: 0.82rem;
	}
	.lead {
		color: var(--ink);
	}
	/* Dimmed by TOKEN, never by opacity on the subtree (XR-PH-03): --ink-dim is a measured pair with
	   the card surface, where an alpha would composite against whatever sits behind it. */
	.wait {
		color: var(--ink-dim);
	}
</style>
