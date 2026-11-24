<script lang="ts">
	/*
	 * A LOADING LIST, shaped like the rows it stands in for: a thumbnail block beside two lines of text, so the
	 * arriving content does not reflow the column it replaces. `/` and `/library` declared this identically — markup
	 * and both CSS rules byte for byte — differing only in how many rows and what the wait is called.
	 *
	 * IT OWNS `role="status"`, and that is the load-bearing part rather than the shapes. `aria-busy` on a plain
	 * container announces nothing, and `aria-label` on a roleless `<div>` is PROHIBITED and silently discarded — so
	 * both call sites used to ship a label that reached nobody while reading as coverage. With the role here, the
	 * label counts and the wait is actually announced, once, from one place.
	 *
	 * NOT used by `/song/[mediaId]`, which hand-rolls a different shape (three bare lines, no thumbnail) because it
	 * stands in for a fact list rather than a row list. Forcing it through here would change how that page looks.
	 */
	import { Skeleton } from '$lib/components/ui/skeleton';

	let {
		/** How many placeholder rows. Matched to what the surface typically shows, not to a guess at the response. */
		count = 3,
		/** What is being waited for, in words — this is the announcement, so it names the ACT ("Searching…"). */
		label,
		/** Stands in for SongRow's flat rows: no card, no thumbnail. */
		flat = false
	}: { count?: number; label: string; flat?: boolean } = $props();
</script>

<!-- Keyed by index, which is the exception the rule allows: the "items" are placeholders of a fixed length that never
	reorder, so the index IS their stable identity. -->
<div class="skels" role="status" aria-busy="true" aria-label={label}>
	{#each Array.from({ length: count }, (_, i) => i) as i (i)}
		<!-- THE ROW'S GEOMETRY IS COMPOSED, NEVER RE-DECLARED: a local copy of `.card` + `.list-row` once drifted 2px off
			the rows it stood in for. `flat` mirrors SongRow's `.row.flat` box. -->
		<div class={['list-row', { card: !flat, flat }]}>
			{#if !flat}<Skeleton variant="thumb" />{/if}
			<div class="skel-text">
				<Skeleton />
				<Skeleton variant="line-short" />
			</div>
		</div>
	{/each}
</div>

<style>
	.skels {
		display: flex;
		flex-direction: column;
	}
	/* Two bars in the space the row gives its title and byline. The ROW's box is not described here at all — see the
	   composed classes on the element above, and the thumb variant, which reads the row frame's own tokens. */
	/* SongRow's `.row.flat` box. */
	.flat {
		margin: 0;
		padding: var(--step-8) 0;
		min-height: 64px;
		border-bottom: 1px solid var(--role-rule);
	}
	.skel-text {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}
</style>
