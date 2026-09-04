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
	import { SINGER_COLORS, SINGER_HUE_STEP, hueToHex, nearestSingerHue } from '@encore/shared';
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
	 */
	const PRESET_NAMES = ['violet', 'pink', 'green', 'amber', 'blue', 'coral', 'purple', 'mint'];
	const HUE_NAMES = [
		'red', 'vermilion', 'orange', 'amber', 'yellow', 'lime',
		'green', 'emerald', 'teal', 'cyan', 'sky', 'azure',
		'blue', 'indigo', 'violet', 'purple', 'magenta', 'pink',
		'rose', 'crimson'
	];

	function hueName(h: number): string {
		const i = Math.round((((h % 360) + 360) % 360) / (360 / HUE_NAMES.length)) % HUE_NAMES.length;
		return HUE_NAMES[i]!;
	}

	/* Seeded from the incoming value so the slider and the swatch agree on the very first paint. */
	let hue = $state(nearestSingerHue(value));

	/** The label for whatever is currently selected, preset or wheel pick. */
	const colorLabel = $derived(
		(SINGER_COLORS as readonly string[]).includes(value)
			? PRESET_NAMES[(SINGER_COLORS as readonly string[]).indexOf(value)]!
			: hueName(hue)
	);

	export function colorName(hex: string): string {
		return `${PRESET_NAMES[(SINGER_COLORS as readonly string[]).indexOf(hex)] ?? 'color'} swatch`;
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
		const i = (SINGER_COLORS as readonly string[]).indexOf(value);
		const next = (i + step + SINGER_COLORS.length) % SINGER_COLORS.length;
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
				tabindex={value === c ? 0 : -1}
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
	.picker { display: flex; flex-direction: column; gap: 10px; }
	.swatches { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
	/* The selected colour, named and shown — a hue off the wheel has no swatch to point at. */
	.colour-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
	.field-label { font-size: 0.78rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-dim); }
	.field-hint { margin: -4px 0 0; font-size: 0.8rem; color: var(--ink-dim); }
	.colour-now { display: inline-flex; align-items: center; gap: 7px; font-size: 0.85rem; color: var(--ink); }
	.colour-chip { width: 14px; height: 14px; border-radius: 50%; background: var(--singer); flex: 0 0 auto; }
	.hue { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
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
		height: 44px;
		background: transparent;
		cursor: pointer;
	}
	.hue input::-webkit-slider-runnable-track {
		height: 22px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: linear-gradient(
			to right,
			oklch(0.7 0.16 0), oklch(0.7 0.16 45), oklch(0.7 0.16 90), oklch(0.7 0.16 135),
			oklch(0.7 0.16 180), oklch(0.7 0.16 225), oklch(0.7 0.16 270), oklch(0.7 0.16 315),
			oklch(0.7 0.16 360)
		);
	}
	.hue input::-moz-range-track {
		height: 22px;
		border-radius: 999px;
		border: 1px solid var(--line);
		background: linear-gradient(
			to right,
			oklch(0.7 0.16 0), oklch(0.7 0.16 45), oklch(0.7 0.16 90), oklch(0.7 0.16 135),
			oklch(0.7 0.16 180), oklch(0.7 0.16 225), oklch(0.7 0.16 270), oklch(0.7 0.16 315),
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
		height: 54px; border-radius: var(--radius-sm); border: 3px solid transparent;
		cursor: pointer; transition: transform 0.12s;
		display: grid; place-items: center;
	}
	.swatch.sel { border-color: var(--ink); }
	/* Dark tick on a light swatch, with a faint light halo so it survives the darker presets too. */
	.tick { color: var(--bg); font-size: 1.3rem; display: grid; place-items: center; filter: drop-shadow(0 1px 1px rgba(255, 255, 255, 0.5)); }
</style>
