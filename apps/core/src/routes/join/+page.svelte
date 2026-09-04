<script lang="ts">
	import { SINGER_COLORS, SINGER_HUE_STEP, hueToHex, nearestSingerHue } from '@encore/shared';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { safeNextPath } from '$lib/next-path';
	import Icon from '$lib/ui/Icon.svelte';

	/** Arrow keys move within the group, which is what a radiogroup is expected to do. */
	function onSwatchKey(e: KeyboardEvent) {
		const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
		if (!keys.includes(e.key)) return;
		e.preventDefault();
		const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
		const i = (SINGER_COLORS as readonly string[]).indexOf(color);
		const next = (i + step + SINGER_COLORS.length) % SINGER_COLORS.length;
		color = SINGER_COLORS[next]!;
		(e.currentTarget as HTMLElement)
			?.querySelector<HTMLElement>(`[data-swatch="${next}"]`)
			?.focus();
	}

	/*
	 * Names, because "#7c5cff" tells a screen-reader user nothing they can act on — and because a
	 * sighted guest picking off a wheel deserves to know what they landed on too, so this is shown
	 * on screen as well as announced.
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

	let name = $state('');
	let color = $state<string>(SINGER_COLORS[0]);
	/*
	 * Hue is the ONLY axis a guest controls. Lightness and chroma are pinned in @encore/shared, which is
	 * what guarantees every reachable colour is a dot that stays visible on the dark surfaces and stays
	 * distinguishable from the next guest's. A free picker would allow near-black (the identity dot
	 * disappears) or a hue one degree from someone else's (indistinguishable on the TV roster, where the
	 * dot is the only thing telling them apart besides the name).
	 */
	/* Seeded from the default preset so the slider and the swatch agree on the very first paint. */
	let hue = $state(nearestSingerHue(SINGER_COLORS[0]));

	/** The label for whatever is currently selected, preset or wheel pick. */
	const colorLabel = $derived(
		(SINGER_COLORS as readonly string[]).includes(color)
			? PRESET_NAMES[(SINGER_COLORS as readonly string[]).indexOf(color)]!
			: hueName(hue)
	);

	function colorName(hex: string): string {
		return `${PRESET_NAMES[(SINGER_COLORS as readonly string[]).indexOf(hex)] ?? 'color'} swatch`;
	}

	function pickHue(h: number) {
		hue = h;
		color = hueToHex(h);
	}

	function pickPreset(c: string) {
		color = c;
		// Keep the slider a VIEW of the same selection: without this the thumb stays at hue 0 (red)
		// while showing violet, and the two controls silently disagree about what is selected.
		hue = nearestSingerHue(c);
	}

	let submitting = $state(false);
	let error = $state('');

	const canJoin = $derived(name.trim().length > 0 && !submitting);

	async function join() {
		if (!canJoin) return;
		submitting = true;
		error = '';
		try {
			const res = await fetch('/api/join', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ displayName: name.trim(), color })
			});
			if (!res.ok) {
				error = (await res.json()).error ?? 'Could not join';
				submitting = false;
				return;
			}
			// session cookie is set; head where the join was for — the remote unless something sent us
			// here to reach a specific screen (the settings route redirects unjoined visitors).
			await goto(safeNextPath(page.url.searchParams.get('next')));
		} catch {
			error = 'Network error — try again';
			submitting = false;
		}
	}
</script>

<header style="padding:26px 20px 8px;text-align:center;">
	<div style="font-weight:800;font-size:1.6rem;letter-spacing:.5px;">
		🎤 <span style="background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;">Encore</span>
	</div>
	<p style="color:var(--ink-dim);margin:6px 0 0;font-size:.9rem;">Pick a name and color to start singing.</p>
</header>

<main class="join-main" style="padding:18px 20px;display:flex;flex-direction:column;gap:20px;">
	<label style="display:flex;flex-direction:column;gap:8px;">
		<span style="font-size:.78rem;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-dim);">Your name</span>
		<input
			class="card"
			bind:value={name}
			placeholder="e.g. Maya"
			maxlength="32"
			style="padding:14px;font-size:1.1rem;color:var(--ink);background:var(--card);outline:none;"
			onkeydown={(e) => e.key === 'Enter' && join()}
		/>
	</label>

	<div style="display:flex;flex-direction:column;gap:10px;">
		<div class="colour-head">
			<span class="field-label">Your color</span>
			<!-- The colour IS the identity, so say so. "Your color" alone reads as decoration. -->
			<span class="colour-now"><span class="colour-chip" style="--singer:{color}"></span>{colorLabel}</span>
		</div>
		<p class="field-hint">How you'll spot yourself in the queue and on the TV.</p>
		<div class="swatches" role="radiogroup" aria-label="Your color" tabindex="-1" onkeydown={onSwatchKey}>
			{#each SINGER_COLORS as c, i}
				<button
					role="radio"
					aria-checked={color === c}
					aria-label={colorName(c)}
					tabindex={color === c ? 0 : -1}
					data-swatch={i}
					onclick={() => pickPreset(c)}
					class="swatch"
					class:sel={color === c}
					style="background:{c};"
				>
					<!-- A tick, not just the ring: selection conveyed by colour alone is invisible to a
					     colour-blind guest choosing between the two violets or the two pinks. -->
					{#if color === c}<span class="tick"><Icon name="check" strokeWidth={3} /></span>{/if}
				</button>
			{/each}
		</div>

		<!--
		  Or pick your own hue. A range input rather than a colour wheel or <input type=color>: it keeps
		  the single-tab-stop, arrow-key model the swatch group already has, where a native colour popup
		  is inconsistent across browsers and not reliably keyboard-operable. Only HUE is exposed —
		  lightness and chroma are fixed in @encore/shared so no reachable value can be an invisible dot.
		-->
		<label class="hue" style="--singer:{color}">
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

	{#if error}
		<div class="err" role="alert">{error}</div>
	{/if}

	<button
		class="btn-accent submit"
		disabled={!canJoin}
		onclick={join}
		style="padding:16px;font-size:1.1rem;border-radius:16px;opacity:{canJoin ? 1 : 0.5};"
	>
		{#if submitting}Joining…{:else}Start singing <Icon name="arrow-right" />{/if}
	</button>
</main>

<style>
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
	 */
	.hue input {
		-webkit-appearance: none;
		appearance: none;
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
	/* 28px thumb: the control is a 22px track, so the grab target has to be bigger than the track. */
	.hue input::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 28px;
		height: 28px;
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
	.err { color: var(--danger); font-size: 0.9rem; }

	/*
	 * Join stays narrow while the shell widens: it is four short controls, so stretching the name
	 * field and colour swatches across a desktop column would make them harder to use, not easier.
	 */
	/* Declared here rather than inline: an inline style outranks every stylesheet rule, so a `flex:1`
	   attribute would make the desktop override below silently do nothing. */
	.join-main {
		flex: 1;
	}
	.submit {
		/* On a phone the button sits at the bottom of the viewport, where a thumb already is. */
		margin-top: auto;
		/* Centres the trailing mark with the label instead of letting it sit on the text baseline. */
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
	}
	@media (min-width: 768px) {
		/*
		 * Centre the wordmark and the form TOGETHER. Centring only the form leaves the header pinned to
		 * the top of the window with a void between them, which reads as a layout accident rather than a
		 * sign-in card. This needs the shell because the header is main's sibling, not its child.
		 */
		:global(.app-shell:has(.join-main)) {
			justify-content: center;
		}
		.join-main {
			max-width: 420px;
			margin: 0 auto;
			/* Without this the flex:1 inline style eats the shell's free space and defeats the centring. */
			flex: 0 0 auto;
			padding-bottom: 0;
		}
		.submit {
			/* Pinned to the viewport bottom, the button is stranded far below the form on a tall desktop
			   window, so it follows the fields it submits instead. */
			margin-top: 8px;
		}
	}
</style>
