<script lang="ts">
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
		/** The room's standing default, 0..100 — named in the hint when an override differs from it. */
		roomDefaultPct?: number;
		/** Is the shown level a deliberate per-song override (vs inherited from the room)? */
		pinned?: boolean;
		oninput?: (pct: number) => void;
		oncommit?: (pct: number) => void;
	}
	let { pct, available, roomDefaultPct = 0, pinned = false, oninput, oncommit }: Props = $props();

	const shown = $derived(Math.max(0, Math.min(100, Math.round(pct))));
	const valueLabel = $derived(!available || shown === 0 ? 'Off' : `${shown}%`);
	const hint = $derived(
		!available
			? 'No isolated vocals for this song yet. Re-cook it to get a guiding track.'
			: pinned && roomDefaultPct !== shown
				? `Set for this song. The room default is ${roomDefaultPct}%.`
				: "Fades the original singer back in, quietly, for a song you don't quite know."
	);
</script>

<div class="gt" class:disabled={!available}>
	<div class="gt-head">
		<span class="lab">Guiding track</span>
		<span class="gt-val">{valueLabel}</span>
	</div>
	<input
		class="gt-slider"
		type="range"
		min="0"
		max="100"
		step="5"
		value={shown}
		disabled={!available}
		aria-label="Guiding track — original vocal level"
		style="--fill:{shown}%"
		oninput={(e) => oninput?.(Number(e.currentTarget.value))}
		onchange={(e) => oncommit?.(Number(e.currentTarget.value))}
	/>
	<div class="gt-scale"><span>Off</span><span>Sing-along</span></div>
	<p class="gt-hint">{hint}</p>
</div>

<style>
	/* Track/fill reuse the 4px + gradient idiom of the sheet's seek row, so this reads as part of the
	   same surface. The app's only other range input (the interstitial slider in Settings) is left
	   native — that one sits in a form, this one sits in the performance surface next to the transport,
	   where an unstyled OS slider reads as a different application. */
	.gt {
		margin: 10px 0 2px;
	}
	.gt.disabled {
		opacity: 0.5;
	}
	.gt-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}
	.lab {
		font-size: 0.7rem;
		color: var(--ink-dim);
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	.gt-val {
		font-size: 0.78rem;
		font-weight: 700;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
	.gt-hint {
		font-size: 0.7rem;
		color: var(--ink-dim);
		margin: 6px 0 0;
		line-height: 1.45;
	}
	.gt-scale {
		display: flex;
		justify-content: space-between;
		font-size: 0.62rem;
		color: var(--ink-dim);
		margin-top: 5px;
	}

	.gt-slider {
		-webkit-appearance: none;
		appearance: none;
		display: block;
		width: 100%;
		height: 24px;
		margin: 13px 0 0;
		background: transparent;
		cursor: pointer;
	}
	/* --fill is set inline from the current value: a gradient stop is how a native range shows a
	   filled portion without a second element, and it keeps the paint on the track itself. */
	.gt-slider::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 4px;
		background: linear-gradient(90deg, var(--accent) 0%, var(--accent2) var(--fill), var(--track-bg) var(--fill));
	}
	.gt-slider::-moz-range-track {
		height: 4px;
		border-radius: 4px;
		background: linear-gradient(90deg, var(--accent) 0%, var(--accent2) var(--fill), var(--track-bg) var(--fill));
	}
	/* A 22px thumb on a 4px track: the TRACK is a hairline for legibility, the THUMB is what a thumb
	   actually has to hit, and the 24px input box keeps the hit area at the row height. */
	.gt-slider::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		margin-top: -9px;
		background: var(--ink);
		border: 2px solid var(--accent);
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
	}
	.gt-slider::-moz-range-thumb {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 2px solid var(--accent);
		background: var(--ink);
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
	}
	.gt.disabled .gt-slider {
		cursor: default;
	}
	.gt.disabled .gt-slider::-webkit-slider-runnable-track {
		background: var(--track-bg);
	}
	.gt.disabled .gt-slider::-moz-range-track {
		background: var(--track-bg);
	}
	.gt.disabled .gt-slider::-webkit-slider-thumb {
		background: var(--ink-dim);
		border-color: var(--line-strong);
	}
	.gt.disabled .gt-slider::-moz-range-thumb {
		background: var(--ink-dim);
		border-color: var(--line-strong);
	}
</style>
