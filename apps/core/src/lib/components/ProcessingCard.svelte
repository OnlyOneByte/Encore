<script lang="ts">
	import { overallCookPct, SINGER_COLORS } from '@encore/shared';
	import Icon from '$lib/ui/Icon.svelte';
	// The live "make karaoke" progress card — the watching-not-waiting feel. Ported from docs/mocks.
	import type { MediaStatus } from '@encore/shared';
	import { cookStageLabel } from '$lib/cook-phrasing';
	interface Props {
		// Queue-slot number + the singer who asked for it. Both absent when the card renders OUTSIDE
		// the rotation list — a song cooking for someone else's turn still needs somewhere to show its
		// progress, and there is no slot or singer to attribute it to there.
		seq?: number;
		title: string;
		singerName?: string;
		singerColor?: string;
		/** The singer who queued this is in the room but unreachable (locked phone, pocket). */
		singerAway?: boolean;
		status: MediaStatus; // queued|downloading|separating|aligning|ready|failed
		pct: number;
		// A cooking song is still a QUEUE ENTRY, so it gets the same controls a ready row does: remove
		// (a 1-2 min cook is a long time to be stuck on a mis-tap) and reorder (deciding what's next is
		// exactly what you do while something cooks). All absent when the card renders outside the
		// rotation (no slot there to act on).
		onremove?: () => void;
		reorderable?: boolean;
		canUp?: boolean;
		canDown?: boolean;
		onup?: () => void;
		ondown?: () => void;
	}
	let {
		seq, title, singerName, singerColor = SINGER_COLORS[0], singerAway = false, status, pct,
		onremove, reorderable = false, canUp = false, canDown = false, onup, ondown
	}: Props = $props();

	// pct is shown separately in the .stage row, so the line itself omits it.
	const stageLabel = $derived(cookStageLabel(status));
	// `pct` is the WORKER'S per-step 0-100. The bar shows OVERALL cook completion, not the current
	// step's own progress — otherwise every step reaching 100% filled the whole bar while three of
	// five milestones had not started. overallCookPct maps the per-step pct into a per-stage
	// band over the shared MEDIA_STAGES, reaching 100 iff status === 'ready'. Rounded for the readout;
	// the bar uses the unrounded fraction so its transition stays smooth.
	const overall = $derived(overallCookPct(status, pct));
</script>

<div class="qrow proc card list-row">
	<div class="seq">{#if seq}{seq}{:else}<Icon name="sparkle" />{/if}</div>
	<div class="meta">
		<div class="t">{title}<span class="sparkle"><Icon name="sparkle" /></span></div>
		{#if singerName}
			<div class="who">
				<!-- Same away marker as QueueRow: a cook outlives its owner's attention span, and the room
				     should not learn the singer left only once the song reaches the front.

				     This line names the SINGER and nothing else. It used to end in "· being prepared" (and
				     rendered a bare "being prepared" with no singer), which was a competing phrasing for cook
				     state alongside cook-phrasing.ts's "Making karaoke..." and SongRow's chip -- and it sat
				     one line above the .stage row that already says exactly that, from the shared source.
				     Redundant AND divergent, so it is gone. -->
				<i class:dim={singerAway} style="--singer:{singerColor}"></i> {singerName}{#if singerAway}<span
						class="away">· away</span>{/if}
			</div>
		{/if}
	</div>
	{#if onremove || reorderable}
		<div class="actions">
			{#if reorderable}
				<button class="act icon-btn" aria-label="move up" disabled={!canUp} onclick={() => onup?.()}><Icon name="arrow-up" /></button>
				<button class="act icon-btn" aria-label="move down" disabled={!canDown} onclick={() => ondown?.()}><Icon name="arrow-down" /></button>
			{/if}
			{#if onremove}
				<button class="remove icon-btn" aria-label="remove from queue" onclick={() => onremove?.()}><Icon name="close" /></button>
			{/if}
		</div>
	{/if}
	<div class="progress">
		<div class="bar"><i style="transform:scaleX({overall / 100})"></i></div>
		<div class="stage" aria-live="polite"><span>{stageLabel}</span><span>{Math.round(overall)}%</span></div>
	</div>
</div>

<style>
	/* .list-row gives the padding, margin and gap; ProcessingCard overrides its display to a two-row
	   grid. Row 1: seq (auto) / title+singer (1fr) / actions (auto). Row 2: the progress block, spanning
	   every column so it always gets the card's full inner width — the actions cluster can no longer eat
	   into the bar or the stage line (issue #176). align-items on row 1 keeps the seq bubble and the
	   action cluster anchored to the title line rather than floating in a taller card. */
	.qrow.proc {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: flex-start;
		row-gap: 0;
	}
	/* The progress block is the second grid row and spans from the first column through the last,
	   regardless of whether the actions column rendered. This is the fix's load-bearing declaration. */
	.progress { grid-column: 1 / -1; }
	.proc { background: linear-gradient(var(--card), var(--card-tint)); border-color: var(--line-tint); }
	.seq { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-size: 0.8rem; font-weight: 700; background: var(--card2); color: var(--ink-dim); flex: 0 0 auto; }
	.meta { flex: 1; min-width: 0; }
	.t { font-weight: 600; }
	/* Spacing via margin, matching SongRow — one mechanism, not a literal space in one place and
	   CSS in the other. */
	.sparkle { color: var(--warn); display: inline-grid; place-items: center; vertical-align: -2px; margin-left: 5px; }
	.who { display: flex; align-items: center; gap: 7px; font-size: 0.78rem; color: var(--ink-dim); margin-top: 2px; }
	.who i.dim { opacity: 0.5; }
	.who .away { color: var(--warn); margin-left: 0.35em; }
	/* flex: 0 0 auto is load-bearing HERE, not just QueueRow parity (issue #89). .who above is a
	   `display: flex` container with no flex-wrap, so it computes nowrap; the dot is an empty flex item
	   whose automatic minimum size is 0. When the actions cluster renders (the normal in-rotation card)
	   it cuts .who from ~282px to 134px (actions = 3x44 + 2x8 = 148px), and a name at the 32-char
	   profile maxlength then overflows it. Without this rule the shrinkable dot shrinks from 10px to
	   ~5.5px at 390px (measured on the long-name fixture below) — a ~45% loss of the only non-text
	   singer discriminator (colors.ts:12-14: "the only thing telling two singers apart besides the
	   name"). It does NOT reach 0px here, unlike QueueRow: QueueRow.svelte:91 additionally gives .who
	   `min-width:0; white-space:nowrap; overflow:hidden`, making the name an unbreakable run that holds
	   its width so the empty dot absorbs the ENTIRE deficit (0px in #89); this .who lacks that trio, so
	   the name shrinks too and the deficit is shared. The ~45% shrink still earns the rule on its own
	   merits, with QueueRow parity a bonus. design-system.test.ts's identity-dot guard reds if this is
	   dropped. */
	.who i { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 50%; background: var(--singer); }
	.bar { height: 6px; border-radius: 6px; background: var(--card-tint2); overflow: hidden; margin-top: 9px; }
	/* GPU-composited fill: scaleX from the left edge, never animates layout width */
	.bar > i { display: block; height: 100%; width: 100%; background: var(--grad); border-radius: 6px; transform-origin: left center; transition: transform 0.4s ease; }
	.stage { display: flex; justify-content: space-between; font-size: 0.74rem; color: var(--warn); margin-top: 7px; }
	/* Identical to QueueRow's icon buttons, so the controls don't visually reshuffle when a song
	   finishes cooking and its card becomes a row. The card is taller than a row, so the cluster aligns
	   to the title line (flex-start) rather than the card's centre — its own comment already claimed
	   this, but align-items:center floated the buttons mid-card. */
	.actions { display: flex; align-items: flex-start; gap: 8px; flex: 0 0 auto; }
	/* Sizing, radius, surface and glyph size come from .icon-btn in app.css. */
	.act:disabled { opacity: 0.35; cursor: default; }
	.act:not(:disabled):active { transform: scale(0.9); color: var(--ink); }
	.remove:active { transform: scale(0.9); color: var(--accent2); }
</style>
