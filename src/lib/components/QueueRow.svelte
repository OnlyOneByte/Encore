<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	// A row in the rotation queue. Ported from docs/mocks.
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
		/**
		 * The singer who queued this is in the room but unreachable — a locked phone or a pocket.
		 * Surfaced HERE because the room decides by hand whether to skip an absent singer's turn, and the
		 * phone is where the skip control lives. Without it, a departed singer's song looked entirely
		 * normal and nobody knew there was a decision to make.
		 */
		singerAway?: boolean;
		subtitle?: string; // e.g. "now playing", "after Liam"
		pending?: 'add' | 'move' | null; // optimistic, not yet confirmed — see pendingLabel
		removable?: boolean; // show the remove affordance (mine, not currently playing)
		/*
		 * `reorderable` RETIRED (2026-09-21) with the arrow buttons that were its only reader. Whether this row
		 * can be moved is `grip` — the caller's `gripVisible()` predicate — and whether it may be moved RIGHT
		 * NOW is `pending`. Two props for one question was how a row could show a grip and dead arrows.
		 */
		/**
		 * How far this row must slide, in ROWS, to make room for one being dragged past it: -1, 0 or +1.
		 *
		 * The page computes it with `rowShift` and this turns it into a composited `transform` — which is what
		 * makes the live sort animate. ROWS rather than pixels because the pixel height is the page's business
		 * (it measures one row at press time); a component taking px would need the same measurement twice.
		 */
		shift?: -1 | 0 | 1;
		/**
		 * show the drag grip. The caller passes `gripVisible()` from `$lib/reorder-mode`,
		 * never a raw boolean: the grip is a promise that a `move` will land, and the four conditions
		 * that make it true are argued there. Independent of `reorderable` on purpose — the up/down
		 * buttons are the single-pointer alternative and must not be coupled to the grip.
		 */
		grip?: boolean;
		/**
		 * this row is not a legal drop target while the reorder mode is open (it is another
		 * guest's song). De-emphasised with a SURFACE token, never `opacity`:, and the
		 * `.pending` comment below records what subtree opacity did to this very row's contrast.
		 */
		dimmed?: boolean;
		/** This is the row being dragged. Its offset is `dragY`, applied as a transform. */
		moving?: boolean;
		/** Live pointer offset in px for the moving row. CSS-var driven — see the `.moving` rule. */
		dragY?: number;
		/** Pointer press on the grip: begins the drag. */
		ongripdown?: (e: PointerEvent) => void;
		/**
		 * Click / keyboard activation of the grip: opens the mode without a pointer drag. Receives the
		 * grip ELEMENT, not nothing: the rule requires focus to return to the grip that opened the mode,
		 * and the page cannot name that element on its own. Driving the mode is what found this — the
		 * handler passed `null`, so a keyboard guest who opened the mode and pressed Escape was left with
		 * focus on `<body>`.
		 */
		ongrip?: (el: HTMLElement | null) => void;
		/**
		 * The queue entry's id, published on the grip as `data-grip`.
		 *
		 * Focus return cannot be done by holding the element: entering the mode inserts the
		 * drop-slot buttons into this list, and Svelte recreates the row's DOM around them — so the grip
		 * the guest pressed is a detached node by the time the mode closes, and focusing it puts focus
		 * nowhere. Measured by driving the mode in a real browser, where `activeElement` was `<body>` after Escape even
		 * though the handler had called `focus()`. A stable attribute is what survives the re-render, so
		 * the page re-finds the grip by id instead.
		 */
		gripId?: string;
		/*
		 * `canUp`, `canDown`, `onup` and `ondown` RETIRED (2026-09-21) with the arrow buttons. The
		 * single-pointer reorder they provided is `onnudge` below, on the grip — same one-place step, no row
		 * of controls. The `disabled` state they carried is expressed by the list declining a nudge at the
		 * ends (`keyboardMoveTarget` returns null) rather than by two buttons that are dead most of the time.
		 */
		/** A keyboard step from the grip: -1 for Arrow Up, +1 for Arrow Down. */
		onnudge?: (delta: number) => void;
		onremove?: () => void;
	}
	let {
		seq,
		title,
		singerName,
		// Defaulted to match sibling ProcessingCard: without a fallback, `--singer:{singerColor}`
		// resolves against `undefined`, `background: var(--singer)` has no value, and the singer
		// identity dot renders invisible. SINGER_COLORS[0] is the shared canonical fallback.
		singerColor = SINGER_COLORS[0],
		mine = false,
		up = false,
		singerAway = false,
		subtitle = '',
		pending = null,
		removable = false,
		shift = 0,
		grip = false,
		dimmed = false,
		moving = false,
		dragY = 0,
		ongripdown,
		ongrip,
		gripId,
		onremove,
		onnudge
	}: Props = $props();

	/**
	 * What the unconfirmed marker SAYS. An optimistic reorder used to borrow the add path's word and
	 * announce "adding…" on a row that was already in the queue. One expression,
	 * so the two states cannot drift into saying the same thing again.
	 */
	const pendingLabel = $derived(pending === 'move' ? 'moving…' : 'adding…');
</script>

<!--
	<Item.Root> supplies the row GRAMMAR — the `group/item` context its parts read — while this
	file keeps the row ELEMENT through Item's own `child` snippet. That is load-bearing: the root carries
	five conditional state classes and the drag offset as a custom property, and a `class:` directive is
	not valid on a component while a class handed to one is scoped to the caller and stripped there.
	`bare` because `.card` already paints this row and `.list-row` already lays it out.

	The root's `class` attribute stays STATIC and is written after the spread, so it wins. No
	interpolation belongs in it: contrast.test.ts derives this row's classes by splitting that attribute
	on whitespace, and a `{props.class ?? ''}` handed it the token `??`, which its selector matching then
	applied as a regex quantifier — matching every rule in the file and reporting the singer dot as the
	card root dimming its own subtree. `{...props}` already supplies the data-slot the grammar keys on.
-->
<Item.Root variant="bare" size="bare">
	{#snippet child({ props })}
		<div
			{...props}
			class="qrow card list-row pop-in"
			class:mine={mine}
			class:up={up}
			class:pending={pending}
			class:dimmed={dimmed}
			class:moving={moving}
			class:shifted={shift !== 0}
			style="--drag-y:{dragY}px; --row-shift:{shift}"
		>
			<Item.Media>
				<!--
					THE GRIP LEADS THE ROW (2026-09-21), and it is a handle rather than a button-looking control.

					It sat at the far right in a row of four outlined 44px icon buttons — up, down, remove, grip —
					which was reported as taking too much space, and it put the thing you PICK THE ROW UP BY at the
					opposite end from the row's identity. A drag handle on the left of what it drags is the
					convention every sortable list uses, and it reads as part of the row rather than as a fourth
					action on it.

					NO OUTLINE: `variant="ghost"` rather than `outline`. The three siblings it used to stand in a
					row with are gone (the arrows are retired — in `$lib/reorder-mode` — and remove
					keeps its own box on the right), so a border here would be the only one left, framing a texture.

					STILL A REAL BUTTON, and still `press="grab"` — which is not styling: the last clause is
					that `cursor: grab` lives on this control and never on a row, and `press="grab"` is where the
					button variant declares both that cursor and the `touch-action: none` the drag needs to stop
					the browser claiming the vertical gesture for scrolling.

					AND IT IS THE NON-DRAG PATH. Arrow Up/Down while it has focus moves the row one place and
					commits; that is SC 2.5.7's single-pointer alternative and SC 2.1.1's keyboard operability,
					which the deleted arrows used to carry. `aria-keyshortcuts` announces it, and the label names
					the action rather than the gesture so it is honest for both paths.
				-->
				<!--
					INERT WHILE A MOVE IS UNCONFIRMED. `pending` gates the grip for the same reason it gated
					the arrows it replaced — a second reorder against a position the server has not agreed to yet would
					issue an op for an index that no longer means what the guest saw. The seq bubble stays, so the row
					keeps its place in the list while it settles; only the handle to move it goes.
				-->
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
							// The list owns what a step means; this only reports which way and stops the page
							// scrolling under the guest while they use it.
							e.preventDefault();
							onnudge?.(e.key === 'ArrowUp' ? -1 : 1);
						}}
						onclick={(e) => ongrip?.(e.currentTarget as HTMLElement)}><Icon name="grip" /></Button
					>
				{/if}
				<div class="seq">{seq}</div>
			</Item.Media>
			<Item.Content>
				<div class="t">{title}</div>
				<!--
					prettier-ignore -- the singer line below is BOTH whitespace-load-bearing and pinned by a
					guard, so it is fenced from the formatter as a whole element.

					Whitespace: the separators are {' · '} EXPRESSIONS, not literal " · " text, because Svelte
					trims the leading whitespace of a text node that opens a block -- the plain form rendered
					"Sam· now playing" with the dot welded to the name. The `away` span stays literal on
					purpose: it carries a margin-left of its own, so a space there would double the gap.

					The guard: prettier's line-break idiom for inline elements is `</span\n>`, which is
					whitespace-SAFE but changes the SOURCE TEXT, and
					`lib/stores/queue-pending-add.test.ts` scans this file for the literal
					`<span class="adding">{pendingLabel}</span>` to prove the marker renders the derived
					expression rather than a hardcoded word. Letting prettier break that line reds the guard.

					The fence sits on `.who` rather than on the mustache sequence because prettier-ignore
					fences the next ELEMENT; it does not apply to a bare text/mustache run.
				-->
				<!-- prettier-ignore -->
				<div class="who">
					<i class="singer-dot" class:dim={singerAway} style="--singer:{singerColor}"></i>
					{singerName}{#if singerAway}<span class="away">· away</span
						>{/if}{#if subtitle}{' · '}{subtitle}{/if}{#if pending}{' · '}<span class="adding">{pendingLabel}</span>{/if}
				</div>
			</Item.Content>
			{#if !pending}
				<Item.Actions>
					<!--
						ONE ACTION LEFT ON THE RIGHT. The `move up` / `move down` pair was deleted here (2026-09-21):
						two 44px outlined buttons on every row to move a song one place, which is what "the up/down
						buttons take up too much space" was about. Their job — a reorder without a drag — did not go
						with them; it moved onto the grip above, where Arrow Up/Down does the same one-place step for
						no layout at all. See the header of `$lib/reorder-mode` for why that keeps (a
						conformance row, SC 2.5.7 / 2.1.1) satisfied rather than traded away.
					-->
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
	/*
	 * S8: `.meta` and `.actions` moved to ui/item as Encore's shared ROW GRAMMAR — `.actions` was
	 * a verbatim duplicate of ProcessingCard's. `.seq`, `.t` and `.who` STAY here, because their
	 * surfaces or descendants do: `.seq` paints its own colour+background (see its own note below —
	 * moving it fired contrast.test.ts), and the subtitle line holds a singer identity dot whose rule
	 * two contrast guards read directly, and a descendant rule cannot follow its ancestor into a
	 * component with no `child` snippet.
	 */
	/* Geometry comes from .list-row in app.css, shared with the search row and the processing card.
	   The entry animation is app.css's .pop-in helper (added to the root class list above), which
	   is wrapped in @media (prefers-reduced-motion: no-preference) so it honours Reduce Motion.
	   Do NOT re-declare a local @keyframes pop here: that copy was unguarded. */
	.mine {
		border-color: var(--line-tint);
		background: linear-gradient(var(--card), var(--card-tint));
	}
	/* Optimistic-add marker, signalled on the SURFACE and not with opacity. The dim this
	   replaces was `opacity: 0.55` on this root, which flattened the whole subtree and composited it
	   against --bg: `adding…` -- the entire explanation for why the row is greyed out and has lost its
	   remove button -- rendered at 3.77:1 against a 4.5:1 floor, the byline at 2.68:1, and the singer
	   dot at 2.57:1, under the 3:1 floor colors.ts refuses a STORED singer colour for. No alpha fixes
	   that: the byline needs 0.807 to clear AA, which is indistinguishable from 1.0, so a legible dim
	   is not a perceptible state signal. --warn-bg/--warn-line is app.css's status-surface pair for
	   exactly this ("a surface that must read as a warning on its own"); the subtree keeps full
	   opacity, so --warn now reads 8.57:1 and the dot 5.19:1. Must stay AFTER .mine -- both are
	   single-class, so source order is what lets a pending row override its own `mine` gradient.
	   contrast.test.ts's `no card root dims its own subtree with opacity` reds if opacity comes back. */
	.pending {
		background: var(--warn-bg);
		border-color: var(--warn-line);
	}
	/*
	 * S8: `.seq` STAYS here, inside <Item.Media>. It sets both a colour and a background, which is
	 * exactly the shape contrast.test.ts's exclusion list names by name ("the .seq bubble") when
	 * reasoning about what surface this row's subtree paints on. Moving it into ui/item changed that
	 * model and the dimming guard fired. ui/item carries the BOX (`flex: 0 0 auto`); the colours stay
	 * attributable to this file.
	 */
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
	/* Same truncation as .t: a long name plus an appended away/adding badge could wrap and change the
	   row's height between states. min-width:0 lets the flex item shrink below its content width. */
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
	/* The dot is app.css's shared `.singer-dot` since the primitive-adoption pass (it was four byte-identical copies).
	   Its `flex: 0 0 auto` is what stops it shrinking: .who is a nowrap/overflow flex container, and an
	   empty element's automatic minimum size is 0, so under a long name the dot collapsed to 0px and the
	   singer's colour vanished from their own row (an earlier fix). Same protection .seq/.actions carry.
	   design-system.test.ts's identity-dot guard pins the basis on the shared rule. */
	/* Hue kept (it is the singer's identity), presence dimmed. */
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
	/* Sizing, radius, surface and glyph size come from <Button variant="icon"> in components/ui/button.
	   `.icon-btn` in app.css was deleted when its ten consumers became that variant; this
	   block and ProcessingCard's were byte-identical, each with its own copy of the same rationale. */
	/*
	 * another guest's row while the reorder mode is open: not a legal drop target, so it is
	 * de-emphasised and made non-interactive (the `inert` attribute is set by the caller, which is what
	 * removes pointer AND keyboard reach in one declaration rather than two half-measures).
	 *
	 * DE-EMPHASISED WITH A SURFACE, NOT `opacity`. Subtree opacity on this exact row is
	 * already a recorded defect — see the `.pending` comment above, where `opacity: 0.55` dropped the
	 * byline to 2.68:1 and the singer dot to 2.57:1. These rows stay INFORMATIONAL during the mode:
	 * they are who you are being ordered around, so the inactive-component contrast exemption does not
	 * apply to them and their text has to keep passing AA. Measured on the tokens: `--ink` on `--bg2`
	 * is 16.84:1 and `--ink-dim` is 6.78:1, both above the 4.5:1 floor; and because `--bg2` is DARKER
	 * than the `--card` it replaces, the singer dot's own contrast goes UP rather than down.
	 * Must stay AFTER `.mine` — both are single-class, so source order is what lets a dimmed row
	 * override its own `mine` gradient, the same ordering constraint `.pending` documents.
	 */
	.dimmed {
		background: var(--bg2);
		border-color: var(--line);
	}
	/*
	 * The dragged row follows the finger. `--drag-y` is written by the page from the live pointer
	 * offset and read HERE, so the movement is a CSS transform of a GPU-composited property — the
	 * `--drag` idiom the reorder mode uses for every drag on this screen (the queue sheet's pull used
	 * it too, before that surface was deleted).
	 *
	 * There is deliberately NO `transition` and no keyframe on this rule, which is what makes
	 * hold by construction rather than by a media query: nothing is interpolated over time, so there is
	 * no duration for `prefers-reduced-motion` to have to zero out. The row's position is a 1:1
	 * response to the pointer's position — the same class of movement as scrolling — and the commit is
	 * instant, because the authoritative list re-derives `rotationSeq` on the patch. This is also why
	 * no drag library is pulled in: a library would animate the settle in JS, which is precisely the
	 * defect the standard names and which `motion.test.ts` cannot see.
	 */
	.moving {
		transform: translateY(var(--drag-y, 0px));
		/* Above its siblings while it travels, so it is not clipped by the next row's surface. */
		position: relative;
		z-index: var(--z-row-lifted);
		/*
		 * `var(--accent)`, not the retired `--accent-strong`: the fill IS the strong
		 * value now that the accent is registry stop 41, and this is a BORDER — non-text, so the 3:1
		 * floor applies and stop 41 clears it on both dark surfaces.
		 */
		border-color: var(--accent);
		/*
		 * …and transparent to hit-testing, which is not cosmetic. The row is translated to sit under the
		 * finger, so with `z-index: 2` it was the topmost element at the pointer and
		 * `document.elementFromPoint` returned IT instead of the drop slot beneath — the hovered slot read
		 * as null and a drag released squarely on a legal target committed nothing. The row is a passenger
		 * during the gesture; the things being pointed AT are the slots.
		 */
		pointer-events: none;
	}
	/* the last clause: `cursor: grab` lives on the grip BUTTON and on nothing else, so it can
	   never appear on a row that has no reorder path. `touch-action: none` because a vertical drag
	   starting on this button must move the row rather than scroll the page. */
	/*
	 * THE ROWS THE DRAGGED ONE PASSES SLIDE OUT OF ITS WAY, one place each — which is what makes this a
	 * LIVE SORT rather than a drag over drawn targets (see routes/+page.svelte and `rowShift`).
	 *
	 * `--row-shift` is a COUNT of rows, written by the page from the pure `rowShift`, and `--row-h` is the
	 * one height it measured at press time. Multiplying here keeps pixels out of the page's markup and keeps
	 * the movement a `transform`, which is the only kind `motion.test.ts` allows to be animated.
	 *
	 * THE TRANSITION IS GATED, not unconditional — this is the one interpolated movement on this row, so
	 * unlike `.moving` (a 1:1 response to the finger, by construction) it has a duration that
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
