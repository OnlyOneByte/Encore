<!--
	ColourRing — the whole 48-stop palette as one circular control, and the join screen's colour picker. A
	RING because hue is cyclical: on a strip the first and last stops are neighbours in colour and opposite
	ends in space, and the masked hole is free space for the stop's NAME.

	HUE IS THE ONLY AXIS. The stops are the registry's uniform variant, all at one OKLCH lightness, and
	lightness and chroma are not the guest's to choose — that is what guarantees every reachable colour stays
	visible on the dark surfaces and distinguishable from the next guest's. The registry's measured contrast
	ratio is checked in palette-registry.test.ts and deliberately NOT shown to the person picking.

	OPERABLE WITHOUT A POINTER, which is load-bearing because this replaces a native range input and inherits
	nothing: ONE `role="slider"` and one tab stop, with aria-valuemin/max/now over the stop index and
	aria-valuetext over the stop NAME.

	PIPS ARE PEOPLE — a hollow dot marks a colour somebody in the room already holds, so a guest can avoid
	arriving as a near-twin. INFORMATION, never a block: two singers sharing a colour is legal (only a
	duplicate NAME is rejected), and refusing a stop the guest can see needs an explanation the ring has no
	room for.
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

	/* DERIVED from `value`, never held beside it: with no second piece of state the knob, the hub and the value
	   cannot disagree. `nearestPaletteStop` matches a fill exactly and otherwise falls back to nearest hue, so
	   a colour from outside this palette lands somewhere sensible rather than at stop 0. */
	const stop = $derived(nearestPaletteStop(value));
	const index = $derived(stop.i - 1);

	/* Static: the stops are fixed, so the paint is computed once rather than per render. */
	const gradient = paletteConicGradient();

	/* One pip per DISTINCT stop, because two guests on one colour are one fact about the ring. */
	const pips = $derived([...new Set(taken.map((c) => nearestPaletteStop(c).i - 1))]);

	function pick(i: number) {
		value = paletteStopAt(i).fill;
	}

	/**
	 * The slider keyboard contract. Arrow steps WRAP, because a ring has no ends and clamping at the last stop
	 * makes it a dead end a keyboard guest cannot cross while a pointer guest can. Home/End stay first and
	 * last, so the two named extremes are reachable in one press even though the value is cyclical.
	 */
	function onKeyDown(e: KeyboardEvent) {
		const n = PALETTE_STOPS.length;
		let next: number | null = null;
		if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = index + 1;
		else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = index - 1;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = n - 1;
		if (next === null) return;
		// Arrow keys scroll the page and Home/End jump it, so a control that consumed neither would move the
		// screen out from under the guest on every step.
		e.preventDefault();
		pick(next);
	}

	/* `paletteStopAtRingAngle` is the exact inverse of the angle the knob is drawn at, so what you touch is
	   what you get. */
	let dragging = $state(false);

	function stopUnderPointer(e: PointerEvent, el: HTMLElement): number | null {
		const box = el.getBoundingClientRect();
		const dx = e.clientX - (box.left + box.width / 2);
		const dy = e.clientY - (box.top + box.height / 2);
		// Near the centre there is no meaningful angle — a pixel of jitter swings the hue across the wheel —
		// and the centre is the hub, a readout rather than a target.
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
		// Capture keeps the moves coming once the finger leaves the ring's box: a circular gesture wanders, and
		// without it the drag dies at the edge. Optional-called because the mount rung has no implementation.
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
		The `role="slider"` sits on the DISC, not the knob, so a tap anywhere on the band is a pick and the
		measured gate reads a target the size of the ring rather than of the dot. The knob, pips and hub are
		aria-hidden presentation; the one fact a reader needs is `aria-valuetext`, spoken as the stop's name.
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
		<!--
			THE HUB NAMES THE COLOUR AND STOPS THERE. A hex and a contrast ratio are the facts the REGISTRY needs
			to certify a stop, not anything the person picking it can use — the name is the whole of what they
			need, and it is what a screen reader already says through aria-valuetext.
		-->
		<span class="cr-hub" aria-hidden="true">
			<span class="cr-dot" style="--cr-fill:{stop.fill}"></span>
			<b class="cr-name">{stop.name}</b>
		</span>
	</div>
</div>

<style>
	.ring-field {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}
	/* The shared eyebrow idiom: this labels a control that carries its own accessible name, so there is
	   nothing for a real label element to point at. */
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
	 * THE DISC. Three lengths derived off `--tap`, so the control scales with the tap standard: the diameter
	 * is five tap targets across, the masked hole's radius makes the BAND exactly one tap target wide (the
	 * ring IS the touch target), and `--cr-r` is the middle of the band, where the knob and pips sit.
	 *
	 * THE DIAMETER MUST NOT BECOME A PERCENTAGE. A percentage HEIGHT resolves against the parent, and this
	 * pane's column is auto-height, so `min(…, 100%)` computes to 0: the disc renders as a zero-height line,
	 * the masked band has no box to paint in, and the hub's inset collapses. Expressed in --tap it resolves
	 * identically in width, height and inside the mask's own gradient, and already fits the 320px floor.
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
	 * A SPECIFICITY TRAP, which is why the role attribute is in the selector. app.css's global
	 * `[tabindex]:focus-visible` also sets a small border-radius, drawing a rounded SQUARE around a circular
	 * control — and at equal specificity which rule wins depends on stylesheet order. Naming the attribute
	 * alongside the class raises this one step. Same token and width: only the SHAPE changes.
	 */
	.colour-ring[role='slider']:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: var(--space-3xs);
		border-radius: var(--radius-pill);
	}
	/*
	 * One hard-edged conic gradient with the centre MASKED out, never covered by a stacked circle: an overlay
	 * would have to match whatever surface the ring sits on and would be wrong the moment it moved. The
	 * `transparent` and `black` here are mask ALPHA, not palette colours, and they share one position so the
	 * edge is hard rather than feathered.
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
	 * THE KNOB's BOX is a full tap target even though the dot inside is drawn smaller: the mark is the
	 * affordance, the box is what a thumb has to hit. It is placed by TRANSFORM alone, so the only thing that
	 * changes when the selection moves is a composited property; the trailing counter-rotate keeps the dot's
	 * own frame upright.
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
	/* HOLLOW, so a taken colour reads as taken rather than as a second selection: the page colour filled and
	   dim ink ringed, the same figure/ground trick the knob uses one size up. */
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
	/* `inset: var(--tap)` IS the masked hole, since the band is one tap target wide on each side, so the
	   readout is bounded by the hole rather than a guessed width. `pointer-events: none` so a tap on the text
	   still reaches the disc's handler and is ignored there as centre-adjacent. */
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
</style>
