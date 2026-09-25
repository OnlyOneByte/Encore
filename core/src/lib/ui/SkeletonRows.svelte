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
		label
	}: { count?: number; label: string } = $props();
</script>

<!-- Keyed by index, which is the exception the rule allows: the "items" are placeholders of a fixed length that never
	reorder, so the index IS their stable identity. -->
<div class="skels" role="status" aria-busy="true" aria-label={label}>
	{#each Array.from({ length: count }, (_, i) => i) as i (i)}
		<div class="skel-row">
			<Skeleton variant="thumb" />
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
	/* The row's own surface, matching `.card` + `.list-row` geometry so the placeholder occupies what the real row
	   will. Declared rather than composed from those primitives, because a skeleton takes no hover or state colour. */
	.skel-row {
		display: flex;
		align-items: center;
		gap: var(--space-lg);
		padding: var(--space-lg) var(--space-xl);
		margin-bottom: var(--space-sm);
		border-radius: var(--radius-sm);
		background: var(--card);
		border: 1px solid var(--line);
	}
	.skel-text {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}
</style>
