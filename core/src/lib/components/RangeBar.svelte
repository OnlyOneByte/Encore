<script lang="ts">
	// The VOCAL RANGE bar — a fixed pitch axis with the song's sung range drawn on it. INTENTIONALLY DUMB ABOUT MUSIC:
	// every judgement about a voice lives in the contract's pure helpers and arrives here as fractions, so what is left
	// in this file is the axis arithmetic that turns a midi number into a percentage.
	import { voiceBandZones, rangeBarFractions, AXIS_LOW_MIDI, AXIS_HIGH_MIDI, type SongProfile } from '$lib/contract';

	interface Props {
		/** The song's analysis. `null`/absent, or a profile with no range, renders NOTHING (see below). */
		profile?: SongProfile | null;
		/** Current key shift in semitones — slides the whole range so the bar tracks the ± buttons. */
		keyShift?: number;
	}
	let { profile = null, keyShift = 0 }: Props = $props();

	/* The band zones are a FIXED backdrop and never move with the shift: the axis is absolute pitch, and only
	   the SONG moves across it. Precomputed as left/width percentages so the template does no arithmetic. */
	const SPAN = AXIS_HIGH_MIDI - AXIS_LOW_MIDI;
	const zones = voiceBandZones().map((z) => ({
		id: z.id,
		label: z.label,
		pctLo: ((z.lowMidi - AXIS_LOW_MIDI) / SPAN) * 100,
		pctW: ((z.highMidi - z.lowMidi) / SPAN) * 100
	}));

	/* `null` for no usable range, and the caller renders nothing on it: an absent range must be a MISSING
	   bar, never an empty track, which reads as a range of zero. */
	const frac = $derived(rangeBarFractions(profile, keyShift));

	/*
	 * The histogram as shaded segments under the block, so a chorus that camps on a high note looks denser than a verse
	 * that grazes it. Opacity is normalised against the busiest bucket, so the shape reads regardless of song length; an
	 * absent histogram degrades to a flat fill. The shift applies HERE too, or a transposed song shades the wrong place.
	 */
	const histBars = $derived.by(() => {
		if (!profile || !profile.histogram || profile.lowMidi === null) return [];
		const h = profile.histogram;
		const max = Math.max(...h, 0);
		if (max <= 0) return [];
		const shift = Math.trunc(keyShift);
		return h.map((secs, i) => {
			const midi = profile.lowMidi! + i + shift;
			// Clamped, so a freak semitone outside the axis shades the edge rather than overflowing.
			const at = Math.max(0, Math.min(1, (midi - AXIS_LOW_MIDI) / SPAN));
			return {
				leftPct: at * 100,
				widthPct: (1 / SPAN) * 100,
				// Floored, so a single grazed semitone is faint rather than invisible.
				opacity: max > 0 ? 0.12 + 0.88 * (secs / max) : 0
			};
		});
	});
</script>

{#if frac}
	<!-- aria-hidden because this is decorative REINFORCEMENT of the readout beside it, which already states the same
			facts in words — otherwise a screen reader announces an unlabelled graphic repeating what it read. -->
	<div class="rangebar" aria-hidden="true">
		<!-- Layer 1: voice-band zones as soft shading. Deliberately faint: it says roughly where you are, no more. -->
		<div class="zones">
			{#each zones as z (z.id)}
				<span class="zone {z.id}" style="left:{z.pctLo}%;width:{z.pctW}%"></span>
			{/each}
		</div>

		<div class="track"></div>

		<!-- Layer 2: histogram weight, painted under the block so density reads through it. -->
		{#each histBars as b, i (i)}
			<span class="hist" style="left:{b.leftPct}%;width:{b.widthPct}%;opacity:{b.opacity}"></span>
		{/each}

		<!-- Layer 3: the WHISKERS — absolute extremes, so one shrieked note lands here. Kept low-key on purpose. -->
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
	/* SUB-TOKEN RADII ARE DELIBERATE: these are drawing geometry inside an aria-hidden chart, not surfaces on the app's
	   radius scale, whose smallest step is larger than the hairlines here — snapping a 2px hairline up rounds it into a
	   lozenge. Everything positions absolutely off this box, so the helpers' fractions land as percentages directly. */
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
	/* Low voices cool, high voices warm — a rough cue reinforcing the WORDS beside the bar, never the sole carrier.
	   Washes from the accent family, deliberately NOT the singer-colour tokens: those are identity. */
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

	/* Above the zones and below the block. `min-width` is what stops a sub-pixel column vanishing on a narrow phone. */
	.hist {
		position: absolute;
		top: 6px;
		bottom: 6px;
		min-width: 1px;
		background: var(--accent2);
	}

	/* The solid, confident middle, on top of the histogram shading. NEVER NAMED `block`: that is one of Tailwind's own
	   utility names and vendored components use it, so the class would inherit `display: block` from a utility emitted for
	   something else. This is the third such collision in the tree, and the only defence is not to use a utility's name. */
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

	/* Thin vertical ticks at the absolute extremes, joined by a faint line so the full span reads even where the block
	   is narrow. Deliberately quieter than the block. */
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
		/* 9.6px, BELOW the ladder's floor, and — unlike the radii above — NOT covered by the aria-hidden argument:
			   this row is a SIBLING of `.rangebar` (which opens and closes in the markup above it), so "C2"/"C6" are
			   announced, and the consumers beside this chart state the SONG's range and octave count, never the axis
			   bounds. So the facts this labels are NOT restated anywhere. Kept at 0.6rem for now because a ladder step
			   widens the end labels past the track they bracket, but this is an OPEN item, not a sanctioned exception —
			   see the sub-12px rule in docs/FRONTEND.md, which records it as the one unresolved breach. */
		font-size: 0.6rem;
		color: var(--ink-dim);
		font-variant-numeric: tabular-nums;
		margin-top: 1px;
	}
</style>
