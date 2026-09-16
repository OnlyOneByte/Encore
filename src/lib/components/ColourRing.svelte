<!--
	ColourRing — the whole 48-stop palette as one circular control. The join screen's colour picker.

	WHAT IT REPLACED, AND WHY A RING. The identity pane used to carry TWO controls for one choice: eight
	preset swatches in a roving-tabindex radiogroup, plus a continuous hue slider under them. That pairing
	cost a running agreement problem (tap a swatch and the slider's thumb has to travel, or the two
	disagree about what is selected — see ColourPicker.svelte, which now demos only in the /components gallery), and
	it cut the hue circle open at an arbitrary point: on a strip, the first and last stops are neighbours
	in colour and opposite ends in space. A ring has no ends, so every stop's neighbours are its
	neighbours, and the hole in the middle is free space for the thing a strip has nowhere to put — the
	stop's NAME, its hex, and the contrast figure it was measured at.

	HUE IS STILL THE ONLY AXIS. The stops come from `variants.uniform` of the generated palette registry,
	all at OKLCH L≈0.72 — the same band the retired wheel emitted at `SINGER_L`. Lightness and chroma are
	not the guest's to choose, which is what guarantees every reachable colour is a dot that stays visible
	on the dark surfaces and stays distinguishable from the next guest's. What the registry adds over
	live arithmetic is a NAME per stop (so a screen reader says "Turquoise" rather than "21") and a
	measured contrast ratio, both of which the hub shows.

	OPERABLE WITHOUT A POINTER, which is the load-bearing half: this replaces a native `<input
	type=range>`, so nothing is inherited. It is one `role="slider"` — a single tab stop — carrying
	`aria-valuemin`/`max`/`now` over the stop index and `aria-valuetext` over the stop NAME. Arrow keys
	move one stop (Right/Up forward, Left/Down back, wrapping, because hue is cyclical), Home/End jump to
	the first and last stop, and the focus ring is drawn in `--focus`. A guest on a switch or a keyboard
	reaches every one of the 48 colours.

	PIPS ARE PEOPLE. A hollow dot on the band marks a colour somebody already in the room is holding, so
	a guest can avoid arriving as a near-twin of the singer beside them on the TV roster. They are
	INFORMATION, not a block: two singers sharing a colour is legal (the join only rejects a duplicate
	NAME), and refusing a stop the guest can see would need an explanation the ring has no room for.
-->
<script lang="ts">
	import {
		PALETTE_STOPS,
		nearestPaletteStop,
		paletteConicGradient,
		paletteRingAngle,
		paletteStopAt,
		paletteStopAtRingAngle
	} from '$lib/contract';

	interface Props {
		/** The selected colour, as a canonical hex. Bindable. Always one of the palette's 48 fills once touched. */
		value: string;
		/** Heading above the ring, and the control's accessible name. */
		label?: string;
		/** One line under the heading; omit for a compact placement. */
		hint?: string;
		/**
		 * Colours already held by people in the room, drawn as hollow pips. Empty is a legitimate state
		 * (an empty room), so there is no "unknown" case to distinguish.
		 */
		taken?: readonly string[];
	}
	let { value = $bindable(), label = 'Your color', hint = '', taken = [] }: Props = $props();

	/*
	 * The selection, derived from `value` rather than held beside it. There is no second piece of state
	 * to keep in step — the defect the two-control picker had to spend a `pickPreset` on — so the knob,
	 * the hub and the value cannot disagree by construction. `nearestPaletteStop` matches a palette fill
	 * EXACTLY and falls back to nearest hue, so a legacy preset or a hue from the retired 24-stop wheel
	 * lands somewhere sensible instead of at stop 0.
	 */
	const stop = $derived(nearestPaletteStop(value));
	const index = $derived(stop.i - 1);

	/* Static: 48 fixed stops, so the paint is computed once rather than per render. */
	const gradient = paletteConicGradient();

	/*
	 * One pip per DISTINCT stop somebody holds. Deduped because two guests on the same colour are one
	 * fact about the ring, and mapped through `nearestPaletteStop` so a singer who joined before this
	 * palette existed still shows up at the stop nearest their colour rather than not at all.
	 */
	const pips = $derived([...new Set(taken.map((c) => nearestPaletteStop(c).i - 1))]);

	function pick(i: number) {
		value = paletteStopAt(i).fill;
	}

	/**
	 * The keyboard contract for a slider, which is the whole accessibility case for this control.
	 *
	 * Right/Up step forward and Left/Down step back (the ARIA convention: Up and Right increase), and both
	 * WRAP — a ring has no ends, and clamping at stop 48 would make the last stop a dead end a keyboard
	 * guest cannot cross while a pointer guest can. Home/End are still first/last, so the two named
	 * extremes stay reachable in one press even though the value itself is cyclical.
	 */
	function onKeyDown(e: KeyboardEvent) {
		const n = PALETTE_STOPS.length;
		let next: number | null = null;
		if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = index + 1;
		else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = index - 1;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = n - 1;
		if (next === null) return;
		// Arrow keys scroll the page and Home/End jump it; a control that consumed neither would move the
		// screen out from under the guest on every step.
		e.preventDefault();
		pick(next);
	}

	/*
	 * Pointer: the angle under the finger, snapped to a sector. `paletteStopAtRingAngle` is the exact
	 * inverse of the angle the knob is drawn at, so what you touch is what you get.
	 */
	let dragging = $state(false);

	function stopUnderPointer(e: PointerEvent, el: HTMLElement): number | null {
		const box = el.getBoundingClientRect();
		const dx = e.clientX - (box.left + box.width / 2);
		const dy = e.clientY - (box.top + box.height / 2);
		// Near the centre there is no meaningful angle — a pixel of jitter would swing the hue across the
		// wheel — and the centre is the hub, which is a readout rather than a target.
		if (Math.hypot(dx, dy) < box.width / 5) return null;
		// Compass degrees, clockwise from 12 o'clock: the frame `paletteRingAngle` is written in.
		const compass = (Math.atan2(dx, -dy) * 180) / Math.PI;
		return paletteStopAtRingAngle(compass).i - 1;
	}

	function onPointerDown(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		const next = stopUnderPointer(e, el);
		if (next === null) return;
		dragging = true;
		// Keep receiving moves once the finger leaves the ring's box — a circular gesture wanders, and
		// without capture the drag dies the moment it crosses the edge. Guarded because the mount-rung
		// harness has no pointer-capture implementation.
		el.setPointerCapture?.(e.pointerId);
		pick(next);
	}

	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		const next = stopUnderPointer(e, e.currentTarget as HTMLElement);
		if (next !== null) pick(next);
	}

	function endDrag() {
		dragging = false;
	}
</script>

<div class="ring-field">
	<span class="field-label">{label}</span>
	{#if hint}<p class="field-hint">{hint}</p>{/if}

	<!--
		ONE control, and it is the whole disc. The `role="slider"` sits on the disc rather than on the knob
		so a tap anywhere on the band is a pick (and so the measured gate reads a target the size of the
		ring, not of the dot). The knob, the pips and the hub are `aria-hidden` presentation: a slider's
		descendants are presentational by ARIA anyway, and the one fact a reader needs — which colour is
		selected — is `aria-valuetext`, spoken as the stop's name.
	-->
	<div
		class="colour-ring"
		role="slider"
		tabindex="0"
		aria-label={label}
		aria-valuemin={1}
		aria-valuemax={PALETTE_STOPS.length}
		aria-valuenow={stop.i}
		aria-valuetext={stop.name}
		onkeydown={onKeyDown}
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={endDrag}
		onpointercancel={endDrag}
	>
		<span class="cr-band" style="--cr-grad:{gradient}" aria-hidden="true"></span>
		{#each pips as pip (pip)}
			<span class="cr-pip" style="--cr-a:{paletteRingAngle(pip)}deg" aria-hidden="true"></span>
		{/each}
		<span class="cr-knob" style="--cr-a:{paletteRingAngle(index)}deg; --cr-fill:{stop.fill}" aria-hidden="true"></span>
		<span class="cr-hub" aria-hidden="true">
			<span class="cr-dot" style="--cr-fill:{stop.fill}"></span>
			<b class="cr-name">{stop.name}</b>
			<small class="cr-hex">{stop.fill}</small>
			<small class="cr-ratio">{stop.r_dot_card.toFixed(2)}:1 on card</small>
		</span>
	</div>
</div>

<style>
	.ring-field {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}
	/* The eyebrow idiom the settings page, CodeEntry and ColourPicker all use, for the same reason each
	   of them does: this labels a control that carries its own accessible name, so there is nothing for a
	   real <label> to point at. */
	.field-label {
		font-size: var(--ph-text-sm);
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
	.field-hint {
		margin: 0;
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
	}
	/*
	 * THE DISC. Three derived lengths, all off `--tap`, so the control scales with the tap standard rather
	 * than with a screenshot:
	 *
	 *   --cr-d     the outer diameter. Five tap targets across (220px at --tap: 44px), which leaves room
	 *              at 320px — the reflow viewport — after the pane's own gutters.
	 *   --cr-hole  the radius of the punched-out centre. `d/2 - tap` makes the BAND exactly one tap
	 *              target wide, which is the property that matters: the ring is the touch target.
	 *   --cr-r     the radius the knob and the pips sit on — the middle of the band.
	 *
	 * `--cr-d` IS DELIBERATELY NOT `min(…, 100%)`, and this was measured rather than reasoned. A
	 * percentage HEIGHT resolves against the parent's height, and this pane's column is auto-height, so
	 * `height: min(220px, 100%)` computed to **0** — the disc rendered as a 220×0 line, the masked band
	 * had no box to paint in, and the hub's `inset` collapsed. It looked like a styling accident and was a
	 * units bug. The diameter is therefore expressed only in `--tap`, which resolves identically in width,
	 * height, and inside the mask's own gradient — and at 220px it already fits the 320px reflow viewport
	 * with the pane's `--space-4xl` gutters on both sides, so there is nothing for a percentage to save.
	 */
	.colour-ring {
		--cr-d: calc(var(--tap) * 5);
		--cr-hole: calc(var(--cr-d) / 2 - var(--tap));
		--cr-r: calc(var(--cr-d) / 2 - var(--tap) / 2);
		position: relative;
		width: var(--cr-d);
		height: var(--cr-d);
		margin-inline: auto;
		border-radius: var(--radius-pill);
		cursor: pointer;
		/* Own the gesture. A circular drag has a vertical component everywhere, so without this the
		   browser hands half the arc to the page's scroller and the hue stops following the finger. */
		touch-action: none;
	}
	/*
	 * THE FOCUS RING, restated rather than inherited, and the reason is specificity. app.css's global
	 * `[tabindex]:focus-visible` rule also sets `border-radius: var(--radius-sm)`, which would draw a
	 * rounded SQUARE around a circular control; at equal specificity (0,2,0) which one wins depends on
	 * stylesheet order, which is not something this component can rely on. Naming the attribute alongside
	 * the class raises this to (0,3,0) so the disc's outline is a circle. Same token, same width — this
	 * changes the SHAPE of the global ring, never its presence.
	 */
	.colour-ring[role='slider']:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: var(--space-3xs);
		border-radius: var(--radius-pill);
	}
	/*
	 * The 48 fills, painted as one hard-edged conic gradient with the centre masked out. A mask rather
	 * than a smaller circle stacked on top: an overlay would have to match `--card` (or whatever surface
	 * the ring happens to sit on) and would be wrong the moment it moved, where a mask genuinely removes
	 * the middle. `transparent` and `black` are mask ALPHA, not palette colours — the two stops share one
	 * position so the edge is hard rather than feathered.
	 */
	.cr-band {
		position: absolute;
		inset: 0;
		border-radius: var(--radius-pill);
		background: var(--cr-grad);
		-webkit-mask: radial-gradient(circle, transparent var(--cr-hole), black var(--cr-hole));
		mask: radial-gradient(circle, transparent var(--cr-hole), black var(--cr-hole));
	}
	/*
	 * THE KNOB. Its BOX is a full tap target even though the dot inside it is drawn smaller — the drawn
	 * mark is an affordance, the box is what a thumb has to hit. Centred on the disc by `left/top: 50%`
	 * plus half its own size in negative margin, then moved onto the band by a transform alone, so the
	 * only thing that changes when the selection moves is `transform` (the one property this codebase
	 * animates, alongside opacity). The trailing counter-rotate keeps the dot's own frame upright.
	 */
	.cr-knob {
		position: absolute;
		left: 50%;
		top: 50%;
		width: var(--tap);
		height: var(--tap);
		margin: calc(var(--tap) / -2) 0 0 calc(var(--tap) / -2);
		border-radius: var(--radius-pill);
		display: grid;
		place-items: center;
		transform: rotate(var(--cr-a)) translateY(calc(-1 * var(--cr-r))) rotate(calc(-1 * var(--cr-a)));
		transition: transform var(--motion-fast);
	}
	.cr-knob::after {
		content: '';
		width: calc(var(--tap) * 0.66);
		height: calc(var(--tap) * 0.66);
		border-radius: var(--radius-pill);
		background: var(--cr-fill);
		/* Two rings: the page colour first so the knob reads as lifted off the band it sits on, then ink,
		   so the knob is findable against any of the 48 hues under it. */
		box-shadow:
			0 0 0 calc(var(--tap) / 16) var(--bg),
			0 0 0 calc(var(--tap) / 8) var(--ink);
	}
	@media (prefers-reduced-motion: reduce) {
		.cr-knob {
			transition: none;
		}
	}
	/*
	 * A colour somebody in the room already holds: HOLLOW, so it reads as "taken" rather than as a second
	 * selection. Filled with the page colour and ringed in dim ink, which is the same figure/ground trick
	 * the knob uses one size up.
	 */
	.cr-pip {
		position: absolute;
		left: 50%;
		top: 50%;
		width: calc(var(--tap) / 5);
		height: calc(var(--tap) / 5);
		margin: calc(var(--tap) / -10) 0 0 calc(var(--tap) / -10);
		border-radius: var(--radius-pill);
		background: var(--bg);
		box-shadow: 0 0 0 calc(var(--tap) / 22) var(--ink-dim);
		transform: rotate(var(--cr-a)) translateY(calc(-1 * var(--cr-r)));
	}
	/*
	 * THE HUB — the space a strip does not have. `inset: var(--tap)` is exactly the masked hole, since the
	 * band is one tap target wide on each side, so the readout is bounded by the hole rather than by a
	 * guessed width. `pointer-events: none` so a tap that lands on the text still reaches the disc's
	 * handler and is simply ignored as centre-adjacent.
	 */
	.cr-hub {
		position: absolute;
		inset: var(--tap);
		display: grid;
		place-items: center;
		align-content: center;
		text-align: center;
		line-height: var(--lh-tight);
		pointer-events: none;
	}
	.cr-dot {
		width: calc(var(--tap) / 2.2);
		height: calc(var(--tap) / 2.2);
		border-radius: var(--radius-pill);
		background: var(--cr-fill);
		margin-bottom: var(--space-2xs);
	}
	.cr-name {
		font-size: var(--ph-text-base);
		color: var(--ink);
	}
	/* The hex and the measured ratio are the detail behind the name: same size, dimmed, so the name stays
	   the thing you read first. The ratio is the registry's own published figure — see
	   player-palette.ts — not a number computed here. */
	.cr-hex,
	.cr-ratio {
		font-size: var(--ph-text-2xs);
		color: var(--ink-dim);
	}
</style>
