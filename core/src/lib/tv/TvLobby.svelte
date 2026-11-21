<script lang="ts">
	import type { Snippet } from 'svelte';
	import JoinBadge from './JoinBadge.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import { lobbyLine, type RosterMember } from './screen';
	import { processStageLabel } from '$lib/phrasing/process-phrasing';
	import { joinAddressLabel } from './join-address';

	interface Props {
		qrDataUrl: string;
		joinUrl: string;
		/** Present singers, already capped + ordered by `lobbyRoster`. */
		roster: RosterMember[];
		/** How many present singers did not fit in `roster`. */
		overflow?: number;
		// Queued entries whose karaoke is being MADE. `tvScreen()` routes a queued-but-unplayable entry HERE, so a
		// headline that only describes "nobody has picked" contradicts the phone's "Making karaoke…" card.
		pendingCount?: number;
		/** What the room is waiting on when turns are queued and NONE is being made (`stuckTurnsLines`). Without it
		 * a dead turn read "Making karaoke… this takes a minute" for as long as it sat there. */
		stuck?: { headline: string; next: string } | null;
		/** The advertised join address is unroutable — render the operator notice, not a dead QR. */
		unreachable?: boolean;
		/** Without it, the state a latecomer walks in on is the one state with no typed way in. */
		roomCode?: string | null;
		/** A song being made is past its estimate (`etaSec < 0`): the phone's card says so, and so must this. */
		overdue?: boolean;
		/** ONE TV PER ROOM: on a copy, what stands where the QR does ("Make this the TV"); guests join from the TV's. */
		join?: Snippet;
	}

	let {
		qrDataUrl,
		joinUrl,
		roster,
		overflow = 0,
		pendingCount = 0,
		stuck = null,
		unreachable = false,
		roomCode = null,
		overdue = false,
		join
	}: Props = $props();

	const count = $derived(roster.length + overflow);

	// A COUNT IS NOT THE CONSTRAINT — TOTAL WIDTH IS: `displayName` admits 32 characters, so nine long names already
	// overflow the two rows `max-height: 26vh` allows while a count rule sits quiet until 13. CHAR_BUDGET is
	// CHIP_STEPDOWN times a typical name, and both are read off the DATA, never a measurement of the rendered strip.
	// See docs/FRONTEND.md#the-attract-and-lobby-idles.
	const CHIP_STEPDOWN = 12;
	const CHAR_BUDGET = 120;
	const rosterChars = $derived(roster.reduce((n, m) => n + m.displayName.length, 0));
	const dense = $derived(roster.length > CHIP_STEPDOWN || rosterChars > CHAR_BUDGET);
	/* Stripping the query is what keeps the address to ONE line, so it cannot collide with a full roster below. */
	const joinShort = $derived(joinAddressLabel(joinUrl));
	/** Somebody has picked, it just is not singable yet. Different situation, different words. */
	const processing = $derived(pendingCount > 0);

	// From process-phrasing — the ONE guest-facing vocabulary, shared with the phone. The TV holds only a coarse
	// "something is processing" state, so it passes the least-committal in-flight value.
	const headline = $derived(
		processing
			? pendingCount === 1
				? processStageLabel('queued')
				: `${processStageLabel('queued')} · ${pendingCount} in line`
			: (stuck?.headline ?? 'Waiting for someone to pick a song…')
	);

	// The line under the headline, in `screen.ts` so a unit test can read every wording of it. A stuck turn's way out
	// replaces the "pick a song" prompt, but never the line for a song being made.
	const sub = $derived(!processing && stuck ? stuck.next : lobbyLine(count, processing, overdue));
</script>

<!--
	The roster is PRESENCE-derived, never the full singer table: that table is append-only and file-backed, so it would
	accumulate everyone who ever joined across nights.
-->
<div class="lobby">
	<div class="stack-region">
		<div class="stack">
			<!--
				ORDER: instruction, then the QR, then the typed address — the same object, at a smaller scale, that sits in
				the corner during a song, so a guest recognises it across states.
			-->
			<div class="brand"><Icon name="mic" /> <span class="grad-text">Encore</span></div>
			<div class="copy">
				<h1>{headline}</h1>
				<p class="sub">{sub}</p>
			</div>
			{#if join}
				{@render join()}
			{:else}
				<JoinBadge
					qrDataUrl={qrDataUrl}
					joinUrl={joinUrl}
					placement="hero"
					size="var(--tv-attract-qr)"
					unreachable={unreachable}
				/>
			{/if}
			<!-- The address in TEXT as well as in the QR, so the lobby can still be joined when a camera will not scan. -->
			<p class="url">{joinShort}</p>
			<!-- Same ladder as attract, but the VALUE one tier down: this screen also carries a headline and a roster. -->
			{#if roomCode}
				<p class="code"><span class="code-l">or enter room code</span><b class="code-v">{roomCode}</b></p>
			{/if}
		</div>
	</div>

	{#if roster.length > 0}
		<div class={['strip', { dense }]}>
			<span class="label">In the room</span>
			{#each roster as member (member.id)}
				<!--
					An away singer is GREYED, not removed: a locked phone must not erase its owner from the one place a guest
					confirms the room saw them join. "away" is spelled OUT, because dimming alone is not legible across a room.
				-->
				<span class={['person', { away: member.state === 'away' }]}>
					<span class="swatch" style="--singer: {member.color}"></span><span class="name">{member.displayName}</span>
					{#if member.state === 'away'}<span class="tag">away</span>{/if}
				</span>
			{/each}
		</div>
	{/if}
</div>

<style>
	.lobby {
		position: absolute;
		inset: 0;
		z-index: var(--z-tv-screen);
		display: flex;
		/* COLUMN, not a single centred box: the stack takes a flex region that ENDS where the strip begins, so the
		   strip's real height reserves its own band at every resolution. Centred across the full `inset: 0` box the two
		   intersected on short panels and the strip's chips painted over the typed join address. */
		flex-direction: column;
		background: radial-gradient(80% 60% at 50% 30%, var(--stage-glow) 0%, var(--bg) 70%);
	}
	/* The stack owns all the space the strip does not, so on a short panel it slides UP out of the way. */
	.stack-region {
		flex: 1;
		min-height: 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.stack {
		display: flex;
		flex-direction: column;
		align-items: center;
		/* No flex `gap`: the rhythm is deliberately UNEVEN, and one gap would force all three intervals equal.
		   Per-child margins in vh instead, so the proportions hold at 720p and 4K. */
	}
	.brand {
		font-weight: 800;
		font-size: var(--tv-name);
		display: inline-flex;
		align-items: center;
		gap: var(--space-lg);
		margin-bottom: 2.4vh;
	}
	.copy {
		text-align: center;
	}
	h1 {
		/* --tv-name, not --tv-hero: the whole roster shows below, so the headline yields height to it. */
		font-size: var(--tv-name);
		font-weight: 900;
		line-height: 1.04;
		margin: 0;
		max-width: 26ch;
	}
	.sub {
		font-size: var(--tv-label);
		color: var(--ink-dim);
		margin: 1.2vh 0 0;
	}
	.stack :global(.hero) {
		margin-top: 2.8vh;
	}
	/* Same rule as attract's `.jt-url`: an address is ONE unbreakable token, sized to fit rather than wrapped. */
	.url {
		font-size: var(--tv-name);
		font-weight: 800;
		color: var(--ink);
		margin: 1.6vh 0 0;
	}
	/* `text-align: center` IS LOAD-BEARING, not a default restated: `.stack` is a flex COLUMN with
	   `align-items: center`, so this <p> is a shrink-to-fit item sized by its wider child and its two block children
	   would otherwise inherit the stage's left alignment. */
	.code {
		margin: 1.2vh 0 0;
		text-align: center;
	}
	/* EACH `padding-left` MUST MATCH ITS OWN `letter-spacing`: tracking adds its space after the last glyph as well as
	   between, and a centred line box includes it, so the glyphs sit left of true centre by half the tracking. */
	.code-l {
		display: block;
		font-size: var(--tv-label);
		letter-spacing: 0.16em;
		padding-left: 0.16em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
	.code-v {
		display: block;
		margin-top: 0.4vh;
		font-size: var(--tv-name);
		font-weight: 800;
		letter-spacing: 0.18em;
		padding-left: 0.18em;
		color: var(--ink);
	}

	.strip {
		/* In normal flow, NOT `position: absolute`, so its height is part of layout and reserves the band above it. */
		flex: none;
		/* The BACKDROP is full-bleed but the CONTENT must not be: this padding carries the safe-area inset, or an
		   overscanning set crops the roster. It ALSO reserves the corner controls, which are absolute in the
		   bottom-right and ABOVE this strip in paint order — a wrapped roster's last chip landed under the fullscreen
		   button. Applied to BOTH sides, so the centred roster stays centred. */
		padding: 22px var(--tv-strip-corner-clear) calc(var(--tv-safe-y) * 0.6);
		background: linear-gradient(transparent, color-mix(in srgb, var(--bg) 90%, transparent) 40%);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2xl);
		/* WRAP, never clip: the `.dense` step-down shrinks the chips rather than truncating the roster. */
		flex-wrap: wrap;
		/* Stops the wrapped strip growing UPWARD into the corner controls. Deliberately NO `overflow: hidden` — a hard
		   clip silently ate roster members. */
		max-height: 26vh;
	}
	/* Written as `.dense .name` / `.dense .swatch`, so chip type and dot step down together. The GAP has to step down
	   by something a room can see from the sofa: it was the retired `xl`, which made 16 -> 14, a 1.14 step, while the
	   chip type beside it dropped --tv-name -> --tv-body, 1.509 / 1.132 = 1.333. `lg` makes the gap 16 -> 12, also
	   1.333, so the two halves of the step-down now move by the same factor. */
	.strip.dense {
		gap: var(--space-lg);
	}
	.strip.dense .name {
		font-size: var(--tv-body);
	}
	.strip.dense .swatch {
		width: 0.5em;
		height: 0.5em;
	}
	.label {
		font-size: var(--tv-eyebrow);
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--ink-dim);
		font-weight: 700;
	}
	/* A NAME AND A DOT, not a pill: filled bordered chips made the bottom of the screen read as a row of buttons on a
	   surface with no input at all. */
	.person {
		display: inline-flex;
		align-items: center;
		gap: 0.42em;
		font-size: var(--tv-body);
		font-weight: 700;
		/* Bounded so one very long name cannot blow a row out. The NAME ellipsises; the dot is the singer's identity,
		   so it is flex:none and always shows. */
		max-width: 16ch;
		min-width: 0;
	}
	.person .name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	/* The name greys to --ink-dim; the DOT keeps its HUE and is only alpha-dimmed below. That distinction is the point:
	   RECOLOURING the swatch would read as a different singer, where dimming it reads as the same singer, away. Opacity
	   is legal on that leaf precisely because it carries no text. */
	.person.away {
		color: var(--ink-dim);
		font-weight: 500;
	}
	.person.away .swatch {
		opacity: 0.55;
	}
	.tag {
		font-size: var(--tv-eyebrow);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		/* Folded: --ink-dim AND an 0.8 alpha double-dimmed this label, and neither half read as the result. */
		color: color-mix(in srgb, var(--ink-dim) 80%, transparent);
	}
	.swatch {
		width: 0.62em;
		height: 0.62em;
		border-radius: 50%;
		flex: none;
		background: var(--singer);
		/* A hairline ring so the dot never dissolves: the picker's pinned lightness already guarantees 3:1, but this dot
		   is the ONLY thing separating one singer from another across a room. In `em`, so it tracks the name. */
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 25%, transparent);
	}
</style>
