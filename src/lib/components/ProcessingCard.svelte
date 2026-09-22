<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { SINGER_COLORS } from '$lib/contract';
	import { overallProcessPct } from '$lib/process-progress';
	import Icon from '$lib/ui/Icon.svelte';
	// The live "make karaoke" progress card — the watching-not-waiting feel. Ported from docs/mocks.
	import type { MediaStatus } from '$lib/contract';
	import { processStageLabel } from '$lib/phrasing/process-phrasing';
	import { Progress } from '$lib/components/ui/progress';
	import * as Item from '$lib/components/ui/item';
	interface Props {
		// Queue-slot number + the singer who asked for it. Both absent when the card renders OUTSIDE
		// the rotation list — a song processing for someone else's turn still needs somewhere to show its
		// progress, and there is no slot or singer to attribute it to there.
		seq?: number;
		title: string;
		singerName?: string;
		singerColor?: string;
		/** The singer who queued this is in the room but unreachable (locked phone, pocket). */
		singerAway?: boolean;
		/**
		 * The optimistic add of this entry has not yet been confirmed by the server. Mirrors QueueRow's
		 * `pending`: the primary ✨ Sing flow produces a PROCESSING entry, so the ProcessingCard
		 * is what actually renders during an add — the unconfirmed state has to survive here or it is
		 * invisible on the exact path that creates it. Dims the card, appends the pending marker, and
		 * hides the remove/reorder cluster until the server acks.
		 *
		 * A KIND, not a boolean (XR-PH-10, issue an earlier change): a pending REORDER of a processing entry must not
		 * announce that it is "adding".
		 */
		pending?: 'add' | 'move' | null;
		status: MediaStatus; // queued|downloading|separating|aligning|ready|failed
		pct: number;
		// A processing song is still a QUEUE ENTRY, so it gets the same controls a ready row does: remove
		// (a 1-2 min process is a long time to be stuck on a mis-tap) and reorder (deciding what's next is
		// exactly what you do while something processes). All absent when the card renders outside the
		// rotation (no slot there to act on).
		onremove?: () => void;
		reorderable?: boolean;
		/**
		 * How far this row must slide, in ROWS, to make room for one being dragged past it: -1, 0 or +1.
		 *
		 * The page computes it with `rowShift` and this turns it into a composited `transform` — which is what
		 * makes the live sort animate. ROWS rather than pixels because the pixel height is the page's business
		 * (it measures one row at press time); a component taking px would need the same measurement twice.
		 */
		shift?: -1 | 0 | 1;
		/**
		 * XR-PH-18 — another guest's row while the own-picks reorder mode is open. A processing
		 * song is still a queue entry, so another guest's process is one of the rows the mode has to
		 * de-emphasise; found by driving the mode, where the only non-mine row on screen was a processing
		 * card and stayed at full weight. Surface token, never `opacity` (XR-PH-03) — same rule and same
		 * reason as QueueRow's.
		 */
		dimmed?: boolean;
		/*
		 * `canUp`, `canDown`, `onup` and `ondown` RETIRED (2026-09-21) with the arrow buttons — see the note in
		 * the markup, and `$lib/reorder-mode`'s header for where the non-drag reorder path went.
		 */
	}
	let {
		seq,
		title,
		singerName,
		singerColor = SINGER_COLORS[0],
		singerAway = false,
		pending = null,
		status,
		pct,
		onremove,
		reorderable = false,
		shift = 0,
		dimmed = false
	}: Props = $props();

	// pct is shown separately in the .stage row, so the line itself omits it.
	const stageLabel = $derived(processStageLabel(status));
	// What the unconfirmed marker SAYS — one expression, so a pending reorder cannot re-borrow the
	// add path's word (XR-PH-10, issue an earlier change). Mirrors QueueRow's derivation of the same name.
	const pendingLabel = $derived(pending === 'move' ? 'moving…' : 'adding…');
	// A terminally failed process is NOT in flight. It reaches this card because the singer's own
	// queue slot must say the process died — a dead turn used to render as a plain waiting row,
	// indistinguishable from a turn about to play. On this branch the card drops the progress bar and
	// the sparkle (there is no progress to show) and tints the stage line as a failure. `failed`
	// carries the SongRow's Sing retry, not this card, so nothing here re-processes.
	const failed = $derived(status === 'failed');
	// `pct` is the WORKER'S per-step 0-100. The bar shows OVERALL process completion, not the current
	// step's own progress — otherwise every step reaching 100% filled the whole bar while three of
	// five milestones had not started. overallProcessPct maps the per-step pct into a per-stage
	// band over the shared MEDIA_STAGES, reaching 100 iff status === 'ready'. Rounded for the readout;
	// the bar uses the unrounded fraction so its transition stays smooth.
	const overall = $derived(overallProcessPct(status, pct));
</script>

<!--
	an earlier change: <Item.Root> supplies the row grammar through Item's own `child` snippet, so this file keeps
	the row ELEMENT — its conditional state classes cannot become a component's props, because a `class:`
	directive is not valid on a component and a class handed to one is scoped to the caller. `bare`
	because `.card` paints the row and `.list-row` lays it out.

	The root's `class` attribute stays STATIC: contrast.test.ts derives the row's classes by splitting it
	on whitespace, so an interpolation there can hand it a token it then uses as a regex.
-->
<Item.Root variant="bare" size="bare">
	{#snippet child({ props })}
		<div
			{...props}
			class="qrow proc card list-row"
			class:pending={pending}
			class:failed={failed}
			class:dimmed={dimmed}
			class:shifted={shift !== 0}
			style="--row-shift:{shift}"
		>
			<Item.Media
				><div class="seq">
					{#if seq}{seq}{:else}<Icon name="sparkle" />{/if}
				</div></Item.Media
			>
			<Item.Content>
				<!--
					The sparkle is a SIBLING of `.t`, not nested inside it — the an earlier change shape SongRow already
					uses. `.t` now carries `overflow: hidden` (so a long title ellipsises instead of growing
					the card), and `overflow: hidden` makes the box a scroll container: a mark inside it is
					clipped off-box the moment the title is long enough to need the ellipsis, which is
					precisely the state the mark exists to announce. As a sibling with `flex: 0 0 auto` it
					always paints, and it no longer competes with the title for the last line's characters.
				-->
				<div class="title-line">
					<span class="t">{title}</span>
					{#if !failed}<span class="sparkle"><Icon name="sparkle" /></span>{/if}
				</div>
				{#if singerName}
					<div class="who">
						<!-- Same away marker as QueueRow: a process outlives its owner's attention span, and the room
				     should not learn the singer left only once the song reaches the front.

				     This line names the SINGER and nothing else. It used to end in "· being prepared" (and
				     rendered a bare "being prepared" with no singer), which was a competing phrasing for process
				     state alongside process-phrasing.ts's "Making karaoke..." and SongRow's chip -- and it sat
				     one line above the .stage row that already says exactly that, from the shared source.
				     Redundant AND divergent, so it is gone. -->
						<i class="singer-dot" class:dim={singerAway} style="--singer:{singerColor}"></i>
						{singerName}{#if singerAway}<span class="away">· away</span>{/if}{#if pending}{' · '}<span class="adding"
								>{pendingLabel}</span
							>{/if}
					</div>
				{/if}
			</Item.Content>
			{#if !pending && (onremove || reorderable)}
				<Item.Actions data-align="start">
					<!--
						THE ARROWS ARE GONE FROM HERE TOO (2026-09-21) — two 44px outlined buttons per card to move a
						song one place, reported as taking too much space. A processing card is NOT draggable (it has
						no grip: the live sort moves uniform queued rows, and this card is a different height and a
						different component), so its reorder path is the keyboard nudge on the QUEUED rows around it:
						a card in the queue moves when the rows either side of it do.

						`reorderable` is kept in the props and in this gate deliberately — it is what the route uses
						to say "this position can move at all", and a card that could never move should not grow a
						remove button in a row labelled as if it could.
					-->
					{#if onremove}
						<Button
							variant="outline"
							size="icon"
							press="accent2"
							aria-label="remove from queue"
							onclick={() => onremove?.()}><Icon name="close" /></Button
						>
					{/if}
				</Item.Actions>
			{/if}
			<div class="progress">
				{#if failed}
					<!-- No bar for a dead process: there is no progress to show, and a bar stuck near 0 reads as a
			     stalled process rather than a failed one. The stage line alone carries "Couldn't make
			     karaoke", tinted as a failure so the card is legible as broken at a glance. -->
					<div class="stage bad" aria-live="polite"><span>{stageLabel}</span></div>
				{:else}
					<div class="bar-slot"><Progress value={overall} aria-label="Process progress" /></div>
					<div class="stage" aria-live="polite"><span>{stageLabel}</span><span>{Math.round(overall)}%</span></div>
				{/if}
			</div>
		</div>
	{/snippet}
</Item.Root>

<style>
	/*
	 * `.meta` and `.actions` moved to ui/item as Encore's shared row grammar — both were
	 * verbatim duplicates of QueueRow's. `.seq`, `.t` and `.who` STAY, because they declare COLOUR and
	 * contrast.test.ts reasons about this row by reading those rules in this file (its exclusion list
	 * names "the .seq bubble" directly, and a sibling arm reads the singer dot's own rule).
	 */
	/* .list-row gives the padding, margin and gap; ProcessingCard overrides its display to a two-row
	   grid. Row 1: seq (auto) / title+singer (1fr) / actions (auto). Row 2: the progress block, spanning
	   every column so it always gets the card's full inner width — the actions cluster can no longer eat
	   into the bar or the stage line. align-items on row 1 keeps the seq bubble and the
	   action cluster anchored to the title line rather than floating in a taller card. */
	.qrow.proc {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: flex-start;
		row-gap: 0;
	}
	/* The progress block is the second grid row and spans from the first column through the last,
	   regardless of whether the actions column rendered. This is the fix's load-bearing declaration. */
	.progress {
		grid-column: 1 / -1;
	}
	.proc {
		background: linear-gradient(var(--card), var(--card-tint));
		border-color: var(--line-tint);
	}
	/* A dead process. The card's own border reads as broken before the text is, matching the red
	   "Couldn't make karaoke" chip the search row shows for the same media, and the stage line takes
	   the danger ink instead of the in-flight --warn. Borrows the shared --danger tokens rather than a
	   fourth palette. */
	.proc.failed {
		border-color: var(--danger-line);
	}
	.stage.bad {
		color: var(--danger-ink);
	}
	/* Optimistic-add markers, matching QueueRow: warn-tint the CARD SURFACE and the
	   appended `adding…` word so an unconfirmed processing entry reads as not-yet-committed.
	   NOT with opacity. This rule was `opacity: 0.55`, which flattened the whole card and
	   composited it against --bg, so the stage line -- `Making karaoke… / 68%`, the only thing telling
	   a singer the process is moving, on the card the an earlier change fix says actually renders during the primary
	   ✨ Sing flow -- rendered at 3.76:1 against a 4.5:1 floor, and the singer dot at 2.57:1 under its
	   3:1 floor. Retuning the alpha cannot work (the byline needs 0.807, indistinguishable from 1.0),
	   so the state moved to app.css's --warn-bg/--warn-line status pair and the subtree keeps full
	   opacity: --warn now reads 8.57:1 and the dot 5.19:1. Must stay AFTER .proc so a pending card
	   overrides its processing gradient; `.proc.failed`'s border wins on specificity, deliberately, so a
	   dead process still reads as broken rather than as merely unconfirmed.
	   contrast.test.ts's `no card root dims its own subtree with opacity` reds if opacity comes back. */
	.pending {
		background: var(--warn-bg);
		border-color: var(--warn-line);
	}
	.adding {
		color: var(--warn);
	}
	/*
	 * XR-PH-18 — another guest's processing row while the reorder mode is open. Mirrors QueueRow's
	 * `.dimmed` exactly, token for token, because the two row kinds sit in the same list and a mode
	 * that de-emphasised only one of them would read as "this row is special" rather than as
	 * "this row is not a target". Surface + border, never `opacity` (XR-PH-03) — this card's own
	 * `.pending` comment above records what subtree opacity did to it.
	 * After `.pending` for the same source-order reason that rule documents.
	 */
	.dimmed {
		background: var(--bg2);
		border-color: var(--line);
	}
	.seq {
		width: 26px;
		height: 26px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font-size: var(--ph-text-sm);
		font-weight: 700;
		background: var(--card2);
		color: var(--ink-dim);
		flex: 0 0 auto;
	}
	/* Byte-identical to QueueRow's `.t`, deliberately: the two row kinds sit in the SAME phone list, so a
	   long title that grew THIS card while the queue row beside it ellipsised read as a layout bug rather
	   than as a difference. This rule was `font-weight: 600` and nothing else, so an unbreakable title
	   pushed the `1fr` title column wider and the whole card with it. `overflow: hidden` also makes this
	   box a scroll container, whose inline min-content contribution is 0 — that is what stops the grid
	   track being forced wide, and it is the same mechanism QueueRow relies on (neither needs
	   `min-width: 0`). */
	/* The title and the processing mark share one flex line, so the mark is a sibling that always paints
	   while the title takes the ellipsis (the an earlier change shape, matching SongRow). */
	.title-line {
		display: flex;
		align-items: baseline;
		min-width: 0;
	}
	.t {
		flex: 0 1 auto;
		min-width: 0;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* Spacing via margin, matching SongRow — one mechanism, not a literal space in one place and
	   CSS in the other. `flex: 0 0 auto` is load-bearing: as a flex sibling of a shrinking title the
	   mark is otherwise the thing that shrinks, which is the an earlier change defect in a different disguise. */
	.sparkle {
		flex: 0 0 auto;
		color: var(--warn);
		display: inline-grid;
		place-items: center;
		margin-left: 5px;
	}
	.who {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
		margin-top: var(--space-3xs);
	}
	.who i.dim {
		opacity: 0.5;
	}
	.who .away {
		color: var(--warn);
		margin-left: 0.35em;
	}
	/* The dot's `flex: 0 0 auto is load-bearing` HERE, not just QueueRow parity (an earlier fix) — and since
	   the primitive-adoption pass the declaration itself lives in app.css's shared `.singer-dot` rule, because this
	   dot was one of four byte-identical copies. The measured reasoning stays with the card it was
	   measured on. .who is a
	   `display: flex` container; the dot is an empty flex item whose automatic minimum size is 0, so
	   without a non-shrinking basis it is the item that gives up width first. When the actions cluster
	   renders (the normal in-rotation card) it cuts .who from ~282px to 134px (actions = 3x44 + 2x8 =
	   148px), and a name at the 32-char profile maxlength then overflows it. How far the dot shrinks
	   depends on whether the name can WRAP, not on QueueRow's trio: what holds a name's width is the
	   absence of a break opportunity, and an empty dot has no intrinsic content to protect it either
	   way. So without that shared rule (measured at 390px on the fixture below):
	     • a name with spaces (e.g. "Christopher Alexander Montgomery") wraps, sharing the deficit, and
	       the dot shrinks 10px -> ~5.45px — a ~45% loss;
	     • an UNBROKEN name at the maxlength (e.g. "ChristopherAlexanderMontgomeryJr", 32 chars, reachable — both
	       name fields are maxlength=32 and nothing rejects a single token, cf. an earlier change) cannot wrap, so
	       the dot absorbs the ENTIRE deficit and collapses to 0px — the singer's colour VANISHES from
	       their own card. colors.ts:12-14 calls that dot "the only thing telling two singers apart
	       besides the name", so the real worst case is total loss, not a cosmetic shrink.
	   The mechanism is the same as QueueRow's 0px collapse in an earlier change; the only difference is that
	   QueueRow.svelte's .who adds `min-width:0; white-space:nowrap; overflow:hidden`, which makes EVERY
	   name unbreakable (that is why an earlier change hit 0px even with a spaced name), whereas here only an unbroken
	   token is unbreakable. design-system.test.ts's identity-dot guard reds if the shared rule drops the
	   basis OR if a local copy reappears without it; the long-name fixture below carries an unbroken
	   maxlength name so the 0px case is eyes-on. */
	/*
	 * `.bar` and its `<i>` fill are ui/progress now — the same idiom lived in two components,
	 * so this consolidated a duplicate. The swap also buys what neither hand-rolled bar had:
	 * `role="progressbar"` with aria-valuenow, so a process's progress is finally visible to assistive
	 * tech. Spacing from the element above stays HERE, because that is this component's layout rather
	 * than the bar's own metric.
	 */
	.bar-slot {
		margin-top: 9px;
	}
	/* GPU-composited fill: scaleX from the left edge, never animates layout width */
	.stage {
		display: flex;
		justify-content: space-between;
		font-size: var(--ph-text-xs);
		color: var(--warn);
		margin-top: 7px;
	}
	/* Identical to QueueRow's icon buttons, so the controls don't visually reshuffle when a song
	   finishes processing and its card becomes a row. The card is taller than a row, so the cluster aligns
	   to the title line (flex-start) rather than the card's centre — its own comment already claimed
	   this, but align-items:center floated the buttons mid-card. */
	/* Sizing, radius, surface and glyph size come from <Button variant="icon"> in components/ui/button.
	   `.icon-btn` in app.css was deleted in an earlier change S1b when its ten consumers became that variant. */
	/*
	 * THE ROWS THE DRAGGED ONE PASSES SLIDE OUT OF ITS WAY, one place each — which is what makes this a
	 * LIVE SORT rather than a drag over drawn targets (see routes/+page.svelte and `rowShift`).
	 *
	 * `--row-shift` is a COUNT of rows, written by the page from the pure `rowShift`, and `--row-h` is the
	 * one height it measured at press time. Multiplying here keeps pixels out of the page's markup and keeps
	 * the movement a `transform`, which is the only kind `motion.test.ts` allows to be animated.
	 *
	 * THE TRANSITION IS GATED, not unconditional — this is the one interpolated movement on this row, so
	 * unlike `.moving` (a 1:1 response to the finger, XR-PH-06 by construction) it has a duration that
	 * `prefers-reduced-motion` must be able to remove. Under `reduce` no transition is declared at all and
	 * the rows simply appear in their new places, which is still a correct live sort.
	 */
	.shifted {
		transform: translateY(calc(var(--row-shift, 0) * var(--row-h, 0px)));
	}
	@media (prefers-reduced-motion: no-preference) {
		.shifted {
			transition: transform 160ms cubic-bezier(0.32, 0.72, 0, 1);
		}
	}
</style>
