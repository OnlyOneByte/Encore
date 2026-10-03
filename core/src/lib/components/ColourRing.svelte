<!-- ColourRing — the whole 48-stop palette as one circular control, and the join screen's colour picker. A RING
	because hue is cyclical, and the masked hole is free space for the stop's NAME. HUE IS THE ONLY AXIS: the stops are
	the registry's uniform variant at one OKLCH lightness, which is what guarantees every reachable colour stays visible
	on the dark surfaces. PIPS ARE PEOPLE, and INFORMATION never a block — two singers sharing a colour is legal.
	See docs/FRONTEND.md#charts-fields-and-the-rest. -->
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
		/** Heading above the ring, and the control's accessible name (one string serves both, so they cannot drift and
		 * SC 2.5.3 holds by construction). SECOND PERSON, and the default is the canonical spelling: this value is the
		 * singer's OWN, which is the app's test for `Your …` over a bare noun (docs/FRONTEND.md, label registers). Both
		 * call sites spell it anyway so a copy grep finds the words on the surface that shows them; /settings used to
		 * pass a bare `Color` and was the only site that overrode the default away from the rule. */
		label?: string;
		hint?: string;
		/** Colours already held by people in the room, drawn as hollow pips. Empty is a legitimate state (an empty room),
		 * so there is no "unknown" case to distinguish. */
		taken?: readonly string[];
	}
	let { value = $bindable(), label = 'Your color', hint = '', taken = [] }: Props = $props();

	/* DERIVED from `value`, never held beside it: with no second piece of state the knob, the hub and the value cannot
	   disagree. `nearestPaletteStop` falls back to nearest hue, so a foreign colour lands sensibly, not at stop 0. */
	const stop = $derived(nearestPaletteStop(value));
	const index = $derived(stop.i - 1);

	/* Static: the stops are fixed, so the paint is computed once rather than per render. */
	const gradient = paletteConicGradient();

	/* One pip per DISTINCT stop, because two guests on one colour are one fact about the ring. */
	const pips = $derived([...new Set(taken.map((c) => nearestPaletteStop(c).i - 1))]);

	function pick(i: number) {
		value = paletteStopAt(i).fill;
	}

	/** Arrow steps WRAP, because a ring has no ends and clamping at the last stop makes it a dead end a keyboard guest
	 * cannot cross while a pointer guest can. Home/End stay first and last, so the named extremes are one press away. */
	function onKeyDown(e: KeyboardEvent) {
		const n = PALETTE_STOPS.length;
		let next: number | null = null;
		if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = index + 1;
		else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = index - 1;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = n - 1;
		if (next === null) return;
		// Arrow keys scroll the page and Home/End jump it, so a control consuming neither moves the screen under the guest.
		e.preventDefault();
		pick(next);
	}

	let dragging = $state(false);

	/* `paletteStopAtRingAngle` is the exact inverse of the angle the knob is drawn at, so what you touch is what you get. */
	function stopUnderPointer(e: PointerEvent, el: HTMLElement): number | null {
		const box = el.getBoundingClientRect();
		const dx = e.clientX - (box.left + box.width / 2);
		const dy = e.clientY - (box.top + box.height / 2);
		// Near the centre there is no meaningful angle — a pixel of jitter swings the hue across the wheel — and the
		// centre is the hub, a readout rather than a target.
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
		// Capture keeps the moves coming once the finger leaves the ring's box: a circular gesture wanders. Optional-called,
		// because the mount rung has no implementation.
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
	<span class="control-label">{label}</span>
	{#if hint}<p class="field-hint">{hint}</p>{/if}

	<!-- The `role="slider"` sits on the DISC, not the knob, so a tap anywhere on the band is a pick and the measured
			gate reads a target the size of the ring rather than of the dot. The knob, pips and hub are aria-hidden. -->
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
		<!-- THE HUB NAMES THE COLOUR AND STOPS THERE: a hex and a contrast ratio are the facts the REGISTRY needs to certify
				a stop, not anything the person picking it can use. -->
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
	.field-hint {
		margin: 0;
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
	}
	/* THE DISC. Three lengths derived off `--tap`, so the control scales with the tap standard: the diameter is five tap
	   targets across, the masked hole's radius makes the BAND exactly one tap target wide (the ring IS the touch target),
	   and `--cr-r` is the middle of the band. THE DIAMETER MUST NOT BECOME A PERCENTAGE — a percentage HEIGHT resolves
	   against this auto-height column and computes to 0, so the disc renders as a zero-height line and the hub collapses. */
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
		/* Own the gesture: a circular drag has a vertical component everywhere, so without this the browser hands half the
		   arc to the page's scroller and the hue stops following the finger. */
		touch-action: none;
	}
	/* A SPECIFICITY TRAP, which is why the role attribute is in the selector: app.css's global `[tabindex]:focus-visible`
	   also sets a small border-radius, drawing a rounded SQUARE around a circular control, and at equal specificity which
	   rule wins depends on stylesheet order. Same token and width — only the SHAPE changes. */
	.colour-ring[role='slider']:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: var(--space-3xs);
		border-radius: var(--radius-pill);
	}
	/* One hard-edged conic gradient with the centre MASKED out, never covered by a stacked circle: an overlay would have
	   to match whatever surface the ring sits on and would be wrong the moment it moved. The `transparent` and `black`
	   are mask ALPHA, not palette colours, and they share one position so the edge is hard rather than feathered. */
	.cr-band {
		position: absolute;
		inset: 0;
		border-radius: var(--radius-pill);
		background: var(--cr-grad);
		-webkit-mask: radial-gradient(circle, transparent var(--cr-hole), black var(--cr-hole));
		mask: radial-gradient(circle, transparent var(--cr-hole), black var(--cr-hole));
	}
	/* THE KNOB's BOX is a full tap target even though the dot inside is drawn smaller: the mark is the affordance, the
	   box is what a thumb has to hit. It is placed by TRANSFORM alone, so only a composited property changes when the
	   selection moves; the trailing counter-rotate keeps the dot's own frame upright. */
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
	}
	.cr-knob::after {
		content: '';
		width: calc(var(--tap) * 0.66);
		height: calc(var(--tap) * 0.66);
		border-radius: var(--radius-pill);
		background: var(--cr-fill);
		/* Two rings, the page colour first then ink, so the knob reads as lifted off the band and stays findable against
			   any of the 48 hues under it. */
		box-shadow:
			0 0 0 calc(var(--tap) / 16) var(--bg),
			0 0 0 calc(var(--tap) / 8) var(--ink);
	}
	/* OPT-IN, not declared-then-reset: a `transition: none` reset is a declaration a later rule can out-cascade,
	   and then the knob glides for someone who asked for no motion. Reduced, it is simply AT the new hue. */
	@media (prefers-reduced-motion: no-preference) {
		.cr-knob {
			transition: transform var(--motion-fast);
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
	/* `inset: var(--tap)` IS the masked hole, since the band is one tap target wide on each side, so the readout is
	   bounded by the hole. `pointer-events: none`, so a tap on the text still reaches the disc's handler. */
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
