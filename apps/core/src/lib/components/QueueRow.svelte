<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	// A row in the rotation queue. Ported from docs/mocks.
	import { SINGER_COLORS } from '$shared';
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
		reorderable?: boolean; // show move up/down (the caller's predicate — see routes/+page.svelte)
		/**
		 * XR-PH-17 — show the drag grip. The caller passes `gripVisible()` from `$lib/reorder-mode`,
		 * never a raw boolean: the grip is a promise that a `move` will land, and the four conditions
		 * that make it true are argued there. Independent of `reorderable` on purpose — the up/down
		 * buttons are the single-pointer alternative (XR-PH-20) and must not be coupled to the grip.
		 */
		grip?: boolean;
		/**
		 * XR-PH-18 — this row is not a legal drop target while the reorder mode is open (it is another
		 * guest's song). De-emphasised with a SURFACE token, never `opacity`: XR-PH-03, and the
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
		 * grip ELEMENT, not nothing: XR-PH-19 requires focus to return to the grip that opened the mode,
		 * and the page cannot name that element on its own. Driving the mode is what found this — the
		 * handler passed `null`, so a keyboard guest who opened the mode and pressed Escape was left with
		 * focus on `<body>`.
		 */
		ongrip?: (el: HTMLElement | null) => void;
		/**
		 * The queue entry's id, published on the grip as `data-grip`.
		 *
		 * Focus return (XR-PH-19) cannot be done by holding the element: entering the mode inserts the
		 * drop-slot buttons into this list, and Svelte recreates the row's DOM around them — so the grip
		 * the guest pressed is a detached node by the time the mode closes, and focusing it puts focus
		 * nowhere. Measured by driving the mode in a real browser, where `activeElement` was `<body>` after Escape even
		 * though the handler had called `focus()`. A stable attribute is what survives the re-render, so
		 * the page re-finds the grip by id instead.
		 */
		gripId?: string;
		canUp?: boolean;
		canDown?: boolean;
		onremove?: () => void;
		onup?: () => void;
		ondown?: () => void;
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
		reorderable = false,
		grip = false,
		dimmed = false,
		moving = false,
		dragY = 0,
		ongripdown,
		ongrip,
		gripId,
		canUp = false,
		canDown = false,
		onremove,
		onup,
		ondown
	}: Props = $props();

	/**
	 * What the unconfirmed marker SAYS. An optimistic reorder used to borrow the add path's word and
	 * announce "adding…" on a row that was already in the queue (XR-PH-10). One expression,
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
	style="--drag-y:{dragY}px"
>
			<Item.Media><div class="seq">{seq}</div></Item.Media>
			<Item.Content>
				<div class="t">{title}</div>
		<div class="who">
			<!-- The separators are {' · '} expressions, not literal " · " text: Svelte trims the leading
			     whitespace of a text node that opens a block, so the plain form rendered "Sam· now
			     playing" with the dot welded to the name. The `away` span stays literal on purpose -- it
			     carries a margin-left of its own, so adding a space there would double the gap. -->
			<i class:dim={singerAway} style="--singer:{singerColor}"></i>
			{singerName}{#if singerAway}<span class="away">· away</span
				>{/if}{#if subtitle}{' · '}{subtitle}{/if}{#if pending}{' · '}<span class="adding">{pendingLabel}</span>{/if}
				</div>
			</Item.Content>
			{#if !pending}
				<Item.Actions>
			{#if reorderable}
				<Button variant="outline" size="icon" press="ink" aria-label="move up" disabled={!canUp} onclick={() => onup?.()}
					><Icon name="arrow-up" /></Button
				>
				<Button variant="outline" size="icon" press="ink" aria-label="move down" disabled={!canDown} onclick={() => ondown?.()}
					><Icon name="arrow-down" /></Button
				>
			{/if}
			{#if removable}
				<Button variant="outline" size="icon" press="accent2" aria-label="remove from queue" onclick={() => onremove?.()}
					><Icon name="close" /></Button
				>
			{/if}
			<!--
				THE GRIP (XR-PH-17). It renders under `grip` ALONE, as a SIBLING of the button
				pair above — never as a wrapper around it and never in an `{:else}` against it. That shape
				is the requirement, not a style choice: XR-PH-20 is a WCAG 2.5.7 conformance row, so the
				single-pointer alternative must stay present and operable *while the mode is open*, and a
				grip that could ever replace the buttons is the one arrangement that falsifies it.

				The history this does NOT repeat: a grip previously rendered only on rows that were neither
				removable nor reorderable — another guest's song — where it was the sole affordance,
				promising a drag-to-reorder that does not exist and that the row had no reorder path to
				fall back on. `grip` is now `gripVisible()` from `$lib/reorder-mode`, which is false on
				another guest's row by its first condition; and `cursor: grab` lives on THIS button only,
				never on a row (XR-PH-17's last clause).
			-->
			{#if grip}
				<Button
					variant="outline" size="icon"
					press="grab"
					aria-label="Reorder your songs"
					data-grip={gripId}
					onpointerdown={(e) => ongripdown?.(e)}
					onclick={(e) => ongrip?.(e.currentTarget as HTMLElement)}><Icon name="grip" /></Button
				>
			{/if}
				</Item.Actions>
	{/if}
</div>
	{/snippet}
</Item.Root>

<style>
	/*
	 * S8: `.seq`, `.meta` and `.actions` moved to ui/item as Encore's shared ROW GRAMMAR — `.seq`
	 * and `.actions` were verbatim duplicates of ProcessingCard's. `.t` and `.who` STAY, because their
	 * descendants do: the subtitle line holds a singer identity dot whose rule two contrast guards read
	 * directly, and a descendant rule cannot follow its ancestor into a component with no `child` snippet.
	 */
	/* Geometry comes from .list-row in app.css, shared with the search row and the cooking card.
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
		font-size: 0.78rem;
		color: var(--ink-dim);
		margin-top: var(--space-3xs);
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* flex: 0 0 auto so the identity dot never shrinks: .who is a nowrap/overflow flex container,
	   and an empty element's automatic minimum size is 0, so under a long name the dot collapsed to 0px
	   and the singer's colour vanished from their own row. Same protection .seq/.actions carry. */
	.who i {
		flex: 0 0 auto;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		display: inline-block;
		background: var(--singer);
	}
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
	 * XR-PH-18 — another guest's row while the reorder mode is open: not a legal drop target, so it is
	 * de-emphasised and made non-interactive (the `inert` attribute is set by the caller, which is what
	 * removes pointer AND keyboard reach in one declaration rather than two half-measures).
	 *
	 * DE-EMPHASISED WITH A SURFACE, NOT `opacity` (XR-PH-03). Subtree opacity on this exact row is
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
	 * There is deliberately NO `transition` and no keyframe on this rule, which is what makes XR-PH-06
	 * hold by construction rather than by a media query: nothing is interpolated over time, so there is
	 * no duration for `prefers-reduced-motion` to have to zero out. The row's position is a 1:1
	 * response to the pointer's position — the same class of movement as scrolling — and the commit is
	 * instant, because the authoritative list re-derives `rotationSeq` on the patch. This is also why
	 * no drag library is pulled in: a library would animate the settle in JS, which is precisely the
	 * defect XR-PH-06 names and which `motion.test.ts` cannot see.
	 */
	.moving {
		transform: translateY(var(--drag-y, 0px));
		/* Above its siblings while it travels, so it is not clipped by the next row's surface. */
		position: relative;
		z-index: var(--z-row-lifted);
		/*
		 * `var(--accent)`, not the retired `--accent-strong` (XR-COL-11): the fill IS the strong
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
	/* XR-PH-17's last clause: `cursor: grab` lives on the grip BUTTON and on nothing else, so it can
	   never appear on a row that has no reorder path. `touch-action: none` because a vertical drag
	   starting on this button must move the row rather than scroll the page. */
</style>
