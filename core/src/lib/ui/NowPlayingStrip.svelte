<script lang="ts">
	/* THE REPLACEMENT FOR THE NOW-PLAYING DRAWER, and the reason it is a strip rather than a sheet is a product
	   fact rather than a simplification: Encore's now-playing surface is the TELEVISION. The phone is a remote and
	   a queue. A multi-snap sheet existed to give the phone a now-playing view it never needed, and cost 1073 lines
	   across NowPlayingDrawer/NowPlayingBand/sheet-snap plus `vaul-svelte` and the 13-file `ui/drawer/` wrapper it
	   needed — 1336 lines and 57,165 bytes of source, counted off the four paths at the moment they were deleted —
	   to make a third-party sheet behave: a constant snap 0 because the array cannot be replaced under a live
	   pointer, a lazy watch written through `null` on every re-seat, pointer-capture workarounds so a drag does not
	   fire a click, `data-vaul-no-drag` exclusion, and a hand-rolled debounced resize re-seat. The owner reported
	   the sheet expanding on its own and covering the page; that class of defect is structural to the arrangement.

	   SO THIS HAS NO OPEN STATE AT ALL. Its height is a function of nothing but whether it renders, there is no
	   snap array, no drag, and no geometry read — which is also why it mounts on the test rung the sheet could not.
	   Everything the sheet's expanded body held (the guiding track, the vocal range, key shift) lives on /queue,
	   above the queue list, because that is the screen you are already on to see whose turn is next.

	   IT RENDERS ONLY WHEN THERE IS SOMETHING TO DO. The old band was permanently present and showed "Nothing
	   playing" beside a disabled transport whose play button was the brightest thing on an idle screen — the
	   design review's "the brightest element on screen does nothing". With nothing playing and nothing queued
	   there is no strip and the tab bar alone holds the bottom. */
	import Icon from '$lib/ui/Icon.svelte';
	import ReactionRow from '$lib/ui/ReactionRow.svelte';
	import { progressFraction } from '$lib/clock';
	import type { ReactionKind } from '$lib/contract';

	let {
		title,
		singerName,
		singerColor,
		isPlaying,
		elapsedSec,
		durationSec,
		hasSong,
		canStart,
		queueCount,
		onrestart,
		ontoggleplay,
		onskip,
		onreact
	}: {
		title: string | null;
		singerName: string | null;
		singerColor: string | null;
		isPlaying: boolean;
		elapsedSec: number;
		durationSec: number;
		hasSong: boolean;
		canStart: boolean;
		queueCount: number;
		onrestart: () => void;
		ontoggleplay: () => void;
		onskip: () => void;
		/** Absent means no reaction row: nothing is on, it is your song, or the room switched reactions off. */
		onreact?: (kind: ReactionKind) => void;
	} = $props();

	const fraction = $derived(progressFraction(elapsedSec, durationSec));
	/* THREE STATES, not two, and getting this to two cost a real defect in each direction.
	   PRESENCE is `hasSong || queueCount > 0`: anything in the rotation means the dock has something to say. The
	   first version keyed presence on `canStart` instead — a PLAYABLE queued song — which fixed the dead-bright-button
	   half and broke the other: queueing a song starts its stem separation, so for the minute that takes the dock
	   went BLANK immediately after the guest's one action, and the gate that drives exactly that state measured no
	   strip at all.
	   ENABLEMENT is separate and is `hasSong || canStart`. `canStart` is the server's own `nextPlayable` predicate,
	   so the play button is live only when a tap will actually start something. Before, it was always enabled: with
	   a queued-but-cooking song the server's `play` handler sets `isPlaying: false`, emits no error and raises no
	   toast, so the brightest element on the screen silently did nothing — the exact fault this component's header
	   claims to have removed.
	   And the COPY follows enablement rather than presence, because a strip that says "Ready when you are" over a
	   song that is still cooking is the same lie told in words. */
	const live = $derived(hasSong || queueCount > 0);
	const canPlay = $derived(hasSong || canStart);
</script>

{#if live}
	{#if hasSong && onreact}
		<ReactionRow singerName={singerName} onreact={onreact} />
	{/if}
	<!-- A `section`, not a `nav`: the tab bar below is the navigation landmark, and two sibling navs make the
		landmark list ambiguous to a screen reader. The label names the thing rather than the control group. -->
	<section class="strip" aria-label="Now playing">
		<!-- THE PROGRESS HAIRLINE IS `aria-hidden` AND NOT A `progressbar`: it duplicates no information a guest
			cannot get — /tv carries the real elapsed readout at a size readable across a room — and announcing a
			once-a-second percentage over the title is noise on the surface you hold. Scaled on a transform so the
			once-a-second write touches no layout. -->
		<div class="rail" aria-hidden="true">
			<div class="fill" style:transform="scaleX({fraction})"></div>
		</div>

		<a class="meta" href="/queue">
			{#if hasSong}
				<!-- The singer dot is the one place the phone repeats the TV's colour coding, so whose turn it is
					survives a glance at a strip two lines tall. -->
				<span class="dot" style:background={singerColor ?? 'var(--accent)'}></span>
				<span class="who">{singerName ?? 'Someone'}</span>
				<span class="sep" aria-hidden="true">·</span>
				<span class="song">{title ?? 'Untitled'}</span>
			{:else}
				<span class="who">{canPlay ? 'Ready when you are' : 'Making karaoke…'}</span>
			{/if}
		</a>

		<div class="tp">
			<button class="btn" onclick={onrestart} disabled={!hasSong} aria-label="Restart">
				<Icon name="restart" />
			</button>
			<button class="btn primary" onclick={ontoggleplay} disabled={!canPlay} aria-label={isPlaying ? 'Pause' : 'Play'}>
				<Icon name={isPlaying ? 'pause' : 'play'} />
			</button>
			<button class="btn" onclick={onskip} disabled={!hasSong} aria-label="Skip">
				<Icon name="next" />
			</button>
		</div>
	</section>
{/if}

<style>
	.strip {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-md);
		/* NO padding-block: the controls are var(--tap) tall and they set the height, so the strip is exactly one
		   tap floor and the number lives in one place. */
		padding-inline: var(--space-lg);
		background: var(--card);
		border-top: 1px solid var(--line);
		box-shadow: inset 0 1px 0 var(--edge-hi);
	}

	.rail {
		position: absolute;
		inset-block-start: 0;
		inset-inline: 0;
		height: var(--space-3xs);
		background: var(--track-bg);
	}

	.fill {
		height: 100%;
		/* Scaled from the leading edge so `scaleX` grows rightwards rather than from the centre. */
		transform-origin: left center;
		background: var(--grad);
	}

	/* THE WHOLE METADATA BLOCK IS THE LINK to /queue, so the target is the full width the transport leaves rather
	   than the text's own box — the old band made this a button that a drag could fire by accident. */
	.meta {
		flex: 1 1 auto;
		/* Load-bearing: without it the nowrap title sizes the flex item instead of ellipsising inside it, and the
		   transport is pushed off a 320px screen. */
		min-width: 0;
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		min-height: var(--tap);
		color: var(--ink);
		text-decoration: none;
		font-size: var(--ph-text-sm);
	}

	.dot {
		flex: 0 0 var(--space-sm);
		width: var(--space-sm);
		height: var(--space-sm);
		border-radius: var(--radius-pill);
	}

	.who {
		font-weight: 600;
		white-space: nowrap;
	}

	.sep {
		color: var(--ink-dim);
	}

	/* The title is what gives up width: the singer's name is the fact you are checking at a glance, and a truncated
	   name reads as the wrong person where a truncated song title still reads as the right song. */
	.song {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--ink-dim);
	}

	.tp {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		gap: var(--space-2xs);
	}

	.btn {
		flex: 0 0 var(--tap);
		width: var(--tap);
		height: var(--tap);
		display: grid;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: var(--radius-pill);
		background: none;
		color: var(--ink);
	}

	/* Play/pause is the one control that carries a fill, because it is the only one whose state the fill encodes.
	   The other two are momentary, so a resting fill on them would read as state they do not have. */
	.btn.primary {
		background: var(--accent);
		/* --on-accent, NOT --accent-ink. app.css calls --on-accent "the only ink permitted on --accent" and this
		   strip was the one site in the tree stacking --accent-ink on it instead: measured with the app's own
		   contrastRatio, --accent-ink on --accent is 2.537:1 and --on-accent is 5.089:1. SC 1.4.11 wants 3:1 for the
		   visual information identifying a control, and this button is borderless — the glyph IS the identification,
		   so 2.54 was a real failure rather than a palette quibble. --accent-ink's own certification is against a
		   SURFACE (--card2), never against --accent, which is how the misreading survived review. */
		color: var(--on-accent);
	}

	/* DIMMED BY INK, never by opacity on the subtree: an ancestor alpha flattens the glyph and the surface into one
	   buffer, so a token-level contrast check keeps passing while the guest sees worse. */
	.btn:disabled {
		color: var(--ink-dim);
	}

	@media (prefers-reduced-motion: no-preference) {
		/* The PERIOD is --motion-tick, once a second, so the fill is interpolated across the whole gap between
		   writes rather than stepping. Only `transform` is animated, which the compositor can do off-thread. */
		.fill {
			transition: transform var(--motion-tick) linear;
		}
	}
</style>
