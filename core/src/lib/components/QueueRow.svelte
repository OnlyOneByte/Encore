<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { SINGER_COLORS } from '$lib/contract';
	import Icon from '$lib/ui/Icon.svelte';
	import * as Item from '$lib/components/ui/item';
	interface Props {
		seq: number; // 1-based display position
		title: string;
		singerName: string;
		singerColor?: string;
		mine?: boolean;
		up?: boolean; // currently playing / next up (accent the seq bubble)
		/** The TV could not play this turn's song and the rotation HOLDS it: it takes no number, because it is not coming
		 *  up, and the bubble carries a warning mark instead. Say why in `subtitle`. */
		held?: boolean;
		/** The singer is in the room but unreachable. Surfaced here because the room decides BY HAND whether
		 * to skip an absent singer's turn, and without it there is nothing to say a decision is due. */
		singerAway?: boolean;
		subtitle?: string; // e.g. "now playing", "after Liam"
		pending?: 'add' | 'move' | null; // optimistic, not yet confirmed — see pendingLabel
		removable?: boolean; // show the remove affordance (mine, not currently playing)
		/** In ROWS rather than pixels: the pixel height is the page's business (it measures one row at press time),
		 * and a component taking px would need the same measurement twice. */
		shift?: -1 | 0 | 1;
		/** Show the drag grip. The caller passes `gripVisible()` from `$lib/reorder-mode`, never a raw boolean:
		 * the grip is a promise that a move will land, and the conditions for that are argued there. */
		grip?: boolean;
		/** No grip, but keep its column so the number lines up with rows that have one. */
		gripSlot?: boolean;
		/** This is the row being dragged. Its offset is `dragY`, applied as a transform. */
		moving?: boolean;
		/** Live pointer offset in px for the moving row. CSS-var driven — see the `.moving` rule. */
		dragY?: number;
		ongripdown?: (e: PointerEvent) => void;
		/** Published on the grip as `data-grip`, and focus return DEPENDS on it: entering the mode inserts drop-slot
		 * buttons into this list, so Svelte recreates the row's DOM and the grip the guest pressed is a detached node by
		 * the time the mode closes. A stable attribute survives the re-render, so the page re-finds the grip by id. */
		gripId?: string;
		/** A keyboard step from the grip: -1 for Arrow Up, +1 for Arrow Down. */
		onnudge?: (delta: number) => void;
		onremove?: () => void;
		/** The list's hold (app.css `[data-hold]`): `dy` px from where the row was drawn before a patch moved it. */
		hold?: { dy: number; turn: 'a' | 'b' };
	}
	let {
		seq,
		title,
		singerName,
		// A default is required: without one `--singer` resolves against undefined and the identity dot renders invisible.
		singerColor = SINGER_COLORS[0],
		mine = false,
		up = false,
		held = false,
		singerAway = false,
		subtitle = '',
		pending = null,
		removable = false,
		shift = 0,
		grip = false,
		gripSlot = false,
		moving = false,
		dragY = 0,
		ongripdown,
		gripId,
		onremove,
		onnudge,
		hold
	}: Props = $props();

	/** One expression for both unconfirmed states, so a pending MOVE cannot drift back into the add path's word. */
	const pendingLabel = $derived(pending === 'move' ? 'moving…' : 'adding…');

	/** Which way the position number just moved, read by the bubble as `--seq-dir`. `$effect.pre`, never `$effect`:
	 * the direction must be on the element BEFORE the keyed block replaces the digit, because an animation reads its
	 * keyframes when it starts and a later write cannot retune one already running. `prevSeq` is a PLAIN `let` — as
	 * state it would put this effect in a loop with itself — and it is seeded INSIDE the effect, because
	 * `let prevSeq = seq` is a `state_referenced_locally` warning and `bun run check` is held at 0 warnings. */
	let seqDir = $state(0);
	let prevSeq: number | undefined;
	$effect.pre(() => {
		if (prevSeq === undefined || seq === prevSeq) {
			prevSeq = seq;
			return;
		}
		seqDir = seq > prevSeq ? 1 : -1;
		prevSeq = seq;
	});
</script>

<!-- Item.Root supplies the row GRAMMAR while this file keeps the row ELEMENT through Item's `child` snippet: the root
	carries five conditional state classes and the drag offset as a custom property, and a `class:` directive is not
	valid on a component. The root's `class` attribute is written AFTER the spread so it wins. -->
<Item.Root variant="bare" size="bare">
	{#snippet child({ props })}
		<div
			{...props}
			class={['qrow', 'card', 'list-row', 'pop-in', { mine, up, pending, moving, shifted: shift !== 0 }]}
			data-hold={hold?.turn}
			style="--drag-y:{dragY}px; --row-shift:{shift}; --hold-from:{hold?.dy ?? 0}px"
		>
			<Item.Media>
				<!-- THE GRIP LEADS THE ROW, as a handle rather than a fourth action on it. `press="grab"` is not styling: that
						variant is where `cursor: grab` and the `touch-action: none` the drag needs are declared, and the cursor must
						live on this control and never on a row. IT IS ALSO THE NON-DRAG PATH — Arrow Up/Down while it has focus moves
						the row one place and commits, which is SC 2.5.7's single-pointer alternative and SC 2.1.1's keyboard
						operability. A second reorder against a position the server has not agreed to is DECLINED IN THE HANDLERS
						and never by withholding the button: this `{#if}` used to read `grip && !pending`, which removed the grip the
						guest had just pressed, and a removed element takes focus to `<body>` with it. Measured — one ArrowDown moved
						the row and left `document.activeElement` as BODY, so the second press reordered nothing and a second move
						meant tabbing in from the top of the document again. `aria-disabled` announces the decline; the real `disabled`
						attribute would blur the button and reintroduce the same defect. -->
				{#if grip}
					<Button
						variant="ghost"
						size="icon"
						press="grab"
						aria-label="Reorder — drag, or use arrow keys"
						aria-keyshortcuts="ArrowUp ArrowDown"
						aria-disabled={pending ? 'true' : undefined}
						data-grip={gripId}
						onpointerdown={(e) => {
							if (pending) return;
							ongripdown?.(e);
						}}
						onkeydown={(e) => {
							if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
							// The list owns what a step means; this only stops the page scrolling under the guest while they use it.
							e.preventDefault();
							// The decline that `!pending` on the block above used to make by deletion. `preventDefault` first, so an
							// unconfirmed row does not answer the press by scrolling the grip out from under the guest instead.
							if (pending) return;
							onnudge?.(e.key === 'ArrowUp' ? -1 : 1);
						}}><Icon name="grip" /></Button
					>
				{:else if gripSlot}
					<!-- A row someone else cannot move (proposal 14's held On deck) keeps the handle's COLUMN, empty and inert, so
						its number lines up with every row that has one. Not a button: nothing to press, no focus stop. -->
					<span class="size-tap shrink-0" aria-hidden="true" data-grip-slot></span>
				{/if}
				<!-- THE NUMBER IS KEYED ON ITSELF, so a change swaps the element rather than mutating a text node — which gives the
						digit an entrance with no class-toggle timer and no geometry read, and a geometry read throws on the mount rung. -->
				<div class={['seq', { held }]} style="--seq-dir:{seqDir}">
					{#if held}<Icon name="warning" />{:else}{#key seq}<span class="n">{seq}</span>{/key}{/if}
				</div>
			</Item.Media>
			<Item.Content>
				<div class="t">{title}</div>
				<!-- The singer line is fenced from the formatter because it is BOTH whitespace-load-bearing and pinned by a guard:
						the separators must stay EXPRESSIONS rather than literal text, since Svelte trims the leading whitespace of a text
						node that opens a block and welds the dot to the name. The fence sits on the ELEMENT — prettier-ignore skips a
						bare mustache run. -->
				<!-- prettier-ignore -->
				<div class="who">
					<i class={['singer-dot', { dim: singerAway }]} style="--singer:{singerColor}"></i>
					{singerName}{#if singerAway}<span class="away">· away</span
						>{/if}{#if subtitle}{' · '}{subtitle}{/if}{#if pending}{' · '}<span class="adding">{pendingLabel}</span>{/if}
				</div>
			</Item.Content>
			{#if !pending}
				<Item.Actions>
					<!-- ONE action on the right. A reorder without a drag lives on the GRIP above (Arrow Up/Down), which keeps
							SC 2.5.7 / 2.1.1 satisfied for no layout at all — see `$lib/reorder-mode`. -->
					{#if removable}
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
		</div>
	{/snippet}
</Item.Root>

<style>
	/* Geometry comes from `.list-row` in app.css, shared with the search row and the processing card. The entry
	   animation is app.css's `.pop-in`, already inside a no-preference query — do NOT re-declare a local
	   `@keyframes pop` here, which is how an unguarded copy gets shipped. */
	.mine {
		border-color: var(--line-tint);
		background: linear-gradient(var(--card), var(--card-tint));
	}
	/* The unconfirmed state is signalled on the SURFACE, never with opacity: a subtree alpha here composites the
	   explanatory text and the singer dot under their floors, and the value that clears AA is indistinguishable from 1.0.
	   MUST STAY AFTER `.mine`: both are single-class, so source order is what lets pending override its own gradient. */
	.pending {
		background: var(--warn-bg);
		border-color: var(--warn-line);
	}
	/* `.seq` must STAY here: it sets both a colour and a background, and a contrast question about this row has to be
	   answerable from this file. The primitive carries the BOX; the colours stay attributable here. */
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
		/* The bubble is the roll's WINDOW: the arriving digit must be clipped on the way in, or the old number is
			   briefly legible above the new one. */
		overflow: hidden;
	}
	/* `from` only, so the landing state is the element's own and nothing is restated; a `--seq-dir` of 0
	   degrades the roll to a plain fade. Under Reduce Motion the number simply changes. */
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
	.seq.held {
		color: var(--warn);
	}
	.up .seq {
		background: var(--accent);
		color: var(--on-accent);
	}
	.t {
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* Same truncation as `.t`: a long name plus an appended away or adding badge would otherwise wrap and
	   change the row's height between states. `min-width: 0` is what lets the flex item shrink at all. */
	.who {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
		margin-top: var(--space-3xs);
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* Hue kept — it is the singer's identity — and only presence dimmed. */
	.who i.dim {
		opacity: 0.5;
	}
	.away {
		color: var(--warn);
		margin-left: 0.35em;
	}
	.adding {
		color: var(--warn);
	}
	/* NO `transition` AND NO KEYFRAME HERE, which is what makes this reduced-motion-safe by construction: nothing is
	   interpolated, so there is no duration to zero out, and the position is a 1:1 response to the pointer. It is also
	   why no drag library is used — a library animates the settle in JS, where no CSS-level check could see it. */
	.moving {
		transform: translateY(var(--drag-y, 0px));
		/* Above its siblings while it travels, so it is not clipped by the next row's surface. */
		position: relative;
		z-index: var(--z-row-lifted);
		/* A BORDER, so the 3:1 non-text floor applies and --accent clears it on both dark surfaces. */
		border-color: var(--accent);
		/* Transparent to hit-testing, and not cosmetic: translated under the finger it is the topmost element at
		   the pointer, so it is what `elementFromPoint` returns instead of the drop slot beneath. */
		pointer-events: none;
	}
	/* THE ROWS THE DRAGGED ONE PASSES SLIDE OUT OF ITS WAY, which is what makes this a LIVE SORT. `--row-shift` is a
	   COUNT of rows and `--row-h` the one height measured at press time, so pixels stay out of the markup. THE
	   TRANSITION IS GATED, unlike `.moving`: it is the one interpolated movement on this row. */
	.shifted {
		transform: translateY(calc(var(--row-shift, 0) * var(--row-h, 0px)));
	}
	@media (prefers-reduced-motion: no-preference) {
		.shifted {
			transition: transform 160ms cubic-bezier(0.32, 0.72, 0, 1);
		}
	}
</style>
