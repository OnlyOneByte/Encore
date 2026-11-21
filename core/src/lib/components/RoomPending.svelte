<!-- THE TAB BEFORE THE PHONE KNOWS IT IS IN THE ROOM: grey rows where the tab's list will be, and no join form,
	because only a 401 from /api/me proves a guest is out (`RoomLink.status`). After UNREACHABLE_AFTER_MS of asking it
	says so above the rows — still asking, and the tab fills in by itself when the party answers. -->
<script lang="ts">
	import SkeletonRows from '$lib/ui/SkeletonRows.svelte';
	import Icon from '$lib/ui/Icon.svelte';

	let { unreachable }: { unreachable: boolean } = $props();
</script>

<div class="pending" data-room-pending>
	<!-- MOUNTED EMPTY, and only its text arrives: a screen reader often stays silent for a live region inserted with its
		words already in it. Its two lines' height is RESERVED, so the rows below do not step down when they fill in. -->
	<div class="unreachable" role="status">
		<p class="title">
			{#if unreachable}<Icon name="warning" /> Can't reach the party. Trying again…{/if}
		</p>
		<p class="hint">
			{#if unreachable}Check you're on the party Wi-Fi.{/if}
		</p>
	</div>
	<SkeletonRows count={4} label="Checking you're in the room…" />
</div>

<style>
	.pending {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		/* No padding of its own: each tab renders it inside its own `main`, so the rows sit where the tab's rows will. */
	}
	.unreachable {
		display: flex;
		flex-direction: column;
		gap: var(--space-2xs);
	}
	/* Two lines for the title, because it wraps on a phone, and one for the hint: the most the message ever takes. */
	.title {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		margin: 0;
		min-height: 2lh;
		color: var(--warn);
		font-size: var(--ph-text-base);
		font-weight: 600;
	}
	.hint {
		margin: 0;
		min-height: 1lh;
		color: var(--muted-foreground);
		font-size: var(--ph-text-sm);
	}
</style>
