<script lang="ts">
	import FieldSlider from '$lib/ui/FieldSlider.svelte';
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

<div class={['gt', { disabled: !available }]}>
	<!--
		The label row is the Field primitive's `data-inline` hook, which supplies the flex row, the top rhythm and the dim
		ink. The label TEXT overrides NOTHING: the register follows what the label LABELS — a slider — and the element it
		sits in says the same thing, a real `[data-slot='field-label']`. Neither test is the row's SHAPE. So the dress is
		`--ph-text-md` (0.9rem, 14.4px against body's `font-size: 100%`), weight 500, sentence case, `--ink-dim`, out of
		label.svelte plus field-label.svelte.
		It WAS a `<span class="lab">` at `--ph-text-xs` (12px), uppercase, 0.1em tracking, which is THE SECTION REGISTER IN
		THIS APP (`.grouphead` over a list of rows, the `eyebrow` button variant over a disclosure). app.css's
		`.control-label` records what that swap costs — settings' You card held both dresses across one 8px card gap, a
		field label reading as a heading — and /settings labels THIS KNOB at room scope (`for="guide-default"`) as
		`Guiding track · <n>%` in the primitive's own dress, so the per-song override now reads as the same control.
		The retired comment's arithmetic was sound: the primitive's type IS larger than that eyebrow, so the label would
		have outsized the value it labels. The answer is the VALUE's rung, not the label's — `.gt-val` moved
		`--ph-text-sm` -> `--ph-text-md` (13.12px -> 14.4px) below, which costs no height because the label's own text
		already sets the row's tallest line box at that rung. Rank is carried by weight (700 over 500) and ink (`--ink`
		over `--ink-dim`) — and ink alone is what the disabled rule below moves, so the two states cannot collide.
		`for` BINDS NOTHING here, and is kept only as the id pairing a reader expects: bits-ui's slider root is a
		`<span>` (its `slider.svelte`), and `<label for>` binds labelable elements only, so the name the thumb announces
		comes from FieldSlider's attachment instead. That file's header carries the full account.
	-->
	<Field.Label data-inline for="guiding-track">
		Guiding track
		<span class="gt-val">{valueLabel}</span>
	</Field.Label>
	<FieldSlider
		id="guiding-track"
		variant="guiding"
		type="single"
		min={0}
		max={100}
		step={1}
		value={shown}
		disabled={!available}
		label="Guiding track — original vocal level"
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
	 * page and drops the label's dim ink under AA. `class:disabled` is the anchor a measured probe reads this state by
	 * (`.gt.disabled` in tests/playwright/world/selectors.ts), so it must stay.
	 */
	.gt.disabled .gt-val {
		color: var(--ink-dim);
	}
	.gt-val {
		/* The label row is a plain flex row with exactly two items — the label's own text and this span — so the value
		   pushes itself right. `.gt-val` is also `SEL.guideReadout` in tests/playwright/world/selectors.ts, so the class
		   stays whatever the dress does. ONE RUNG WITH THE LABEL (`--ph-text-md`), never under it: the label is the
		   primitive's and cannot come down, and a reading smaller than the word labelling it inverts the rank. */
		margin-left: auto;
		font-size: var(--ph-text-md);
		font-weight: 700;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
</style>
