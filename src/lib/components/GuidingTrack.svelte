<script lang="ts">
	import { Slider } from '$lib/components/ui/slider';
	import * as Field from '$lib/components/ui/field';
	// The GUIDING TRACK control — how loud the original vocals sit under the instrumental.
	//
	// Presentational: it owns the label copy, the shape and the disabled state, and reports raw
	// percentages up. Throttling, the websocket command and the override-vs-room-default resolution all
	// live with the caller, because those are room state rather than anything this control knows.
	//
	// Lives in the sheet BODY on the phone rather than the peek: the peek is a pointer-drag surface for
	// the sheet itself, and a range input there fights that gesture on every drag.
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
		The shadcn migration: the label/value row is <Field.Label>, the settings page's own idiom (27 of them), reached
		with `data-inline` — the field primitive's existing hook for a label that lays out beside content
		it contains. It supplies the flex row, the `var(--space-lg)` top rhythm and `--ink-dim`, which is
		what `.gt-head` and `.lab`'s `color` used to do here.

		`.lab` KEEPS its three typographic declarations rather than handing the text straight to
		<Field.Label>. That is a role difference, not a preference: the label primitive resolves to
		`text-sm` (14px, sentence case) through ui/label, and this is an 11px uppercase EYEBROW sitting
		beside a bold readout — adopting the primitive's type would make the label larger than the value
		it labels. The declarations sit on a plain <span> this file renders, so the scoped rule reaches it
		(a class handed to <Field.Label> would not — ui-scoped-style-reach-913.test.ts).
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
	/* Track/fill reuse the 4px + gradient idiom of the sheet's seek row, so this reads as part of the
	   same surface. The app's only other range input (the interstitial slider in Settings) is left
	   native — that one sits in a form, this one sits in the performance surface next to the transport,
	   where an unstyled OS slider reads as a different application. */
	.gt {
		/* The TOP margin moved to <Field.Label>'s own `var(--space-lg)` rhythm — the same rhythm that
		   separates one settings control from the next. Keeping `var(--space-md)` here as well would
		   stack the two. */
		margin: 0 0 var(--space-3xs);
	}
	/*
	 * the disabled rail/thumb recolouring that lived here as four::-webkit-slider-* and
	 * ::-moz-range-* rules is ui/slider's `data-disabled` treatment on the guiding variant now —
	 * scoped CSS cannot reach an element a child component renders.
	 *
	 * `.gt.disabled { opacity: 0.5 }` is GONE, and that is a contrast fix rather than tidying. The
	 * wrapper's alpha flattened its whole subtree against --bg, and neither element it dimmed is the
	 * disabled control: MEASURED, `.lab` fell from 6.27:1 to 2.43:1 and `.gt-val` from 15.56:1 to
	 * 4.67:1 — the label under AA outright. contrast.test.ts's ancestor-opacity ban never reached it
	 * because that arm scopes itself to card ROOTS and `.gt` is not one, which is how this survived.
	 *
	 * The replacement is XR-PH-03's rule, the one QueueRow, ProcessingCard, MyPositionCard and
	 * RangeBar all record: dim by TOKEN, never by opacity on a subtree. The readout drops --ink →
	 * --ink-dim (6.27:1, its own measured pair with the card) and says "Off"; the CONTROL keeps its own
	 * `data-disabled:opacity-50`, which is a single leaf carrying no text, the in-repo pattern
	 * contrast.test.ts explicitly steers toward.
	 *
	 * XR-PH-03's containment claim is untouched: the reason sentence still sits OUTSIDE `.gt` entirely,
	 * on the hero (an earlier change Q1-D), and `class:disabled` remains the anchor p16 reads it by.
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
		/* What `.gt-head`'s `justify-content: space-between` used to do, from the value's own side —
		   <Field.Label data-inline> is a plain flex row, and the row has exactly these two children. */
		margin-left: auto;
		font-size: var(--ph-text-sm);
		font-weight: 700;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
</style>
