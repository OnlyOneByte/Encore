<!--
	ColourPicker — the eight presets plus the hue wheel, as one control.

	Extracted from /join so the profile sheet can offer the SAME picker rather than a second
	implementation: two pickers would be two places for the preset-vs-slider agreement to drift, and that
	agreement is the whole reason `pickPreset` also moves the hue.

	HUE IS THE ONLY AXIS a guest controls. Lightness and chroma are pinned in @encore/shared, which is
	what guarantees every reachable colour is a dot that stays visible on the dark surfaces and stays
	distinguishable from the next guest's. A free picker would allow near-black (the identity dot
	disappears) or a hue one degree from someone else's (indistinguishable on the TV roster, where the dot
	is the only thing telling two singers apart besides the name).
-->
<script lang="ts">
	import {
		SINGER_COLORS,
		SINGER_HUE_STEP,
		hueToHex,
		nearestSingerHue,
		nextSwatchIndex,
		presetTabStopIndex
	} from '@encore/shared';
	import Icon from '$lib/ui/Icon.svelte';

	interface Props {
		/** The selected colour, as a canonical hex. Bindable. */
		value: string;
		/** Heading above the swatches. */
		label?: string;
		/** One line under the heading; omit for a compact placement. */
		hint?: string;
	}
	let { value = $bindable(), label = 'Your color', hint = '' }: Props = $props();

	/*
	 * Names, because "#7c5cff" tells a screen-reader user nothing they can act on — and because a
	 * sighted guest picking off a wheel deserves to know what they landed on too, so this is shown on
	 * screen as well as announced.
	 *
	 * COUPLING (load-bearing): PRESET_NAMES is mapped to the shared SINGER_COLORS BY POSITION —
	 * PRESET_NAMES[i] is the name of SINGER_COLORS[i]. This array cannot be reordered without also
	 * reordering SINGER_COLORS in packages/shared/src/colors.ts, and vice versa. The single named
	 * chokepoint for this mapping is presetIndex() below — every read of PRESET_NAMES goes through it.
	 * Guarded on two sides: contract.test.ts pins this list against the names the e2e flow queries by, and
	 * design-system.test.ts ('the colour picker has exactly one name per shared preset colour') asserts
	 * PRESET_NAMES and SINGER_COLORS stay the SAME LENGTH — so a resize of either that would announce a
	 * preset as `undefined` reds. Neither can check ORDER (nothing in a hex says "violet"), so a
	 * consistent same-length REORDER of both still needs a human reading either file.
	 */
	const PRESET_NAMES = ['violet', 'pink', 'green', 'amber', 'blue', 'coral', 'purple', 'mint'];
	const HUE_NAMES = [
		'red',
		'vermilion',
		'orange',
		'amber',
		'yellow',
		'lime',
		'green',
		'emerald',
		'teal',
		'cyan',
		'sky',
		'azure',
		'blue',
		'indigo',
		'violet',
		'purple',
		'magenta',
		'pink',
		'rose',
		'crimson'
	];

	function hueName(h: number): string {
		const i = Math.round((((h % 360) + 360) % 360) / (360 / HUE_NAMES.length)) % HUE_NAMES.length;
		return HUE_NAMES[i]!;
	}

	/* Seeded from the incoming value so the slider and the swatch agree on the very first paint. */
	let hue = $state(nearestSingerHue(value));

	/** The label for whatever is currently selected, preset or wheel pick. */
	const colorLabel = $derived(presetIndex(value) !== -1 ? PRESET_NAMES[presetIndex(value)]! : hueName(hue));

	/**
	 * Maps a preset hex to its position in the shared SINGER_COLORS array — the one place the
	 * name-by-index coupling is made explicit. presetIndex(hex) returns -1 for a non-preset (a wheel
	 * hue), so every read of PRESET_NAMES goes through the SAME index and there is a single, named
	 * chokepoint if the two arrays ever drift.
	 */
	function presetIndex(hex: string): number {
		return (SINGER_COLORS as readonly string[]).indexOf(hex);
	}

	/**
	 * The bare colour name for a preset, or a neutral fallback for a wheel hue.
	 *
	 * Returns just "violet", NOT "violet swatch": this is used as each preset radio's aria-label, and
	 * the element is ALREADY announced as a radio by its role, so appending "swatch" makes a reader
	 * say "violet swatch, radio button" — the noun is redundant control-type noise.
	 */
	export function colorName(hex: string): string {
		const i = presetIndex(hex);
		return i === -1 ? 'color' : PRESET_NAMES[i]!;
	}

	function pickHue(h: number) {
		hue = h;
		value = hueToHex(h);
	}

	function pickPreset(c: string) {
		value = c;
		// Keep the slider a VIEW of the same selection: without this the thumb stays at hue 0 (red)
		// while showing violet, and the two controls silently disagree about what is selected.
		hue = nearestSingerHue(c);
	}

	/** Arrow keys move within the group, which is what a radiogroup is expected to do. */
	function onSwatchKey(e: KeyboardEvent) {
		const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
		if (!keys.includes(e.key)) return;
		e.preventDefault();
		const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
		// Anchor arrow movement on the SAME index the tab stop uses (presetTabStopIndex, via
		// nextSwatchIndex) so the two cannot disagree after a wheel pick — see #215.
		const next = nextSwatchIndex(value, step);
		pickPreset(SINGER_COLORS[next]!);
		(e.currentTarget as HTMLElement)?.querySelector<HTMLElement>(`[data-swatch="${next}"]`)?.focus();
	}
</script>

<div class="picker">
	<div class="colour-head">
		<span class="field-label">{label}</span>
		<!-- The colour IS the identity, so say so. "Your color" alone reads as decoration. -->
		<span class="colour-now"><span class="colour-chip" style="--singer:{value}"></span>{colorLabel}</span>
	</div>
	{#if hint}<p class="field-hint">{hint}</p>{/if}

	<div class="swatches" role="radiogroup" aria-label={label} tabindex="-1" onkeydown={onSwatchKey}>
		{#each SINGER_COLORS as c, i}
			<button
				role="radio"
				aria-checked={value === c}
				aria-label={colorName(c)}
				tabindex={i === presetTabStopIndex(value) ? 0 : -1}
				data-swatch={i}
				onclick={() => pickPreset(c)}
				class="swatch"
				class:sel={value === c}
				style="background:{c};"
			>
				<!-- A tick, not just the ring: selection conveyed by colour alone is invisible to a
				     colour-blind guest choosing between the two violets or the two pinks. -->
				{#if value === c}<span class="tick"><Icon name="check" strokeWidth={3} /></span>{/if}
			</button>
		{/each}
	</div>

	<!--
	  Or pick your own hue. A range input rather than a colour wheel or <input type=color>: it keeps the
	  single-tab-stop, arrow-key model the swatch group already has, where a native colour popup is
	  inconsistent across browsers and not reliably keyboard-operable.
	-->
	<label class="hue" style="--singer:{value}">
		<span class="field-label">Or pick your own</span>
		<input
			type="range"
			min="0"
			max={360 - SINGER_HUE_STEP}
			step={SINGER_HUE_STEP}
			value={hue}
			aria-label="Pick your own color by hue"
			aria-valuetext={hueName(hue)}
			oninput={(e) => pickHue(Number(e.currentTarget.value))}
		/>
	</label>
</div>

<style>
	.picker {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}
	.swatches {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: var(--space-lg);
	}
	/* The selected colour, named and shown — a hue off the wheel has no swatch to point at. */
	.colour-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-lg);
	}
	.field-label {
		font-size: 0.78rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
	.field-hint {
		margin: -4px 0 0;
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
	}
	.colour-now {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-size: 0.85rem;
		color: var(--ink);
	}
	.colour-chip {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--singer);
		flex: 0 0 auto;
	}
	.hue {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		margin-top: var(--space-2xs);
	}
	/*
	 * The track shows the actual reachable colours rather than a generic rainbow, so what you drag
	 * through is what you can get. Built from the same pinned lightness and chroma the picker emits.
	 *
	 * 44px interactive height (the project's minimum touch target); the input box itself is
	 * transparent and the 22px rainbow is painted on the runnable-track pseudo-elements, which the
	 * browser centres in the box. The 28px thumb on a 22px track was a 28px hit area — below 44px.
	 */
	.hue input {
		-webkit-appearance: none;
		appearance: none;
		height: var(--tap);
		background: transparent;
		cursor: pointer;
		/* Own the touch gesture so the drag is never re-interpreted as a page scroll. Inside the
		   profile sheet (overflow-y:auto) a hue drag with any vertical component was handed to the
		   sheet's scroll and the hue never moved; the slider only travels on ONE axis, so claiming all
		   touch behaviour here costs nothing and makes the horizontal drag reliable. */
		touch-action: none;
	}
	.hue input::-webkit-slider-runnable-track {
		height: 22px;
		border-radius: var(--radius-pill);
		border: 1px solid var(--line);
		background: linear-gradient(
			to right,
			oklch(0.7 0.16 0),
			oklch(0.7 0.16 45),
			oklch(0.7 0.16 90),
			oklch(0.7 0.16 135),
			oklch(0.7 0.16 180),
			oklch(0.7 0.16 225),
			oklch(0.7 0.16 270),
			oklch(0.7 0.16 315),
			oklch(0.7 0.16 360)
		);
	}
	.hue input::-moz-range-track {
		height: 22px;
		border-radius: var(--radius-pill);
		border: 1px solid var(--line);
		background: linear-gradient(
			to right,
			oklch(0.7 0.16 0),
			oklch(0.7 0.16 45),
			oklch(0.7 0.16 90),
			oklch(0.7 0.16 135),
			oklch(0.7 0.16 180),
			oklch(0.7 0.16 225),
			oklch(0.7 0.16 270),
			oklch(0.7 0.16 315),
			oklch(0.7 0.16 360)
		);
	}
	/* 28px thumb: bigger than the 22px track so it reads as the grab affordance. margin-top centres
	   it on the 22px runnable-track: (22 - 28) / 2 = -3px. */
	.hue input::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 28px;
		height: 28px;
		margin-top: -3px;
		border-radius: 50%;
		background: var(--singer, #fff);
		border: 3px solid var(--ink);
		box-shadow: var(--shadow);
		cursor: pointer;
	}
	.hue input::-moz-range-thumb {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: transparent;
		border: 3px solid var(--ink);
		box-shadow: var(--shadow);
		cursor: pointer;
	}
	.swatch {
		height: 54px;
		border-radius: var(--radius-sm);
		border: 3px solid transparent;
		cursor: pointer;
		transition: transform var(--motion-fast);
		display: grid;
		place-items: center;
	}
	.swatch.sel {
		border-color: var(--ink);
	}
	/* Dark tick on a light swatch, with a faint light halo so it survives the darker presets too. */
	.tick {
		color: var(--bg);
		font-size: 1.3rem;
		display: grid;
		place-items: center;
		filter: drop-shadow(0 1px 1px rgba(255, 255, 255, 0.5));
	}
</style>
