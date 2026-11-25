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

	   ONE HEIGHT, ALWAYS (proposal 13). It renders on every joined phone surface, and nothing inside it changes its
	   height: every state is one var(--tap) row. The dock used to have three heights (tabs alone, strip + tabs, and
	   the reaction row on top), and each step moved the fixed dock's top edge 45 to 116 px on every phone in the
	   room (CLS up to 0.24 at 320). So the reactions live behind the Cheer key, the "Reconnecting…" cue takes the
	   title slot, and an idle room reads "Nothing playing".

	   A NOW-LINE, NOT A REMOTE (redesign step 4, an owner ruling): pause, restart and skip live on the Queue tab's
	   Now card. The strip says who is singing what, keeps the one tap to cheer, and with nothing playing the one Play. */
	import Icon from '$lib/ui/Icon.svelte';
	import ReactionGlyph from '$lib/ui/ReactionGlyph.svelte';
	import ReactionRow, { CHEER_TRAY_MS } from '$lib/ui/ReactionRow.svelte';
	import { progressFraction } from '$lib/clock';
	import type { ReactionKind } from '$lib/contract';
	import { processStageLabel } from '$lib/phrasing/process-phrasing';
	import { tick } from 'svelte';

	let {
		title,
		singerName,
		singerColor,
		elapsedSec,
		durationSec,
		hasSong,
		canStart,
		queueCount,
		waitingLine = processStageLabel('queued'),
		entryId = null,
		connected = true,
		onreact,
		reactResting = false,
		onplay
	}: {
		title: string | null;
		singerName: string | null;
		singerColor: string | null;
		elapsedSec: number;
		durationSec: number;
		hasSong: boolean;
		canStart: boolean;
		queueCount: number;
		/** What a queue with nothing playable is waiting on: "Making karaoke…", or why no karaoke is coming. Worded by
		 * the layout from the fold the TV lobby reads, so the strip cannot say "Making karaoke…" under dead rows. */
		waitingLine?: string;
		/** The current entry: a song change closes the cheer tray, since its label named the singer before. */
		entryId?: string | null;
		/** False while the link is down: "Reconnecting…" takes the title slot. */
		connected?: boolean;
		onreact?: (kind: ReactionKind) => void;
		/** Your song, or the room switched reactions off: the Cheer key keeps its slot but is hidden and inert. */
		reactResting?: boolean;
		/** Starts the next playable song: the strip's one transport key, shown only with nothing playing. */
		onplay?: () => void;
	} = $props();

	const fraction = $derived(progressFraction(elapsedSec, durationSec));
	/* Anything in the rotation gives the line something to say; "Ready when you are" and its Play only when a song can
	   really start (`canStart` is the server's own `nextPlayable`), or they would promise a song that is still cooking. */
	const live = $derived(hasSong || queueCount > 0);
	/* `connected` too: offline the link is what the strip must say, so the key rests and an open tray closes rather
	   than covering "Reconnecting…" with four buttons whose taps would be dropped. */
	const canCheer = $derived(hasSong && !!onreact && !reactResting && connected);

	/* THE CHEER TRAY swaps the strip's contents in place, at the same height. It closes after CHEER_TRAY_MS with no
	   tap, on ✕, or when the song changes or stops being cheerable (your song, reactions off, the link down). The
	   tray focuses its own first key when it opens (ReactionRow). */
	let cheering = $state(false);
	let cheerTimer: ReturnType<typeof setTimeout> | undefined;
	let strip = $state<HTMLElement | undefined>();
	let cheerKey = $state<HTMLButtonElement | undefined>();
	let metaLink = $state<HTMLAnchorElement | undefined>();
	/* EVERY CLOSE HANDS FOCUS BACK, not only ✕: the tray's buttons leave the page, so focus held inside them would
	   fall to <body> on the timeout, a song change or the link dropping. Back to the key when it is live, else to the
	   /queue link that takes the tray's place. */
	const refocus = () => (cheerKey && !cheerKey.inert ? cheerKey : metaLink)?.focus();
	function closeCheers() {
		clearTimeout(cheerTimer);
		const had = cheering && !!strip?.contains(document.activeElement);
		cheering = false;
		if (had) void tick().then(refocus);
	}
	function holdCheers() {
		clearTimeout(cheerTimer);
		cheerTimer = setTimeout(closeCheers, CHEER_TRAY_MS);
	}
	function openCheers() {
		cheering = true;
		holdCheers();
	}
	$effect(() => {
		void entryId;
		if (!canCheer) return;
		return closeCheers;
	});
	/* Play gives its slot to the Cheer key once the song starts: focus follows it there (or to the link when the key
	   rests, on your own song), never to <body>. */
	let playTapped = false;
	$effect(() => {
		if (!hasSong || !playTapped) return;
		playTapped = false;
		if (document.activeElement === document.body) refocus();
	});
</script>

<!-- A `section`, not a `nav`: the tab bar below is the navigation landmark, and two sibling navs make the
	landmark list ambiguous to a screen reader. The label names the thing rather than the control group. -->
<section class="strip" aria-label="Now playing" bind:this={strip}>
	<!-- THE PROGRESS HAIRLINE IS `aria-hidden` AND NOT A `progressbar`: it duplicates no information a guest
		cannot get — /tv carries the real elapsed readout at a size readable across a room — and announcing a
		once-a-second percentage over the title is noise on the surface you hold. Scaled on a transform so the
		once-a-second write touches no layout. `?? 0`: with no song `progressFraction` is null, and `scaleX(null)` is
		an invalid transform, which drew the fill FULL under "Nothing playing". -->
	<div class="rail" aria-hidden="true">
		<div class="fill" style:transform="scaleX({fraction ?? 0})"></div>
	</div>

	{#if cheering && canCheer && onreact}
		<ReactionRow
			singerName={singerName}
			onreact={(kind) => {
				holdCheers();
				onreact(kind);
			}}
			onclose={closeCheers}
		/>
	{:else}
		<a class="meta" href="/queue" bind:this={metaLink}>
			{#if !connected}
				<!-- THE OFFLINE CUE TAKES THE TITLE SLOT rather than a row of its own, so a wifi blip no longer grows the
					dock. --warn, NOT --danger: a dropped socket self-heals on the next backoff tick. It says only
					Reconnecting… because queue taps are held and resent while transport taps are lost (+layout.svelte's
					`transport()` says the second). -->
				<span class="offline" role="status" aria-live="polite"><Icon name="warning" /> Reconnecting…</span>
			{:else if hasSong}
				<!-- The singer dot is the one place the phone repeats the TV's colour coding, so whose turn it is
					survives a glance at a strip two lines tall. -->
				<span class="dot" style:background={singerColor ?? 'var(--accent)'}></span>
				<!-- KEYED ON THE ENTRY: a new song is new nodes, not the old title spans sliding sideways because the new
					singer's name is a different width (a layout shift on every phone at every song change). -->
				{#key entryId}
					<span class="who">{singerName ?? 'Someone'}</span>
					<span class="sep" aria-hidden="true">·</span>
					<span class="song">{title ?? 'Untitled'}</span>
				{/key}
			{:else if live}
				<!-- `.status`, which WRAPS to two lines inside its box, never `.who`, which does not shrink: the waiting line
					can be a whole sentence, and at 320px it ran under the restart button. Not `.song` either, which means
					"a song is playing" to every spec reading the strip. -->
				<span class="status">{canStart ? 'Ready when you are' : waitingLine}</span>
			{:else}
				<span class="idle">Nothing playing</span>
			{/if}
		</a>

		<!-- THE CHEER KEY'S SLOT IS HERE for the whole song, as #986 did for the row: on your song or with reactions
			off it is hidden and inert in place, so nothing in the line moves at the handoff or when the host flips it. -->
		{#if hasSong}
			<div class="tp">
				<button
					class="btn cheer-key"
					class:resting={!canCheer}
					bind:this={cheerKey}
					onclick={openCheers}
					inert={!canCheer}
					aria-label="Cheer for {singerName ?? 'the singer'}"
				>
					<span class="pic"><ReactionGlyph kind="clap" /></span>
				</button>
			</div>
		{:else if canStart && onplay}
			<!-- "Ready when you are" keeps its Play here, in the Cheer key's slot: a room idle with a ready queue (after a
				server restart) waits for a tap, and /queue's Now card only exists once a song plays. -->
			<div class="tp">
				<button class="btn primary play" onclick={() => ((playTapped = true), onplay())} aria-label="Play"
					><Icon name="play" /></button
				>
			</div>
		{/if}
	{/if}
</section>

<style>
	.strip {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-md);
		/* NO padding-block: the controls are var(--tap) tall and they set the height, so the strip is exactly one
		   tap floor and the number lives in one place. */
		padding-inline: var(--space-lg);
		/* Spotlight chrome: ink on the ground, one rule on top, no surface of its own. */
		background: var(--role-ground);
		border-top: 1px solid var(--role-rule);
	}

	.rail {
		position: absolute;
		inset-block-start: 0;
		inset-inline: 0;
		height: var(--space-3xs);
		background: var(--track-bg);
		/* Decoration over the top of the row: without this it takes the first 2px of the /queue link's hit extent. */
		pointer-events: none;
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

	/* NEVER SHRINKS, so a short name always shows whole; a long one stops at the cap and ellipsises there, leaving the
	   title its room. `min-width: 0` here let a two-letter name shrink with the title to one clipped glyph. */
	.who {
		font-weight: 600;
		white-space: nowrap;
		flex-shrink: 0;
		max-width: 60%;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.sep,
	.idle {
		color: var(--ink-dim);
	}

	/* nowrap: one line, so the strip keeps its one height. "Reconnecting…" fits beside the transport at 320. */
	.offline {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		white-space: nowrap;
		color: var(--warn);
		font-weight: 600;
	}

	/* The title is what gives up width: the singer's name is the fact you are checking at a glance, and a truncated
	   name reads as the wrong person where a truncated song title still reads as the right song. The name's 60% cap
	   on `.who` is what keeps a long name from taking the title away; `min-width` only stops the title collapsing
	   below a few letters when the row itself is that narrow. */
	.song {
		min-width: 4ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--ink-dim);
	}

	/* The waiting line, in the name's weight. It WRAPS, to two lines at most: it can be a whole sentence with two ways
	   out in it ("Your song didn't work. Try again or pick another."), and on Sing and Library it is the singer's only
	   notice. With no song the line has the strip's whole width, and two lines fit inside its one tap floor. */
	.status {
		min-width: 4ch;
		overflow: hidden;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		line-height: var(--lh-snug);
		font-weight: 600;
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

	/* The idle Play, the strip's one fill. --on-accent: the one ink certified on --accent (5.09:1), and the glyph is
	   the borderless key's identification. */
	.btn.primary {
		background: var(--role-accent);
		color: var(--role-on-accent);
	}

	/* The cheers' own surface, so the key reads as the way into them. */
	.cheer-key {
		background: var(--card2);
	}

	/* `visibility` too, so the hidden key is not hit-tested or found by a locator; it switches at the END of the fade
	   out and at the start of the fade in, which is how a `visibility` transition interpolates. */
	.btn.resting {
		opacity: 0;
		visibility: hidden;
	}

	.pic {
		width: calc(var(--tap) / 2);
		height: calc(var(--tap) / 2);
	}

	@media (prefers-reduced-motion: no-preference) {
		/* The PERIOD is --motion-tick, once a second, so the fill is interpolated across the whole gap between
		   writes rather than stepping. Only `transform` is animated, which the compositor can do off-thread. */
		.fill {
			transition: transform var(--motion-tick) linear;
		}
		/* Resting is a fade in place, so it touches no layout. */
		.cheer-key {
			transition:
				opacity var(--motion-base) ease-out,
				visibility var(--motion-base);
		}
	}
</style>
