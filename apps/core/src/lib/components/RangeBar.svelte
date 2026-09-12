<script lang="ts">
	// The VOCAL RANGE bar — a C2..C6 axis with the song's sung range drawn on it.
	//
	// Presentational, and INTENTIONALLY dumb about music: every judgement (which notes, which band,
	// how far the shift moves things) lives in $shared's pure helpers, computed by the caller
	// and handed down as fractions. This component only paints. That split is why the same helpers can
	// feed the TV without a second copy of the geometry, and why the whole thing is unit-testable
	// without a DOM.
	//
	// WHY A COMPONENT AND NOT INLINE MARKUP. The bar has four superimposed layers (band shading,
	// per-semitone histogram weight, the lives-here block, the whisker extremes) and the phone renders
	// it inside a disclosure while the /components gallery renders it in six states. One component is
	// the only way those two callers cannot drift.
	import { voiceBandZones, rangeBarFractions, AXIS_LOW_MIDI, AXIS_HIGH_MIDI, type SongProfile } from '$shared';

	interface Props {
		/** The song's analysis. `null`/absent, or a profile with no range, renders NOTHING (see below). */
		profile?: SongProfile | null;
		/** Current key shift in semitones — slides the whole range so the bar tracks the ± buttons. */
		keyShift?: number;
	}
	let { profile = null, keyShift = 0 }: Props = $props();

	/*
	 * The band ZONES are a fixed backdrop: non-overlapping, they tile the axis and never move with the
	 * shift (the axis is absolute pitch; only the SONG moves across it). Fractions are precomputed once
	 * from the shared helper so the template does no arithmetic. Named `pctLo`/`pctW` because CSS wants
	 * a left offset and a width, and expressing width as (hi-lo) here keeps the template declarative.
	 */
	const SPAN = AXIS_HIGH_MIDI - AXIS_LOW_MIDI;
	const zones = voiceBandZones().map((z) => ({
		id: z.id,
		label: z.label,
		pctLo: ((z.lowMidi - AXIS_LOW_MIDI) / SPAN) * 100,
		pctW: ((z.highMidi - z.lowMidi) / SPAN) * 100
	}));

	/*
	 * Where the song sits, as 0..1 fractions of the axis, ALREADY shifted by keyShift inside the helper.
	 * `null` when there is no usable range — the caller guards on this and renders nothing, so an
	 * absent range is a missing bar, never an empty track that reads as "range = zero".
	 */
	const frac = $derived(rangeBarFractions(profile, keyShift));

	/*
	 * The histogram, turned into shaded segments UNDER the lives-here block, so a chorus that camps on
	 * a high note looks visibly denser than a verse that merely grazes it. index 0 is `lowMidi` (see
	 * SongProfile), one bucket per semitone upward. We map each bucket to its axis fraction and to an
	 * opacity proportional to time-spent, normalised against the busiest bucket so the shape reads
	 * regardless of song length. Absent histogram -> empty list -> the block renders as a flat fill,
	 * which is the correct degrade (we know the range, we just cannot weight it).
	 *
	 * The shift is applied here too (bucket midi = lowMidi + i + keyShift) so the weighting slides in
	 * lockstep with the block and the whiskers — otherwise a transposed song would show its density in
	 * the wrong place.
	 */
	const histBars = $derived.by(() => {
		if (!profile || !profile.histogram || profile.lowMidi === null) return [];
		const h = profile.histogram;
		const max = Math.max(...h, 0);
		if (max <= 0) return [];
		const shift = Math.trunc(keyShift);
		return h.map((secs, i) => {
			const midi = profile.lowMidi! + i + shift;
			// Clamp to the axis so a freak semitone outside C2..C6 shades the edge rather than overflowing.
			const at = Math.max(0, Math.min(1, (midi - AXIS_LOW_MIDI) / SPAN));
			return {
				// one semitone is 1/SPAN of the axis; width in % so segments abut without gaps
				leftPct: at * 100,
				widthPct: (1 / SPAN) * 100,
				// floor at a faint 0.12 so even a single grazed semitone is visible, not invisible
				opacity: max > 0 ? 0.12 + 0.88 * (secs / max) : 0
			};
		});
	});
</script>

{#if frac}
	<!--
		role/aria: the bar is decorative reinforcement of the text readout beside it (range label +
		octave span + band sentence), which already states the same facts in words. aria-hidden keeps a
		screen reader from announcing an unlabelled graphic that repeats what it just read.
	-->
	<div class="rangebar" aria-hidden="true">
		<!-- Layer 1: voice-band zones as SOFT background shading. Colour is the only differentiator and
		     it is deliberately faint — this tells you roughly where you are, it does not make a claim. -->
		<div class="zones">
			{#each zones as z (z.id)}
				<span class="zone {z.id}" style="left:{z.pctLo}%;width:{z.pctW}%"></span>
			{/each}
		</div>

		<!-- The axis hairline the whiskers and block sit on. -->
		<div class="track"></div>

		<!-- Layer 2: histogram weight, painted under the block so density reads through it. -->
		{#each histBars as b, i (i)}
			<span class="hist" style="left:{b.leftPct}%;width:{b.widthPct}%;opacity:{b.opacity}"></span>
		{/each}

		<!-- Layer 3: the WHISKERS — absolute extremes (one shrieked note lands here), thin and low-key
		     so they never outshout the block. -->
		<span class="whisker" style="left:{frac.lo * 100}%"></span>
		<span class="whisker" style="left:{frac.hi * 100}%"></span>
		<span class="whisker-line" style="left:{frac.lo * 100}%;width:{(frac.hi - frac.lo) * 100}%"></span>

		<!-- Layer 4: the lives-here BLOCK (p05..p95) — the honest headline of where the song sits. -->
		<span class="lives-here" style="left:{frac.blockLo * 100}%;width:{(frac.blockHi - frac.blockLo) * 100}%"></span>
	</div>

	<!-- Axis end labels, so the shading is not a mystery gradient. C2 and C6 are the fixed ends. -->
	<div class="axis-ends"><span>C2</span><span>C6</span></div>
{/if}

<style>
	/*
	 * A short, wide strip. Height carries the whiskers + block + shading in one band; the phone gives
	 * it full column width inside the disclosure. Everything positions absolutely off this box, so the
	 * fractions from the helpers land as left/width percentages directly.
	 */
	.rangebar {
		position: relative;
		height: 34px;
		margin: var(--space-sm) 0 var(--space-2xs);
		border-radius: 8px;
		overflow: hidden;
		background: var(--card2);
		border: 1px solid var(--line);
	}
	.zones {
		position: absolute;
		inset: 0;
	}
	/*
	 * Zone tints. Low voices sit cool, high voices warm — a rough, non-literal cue that reinforces the
	 * WORDS (the band sentence beside the bar), never the sole carrier. Opacity kept low so the block
	 * and whiskers above stay the focus. These are not the singer-colour tokens (those are identity);
	 * these are neutral warm/cool washes derived from the accent family.
	 */
	.zone {
		position: absolute;
		top: 0;
		bottom: 0;
	}
	.zone.bass {
		background: color-mix(in srgb, var(--accent) 14%, transparent);
	}
	.zone.baritone {
		background: color-mix(in srgb, var(--accent) 9%, transparent);
	}
	.zone.tenor {
		background: color-mix(in srgb, var(--ink) 5%, transparent);
	}
	.zone.alto {
		background: color-mix(in srgb, var(--accent2) 9%, transparent);
	}
	.zone.soprano {
		background: color-mix(in srgb, var(--accent2) 15%, transparent);
	}

	/* The axis hairline, centred vertically. */
	.track {
		position: absolute;
		left: 0;
		right: 0;
		top: 50%;
		height: 3px;
		transform: translateY(-50%);
		background: var(--line-strong);
		border-radius: 3px;
	}

	/*
	 * Histogram weight. Full-height faint columns whose opacity is the time-per-semitone weight set
	 * inline. Sits above the zones and below the block so a dense region reads through the solid block
	 * as extra saturation. min-width guards a sub-pixel column from vanishing on a narrow phone.
	 */
	.hist {
		position: absolute;
		top: 6px;
		bottom: 6px;
		min-width: 1px;
		background: var(--accent2);
	}

	/* The lives-here block: the solid, confident middle. Sits on top of the histogram shading. */
	/*
	 * Renamed from `.block` in S2/S3 of the shadcn migration. `block` is one of Tailwind's own utility names, and shadcn's
	 * Switch and Slider both use it — so the same token meant "display:block" inside a vendored
	 * component and "the singer's comfortable range" on this element. app.css records that `.underline`
	 * and `.block` collided with these markers once already, which is why the `source(none)` fence
	 * exists. `lives-here` is what the layer is actually called in the design, and no utility can claim
	 * it.
	 */
	.lives-here {
		position: absolute;
		top: 50%;
		height: 12px;
		min-width: 4px;
		transform: translateY(-50%);
		background: var(--accent);
		border-radius: 6px;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
	}

	/* Whiskers: thin vertical ticks at the absolute extremes, joined by a faint connecting line so the
	   full span reads even where the block is narrow. Deliberately quieter than the block. */
	.whisker {
		position: absolute;
		top: 50%;
		width: 2px;
		height: 20px;
		transform: translate(-1px, -50%);
		background: var(--ink);
		opacity: 0.7;
		border-radius: 2px;
	}
	.whisker-line {
		position: absolute;
		top: 50%;
		height: 2px;
		transform: translateY(-50%);
		background: var(--ink);
		opacity: 0.28;
	}

	.axis-ends {
		display: flex;
		justify-content: space-between;
		font-size: 0.6rem;
		color: var(--ink-dim);
		font-variant-numeric: tabular-nums;
		margin-top: 1px;
	}
</style>
