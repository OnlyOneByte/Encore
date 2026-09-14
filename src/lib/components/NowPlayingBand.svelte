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
	const byline = $derived.by(() => {
		if (!hasSong) return 'Queue a song to start the party';
		const parts: string[] = [];
		if (singerName) parts.push(`${singerName} is singing`);
		if (artist) parts.push(artist);
		return parts.join(' · ');
	});
</script>

<div class="band" class:idle={!hasSong}>
	<div class="inner">
		<!--
		The pull surface. It carries the expand action and NOTHING else: XR-PH-15's prohibition is on a
		control sharing a drag surface, and a range input here would fight the gesture. The handle is a
		real button so the band is reachable without a pointer — a drag-only affordance is unreachable
		by keyboard and by a screen reader.
	-->
		<button
			class="handle"
			type="button"
			aria-label={hasSong ? 'Open now playing' : 'Open the player'}
			onclick={() => onexpand?.()}
		>
			<i></i>
		</button>

		<div class="strip">
			<div class="meta">
				<div class="title">{hasSong ? title : 'Nothing playing'}</div>
				<div class="byline">
					{#if hasSong && singerName}
						<span class="dot" style:background={singerColor ?? 'var(--accent)'}></span>
					{/if}
					<span class="byline-text">{byline}</span>
				</div>
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
				<svg class="ring" viewBox="0 0 52 52" aria-hidden="true">
					<circle class="ring-track" cx="26" cy="26" r="22" />
					<circle
						class="ring-fill"
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
		/* Short by design: the handle is a grab affordance, and the disc beside it carries the tap
		   floor for the primary action. Its hit area is widened by the full-width box, not by height. */
		min-height: var(--space-4xl);
		padding: 0;
		border: 0;
		background: none;
		cursor: grab;
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
	.ring {
		position: absolute;
		/* Outside the tap box — see the disc comment in the markup. */
		inset: calc(-1 * var(--space-2xs));
		pointer-events: none;
	}
	.ring-track,
	.ring-fill {
		fill: none;
		stroke-width: 3.4;
	}
	.ring-track {
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
	.ring-fill {
		stroke: var(--accent);
		stroke-linecap: round;
	}

	.idle .title {
		color: var(--ink-dim);
	}
</style>
