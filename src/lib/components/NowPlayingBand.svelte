<script lang="ts">
	// THE BAND — the phone's one docked surface, and snap point 0 of NowPlayingDrawer.
	//
	// PRESENTATIONAL ONLY, deliberately: no socket, no store, no `$app/*` import, so it mounts under the test
	// harness and renders in isolation. Resolving what is playing, throttling, and publishing `--dock-h` belong
	// to the caller.
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
		/** 0..1, or `null` for an unknown duration. NEVER coerce null to 0: a 0% ring reads as a stalled song,
		 * so null draws an EMPTY ring instead. */
		progress?: number | null;
		isPlaying?: boolean;
		/** A queue exists but nothing is current, so the disc must still be live: "start when ready" is a real
		 * intent, and this band holds the app's only play control. */
		canStart?: boolean;
		ontoggleplay?: () => void;
		/**
		 * Restart and skip, the two controls flanking the disc. Every handler here is a CALLBACK so it is
		 * stable for the life of the mount: a prop of this component that changes after mount re-runs the
		 * drawer's size bindings, which throw on the mount rung. Absent in the gallery, which leaves the pair
		 * visible but dead — the state that gallery exists to show.
		 */
		onrestart?: () => void;
		onskip?: () => void;
		/** Raising or lowering the sheet. When present the metadata block becomes a real button; absent it is
		 * plain text, because a labelled control that swallows its press is worse than none. */
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
	 * r=22 in a 52-unit viewBox, never 24: an SVG defaults to `overflow: hidden`, so a stroke reaching the
	 * viewBox boundary is CLIPPED there and the ring renders with four flat sides. At r=22 the 3.4-wide
	 * stroke's outer edge lands at 23.7, clear of the 26-unit half-extent.
	 */
	const RING_RADIUS = 22;
	const CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
	const dashOffset = $derived(
		progress === null ? CIRCUMFERENCE : CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, progress)))
	);

	/* The second line, joined here rather than in the template so a dangling separator is impossible.
	   Nothing playing gets NO second line: the title already states it. */
	const byline = $derived.by(() => {
		if (!hasSong) return null;
		const parts: string[] = [];
		if (singerName) parts.push(`${singerName} is singing`);
		if (artist) parts.push(artist);
		return parts.join(' · ');
	});

	/*
	 * The accessible name CONTAINS the visible text (SC 2.5.3, label in name), so a voice user can say the
	 * title — a bare "Open the player" would replace the visible label with words that are not in it.
	 *
	 * IT IS NOT DIRECTIONAL, and cannot be: naming the press direction needs the snap state as a PROP, and
	 * any prop of this component that changes after mount re-runs the drawer's size bindings, which throw on
	 * the mount rung. Direction would have to arrive as an `aria-expanded` attribute written from an effect.
	 */
	const expandLabel = $derived(hasSong ? `${title} — now playing` : 'Nothing playing');

	/*
	 * A DRAG MUST NOT ALSO COUNT AS A TAP. This block is both the sheet's press-to-toggle control and most
	 * of its drag surface, and vaul captures the pointer without calling preventDefault — so dragging the
	 * sheet down from here ends with a click that immediately reopens it. A press records where it started
	 * and a move past the threshold disarms the toggle. The threshold matches vaul's own swipe threshold
	 * rather than inventing a second number. `pageY` is an event property, not a layout query, so nothing
	 * here reads geometry.
	 */
	const DRAG_CANCEL_PX = 10;
	let pressY: number | null = null;
	let dragged = $state(false);
</script>

<!--
	THE METADATA BLOCK IS THE KEYBOARD PATH INTO THE SHEET, because vaul's Handle is an aria-hidden div with no
	role: without this the transport, the keycaps, the slider and the only door to the song page are pointer-only.
	The action sits on the TEXT rather than on a second grab bar — two pull-up lines is a defect that already
	shipped, and tapping the track info is what every mini-player does anyway.
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
				THE TRANSPORT GROUP — restart, play/pause and skip in one row, all three visible at all times, and the
				app's ONLY copy of each. `data-vaul-no-drag` on the group is a correctness fix: the sheet composing this
				band drags from the band row, and vaul sets pointer CAPTURE on press, so a drag begun on the disc
				retargets its pointerup back to the button and fires a click — pausing the song on the way to opening
				the sheet. One attribute covers all three, because vaul resolves it with a closest() walk.
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
						<circle class="arc-track" cx="26" cy="26" r={RING_RADIUS} />
						<circle
							class="arc-fill"
							cx="26"
							cy="26"
							r={RING_RADIUS}
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
	/* The band reserves its own height and owns the app's only home-indicator inset; the layout publishes its
	   measured height as --dock-h, so no env() term is duplicated onto anything above it. */
	.band {
		background: var(--card);
		border-top: 1px solid var(--line);
		box-shadow: var(--shadow);
		padding-bottom: env(safe-area-inset-bottom, 0px);
		z-index: var(--z-dock);
		/* Safe in a flex or grid parent, which `min-width: 0` is the only way to be: an item's automatic minimum
		   is its MIN-CONTENT width and `.title` is nowrap, so without this the band's minimum is the full
		   untruncated title and it overflows its container instead of ellipsising inside it (SC 1.4.10). */
		min-width: 0;
	}

	/*
	 * FULL-BLEED SURFACE, CAPPED INNER STRIP. Bottom-docked chrome must track --max-w or it floats free of the
	 * content column — a strip running the full viewport puts the transport at the far edge of a laptop, pointing
	 * at nothing. The SURFACE stays full-bleed so the band reads as chrome rather than a floating card.
	 */
	.inner {
		max-width: var(--max-w);
		margin-inline: auto;
		/* Same reason as `.band` above: the nowrap title must not set a floor this box cannot go under. */
		min-width: 0;
	}

	/*
	 * THE EXPAND BUTTON: a button reset and nothing else, so it stays typographically identical to the plain
	 * block the gallery renders — the two are one block with and without an action behind it. `font: inherit`
	 * is already global, so this only undoes the UA's box, and `text-align: left` is the one that bites: a UA
	 * centres button text, which would centre the title and byline inside the band.
	 *
	 * NO HOVER AND NO PRESS STATE: a whole text block lightening under the cursor reads as a selection. The
	 * focus ring is app.css's global `:focus-visible`, which is what makes this reachable at all.
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
	 * ABOVE THE PULL HANDLE'S HIT AREA, named explicitly because DOM order cannot settle it: a positioned
	 * pseudo-element outranks a later sibling that establishes no stacking context. vaul's handle hit area is
	 * var(--tap) tall and CENTRED on a 6px bar, so it overhangs downward toward this strip and clears it by
	 * only a few pixels — removing this tier bets the transport's tap target on that arithmetic.
	 */
	.btn,
	.disc {
		position: relative;
		z-index: var(--z-band-control);
	}
	/* A tighter gap than the strip's, so the three read as one control rather than three adjacent things. */
	.tp {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		flex: 0 0 auto;
	}
	/*
	 * A NEGATIVE focus offset for this one control: app.css's global ring sits 2px OUTSIDE the box, which is
	 * exactly where the progress arc is drawn, so the default lands the ring on top of the arc. Only the offset
	 * changes — width and colour stay the global ones the measured floor reads.
	 */
	.disc:focus-visible {
		outline-offset: -3px;
	}

	.strip {
		display: flex;
		align-items: center;
		gap: var(--space-lg);
		/* The top term is the clearance under the drag bar; the bottom term keeps the controls off a phone's
		   screen edge. Both are inside BAND_SNAP_PX, which `.band-slot` clips at exactly. */
		padding: var(--space-sm) var(--space-2xl) var(--space-lg);
	}

	/*
	 * ONE TAP TARGET TALL. Without this the button's box is its text — 18px with nothing playing — which fails
	 * the 44px floor on a primary control, and only a rendered measurement can see it. It sits on `.meta` rather
	 * than `.meta-btn` so the plain block and the button are the same box. It costs the band no height: the
	 * strip already holds two var(--tap) round controls, and the band's height is published as --dock-h, so
	 * growing it makes every scrolling column reserve more empty chrome.
	 */
	.meta {
		min-height: var(--tap);
		display: flex;
		flex-direction: column;
		justify-content: center;
		flex: 1 1 auto;
		/* What lets the ellipsis engage: a flex child's automatic minimum is its min-content width, so an
		   unbreakable title would size the band instead of truncating inside it. */
		min-width: 0;
	}
	.title {
		/* A span inside a button may only be phrasing content, so block display has to be declared. */
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
	 * Unavailable is a SURFACE change, never a subtree opacity: `phone-inventory.test.ts` rejects dimming a
	 * subtree, because compositing ink against the page at 45% is what quietly drops it under 4.5:1.
	 */
	.disc:disabled {
		color: var(--ink-dim);
	}
	/*
	 * HOVER AS A SURFACE LIFT, never an opacity change: a little --ink mixed into the fill the control already
	 * has. `--focus` is deliberately not borrowed, or hover and focus become indistinguishable. No transition,
	 * so there is no motion to gate. `:not(:disabled)` because a dead transport that lights up under the cursor
	 * promises a tap it will swallow.
	 */
	.btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--card2) 88%, var(--ink));
		border-color: color-mix(in srgb, var(--line-strong) 70%, var(--ink));
	}
	/* The disc paints through `.art`, not its own box (which is transparent so the arc can sit outside the tap
	   box), so its hover has to reach the artwork surface — at the same ratios as `.btn` so the pair moves
	   together. */
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
		/* NO SCRIM: --scrim-strong is sized to lift text off video, and over --card-tint2 it makes a 44px
		   control read as a black hole. When real cover art lands here it needs a LIGHTER scrim measured
		   against artwork brightness, not the video one reused. */
		color: inherit;
	}
	/*
	 * NAMED `arc`, NEVER `ring`: a vendored component uses a ring utility, so Tailwind emits that class into the
	 * bundle and an app class of the same name inherits its box-shadow — here, a pale square around a round
	 * button. The source fence stops utilities being GENERATED from app markup; it cannot stop an app class
	 * colliding with one another file legitimately generated, so the only defence is not to use a utility's name.
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
	/* --accent as a NON-TEXT stroke, the only direction it is certified for: as ink it fails AA on --card, and a
	   ring clears the 3:1 non-text floor. No transition on stroke-dashoffset — it is not a composited property,
	   and a once-a-second update already reads as continuous on a ring this size. */
	.arc-fill {
		stroke: var(--accent);
		stroke-linecap: round;
	}

	.idle .title {
		color: var(--ink-dim);
	}
</style>
