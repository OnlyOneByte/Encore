<script lang="ts">
	// A row in the rotation queue. Ported from docs/mocks.
	import { SINGER_COLORS } from '@encore/shared';
	import Icon from '$lib/ui/Icon.svelte';
	interface Props {
		seq: number; // 1-based display position
		title: string;
		singerName: string;
		singerColor?: string;
		mine?: boolean;
		up?: boolean; // currently playing / next up (accent the seq bubble)
		/**
		 * The singer who queued this is in the room but unreachable — a locked phone or a pocket.
		 * Surfaced HERE because the room decides by hand whether to skip an absent singer's turn, and the
		 * phone is where the skip control lives. Without it, a departed singer's song looked entirely
		 * normal and nobody knew there was a decision to make.
		 */
		singerAway?: boolean;
		subtitle?: string; // e.g. "now playing", "after Liam"
		pending?: boolean; // optimistic, not yet confirmed
		removable?: boolean; // show the remove affordance (mine, not currently playing)
		reorderable?: boolean; // show move up/down (mine, more than one of my picks)
		canUp?: boolean;
		canDown?: boolean;
		onremove?: () => void;
		onup?: () => void;
		ondown?: () => void;
	}
	let {
		seq, title, singerName,
		// Defaulted to match sibling ProcessingCard: without a fallback, `--singer:{singerColor}`
		// resolves against `undefined`, `background: var(--singer)` has no value, and the singer
		// identity dot renders invisible. SINGER_COLORS[0] is the shared canonical fallback.
		singerColor = SINGER_COLORS[0],
		mine = false, up = false, singerAway = false,
		subtitle = '', pending = false, removable = false,
		reorderable = false, canUp = false, canDown = false, onremove, onup, ondown
	}: Props = $props();
</script>

<div class="qrow card list-row" class:mine class:up class:pending>
	<div class="seq">{seq}</div>
	<div class="meta">
		<div class="t">{title}</div>
		<div class="who">
			<!-- The separators are {' · '} expressions, not literal " · " text: Svelte trims the leading
			     whitespace of a text node that opens a block, so the plain form rendered "Sam· now
			     playing" with the dot welded to the name. The `away` span stays literal on purpose -- it
			     carries a margin-left of its own, so adding a space there would double the gap. -->
			<i class:dim={singerAway} style="--singer:{singerColor}"></i>
			{singerName}{#if singerAway}<span class="away">· away</span>{/if}{#if subtitle}{' · '}{subtitle}{/if}{#if pending}{' · '}<span class="adding">adding…</span>{/if}
		</div>
	</div>
	{#if !pending}
		<div class="actions">
			{#if reorderable}
				<button class="act icon-btn" aria-label="move up" disabled={!canUp} onclick={() => onup?.()}><Icon name="arrow-up" /></button>
				<button class="act icon-btn" aria-label="move down" disabled={!canDown} onclick={() => ondown?.()}><Icon name="arrow-down" /></button>
			{/if}
			{#if removable}
				<button class="remove icon-btn" aria-label="remove from queue" onclick={() => onremove?.()}><Icon name="close" /></button>
			{/if}
			<!--
				No grip here. The grip previously rendered ONLY on rows that were neither removable nor
				reorderable (another guest's song), where it was the sole affordance — a cursor:grab
				handle promising a drag-to-reorder that does not exist and that this row has no reorder
				path to fall back on. An affordance that implies an interaction the code never delivers
				is exactly the failure this pass exists to remove. Reorderable rows expose a real path
				(the up/down buttons above); non-reorderable rows correctly expose none.
			-->
		</div>
	{/if}
</div>

<style>
	/* Geometry comes from .list-row in app.css, shared with the search row and the cooking card. */
	.qrow { animation: pop 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.3); }
	@keyframes pop { from { opacity: 0; transform: translateY(-6px) scale(0.97); } to { opacity: 1; transform: none; } }
	.mine { border-color: var(--line-tint); background: linear-gradient(var(--card), var(--card-tint)); }
	.pending { opacity: 0.55; }
	.seq {
		width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center;
		font-size: 0.8rem; font-weight: 700; background: var(--card2); color: var(--ink-dim); flex: 0 0 auto;
	}
	.up .seq { background: var(--accent-strong); color: var(--on-accent); }
	.meta { min-width: 0; }
	.t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	/* Same truncation as .t: a long name plus an appended away/adding badge could wrap and change the
	   row's height between states. min-width:0 lets the flex item shrink below its content width. */
	.who { display: flex; align-items: center; gap: 7px; font-size: 0.78rem; color: var(--ink-dim); margin-top: 2px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.who i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; background: var(--singer); }
	/* Hue kept (it is the singer's identity), presence dimmed. */
	.who i.dim { opacity: 0.5; }
	.away { color: var(--warn); margin-left: 0.35em; }
	.adding { color: var(--warn); }
	.actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
	/* Sizing, radius, surface and glyph size come from .icon-btn in app.css -- this block and
	   ProcessingCard's were byte-identical, each with its own copy of the same rationale. */
	.act:disabled { opacity: 0.35; cursor: default; }
	.act:not(:disabled):active { transform: scale(0.9); color: var(--ink); }
	.remove:active { transform: scale(0.9); color: var(--accent2); }
</style>
