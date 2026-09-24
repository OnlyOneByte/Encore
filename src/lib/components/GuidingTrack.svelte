<script lang="ts">
	import { Slider } from '$lib/components/ui/slider';
	import * as Field from '$lib/components/ui/field';
	// The GUIDING TRACK control — how loud the original vocals sit under the instrumental. PRESENTATIONAL: throttling,
	// the websocket command and the override-versus-room-default resolution belong to the caller, because those are room
	// state. It must stay in the sheet's BODY: a range input inside a drag surface fights the sheet's own gesture.
	interface Props {
		/** The level currently shown, 0..100. */
		pct: number;
		/** Does this song have an isolated vocals stem to mix? */
		available: boolean;
		oninput?: (pct: number) => void;
		oncommit?: (pct: number) => void;
	}
	let { pct, available, oninput, oncommit }: Props = $props();

	const shown = $derived(Math.max(0, Math.min(100, Math.round(pct))));
	const valueLabel = $derived(!available || shown === 0 ? 'Off' : `${shown}%`);
</script>

<div class="gt" class:disabled={!available}>
	<!--
		The label row is the Field primitive's `data-inline` hook, which supplies the flex row, the top rhythm and the dim
		ink. `.lab` KEEPS its own typography rather than handing the text to the primitive: the primitive's label type is
		larger than this uppercase EYEBROW, which would make the label bigger than the value it labels. It sits on a plain
		span this file renders, because a scoped rule cannot reach a class handed to a component.
	-->
	<Field.Label data-inline for="guiding-track">
		<span class="lab">Guiding track</span>
		<span class="gt-val">{valueLabel}</span>
	</Field.Label>
	<Slider
		id="guiding-track"
		variant="guiding"
		type="single"
		min={0}
		max={100}
		step={1}
		value={shown}
		disabled={!available}
		aria-label="Guiding track — original vocal level"
		onValueChange={(v) => oninput?.(v)}
		onValueCommit={(v) => oncommit?.(v)}
	/>
</div>

<style>
	.gt {
		/* NO top margin: the Field label supplies the same rhythm that separates one settings control from the next. */
		margin: 0 0 var(--space-3xs);
	}
	/*
	 * DISABLED DIMS BY TOKEN, never by an opacity on this wrapper: an alpha here flattens the whole subtree against the
	 * page and drops the eyebrow under AA, and contrast.test.ts's ancestor-opacity ban does not reach it because that arm
	 * scopes itself to card ROOTS. `class:disabled` is the anchor a measured probe reads this state by, so it must stay.
	 */
	.gt.disabled .gt-val {
		color: var(--ink-dim);
	}
	.lab {
		font-size: var(--ph-text-2xs);
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	.gt-val {
		/* The label row is a plain flex row with exactly two children, so the value pushes itself right. */
		margin-left: auto;
		font-size: var(--ph-text-sm);
		font-weight: 700;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
</style>
