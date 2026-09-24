<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { SINGER_COLORS } from '$lib/contract';
	import { overallProcessPct } from '$lib/process-progress';
	import Icon from '$lib/ui/Icon.svelte';
	import type { MediaStatus } from '$lib/contract';
	import { processStageLabel } from '$lib/phrasing/process-phrasing';
	import { Progress } from '$lib/components/ui/progress';
	import * as Item from '$lib/components/ui/item';
	interface Props {
		// Both absent when the card renders OUTSIDE the rotation list, where there is no slot or singer to attribute to.
		seq?: number;
		title: string;
		singerName?: string;
		singerColor?: string;
		/** The singer who queued this is in the room but unreachable (locked phone, pocket). */
		singerAway?: boolean;
		/** The optimistic add is unconfirmed. This state has to exist HERE, not only on QueueRow: the primary Sing flow
		 * produces a PROCESSING entry, so this card is what renders during an add, and the unconfirmed state would
		 * otherwise be invisible on the exact path that creates it. A KIND, never a boolean: a pending REORDER must not
		 * announce that it is "adding". */
		pending?: 'add' | 'move' | null;
		status: MediaStatus; // queued|downloading|separating|aligning|ready|failed
		pct: number;
		// A processing song is still a QUEUE ENTRY, so it gets the same controls a ready row does — a minutes-long
		// process is a long time to be stuck on a mis-tap. All absent outside the rotation, where there is no slot.
		onremove?: () => void;
		reorderable?: boolean;
		/** The caller passes `gripVisible()` from `$lib/reorder-mode`, never a raw boolean. This card is draggable in
		 * the same list as the uniform rows: `liveSortTarget` counts crossings against every row's measured CENTRE
		 * rather than dividing by one height, which is what makes a mixed-height list exact in both directions. */
		grip?: boolean;
		/** The queue entry's id, published on the grip as `data-grip` so focus can be re-found after a move. */
		gripId?: string;
		ongripdown?: (e: PointerEvent) => void;
		/** This is the card being dragged. Its offset is `dragY`, applied as a transform. */
		moving?: boolean;
		/** Live pointer offset in px for the moving card. CSS-var driven — see the `.moving` rule. */
		dragY?: number;
		/** A keyboard step from the grip: -1 for Arrow Up, +1 for Arrow Down — the non-drag path. */
		onnudge?: (delta: number) => void;
		/** In ROWS rather than pixels: the pixel height is the page's business, and a component taking px would need
		 * the same measurement twice. */
		shift?: -1 | 0 | 1;
		/** A processing song is still a queue entry, so it is one of the rows the reorder mode must de-emphasise.
		 * Surface token, never `opacity`. */
		dimmed?: boolean;
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
		grip = false,
		gripId,
		ongripdown,
		onnudge,
		moving = false,
		dragY = 0,
		shift = 0,
		dimmed = false
	}: Props = $props();

	// The pct is shown separately in the stage row, so the line itself omits it.
	const stageLabel = $derived(processStageLabel(status));
	// One expression for both unconfirmed states, so a pending reorder cannot re-borrow the add path's word.
	const pendingLabel = $derived(pending === 'move' ? 'moving…' : 'adding…');

	/** Which way the position number just moved — same shape and same three constraints as QueueRow's, so see the
	 * note there. `seq` is OPTIONAL here (an unnumbered job shows a sparkle), so an absent number is not a
	 * direction: it seeds the record and writes nothing. */
	let seqDir = $state(0);
	let prevSeq: number | undefined;
	$effect.pre(() => {
		if (seq === undefined || prevSeq === undefined || seq === prevSeq) {
			prevSeq = seq;
			return;
		}
		seqDir = seq > prevSeq ? 1 : -1;
		prevSeq = seq;
	});
	// A terminally failed process is NOT in flight, and it reaches this card because the singer's own queue slot must
	// say the process died. This branch drops the bar and the sparkle; the RETRY lives on SongRow, not here.
	const failed = $derived(status === 'failed');
	// `pct` is the worker's PER-STEP 0-100; the bar must show OVERALL completion, or every step reaching 100% fills
	// the whole bar while later milestones have not started. Rounded only for the readout.
	const overall = $derived(overallProcessPct(status, pct));
</script>

<!-- Item.Root supplies the row grammar through its `child` snippet, so this file keeps the row ELEMENT: a `class:`
	directive is not valid on a component and a class handed to one is scoped to the caller. THE ROOT'S `class`
	ATTRIBUTE MUST STAY STATIC: contrast.test.ts derives the row's classes by splitting it on whitespace. -->
<Item.Root variant="bare" size="bare">
	{#snippet child({ props })}
		<div
			{...props}
			class="qrow proc card list-row"
			class:pending={pending}
			class:failed={failed}
			class:dimmed={dimmed}
			class:moving={moving}
			class:shifted={shift !== 0}
			style="--drag-y:{dragY}px; --row-shift:{shift}"
		>
			<!-- The digit rolls on a position change exactly as QueueRow's does: the two kinds share ONE list, and a drag
					that rolled one and jumped the other reads as broken. Keyed on the number, so a change swaps the element. -->
			<Item.Media>
				<!-- THE GRIP LEADS THE ROW, deliberately identical to QueueRow's: these two kinds sit in ONE list, and a card
						you cannot pick up beside rows you can reads as broken rather than different. Withheld while a move is unconfirmed. -->
				{#if grip && !pending}
					<Button
						variant="ghost"
						size="icon"
						press="grab"
						aria-label="Reorder — drag, or use arrow keys"
						aria-keyshortcuts="ArrowUp ArrowDown"
						data-grip={gripId}
						onpointerdown={(e) => ongripdown?.(e)}
						onkeydown={(e) => {
							if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
							// The list owns what a step means; this only stops the page scrolling under the guest while they use it.
							e.preventDefault();
							onnudge?.(e.key === 'ArrowUp' ? -1 : 1);
						}}><Icon name="grip" /></Button
					>
				{/if}
				<div class="seq" style="--seq-dir:{seqDir}">
					{#if seq}{#key seq}<span class="n">{seq}</span>{/key}{:else}<Icon name="sparkle" />{/if}
				</div></Item.Media
			>
			<Item.Content>
				<!-- THE SPARKLE MUST STAY A SIBLING of `.t`, never nested inside it: `.t` carries `overflow: hidden`, which makes
						it a scroll container, so a mark inside is clipped off-box exactly when the title is long enough to need the
						ellipsis — precisely the state the mark exists to announce. -->
				<div class="title-line">
					<span class="t">{title}</span>
					{#if !failed}<span class="sparkle"><Icon name="sparkle" /></span>{/if}
				</div>
				{#if singerName}
					<div class="who">
						<!-- Same away marker as QueueRow: a process outlives its owner's attention span. THIS LINE NAMES THE SINGER AND
								NOTHING ELSE — process state belongs to the stage row below it, from the shared phrasing source. -->
						<i class="singer-dot" class:dim={singerAway} style="--singer:{singerColor}"></i>
						{singerName}{#if singerAway}<span class="away">· away</span>{/if}{#if pending}{' · '}<span class="adding"
								>{pendingLabel}</span
							>{/if}
					</div>
				{/if}
			</Item.Content>
			{#if !pending && (onremove || reorderable)}
				<Item.Actions data-align="start">
					<!-- Reordering lives on the GRIP above. `reorderable` stays in this gate deliberately: it is how the route says
							the position can move at all, and a card that could never move should not grow a remove button. -->
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
					<!-- No bar for a dead process: a bar stuck near 0 reads as stalled rather than failed, so the tinted stage
							line carries the state on its own. -->
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
	/* `.seq`, `.t` and `.who` must STAY in this file, because they declare COLOUR and contrast.test.ts reasons about
	   this row by reading those rules here. `.list-row` gives the padding, margin and gap; this card overrides the
	   display to a two-row grid, so the actions cluster cannot eat into the bar. */
	.qrow.proc {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: flex-start;
		row-gap: 0;
	}
	/* Spans first column through last whether or not the actions column rendered — load-bearing. */
	.progress {
		grid-column: 1 / -1;
	}
	.proc {
		background: linear-gradient(var(--card), var(--card-tint));
		border-color: var(--line-tint);
	}
	/* A dead process: the border reads as broken before the text does, matching the failure chip the search row
	   shows for the same media, and the stage line takes the danger ink instead of the in-flight --warn. */
	.proc.failed {
		border-color: var(--danger-line);
	}
	.stage.bad {
		color: var(--danger-ink);
	}
	/* The unconfirmed state is a warn tint on the CARD SURFACE, never a subtree opacity: an alpha here composites the
	   stage line to 3.76:1 against a 4.5:1 floor and the singer dot to 2.57:1, and the value that clears AA is
	   indistinguishable from 1.0. MUST STAY AFTER `.proc` so a pending card overrides its processing gradient;
	   `.proc.failed`'s border wins on specificity, deliberately. contrast.test.ts reds if the opacity comes back. */
	.pending {
		background: var(--warn-bg);
		border-color: var(--warn-line);
	}
	.adding {
		color: var(--warn);
	}
	/* Token for token QueueRow's `.dimmed`, because the two kinds sit in the same list and de-emphasising only one
	   reads as "this row is special". Surface and border, never opacity. After `.pending`, for the same reason. */
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
		/* The bubble is the roll's window — the arriving digit is clipped by the circle on its way in. */
		overflow: hidden;
	}
	/* Byte-identical to QueueRow's roll: one list, one behaviour. `from` only, so the landing state is the
	   element's own, and a `--seq-dir` of 0 degrades it to a fade. */
	@media (prefers-reduced-motion: no-preference) {
		.seq .n {
			animation: seq-roll 180ms cubic-bezier(0.32, 0.72, 0, 1);
		}
		@keyframes seq-roll {
			from {
				transform: translateY(calc(var(--seq-dir, 0) * 110%));
				opacity: 0;
			}
		}
	}
	/* `.t` is byte-identical to QueueRow's deliberately: the two kinds sit in the SAME list, so a long title that grew
	   THIS card while the row beside it ellipsised reads as a layout bug. `overflow: hidden` makes the box a scroll
	   container, whose inline min-content contribution is 0 — which stops the `1fr` track being forced wide. */
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
	/* Spacing via margin, matching SongRow. `flex: 0 0 auto` is load-bearing: as a flex sibling of a shrinking title,
	   the mark is otherwise the thing that shrinks. */
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
	/* The singer dot's `flex: 0 0 auto is load-bearing` on this card, and the declaration itself lives in app.css's
	   shared `.singer-dot` rule. `.who` is a flex container and the dot an empty item whose automatic minimum size is
	   0, so it is the item that gives up width first: with the actions cluster rendered `.who` narrows to roughly
	   134px, and an UNBROKEN name at the profile maxlength cannot wrap, so the dot absorbs the whole deficit and
	   collapses to 0px — and that dot is the only thing telling two singers apart besides the name. The gallery
	   carries an unbroken maxlength fixture so the case stays eyes-on. */
	/* Spacing above the bar stays here: it is this card's layout, not the bar's own metric. */
	.bar-slot {
		margin-top: 9px;
	}
	.stage {
		display: flex;
		justify-content: space-between;
		font-size: var(--ph-text-xs);
		color: var(--warn);
		margin-top: 7px;
	}
	/* THE DRAGGED CARD FOLLOWS THE FINGER — byte for byte QueueRow's `.moving`, because the two kinds are dragged in
	   ONE list by one gesture. No transition and no keyframe, which is what makes reduced motion hold by
	   construction; `pointer-events: none`, or a card translated under the finger answers every hit-test. */
	.moving {
		transform: translateY(var(--drag-y, 0px));
		position: relative;
		z-index: var(--z-row-lifted);
		border-color: var(--accent);
		pointer-events: none;
	}
	/* The live sort, in the same terms QueueRow uses: `--row-shift` is a COUNT of rows and `--row-h` the one
	   height the page measured at press time, so pixels stay out of the markup. The transition is GATED,
	   unlike `.moving`, because it is the one interpolated movement here. */
	.shifted {
		transform: translateY(calc(var(--row-shift, 0) * var(--row-h, 0px)));
	}
	@media (prefers-reduced-motion: no-preference) {
		.shifted {
			transition: transform 160ms cubic-bezier(0.32, 0.72, 0, 1);
		}
	}
</style>
