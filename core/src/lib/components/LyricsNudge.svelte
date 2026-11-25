<script lang="ts">
	// The host's whole-song nudge (proposal 32): Earlier and Later move every line on the TV at once, live, with no
	// re-time. Each tap sends the whole value, one request at a time, so a fast run of taps lands on the last one.
	import { LYRICS_OFFSET_STEP_MS, MAX_LYRICS_OFFSET_MS } from '$lib/contract';
	import { Button } from '$lib/components/ui/button';

	interface Props {
		/** The nudge as stored, in ms; negative shows the words earlier. */
		offsetMs: number;
		/** Store a nudge: the value as stored, or null when it did not land. */
		send: (offsetMs: number) => Promise<number | null>;
	}
	let { offsetMs, send }: Props = $props();

	let stored = $state(0);
	let shown = $state(0);
	let busy = false;
	let wanted: number | null = null;
	// Follow the page's value unless a tap is in flight, which would otherwise be pulled back mid-run.
	$effect(() => {
		const next = offsetMs;
		if (!busy && wanted === null) stored = shown = next;
	});

	async function move(step: number) {
		const next = Math.max(-MAX_LYRICS_OFFSET_MS, Math.min(MAX_LYRICS_OFFSET_MS, shown + step));
		if (next === shown) return;
		shown = wanted = next;
		if (busy) return;
		busy = true;
		while (wanted !== null) {
			const target: number = wanted;
			wanted = null;
			const landed = await send(target);
			if (landed === null) {
				wanted = null;
				shown = stored;
				break;
			}
			stored = landed;
			if (wanted === null) shown = landed;
		}
		busy = false;
	}

	const seconds = (ms: number) => String(Number((Math.abs(ms) / 1000).toFixed(2)));
	const label = $derived(shown === 0 ? 'Words as timed' : `Words ${seconds(shown)} s ${shown < 0 ? 'early' : 'late'}`);
</script>

<!-- A div: the page's own "Timing" section names this region. -->
<div class="nudge card">
	<p class="value" role="status" aria-live="polite">{label}</p>
	<p class="hint">Watch the TV and move the words until they land.</p>
	<!-- aria-disabled, not disabled, at the limit: a disabled button drops the focus it holds (move() no-ops there). -->
	<div class="steps">
		<Button
			variant="keycap"
			aria-disabled={shown <= -MAX_LYRICS_OFFSET_MS}
			onclick={() => void move(-LYRICS_OFFSET_STEP_MS)}>Earlier</Button
		>
		<Button
			variant="keycap"
			aria-disabled={shown >= MAX_LYRICS_OFFSET_MS}
			onclick={() => void move(LYRICS_OFFSET_STEP_MS)}>Later</Button
		>
	</div>
</div>
<p class="note">Every line moves together. To fix one line, fix its words above; Encore times them again.</p>

<style>
	/* Surface, radius and border come from .card in app.css. */
	.nudge {
		padding: var(--space-lg) var(--space-2xl);
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		text-align: center;
	}
	.value {
		margin: 0;
		font-size: var(--ph-text-2xl);
		font-weight: 700;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
	.hint,
	.note {
		margin: 0;
		font-size: var(--ph-text-xs);
		line-height: var(--lh-normal);
		color: var(--ink-dim);
	}
	.steps {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-md);
	}
	/* The keycap's own inert look (dashed, dim), which it keys on `:enabled` and so would not show here. */
	.steps :global([aria-disabled='true']) {
		border-style: dashed;
		border-color: var(--line-strong);
		color: var(--ink-dim);
	}
	.note {
		margin: var(--space-sm) var(--space-2xs) 0;
	}
</style>
