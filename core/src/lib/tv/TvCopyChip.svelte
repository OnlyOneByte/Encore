<script lang="ts" module>
	/** A copy's line: quiet while the seat's screen is live, and honest while it is gone (`tv:seat`'s `tvOnline`).
	 *  `next`: the room's TV back mid-song, which takes the seat when this song ends. */
	export function copyLine(tvOnline: boolean, next = false): string {
		if (next) return 'Back as the TV after this song';
		return tvOnline ? 'This screen is quiet' : 'The TV is reconnecting...';
	}
</script>

<script lang="ts">
	/* ONE TV PER ROOM: shown on a `/tv` that is a COPY (another screen holds the room's seat). The copy shows the same
	   stage, muted and sending no telemetry; one tap here makes this screen the TV. See docs/SERVER.md#the-tv-seat. */
	let { onclaim, tvOnline, next = false }: { onclaim: () => void; tvOnline: boolean; next?: boolean } = $props();
</script>

<div class="copy-chip">
	<!-- No live region here: the page's own (mounted empty with the page) announces every seat change. -->
	<span class="copy-line">{copyLine(tvOnline, next)}</span>
	<button type="button" class="copy-claim" onclick={onclaim}>Make this the TV</button>
</div>

<style>
	.copy-chip {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: flex-end;
		gap: var(--tv-space-2xs) var(--tv-space-lg);
		/* Never wider than the slot the page gives it: at 320 the sentence wraps instead of leaving the screen. */
		max-width: 100%;
		padding: var(--tv-space-lg) var(--tv-space-lg) var(--tv-space-lg) var(--tv-space-4xl);
		border-radius: var(--round-pill);
		background: var(--role-raise);
		color: var(--role-ink-dim);
		font-size: var(--tv-small);
		font-weight: 700;
	}
	.copy-claim {
		padding: var(--tv-space-2xs) var(--tv-space-4xl);
		border: 0;
		border-radius: var(--round-pill);
		background: var(--role-ink);
		color: var(--role-ground);
		font: inherit;
		white-space: nowrap;
		cursor: pointer;
	}
	/* A phone reading along: phone type and a rung less side padding, so the button stays one line inside the slot
	   even at 320. The sentence may wrap; the button may not. */
	@media (max-aspect-ratio: 1/1) {
		.copy-chip {
			font-size: var(--ph-text-sm);
			padding-inline: var(--tv-space-2xs);
		}
		.copy-claim {
			padding-inline: var(--tv-space-2xs);
		}
	}
</style>
