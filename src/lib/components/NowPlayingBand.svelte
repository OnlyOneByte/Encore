<script lang="ts">
	// THE BAND — the phone's one docked surface, and app chrome rather than a home-screen element. It answers the
	// two questions a phone is holding (what is playing, and the transport) in 80px, and pulls up into the drawer
	// for everything else.
	//
	// PRESENTATIONAL ONLY, deliberately: no socket, no store, no `$app/*` import, so it mounts under the test
	// harness and renders in isolation. Resolving what is playing, throttling and publishing `--dock-h` belong to
	// the caller — the same split GuidingTrack uses, so one component cannot drift between its two call sites.
	//
	// THE RING IS THE PROGRESS READOUT, replacing both an elapsed number and a separate 40px thumbnail: the
	// transport button can BE the artwork. `progress` may be null — an unknown duration draws an EMPTY ring
	// rather than one pinned at zero, because a 0% ring reads as a stalled song.
	import Icon from '$lib/ui/Icon.svelte';

	interface Props {
		/** Song title. `null` when nothing is playing — the band then states that instead. */
		title?: string | null;
		/** Who is singing it, for the second line. */
		singerName?: string | null;
		/** The singer's colour, for the identity dot. Falls back to the accent. */
		singerColor?: string | null;
		/** Artist, appended to the second line when there is room for it. */
		artist?: string | null;
		/** 0..1, or null when the duration is unknown. Never coerce null to 0 — see above. */
		progress?: number | null;
		isPlaying?: boolean;
		/**
		 * A queue exists but nothing is current — "start when ready" is a real intent, so the disc must be
		 * live for it even though there is no song yet.
		 *
		 * THIS ARRIVED WITH THE SHEET'S DUPLICATE PLAY/PAUSE BEING DELETED. That button was the only control
		 * carrying `!hasSong && !canStart`, so removing it without this would have taken "start the party
		 * from the phone" with it.
		 */
		canStart?: boolean;
		ontoggleplay?: () => void;
		/**
		 * Restart and skip — the two controls that flank the disc, always rendered.
		 *
		 * They live HERE rather than in the sheet's body because one transport split across two rows is what
		 * the last two rounds of this were reported as. Callbacks, so they are stable for the life of the
		 * mount: a prop of this component that CHANGES after mount re-runs the drawer's size bindings, which
		 * the mount rung throws on. Absent (the /components gallery) leaves the pair inert but visible, which
		 * is the state that gallery exists to show.
		 */
		onrestart?: () => void;
		onskip?: () => void;
		/**
		 * Raising or lowering the sheet. When present, the band's own metadata block becomes a real button
		 * that does it — see the markup. Absent (the /components gallery, which renders five bands with no
		 * drawer) leaves it inert text, because a labelled control that swallows its press is worse than none.
		 */
		onexpand?: () => void;
	}

	let {
		title = null,
		singerName = null,
		singerColor = null,
		artist = null,
		progress = null,
		isPlaying = false,
		canStart = false,
		ontoggleplay,
		onrestart,
		onskip,
		onexpand
	}: Props = $props();

	const hasSong = $derived(title !== null && title !== '');

	/*
	 * r=22 in a 52-unit viewBox, NOT 24 — measured, not chosen. An SVG defaults to
	 * `overflow: hidden`, so a stroke that reaches the viewBox boundary is CLIPPED there: at r=24 the
	 * 3.4-wide stroke's outer edge lands at 25.7 against a 26-unit half-extent, and the ring rendered
	 * with four flat sides — a circle that read as a rounded square. At r=22 the outer edge is 23.7,
	 * clear of the boundary, and the ring sits on the disc's rim.
	 */
	const CIRCUMFERENCE = 2 * Math.PI * 22;
	const dashOffset = $derived(
		progress === null ? CIRCUMFERENCE : CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, progress)))
	);

	/*
	 * The second line, built here rather than in the template so the separator logic has one home.
	 * "Maya is singing · Neil Diamond" when both are known; either alone when only one is; and the
	 * queue-a-song prompt when nothing plays. A dangling "·" is the failure this replaces.
	 */
	/*
	 * Nothing playing gets NO second line. It used to read "Queue a song to start the party", which is
	 * three things at once: a state, an instruction, and a bit of cheer — and the state is already the
	 * title. The instruction is unnecessary because the magnifier is right there, and the cheer is what
	 * makes a room's software sound like it is talking to you rather than telling you something.
	 */
	const byline = $derived.by(() => {
		if (!hasSong) return null;
		const parts: string[] = [];
		if (singerName) parts.push(`${singerName} is singing`);
		if (artist) parts.push(artist);
		return parts.join(' · ');
	});

	/*
	 * The expand button's accessible name, which CONTAINS its visible text on purpose (SC 2.5.3, label in
	 * name): the visible string is the title, or "Nothing playing", and both appear here verbatim with the
	 * action appended. A bare `aria-label="Open the player"` would replace the visible label with words
	 * that are not in it, which is the failure that criterion describes — and it would also stop a voice
	 * user saying "tap Sweet Caroline".
	 */
	/*
	 * NOT DIRECTIONAL, and that is a constraint rather than a preference.
	 *
	 * The press TOGGLES the sheet, so "open the player" is wrong half the time — and the obvious fix, an
	 * `expanded` prop the drawer feeds from its snap point, cannot be had: ANY prop of this component that
	 * changes after mount re-runs the size bindings in the drawer's `.band-slot` / `.np-fit`, and on the
	 * mount rung a geometry read is a throw by design. Measured: a reactive `expanded` took
	 * three of `phone-home`'s mounts down, a constant one passed. So the name says WHAT this is rather
	 * than which way it will move, which is true in both states and is what a mini-player's info row is
	 * called anyway. The visible text is contained in it either way (SC 2.5.3).
	 *
	 * If a direction is ever wanted here, the way in is `aria-expanded` written by the drawer onto this
	 * button's DOM node from an effect — an attribute write does not re-render the component — not a prop.
	 */
	const expandLabel = $derived(hasSong ? `${title} — now playing` : 'Nothing playing');

	/*
	 * A DRAG MUST NOT ALSO COUNT AS A TAP, and that is what these three handlers are for.
	 *
	 * The metadata block is both the sheet's press-to-toggle control AND — since `handleOnly` came off — the
	 * biggest part of its drag surface: `.meta` is `flex: 1`, so it spans everything between the title and
	 * the controls. vaul captures the pointer on press and never calls `preventDefault`, so dragging the
	 * sheet from here ends with a `click` on this button: drag down to collapse, release, and the toggle
	 * immediately reopens it. Measured as exactly that.
	 *
	 * So a press records where it started and a move past the threshold disarms the toggle. 10px is vaul's
	 * own touch threshold for deciding a gesture is a swipe (`use-drawer-content.svelte.js`), which is the
	 * number to match rather than a new one to invent.
	 *
	 * NO GEOMETRY IS READ. `pageY` is a property of the event, not a layout query, so this is safe on the
	 * mount rung — and no pointer event fires there at all.
	 */
	const DRAG_CANCEL_PX = 10;
	let pressY: number | null = null;
	let dragged = $state(false);
</script>

<!--
	THE METADATA BLOCK IS THE KEYBOARD PATH INTO THE SHEET. What replaced the old grab-bar button is vaul's
	`Drawer.Handle`: a `<div aria-hidden="true">` with no tabindex and no role. Measured on the collapsed home
	route, the only drawer controls a keyboard could reach were the magnifier and a play/pause button off screen —
	the transport, the ± keycaps, the slider and the only entry point to /song/[mediaId] were pointer-only.

	THE ACTION MOVED ONTO THE TEXT RATHER THAN GROWING A SECOND BAR: rendering another grab bar here is a defect
	that already shipped once (vaul's handle plus a hand-rolled one drew TWO stacked pull-up lines). The metadata
	block is real, visible, focusable content that names what it opens, and tapping the track info to open the full
	player is what every mini-player already does.

	Still gated on `onexpand`: /components renders five bands with no drawer behind them, and a labelled button
	that swallows its press is worse than inert text.
-->
{#snippet metaBlock()}
	<span class="title">{hasSong ? title : 'Nothing playing'}</span>
	{#if byline}
		<span class="byline">
			{#if singerName}
				<span class="dot" style:background={singerColor ?? 'var(--accent)'}></span>
			{/if}
			<span class="byline-text">{byline}</span>
		</span>
	{/if}
{/snippet}

<div class="band" class:idle={!hasSong}>
	<div class="inner">
		<div class="strip">
			{#if onexpand}
				<button
					class="meta meta-btn"
					type="button"
					aria-label={expandLabel}
					onpointerdown={(e) => {
						pressY = e.pageY;
						dragged = false;
					}}
					onpointermove={(e) => {
						if (pressY !== null && Math.abs(e.pageY - pressY) > DRAG_CANCEL_PX) dragged = true;
					}}
					onclick={() => {
						pressY = null;
						// The sheet has already moved under the finger; toggling now would undo the drag.
						if (dragged) return;
						onexpand();
					}}
				>
					{@render metaBlock()}
				</button>
			{:else}
				<div class="meta">{@render metaBlock()}</div>
			{/if}

			<!--
				THE TRANSPORT GROUP — restart·play·skip in one row, all three visible at all times. The sheet used to
				carry restart and skip in a centred row of its own, which on a laptop left this header almost empty and
				floated a three-button group in the middle of nothing, and on a phone split one control group across two
				rows. Reported twice as the controls not being unified.

				`data-vaul-no-drag` ON THE GROUP is a correctness fix: the sheet composing this band drags from the band
				row, and vaul sets pointer CAPTURE on press — so a drag begun on the disc would retarget its `pointerup`
				back to the button and fire a click, pausing the song on the way to opening the sheet. vaul resolves the
				attribute with `closest()`, so one covers all three.

				THE DISC IS THE ONE PLAY/PAUSE: it carries the progress ring and sits in the thumb zone, and the pair
				flanks it. The sheet's own duplicate copy stays deleted.
			-->
			<div class="tp" data-vaul-no-drag>
				<button
					class="btn"
					type="button"
					aria-label="Restart"
					title="Play this song again from the beginning"
					disabled={!hasSong}
					onclick={() => onrestart?.()}
				>
					<Icon name="restart" />
				</button>
				<!--
				The disc: artwork, transport and progress in one control. The ring is drawn OUTSIDE the
				button box so the tap target stays a full var(--tap) — an inset ring would eat into it, which
				is how a 44px control silently becomes 38px.
			-->
				<button
					class="disc"
					type="button"
					aria-label={isPlaying ? 'Pause' : 'Play'}
					disabled={!hasSong && !canStart}
					onclick={() => ontoggleplay?.()}
				>
					<span class="art"></span>
					<span class="mark"><Icon name={isPlaying ? 'pause' : 'play'} /></span>
					<svg class="arc" viewBox="0 0 52 52" aria-hidden="true">
						<circle class="arc-track" cx="26" cy="26" r="22" />
						<circle
							class="arc-fill"
							cx="26"
							cy="26"
							r="22"
							stroke-dasharray={CIRCUMFERENCE}
							stroke-dashoffset={dashOffset}
							transform="rotate(-90 26 26)"
						/>
					</svg>
				</button>
				<button
					class="btn"
					type="button"
					aria-label="skip"
					title="Skip to the next singer"
					disabled={!hasSong}
					onclick={() => onskip?.()}
				>
					<Icon name="next" />
				</button>
			</div>
		</div>
	</div>
</div>

<style>
	/*
	 * The band reserves its own height and owns the home-indicator inset. Phase 1b moves the
	 * `--dock-h` publication here with it; until then routes/+page.svelte still publishes it, which is
	 * why there is no env() term duplicated onto anything above.
	 */
	.band {
		background: var(--card);
		border-top: 1px solid var(--line);
		box-shadow: var(--shadow);
		padding-bottom: env(safe-area-inset-bottom, 0px);
		z-index: var(--z-dock);
		/*
		 * SAFE TO PLACE IN A FLEX OR GRID PARENT, which `min-width: 0` is the only way to be.
		 *
		 * A flex/grid item's automatic minimum is its MIN-CONTENT width, and `.title` is
		 * `white-space: nowrap`, so the band's min-content is the full untruncated title. Without this
		 * the band refuses to shrink and OVERFLOWS its own container instead of ellipsising inside it —
		 * measured at 593px inside a 390px column, which is how the first gallery frame lost its
		 * controls off the right edge. `.meta` below frees the flex child; this frees the band itself.
		 *
		 * Same defect class as the `.sheet-surface > * { min-width: 0 }` rule the drawer deletion
		 * retired: an unbreakable label sizing a box that was supposed to cap itself (SC 1.4.10).
		 */
		min-width: 0;
	}

	/*
	 * FULL-BLEED SURFACE, CAPPED INNER STRIP. A bottom-docked surface must track `--max-w` or it floats free of
	 * the content column: the shell caps its column and grows it in two steps, so a band whose CONTENT ran the
	 * full viewport would put its transport out at the far edge of a laptop, pointing at nothing.
	 *
	 * The surface stays full-bleed deliberately — paint, top border and safe-area inset span the viewport, so the
	 * band reads as chrome rather than a floating card, and on a phone the two are identical. It also makes the
	 * component honest in ANY container: the strip is bounded by the token rather than by whoever renders it.
	 */
	.inner {
		max-width: var(--max-w);
		margin-inline: auto;
		/* Same reason as `.band` above: the nowrap title must not set a floor this box cannot go under. */
		min-width: 0;
	}

	/*
	 * `.handle`, `.handle::after` and `.handle > i` WENT WITH THE BUTTON THEY STYLED — the bar is vaul's now, and
	 * the expand ACTION moved onto `.meta-btn`. Two of those rules were defect fixes, so what they learned:
	 *   • the drawn bar must not BE the tap target (a 6px control), and growing `min-height` to var(--tap) would
	 *     add 24px to a band whose height is published as `--dock-h` — so the target was an inset pseudo-element
	 *     costing no layout;
	 *   • that pseudo-element must expand DOWNWARD ONLY. Symmetric, it reached above a viewport-fixed band and
	 *     stole taps from the page content scrolling under it — gate:measured read a 44px control on /settings as
	 *     a 0px hit extent. vaul's own hit area is centred on its bar, so this is the hazard to re-measure if that
	 *     bar ever moves down into the strip.
	 */

	/*
	 * THE EXPAND BUTTON. A button reset and nothing else: it must be typographically identical to the inert
	 * `<div class="meta">` the gallery renders, because the two are the same block with and without an
	 * action behind it, and a visible difference between them would be a difference nobody chose.
	 *
	 * `font: inherit` is already global (app.css supplies the two Preflight resets the vendored primitives
	 * assume), so this only has to undo the UA's box: no background, no border, no padding, left-aligned,
	 * inherited colour. `text-align: left` is the one that bites — a UA centres button text, which would
	 * centre the title and the byline inside the band.
	 *
	 * NO HOVER AND NO PRESS STATE, deliberately. The two round controls beside it grew a hover because they
	 * read as "not a control" without one; a whole text block that lightens under the cursor reads as a
	 * selection, and the mini-player convention is that the metadata is quietly tappable. The focus ring is
	 * app.css's global `:focus-visible`, which is what makes this reachable in the first place.
	 */
	.meta-btn {
		background: none;
		border: 0;
		padding: 0;
		margin: 0;
		text-align: left;
		color: inherit;
		cursor: pointer;
		/* A button is not a block by default, and `.meta` is a flex CHILD that must still stretch. */
		display: block;
	}

	/*
	 * ABOVE THE PULL HANDLE'S HIT AREA, explicitly rather than by DOM order.
	 *
	 * RE-AIMED, NOT RETIRED. This used to guard against `.handle::after` — this file's own hit-area
	 * pseudo-element, deleted with the button above — and the lesson it recorded was that being a LATER
	 * SIBLING is not enough: a positioned pseudo-element outranks a sibling that establishes no stacking
	 * context, and the magnifier read 32px of its 44px box until these two named a tier.
	 *
	 * The hazard still exists and now belongs to vaul: `Drawer.Handle`'s `[data-vaul-handle-hitarea]` span
	 * is var(--tap) tall and CENTRED on a 6px bar (drawer-handle.svelte), so it overhangs its bar in both
	 * directions. It currently lands above this strip rather than over it — measured at 390x844: hit area
	 * 743..787, strip top 787 — which is exactly the kind of clearance that survives by a few pixels and
	 * stops surviving when a token moves. Keeping the tier costs one declaration and removing it would be
	 * betting the transport's tap target on that arithmetic.
	 */
	.btn,
	.disc {
		position: relative;
		z-index: var(--z-band-control);
	}
	/*
	 * THE TRANSPORT GROUP. Its own box, tighter than the strip's `--space-lg`, so restart·play·skip read as
	 * one control rather than three things that happen to be adjacent — and the gap between the magnifier
	 * and the group stays the strip's, which is what keeps the collapsed row unchanged.
	 */
	.tp {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		flex: 0 0 auto;
	}
	/*
	 * NO `display: none` ON THE FLANKING PAIR ANY MORE — the transport is always visible. Worth keeping from the
	 * rule that hid it: as a single class (`.tp-side`) it LOST to `.btn`'s own `display: grid` declared further
	 * down this file, so the pair rendered in the collapsed bar — caught on a screenshot, not by the suite, since
	 * presence is all the mount rung can see and visibility is a layout claim.
	 *
	 * The class went too: with no rule behind it nothing in the cascade can reach it, and
	 * `app-class-resolution.test.ts` reds on a class in markup that no rule matches. The pair is addressed as
	 * `.tp .btn`, which names it by structure — the group holds the disc and these two.
	 */
	/*
	 * THE FOCUS RING HUGS THE DISC INSTEAD OF LANDING ON ITS PROGRESS RING.
	 *
	 * app.css draws `:focus-visible` as a 2px `--focus` outline at `outline-offset: 2px`. That offset is
	 * right for every other control and wrong for exactly this one: the progress ring is drawn OUTSIDE the
	 * 44px button box (deliberately — an inset ring would eat the tap floor), so a ring 2px out lands on top
	 * of it. The result reads as a pale box bolted around the play button, which is what it was reported as.
	 *
	 * A NEGATIVE offset, so the indicator sits just inside the disc's own edge and clear of the arc. Width
	 * and colour are untouched, so the measured floor — a >=2px outline in the resolved `--focus` —
	 * is unaffected; only where it is drawn changes.
	 */
	.disc:focus-visible {
		outline-offset: -3px;
	}

	.strip {
		display: flex;
		align-items: center;
		gap: var(--space-lg);
		/*
		 * The top term is the breathing room between the sheet's edge and this row — the handle's 16px margin
		 * and 6px bar alone read as the header starting immediately under the drag bar. It is paid for by the
		 * 8px `BAND_SNAP_PX` gained in `$lib/sheet-snap`, NOT taken from the bottom: `.band-slot` clips at
		 * exactly that height, and the bottom term is what keeps the controls off a phone's screen edge.
		 */
		padding: var(--space-sm) var(--space-2xl) var(--space-lg);
		/*
		 * `--tp-grow` and `--tp-disc-shift` RETIRED with the reveal (2026-09-22). They were the two distances
		 * the enter animation replayed — the whole pair plus its gaps, and one button plus one gap for the
		 * disc — expressed as token arithmetic precisely so the animation never had to read geometry (a
		 * geometry read on the mount rung is a throw). Nothing grows now: the row renders at one width.
		 */
	}

	/*
	 * ONE TAP TARGET TALL, in BOTH forms.
	 *
	 * `gate:measured` caught this the first time it ran after the expand action moved here: the button's box
	 * is its text, which is 18px with nothing playing and ~36px with a byline — a primary control at 18px,
	 * failing the standard's 44px floor on every phone surface. The declared markup looked fine; the rendered
	 * extent is what failed, which is the whole reason that gate reads a browser.
	 *
	 * On `.meta` rather than on `.meta-btn`, so the inert `<div>` the gallery renders and the `<button>` the
	 * app renders are the same box. They are one block with and without an action behind it, and a 26px
	 * difference between them would be a difference nobody chose.
	 *
	 * COSTS THE BAND NO HEIGHT: `.strip` is already taller than this (two var(--tap) round controls sit in
	 * it, centred), so the floor is absorbed by a row that was that tall anyway — and the band's height is
	 * published as `--dock-h`, so growing it would make every scrolling column reserve more empty chrome.
	 * The text stays optically where it was because the column centres it in the taller box.
	 */
	.meta {
		min-height: var(--tap);
		display: flex;
		flex-direction: column;
		justify-content: center;
		flex: 1 1 auto;
		/* min-width:0 is what lets the ellipsis engage: a flex child's automatic minimum is its
		   min-content width, so an unbreakable title would otherwise size the band instead of
		   truncating inside it — the 320px reflow failure the reflow standard measures. */
		min-width: 0;
	}
	.title {
		/* A <span> now (it sits inside a <button>, which may only contain phrasing content), so the block
		   display the old <div> gave for free has to be declared. */
		display: block;
		font-size: var(--ph-text-md);
		font-weight: 650;
		line-height: var(--lh-snug);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.byline {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		margin-top: var(--space-3xs);
		font-size: var(--ph-text-xs);
		line-height: var(--lh-snug);
		color: var(--ink-dim);
		min-width: 0;
	}
	.byline-text {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.dot {
		flex: 0 0 var(--space-md);
		width: var(--space-md);
		height: var(--space-md);
		border-radius: var(--radius-pill);
	}

	.btn,
	.disc {
		flex: 0 0 var(--tap);
		width: var(--tap);
		height: var(--tap);
		min-width: var(--tap);
		min-height: var(--tap);
		border-radius: var(--radius-pill);
		display: grid;
		place-items: center;
		padding: 0;
		border: 1px solid var(--line-strong);
		background: var(--card2);
		color: var(--ink);
	}

	.disc {
		position: relative;
		border-color: transparent;
		background: none;
	}
	/*
	 * Unavailable is a SURFACE change, never a subtree opacity: and
	 * layout/phone-inventory.test.ts both reject dimming a subtree, because compositing ink against
	 * the page at 45% is what quietly drops it under 4.5:1.
	 */
	.disc:disabled {
		color: var(--ink-dim);
	}
	/*
	 * HOVER — the state these two never had, being the only hand-rolled `<button>`s on this surface. Everything
	 * else goes through the shadcn variants, which carry one; a cursor over these got no response at all, which on
	 * a laptop reads as "not a control".
	 *
	 * A SURFACE LIFT, NEVER AN OPACITY CHANGE: the rule rejects a subtree alpha for any state, so hover mixes a
	 * little `--ink` into the fill the control already has — "the same surface, warmer" rather than a new colour
	 * with its own meaning. `--focus` is deliberately not borrowed: it is the focus ring's colour, and a hover
	 * wearing it would make the two states indistinguishable.
	 *
	 * NO TRANSITION, so there is no motion to gate on `prefers-reduced-motion`. `:not(:disabled)` because `.disc`
	 * IS disabled with no song, and a dead transport that lights up under the cursor promises a tap it will
	 * swallow.
	 */
	.btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--card2) 88%, var(--ink));
		border-color: color-mix(in srgb, var(--line-strong) 70%, var(--ink));
	}
	/*
	 * The disc paints through `.art`, not through its own box — the button is `background: none` with a
	 * transparent border so the arc can be drawn OUTSIDE the tap box (see `.arc`). So its hover has to
	 * reach the artwork surface instead, at the same ratios as `.btn` so the pair moves together, and
	 * against the tokens `.art` itself already uses rather than a second set.
	 */
	.disc:hover:not(:disabled) .art {
		background: color-mix(in srgb, var(--card-tint2) 88%, var(--ink));
		border-color: color-mix(in srgb, var(--line) 70%, var(--ink));
	}
	.art {
		position: absolute;
		inset: 0;
		border-radius: var(--radius-pill);
		background: var(--card-tint2);
		border: 1px solid var(--line);
	}
	.mark {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		border-radius: var(--radius-pill);
		/*
		 * NO SCRIM. `--scrim-strong` is 85% black and exists to lift text off a photo or video; over
		 * `--card-tint2` it made a 44px control read as a black hole rather than as artwork with a
		 * glyph on it. The art surface is already dark, so `--ink` on it clears AA comfortably. When
		 * real cover art lands here this needs a LIGHTER scrim chosen against measured artwork
		 * brightness, not the video one reused.
		 */
		color: inherit;
	}
	/*
	 * NAMED `arc`, NOT `ring`, and the rename is a defect fix. `ring` is one of Tailwind's own utility names, and
	 * the vendored button and drawer both use `focus-visible:ring-3`, so Tailwind emits the class into the bundle
	 * — a plain `class="ring"` on this SVG then matched it and picked up a two-layer box-shadow on a 50×50 box
	 * with `border-radius: 0`, painting a pale SQUARE around a round play button.
	 *
	 * Third member of a family app.css documents: `.underline` collided with the lyrics ball's marker style and
	 * `.block` with the same enum's value. The `source(none)` fence stops utilities being GENERATED from app
	 * markup; it cannot stop an app class colliding with one another file legitimately generated. The only
	 * defence is not to use a utility's name.
	 */
	.arc {
		position: absolute;
		/* Outside the tap box — see the disc comment in the markup. */
		inset: calc(-1 * var(--space-2xs));
		pointer-events: none;
	}
	.arc-track,
	.arc-fill {
		fill: none;
		stroke-width: 3.4;
	}
	.arc-track {
		stroke: var(--track-bg);
	}
	/*
	 * --accent as a NON-TEXT stroke, which is the only direction it is certified for: as ink it
	 * measures 3.38:1 on --card. A ring clears the 3:1 non-text floor there.
	 *
	 * No transition on stroke-dashoffset, deliberately. It is not a composited property, so
	 * motion.test.ts would reject it — and the caller updates progress about once a second, which the
	 * eye reads as continuous on a ring this size without animating anything.
	 */
	.arc-fill {
		stroke: var(--accent);
		stroke-linecap: round;
	}

	.idle .title {
		color: var(--ink-dim);
	}
</style>
