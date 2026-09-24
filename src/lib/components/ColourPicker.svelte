<!-- ColourPicker — the presets plus the hue wheel, as one control. The preset-and-slider agreement is the whole reason
	`pickPreset` also moves the hue: two controls for one choice is two places to drift. HUE IS THE ONLY AXIS a guest
	controls; lightness and chroma are pinned in the contract, so no reachable colour can vanish on a dark surface. -->
<script lang="ts">
	import {
		SINGER_COLORS,
		SINGER_HUE_STEP,
		hueToHex,
		nearestSingerHue,
		nextSwatchIndex,
		presetTabStopIndex
	} from '$lib/contract';
	import Icon from '$lib/ui/Icon.svelte';

	interface Props {
		/** The selected colour, as a canonical hex. Bindable. */
		value: string;
		label?: string;
		hint?: string;
	}
	let { value = $bindable(), label = 'Your color', hint = '' }: Props = $props();

	/*
	 * Names, because a hex tells a screen-reader user nothing they can act on. LOAD-BEARING COUPLING: this list maps to
	 * the shared `SINGER_COLORS` BY POSITION, so neither can be reordered without the other, and `presetIndex()` below is
	 * the single chokepoint every read goes through. Two guards pin the LENGTHS staying equal; nothing can check ORDER.
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

	const colorLabel = $derived(presetIndex(value) !== -1 ? PRESET_NAMES[presetIndex(value)]! : hueName(hue));

	/** The one place the name-by-index coupling is made explicit; -1 for a wheel hue rather than a preset. */
	function presetIndex(hex: string): number {
		return (SINGER_COLORS as readonly string[]).indexOf(hex);
	}

	/**
	 * The BARE colour name, never "violet swatch": this is a radio's aria-label and the role already announces the
	 * control type. @knipignore Used only by this component's markup, which knip cannot see. The `export` is load-bearing
	 * too: two source scans match on it.
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
		// Keep the slider a VIEW of the same selection: without this the thumb stays at hue 0 while showing violet.
		hue = nearestSingerHue(c);
	}

	/** Arrow keys move within the group, which is what a radiogroup is expected to do. */
	function onSwatchKey(e: KeyboardEvent) {
		const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
		if (!keys.includes(e.key)) return;
		e.preventDefault();
		const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
		// Anchored on the SAME index the tab stop uses, so the two cannot disagree after a wheel pick.
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
				<!-- A tick, not just the ring: selection by colour alone is invisible between the two violets or the two pinks. -->
				{#if value === c}<span class="tick"><Icon name="check" strokeWidth={3} /></span>{/if}
			</button>
		{/each}
	</div>

	<!-- A range input rather than a native colour input: it keeps the single-tab-stop, arrow-key model the swatch group
		already has, where a native colour popup is inconsistent across browsers and not reliably keyboard-operable. -->
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
	/* Deliberately NOT the Field primitive despite the name: these head a radiogroup that carries its own aria-label, so
	   a real label element would have no control — and the primitive's data-slot would inherit the settings rhythm. */
	.field-label {
		font-size: var(--ph-text-sm);
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
		font-size: var(--ph-text-sm);
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
	/* The track shows the REACHABLE colours rather than a generic rainbow, built from the same pinned lightness and
	   chroma the picker emits, so what you drag through is what you can get. The INPUT BOX is var(--tap) tall and
	   transparent, with the thinner rainbow on the runnable-track pseudo-elements: sizing the box to the drawn track
	   gives a hit area under the floor. */
	.hue input {
		-webkit-appearance: none;
		appearance: none;
		height: var(--tap);
		background: transparent;
		cursor: pointer;
		/* Own the touch gesture: inside a scrollable sheet a hue drag with any vertical component goes to the scroller. */
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
	/* Bigger than the track so it reads as the grab affordance; the negative margin is half the height difference,
		   which is what centres it. */
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
		font-size: var(--ph-text-xl);
		display: grid;
		place-items: center;
		filter: drop-shadow(0 1px 1px rgba(255, 255, 255, 0.5));
	}
</style>
