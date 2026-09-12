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
	import * as Item from '$lib/components/ui/item';

	interface Props {
		/** The built sentence parts, or null when the guest has nothing queued (renders nothing). */
		words: PositionWords | null;
	}
	let { words }: Props = $props();
</script>

{#if words}
	<!--
		The shadcn migration: <Item.Root> supplies the row GRAMMAR — the ordinal is Item.Media, the sentence is
		Item.Content — while this file keeps the row ELEMENT through Item's own `child` snippet. That is
		load-bearing twice over: the root must stay a <section> carrying `aria-label` (the ordinal is a
		bare numeral on screen, so the card names itself), and `.mine`'s tint is a scoped rule, which
		cannot reach a class handed to a component. `bare` because `.card` already paints this row.

		The root's `class` attribute stays STATIC, for the reason QueueRow records: contrast.test.ts
		derives this row's classes by splitting that attribute on whitespace, and an interpolation there
		hands it a token it then applies as a regex.

		NOT Item.Title / Item.Description for the two lines. Both are the right NAME and the wrong
		behaviour here: Item.Title is `line-clamp-1` and Item.Description `line-clamp-2`, and this card's
		first line is the promise it exists to make ("You're up after Bartholomew.") — a clamp truncates
		it on a 320px phone rather than wrapping. Both classes are also pinned by name in
		`phone-home-832.test.ts`, which queries `.big` and `.wait` on the mounted render, so each would
		need a plain inner element inside the primitive anyway.
	-->
	<Item.Root variant="bare" size="bare">
		{#snippet child({ props })}
			<section {...props} class="mine card" aria-label="Your place in the queue">
				<Item.Media><span class="big">{words.ordinal}</span></Item.Media>
				<Item.Content>
					<span class="lead">{words.lead}</span>
					<!-- The wait is a SEPARATE line and a separate element, so its absence is the absence of a
					     line rather than an empty span holding open a gap that reads as a missing value. -->
					{#if words.wait}<span class="wait">{words.wait}</span>{/if}
				</Item.Content>
			</section>
		{/snippet}
	</Item.Root>
{/if}

<style>
	/* Surface, radius and border come from .card in app.css; the accent tint marks it as YOURS, the
	   same signal QueueRow's `.mine` uses, and for the same reason.

	   `display: flex` and `align-items: center` are GONE — Item.Root's base carries both. The `gap`
	   stays: Item's `bare` size contributes none (QueueRow gets its gap from `.list-row`, which this
	   card does not wear). `font-size` moved here from `.lbl`, which Item.Content replaces; `.big` sets
	   its own, so nothing else in the subtree is affected. */
	.mine {
		gap: var(--space-lg);
		padding: var(--space-md) var(--space-xl);
		margin: 0 0 var(--space-md);
		border-color: var(--line-tint);
		background: linear-gradient(var(--card), var(--card-tint));
		font-size: 0.82rem;
	}
	.big {
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
	.lead {
		color: var(--ink);
	}
	/* Dimmed by TOKEN, never by opacity on the subtree (XR-PH-03): --ink-dim is a measured pair with
	   the card surface, where an alpha would composite against whatever sits behind it. */
	.wait {
		color: var(--ink-dim);
	}
</style>
