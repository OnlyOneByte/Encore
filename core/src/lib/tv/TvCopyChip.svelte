<script lang="ts" module>
	/** A copy's line: true while the seat's screen is live, and honest while it is gone (`tv:seat`'s `tvOnline`). */
	export function copyLine(tvOnline: boolean): string {
		return tvOnline ? 'Another screen is the TV' : 'The TV is reconnecting...';
	}
</script>

<script lang="ts">
	/* ONE TV PER ROOM: shown on a `/tv` that is a COPY (another screen holds the room's seat). The copy shows the same
	   stage, muted and sending no telemetry; one tap here makes this screen the TV. See docs/SERVER.md#the-tv-seat. */
	import Icon from '$lib/ui/Icon.svelte';

	let { onclaim, tvOnline }: { onclaim: () => void; tvOnline: boolean } = $props();
</script>

<div class="copy-chip">
	<!-- No live region here: the page's own (mounted empty with the page) announces every seat change. -->
	<span class="copy-line"><Icon name="volume-off" /> {copyLine(tvOnline)}</span>
	<button type="button" class="copy-claim" onclick={onclaim}>Make this the TV</button>
</div>

<style>
	.copy-chip {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: var(--tv-space-3xs);
		/* Never wider than the slot the page gives it: at 320 the sentence wraps instead of leaving the screen. */
		max-width: 100%;
		padding: var(--tv-space-2xs) var(--tv-space-lg);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-xl);
		background: var(--scrim-strong);
		color: var(--ink);
		font-size: var(--tv-small);
	}
	.copy-line {
		display: inline-flex;
		align-items: center;
		gap: var(--tv-space-3xs);
		color: var(--ink-dim);
	}
	.copy-claim {
		padding: var(--tv-space-3xs) var(--tv-space-lg);
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-pill);
		background: color-mix(in srgb, var(--accent2) 18%, transparent);
		color: var(--ink);
		font: inherit;
		font-weight: 700;
		white-space: nowrap;
		cursor: pointer;
	}
	/* A phone reading along: phone type and a rung less side padding, so the button stays one line inside the slot
	   even at 320. The sentence may wrap; the button may not. */
	@media (max-aspect-ratio: 1/1) {
		.copy-chip {
			font-size: var(--ph-text-sm);
		}
		.copy-chip,
		.copy-claim {
			padding-inline: var(--tv-space-2xs);
		}
	}
</style>
