<script lang="ts">
	// THE BAND — the phone's one docked surface, and (from phase 1b) app chrome rather than a
	// home-screen element.
	//
	// WHY IT IS A BAND AND NOT A HERO CARD. The home screen used to open with a hero for a song
	// SOMEONE ELSE is singing, which spent the top third of the screen on the one thing the guest
	// cannot act on. The band answers the two questions a phone is actually holding — what is playing,
	// and how do I add a song — in 80px, and pulls up into the drawer for everything else.
	//
	// PRESENTATIONAL ONLY, DELIBERATELY. It owns no socket, no store and no `$app/*` import, so it
	// mounts under the test harness and renders in isolation. Resolving what is playing, throttling,
	// and publishing `--dock-h` all belong to the caller — the same split GuidingTrack.svelte uses,
	// for the same reason: one component that cannot drift between its two call sites.
	//
	// THE RING IS THE PROGRESS READOUT. It replaced both an elapsed number and a separate 40px
	// thumbnail: the transport button can BE the artwork, so the band carries one disc instead of a
	// thumbnail, a number and a button. `progress` is a fraction and may be null — an unknown duration
	// draws an empty ring rather than one pinned at zero, because a 0% ring reads as a stalled song
	// (the same null-not-zero rule progressFraction already applies in the queue peek).
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
		/** Opening the find surface. The band becomes the search field once it is open. */
		onsearch?: () => void;
		ontoggleplay?: () => void;
		/** Pulling the band up. Phase 1b wires this to the drawer's open state. */
		onexpand?: () => void;
	}

	let {
		title = null,
		singerName = null,
		singerColor = null,
		artist = null,
		progress = null,
		isPlaying = false,
		onsearch,
		ontoggleplay,
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
</script>

<div class="band" class:idle={!hasSong}>
	<div class="inner">
		<!--
		The pull surface, rendered ONLY when there is somewhere to pull to. A labelled button that does
		nothing is worse than an absent one: a screen reader announces "Open now playing" and the tap is
		swallowed. So the affordance is gated on the action existing, which also means this band degrades
		to a status-plus-transport strip wherever no drawer is wired.

		It carries the expand action and NOTHING else: XR-PH-15's prohibition is on a
		control sharing a drag surface, and a range input here would fight the gesture. The handle is a
		real button so the band is reachable without a pointer — a drag-only affordance is unreachable
		by keyboard and by a screen reader.
	-->
		{#if onexpand}
			<button
				class="handle"
				type="button"
				aria-label={hasSong ? 'Open now playing' : 'Open the player'}
				onclick={() => onexpand()}
			>
				<i></i>
			</button>
		{/if}

		<div class="strip">
			<div class="meta">
				<div class="title">{hasSong ? title : 'Nothing playing'}</div>
				{#if byline}
					<div class="byline">
						{#if singerName}
							<span class="dot" style:background={singerColor ?? 'var(--accent)'}></span>
						{/if}
						<span class="byline-text">{byline}</span>
					</div>
				{/if}
			</div>

			<button class="btn" type="button" aria-label="Search for a song" onclick={() => onsearch?.()}>
				<Icon name="search" />
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
				disabled={!hasSong}
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
	 * FULL-BLEED SURFACE, CAPPED INNER STRIP — and the split is the whole desktop answer.
	 *
	 * A bottom-docked surface must track `--max-w` or it floats free of the content column it is
	 * supposed to belong to: the app shell caps its column at `--max-w` and grows it in two steps
	 * (480 → 760 at 768px → 1080 at 1200px), so a band whose CONTENT ran the full viewport width would
	 * put its transport under the singer's thumb on a phone and out at the far edge of a laptop,
	 * pointing at nothing.
	 *
	 * The surface stays full-bleed deliberately — the paint, the top border and the safe-area inset
	 * span the viewport, so the band reads as app chrome rather than as a floating card, and on a phone
	 * (where the viewport is narrower than the cap) the two are identical.
	 *
	 * It also makes the component honest in ANY container: the strip is bounded by the token, not by
	 * whoever renders it, so a desktop-wide gallery column no longer stretches the controls to its
	 * edges — which is exactly how the first captured frame lost them off-screen.
	 */
	.inner {
		max-width: var(--max-w);
		margin-inline: auto;
		/* Same reason as `.band` above: the nowrap title must not set a floor this box cannot go under. */
		min-width: 0;
	}

	.handle {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		/* Short by design: the grab bar is a hint, not the target. See the ::after below for the target. */
		min-height: var(--space-4xl);
		padding: 0;
		border: 0;
		background: none;
		/*
		 * `pointer`, NOT `grab`. This bar looks like a drag handle and for a while it said so — and it has
		 * never been draggable: it is a `<button>` whose click sets the drawer open, so a finger that
		 * pulled up got nothing and a cursor that hovered was told to try. An affordance that promises a
		 * gesture it cannot perform is the same defect class as a labelled button that swallows its tap.
		 *
		 * DRAG-TO-OPEN IS A REAL FEATURE AND IT IS NOT A CSS FIX. vaul owns the gesture, and it can only
		 * follow a finger on an element inside its own drawer tree — an outside element can start a drag
		 * but cannot hand the in-flight pointer over, so the sheet would jump to open rather than track.
		 * The honest route is the band becoming the drawer's collapsed SNAP POINT (`snapPoints`), so there
		 * is one surface at two heights and the drag is vaul's throughout. That is an architecture change,
		 * not a polish pass, so the promise is withdrawn until it is made.
		 */
		cursor: pointer;
		/* Anchors the hit-area pseudo-element. */
		position: relative;
	}
	/*
	 * THE TAP TARGET, and the reason it is a pseudo-element rather than a taller button.
	 *
	 * The measured gate caught this: while the handle was inert (no drawer to open, so no `onexpand` and
	 * no rendered control) a 20px box was nobody's problem. Wiring the drawer turned it into the ONLY way
	 * to reach the transport, the key row and the guiding track — a 20px primary control, which XR-VER-09
	 * fails on a rendered reading. The declared height looked fine; the rendered extent is what failed.
	 *
	 * Growing `min-height` to `--tap` would add 24px to the band, and the band's height is published as
	 * `--dock-h`, so every scrolling column would reserve 24px of empty chrome to make one grab bar
	 * easier to hit. An inset pseudo-element costs no layout at all.
	 *
	 * It expanded SYMMETRICALLY at first, and that was wrong twice over — both times caught by the
	 * measured gate rather than by reading. The first version's comment claimed the overlap onto the
	 * strip was "safe by paint order rather than by luck", because the strip's buttons are later
	 * siblings; the magnifier then read a 32px hit extent inside a 44px box, because a POSITIONED
	 * pseudo-element outranks a later sibling that establishes no stacking context of its own. DOM order
	 * was never doing the work, so `.btn`/`.disc` below say it explicitly. The second problem was the
	 * other direction and worse — see the rule itself.
	 */
	.handle::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		/*
		 * DOWNWARD ONLY, and that asymmetry is the whole correctness of it. This expanded symmetrically
		 * (±12px) until gate:measured named the blocker: a 44px control on /settings read a 0px hit
		 * extent, "blocked by button.handle". The band is FIXED to the viewport, so 12px above it lands
		 * on whatever page content is scrolled under it — on every phone surface. A control that steals
		 * taps from the page it floats over is a worse defect than the small target this was fixing.
		 *
		 * Downward, the 44px fits entirely inside the band (20px of handle + 24 = 44, of the band's 77),
		 * so it can never reach the page. It does overlap the strip below, and the two real controls
		 * there declare --z-band-control to sit above it — measured, not assumed: the magnifier read 32px
		 * of its 44px box until they did. What it legitimately owns is the inert title text, where a tap
		 * opening the now-playing detail is what a mini-player does anyway.
		 */
		top: 0;
		/* 20px of handle plus this reaches var(--tap); both terms are tokens, so it tracks either move. */
		bottom: calc(var(--space-4xl) - var(--tap));
	}
	/*
	 * ABOVE THE HANDLE'S HIT BOX, explicitly. Both are later siblings than `.handle`, which is NOT enough:
	 * its `::after` is positioned and these were not, so the pseudo-element won the hit test over their
	 * top 12px. Measured before and after — the magnifier read 32px of its 44px box, and reads 44px now.
	 */
	.btn,
	.disc {
		position: relative;
		z-index: var(--z-band-control);
	}
	/*
	 * THE FOCUS RING HUGS THE DISC INSTEAD OF LANDING ON ITS PROGRESS RING.
	 *
	 * app.css draws `:focus-visible` as a 2px `--focus` outline at `outline-offset: 2px`. That offset is
	 * right for every other control and wrong for exactly this one: the progress ring is drawn OUTSIDE
	 * the 44px button box (deliberately — an inset ring would eat the tap floor), so a ring 2px out lands
	 * on top of it. The result reads as a pale box bolted around the play button, which is what it was
	 * reported as.
	 *
	 * A NEGATIVE offset, so the indicator sits just inside the disc's own edge and clear of the arc.
	 * Width and colour are untouched, so XR-VER-12's measured floor — a >=2px outline in the resolved
	 * `--focus` — is unaffected; only where it is drawn changes.
	 */
	.disc:focus-visible {
		outline-offset: -3px;
	}
	.handle > i {
		display: block;
		width: 38px;
		height: var(--space-2xs);
		border-radius: var(--radius-pill);
		background: var(--line-strong);
	}

	.strip {
		display: flex;
		align-items: center;
		gap: var(--space-lg);
		padding: 0 var(--space-2xl) var(--space-lg);
	}

	.meta {
		flex: 1 1 auto;
		/* min-width:0 is what lets the ellipsis engage: a flex child's automatic minimum is its
		   min-content width, so an unbreakable title would otherwise size the band instead of
		   truncating inside it — the 320px reflow failure XR-PH-02 measures. */
		min-width: 0;
	}
	.title {
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
	 * Unavailable is a SURFACE change, never a subtree opacity: XR-PH-03 and
	 * layout/phone-inventory.test.ts both reject dimming a subtree, because compositing ink against
	 * the page at 45% is what quietly drops it under 4.5:1.
	 */
	.disc:disabled {
		color: var(--ink-dim);
	}
	/*
	 * HOVER — the state these two never had, and they are the only controls on this surface without one.
	 *
	 * Everything else in the drawer and the header goes through the shadcn `<Button>` variants, which
	 * carry a hover as a matter of course (`hover:bg-muted`, i.e. `--card2`). These two are hand-rolled
	 * `<button>`s and so inherited nothing: a cursor over the magnifier or the transport got no response
	 * at all, which on a laptop reads as "not a control" and was reported as exactly that. The rules
	 * above this point are a `min-height` and a z-tier — nothing that answers a pointer.
	 *
	 * A SURFACE LIFT, NEVER AN OPACITY CHANGE. XR-PH-03 rejects a subtree alpha for any state (the
	 * disabled case above uses an ink token for the same reason), so hover mixes a little `--ink` into
	 * the fill the control already has. That is the move the `secondary` variant already makes, and it
	 * keeps hover reading as "the same surface, warmer" rather than as a new colour with its own
	 * meaning. `--focus` is deliberately NOT borrowed here: it is the focus ring's colour, and a hover
	 * wearing it would make the two states indistinguishable.
	 *
	 * NO TRANSITION, matching `.arc-fill` above and the incumbent `.btn-accent` this pair descends from.
	 * A paint change is correct instantly, so there is no motion to gate on `prefers-reduced-motion` and
	 * nothing here for motion.test.ts to weigh.
	 *
	 * `:not(:disabled)` because `.disc` IS disabled with no song, and a dead transport that lights up
	 * under the cursor promises a tap it will swallow — the same lie the handle's old `cursor: grab`
	 * told. `:focus-visible` is untouched: separate rule, separate property (outline).
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
	 * NAMED `arc`, NOT `ring` — and the rename is a defect fix, not a preference.
	 *
	 * `ring` is one of Tailwind's own utility names (`box-shadow: 0 0 0 <n>px var(--tw-ring-color)`), and
	 * the vendored button and drawer both use `focus-visible:ring-3 ring-ring/50`, so Tailwind emits the
	 * `ring` class into the bundle. A plain `class="ring"` on this SVG then matched it and picked up a
	 * two-layer box-shadow on a 50x50 box with `border-radius: 0` — painting a pale SQUARE around a round
	 * play button. Reported as "a weird white box around the play button", and measured here: the svg
	 * carried a box-shadow it never declared.
	 *
	 * This is the third member of a family app.css already documents in prose: `.underline` collided with
	 * the lyrics ball's marker style and `.block` with the same enum's `block` value, which is why the
	 * `source(none)` fence exists at all. The fence stops utilities being GENERATED from app markup; it
	 * cannot stop an app class from colliding with a utility another file legitimately generated. The only
	 * defence is not to use a utility's name, so this one does not.
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
