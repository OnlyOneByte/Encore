<script lang="ts">
	import { MEDIA_STAGES, mediaStagePosition, SINGER_COLORS } from '@encore/shared';
	import Icon from '$lib/ui/Icon.svelte';
	// The live "make karaoke" progress card — the watching-not-waiting feel. Ported from docs/mocks.
	import type { MediaStatus } from '@encore/shared';
	import { cookStageChipLabel, cookStageLabel } from '$lib/cook-phrasing';
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

	// The stages shown as chips, in worker order. The ORDER comes from the shared `MEDIA_STAGES` — the
	// same list the server positions every `media:status` on — so the strip cannot disagree with what
	// the cook reports. It was a hand-written array here (twice over: STAGE_KEYS and a duplicate
	// `order`), which is what let the two drift apart from the server's view of the same five stops.
	// Labels come from the shared phrasing helper so the card and SongRow speak one vocabulary.
	const STAGES: { key: MediaStatus; label: string }[] = MEDIA_STAGES.map((key) => ({
		key,
		label: cookStageChipLabel(key)
	}));
	function state(key: MediaStatus): 'done' | 'now' | 'todo' {
		const cur = mediaStagePosition(status);
		const k = mediaStagePosition(key);
		// A terminal exit (failed / canceled) is not ON the line, so no chip is current. This is what the
		// bare index comparison below already did with its -1, and saying so explicitly is the point: the
		// old code got the right answer by accident, which is not a property you want a future edit to
		// have to rediscover.
		if (cur < 0) return 'todo';
		if (k < cur) return 'done';
		if (k === cur) return 'now';
		return 'todo';
	}
	// pct is shown separately in the .stage row, so the line itself omits it.
	const stageLabel = $derived(cookStageLabel(status));
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
				     rendered a bare "being prepared" with no singer), which was a fourth phrasing for cook
				     state alongside cook-phrasing.ts's "Making karaoke...", the chip strip's "Making
				     karaoke", and SongRow's chip -- and it sat one line above the .stage row that already
				     says exactly that, from the shared source. Redundant AND divergent, so it is gone. -->
				<i class:dim={singerAway} style="--singer:{singerColor}"></i> {singerName}{#if singerAway}<span
						class="away">· away</span>{/if}
			</div>
		{/if}
		<div class="bar"><i style="transform:scaleX({pct / 100})"></i></div>
		<div class="stage" aria-live="polite"><span>{stageLabel}</span><span>{pct}%</span></div>
		<div class="chips">
			{#each STAGES as s}
				<span class="chip {state(s.key)}">
					{#if state(s.key) === 'done'}<Icon name="check" />{/if}{#if state(s.key) === 'now'}<span class="now-dot" aria-hidden="true"></span>{/if}{s.label}
				</span>
			{/each}
		</div>
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
</div>

<style>
	/* Geometry comes from .list-row in app.css. align-items is the one deliberate override: this card
	   is taller than a plain row, so its seq bubble and actions anchor to the top rather than floating
	   at the vertical centre. */
	.qrow { align-items: flex-start; }
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
	.who i { width: 10px; height: 10px; border-radius: 50%; background: var(--singer); }
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
	.chips { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
	.chip { display: inline-flex; align-items: center; gap: 4px; font-size: 0.66rem; padding: 3px 8px; border-radius: 20px; background: var(--card-tint2); color: var(--ink-dim); }
	/* The "now" marker was a ● glyph; drawn instead so its size does not depend on a fallback font. */
	.now-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: 0 0 auto; }
	/* 16% tints DERIVED from the tokens via color-mix, not the --ok/--warn hexes hand-inlined at
	   0.16 alpha — a hand-inlined copy silently desyncs the moment either token changes. */
	.chip.done { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
	.chip.now { background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); }
</style>
