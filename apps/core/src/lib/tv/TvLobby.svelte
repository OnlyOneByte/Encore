<!--
	TvLobby — "people are here, nobody has picked a song yet".

	Layout option B (chosen 2026-09-02): the QR keeps the stage, the waiting line sits under it, and
	the roster runs along the bottom as a strip. Reads as "the night hasn't started yet" while still
	naming everyone who is in, so the screen answers both questions a glancing guest has: *can I
	join?* and *who's here?*

	The roster is PRESENCE-derived, never the full singer table — that table is append-only
	and file-backed, so it would accumulate everyone who ever joined across nights.
-->
<script lang="ts">
	import JoinBadge from './JoinBadge.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import type { RosterMember } from './screen';
	import { cookStageLabel } from '$lib/cook-phrasing';

	interface Props {
		qrDataUrl: string;
		joinUrl: string;
		/** Present singers, already capped + ordered by `lobbyRoster`. */
		roster: RosterMember[];
		/** How many present singers did not fit in `roster`. */
		overflow?: number;
		/**
		 * Queued entries that cannot play yet — cooking, or waiting on a worker.
		 *
		 * The lobby covers TWO situations, not one, and the headline used to describe only the first:
		 * "Waiting for someone to pick a song…" was shown even when somebody HAD picked one and it was
		 * separating, because tvScreen() routes a queued-but-unplayable entry here (its `waiting` value
		 * requires the player to be actively holding). So the screen contradicted the phone, which was
		 * simultaneously saying "You're next once it's ready".
		 */
		pendingCount?: number;
		/** The advertised join address is unroutable — render the operator notice, not a dead QR. */
		unreachable?: boolean;
	}

	let { qrDataUrl, joinUrl, roster, overflow = 0, pendingCount = 0, unreachable = false }: Props = $props();

	const count = $derived(roster.length + overflow);

	/*
	 * DISPLAY CAP — bound what the strip has to CONTAIN, not clip what it shows (#98).
	 *
	 * The strip sits in the .lobby column below the fixed-height stack; its own height reserves the band
	 * above it, but if it grows tall the region left for the stack shrinks and the join address spills
	 * back into it. `lobbyRoster` already caps the roster at 8, but 8 names at the 32-char ceiling the
	 * join path allows (repository.ts) wrap to ~5 rows on a 720p panel — far taller than the band can be
	 * without eating the stack. So we render at most MAX_CHIPS names here and FOLD the rest into the
	 * "+N more" chip, before layout, so the strip is at most two rows at any name length and NOTHING is
	 * clipped off-screen — the count stays truthful and the overflow chip always survives (it was the
	 * first casualty of a raw `overflow: hidden`). MAX_CHIPS = 4, combined with a per-chip
	 * max-width + ellipsis (a 32-char name is unreadable on a wall anyway), keeps even the widest room to
	 * two rows so the band stays short.
	 */
	const MAX_CHIPS = 4;
	const shownRoster = $derived(roster.slice(0, MAX_CHIPS));
	// Everyone not shown: the names we folded here PLUS the presence overflow lobbyRoster already counted.
	const hiddenCount = $derived(Math.max(0, roster.length - MAX_CHIPS) + overflow);
	/* Scheme-less, matching attract: nobody types "http://" off a wall. The QR carries the full URL. */
	const joinShort = $derived(joinUrl.replace(/^https?:\/\//, ''));
	/** Somebody has picked, it just is not singable yet. Different situation, different words. */
	const cooking = $derived(pendingCount > 0);

	// The cook line comes from cook-phrasing — the ONE guest-facing cook vocabulary, shared with the
	// phone — so the lobby and the phone say the same thing. The TV knows only a coarse "something is
	// cooking" state, so it passes the least-committal in-flight value 'queued' (which resolves to
	// "Making karaoke…") rather than naming a worker step it cannot know. The "· N in line" count is a
	// lobby-only addition the phone has no equivalent for, so it stays here.
	const headline = $derived(
		cooking
			? pendingCount === 1
				? cookStageLabel('queued')
				: `${cookStageLabel('queued')} · ${pendingCount} in line`
			: 'Waiting for someone to pick a song…'
	);

	// With a rehydrated queue but nobody reconnected, the roster is empty — say something true
	// rather than "0 in the room".
	const sub = $derived(
		cooking
			? // Do NOT tell them to pick a song here: they already did, and the honest answer is that the
				// wait is the karaoke being made, not them. "karaoke", not "the vocals"/"separation" — the
				// guest word, matching cook-phrasing and the phone.
				count > 0
				? `${count} in the room · making the karaoke, this takes a minute`
				: 'Making the karaoke — this takes a minute'
			: count > 0
				? `${count} in the room · search on your phone and tap Turn`
				: 'Scan to join, then search on your phone and tap Turn'
	);
</script>

<div class="lobby">
	<div class="stack-region">
	<div class="stack">
		{#if unreachable}
			<JoinBadge {qrDataUrl} {joinUrl} placement="hero" size="var(--tv-qr)" unreachable={true} />
		{:else}
			<!--
				ORDER: instruction, then the QR, then the typed address beneath it.
				The QR used to come first with the copy underneath, which read as "here is a code, and
				some text about it". Leading with the instruction and captioning the code with its own
				address makes the pair one object — and it is the same object, at a smaller scale, that
				sits in the corner during a song, so a guest recognises it across states.
			-->
			<div class="brand"><Icon name="mic" /> <span class="grad">Encore</span></div>
			<div class="copy">
				<h1>{headline}</h1>
				<p class="sub">{sub}</p>
			</div>
			<JoinBadge {qrDataUrl} {joinUrl} placement="hero" size="var(--tv-qr)" unreachable={false} />
			<!--
				The address in text as well as in the QR. The attract screen prints it and this screen did
				not, which left the lobby — the state a latecomer actually walks in on — with no way to join
				when a camera will not scan the code. Same treatment as attract so the two screens do not
				disagree about what the address looks like.
			-->
			<p class="url">{joinShort}</p>
		{/if}
	</div>
	</div>

	{#if roster.length > 0}
		<div class="strip">
			<span class="label">In the room</span>
			{#each shownRoster as member (member.id)}
				<!--
				  An away singer is GREYED, not removed. Before this the roster was pure socket count, so a
				  locked phone erased its owner from the screen — the one place a guest confirms the room
				  saw them join. "away" is spelled out rather than implied by opacity alone: dimming is not
				  a legible signal across a room, and it is invisible to anyone reading the name aloud.
				-->
				<span class="person" class:away={member.state === 'away'}>
					<span class="swatch" style="--singer: {member.color}"></span><span class="name">{member.displayName}</span>
					{#if member.state === 'away'}<span class="tag">away</span>{/if}
				</span>
			{/each}
			{#if hiddenCount > 0}
				<span class="person more">+{hiddenCount} more</span>
			{/if}
		</div>
	{/if}
</div>

<style>
	.lobby {
		position: absolute;
		inset: 0;
		z-index: 5;
		display: flex;
		/*
		 * COLUMN, not a single centred box. The stack takes a flex region that ENDS where the roster
		 * strip begins; the strip flows beneath it in normal order. Centring the stack across the full
		 * `inset: 0` box while the strip was pinned `bottom: 0` and grew upward as names wrapped meant the
		 * two intersected on short panels (≤768px), and DOM order painted the strip's backdrop and chips
		 * over the typed join address — the only way in when a camera won't read the QR (#98). With the
		 * strip in flow its real height always reserves its band, so no roster size at any panel height
		 * can reach the address. The 1920/3840 panels never overlapped, so a reserve keyed to a fixed
		 * height would have been wrong at the tall end; letting the strip's own height do the reserving is
		 * correct at every resolution.
		 */
		flex-direction: column;
		background: radial-gradient(80% 60% at 50% 30%, var(--stage-glow) 0%, var(--bg) 70%);
	}
	/* The stack owns all the space the strip does not, and centres itself inside it — so on a tall panel
	   it reads exactly as before (centred with the strip a thin band at the very bottom), and on a short
	   one it slides up out of the strip's way rather than into it. */
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
		/*
		 * No flex `gap`. The rhythm is deliberately uneven — instruction, a beat, the QR, a smaller beat,
		 * its address — and one gap would force all three intervals equal. Per-child margins in vh, so
		 * the proportions hold at 720p and 4K rather than being right at one size. Mirrors the attract
		 * screen's stack, because the two idles are meant to be the same screen with a different
		 * instruction and a different bottom strip.
		 */
	}
	/* In flow at the head of the stack, exactly as on attract — the two idles are meant to be the same
	   screen. It used to be pinned top-left by the route while attract centred it, which is the kind of
	   mismatch only a side-by-side frame reveals. */
	.brand {
		font-weight: 800;
		font-size: var(--tv-name);
		display: inline-flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 5.2vh;
	}
	.grad {
		background: var(--grad);
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}
	.copy {
		text-align: center;
	}
	h1 {
		/*
		 * --tv-hero, not --tv-name. This is an instruction read once, not a lyric sung along to, so it
		 * does not belong on the reel's ladder — and taking it off the name tier is what pays for the
		 * space above the QR.
		 */
		font-size: var(--tv-hero);
		font-weight: 900;
		line-height: 1.04;
		margin: 0;
		max-width: 26ch;
	}
	.sub {
		font-size: var(--tv-label);
		color: var(--ink-dim);
		margin: 1.4vh 0 0;
	}
	.stack :global(.hero) {
		margin-top: 6.2vh;
	}
	/* Matches the attract screen's treatment of the same string: primary content here, so it takes the
	   join-URL tier rather than the corner-chrome one. */
	.url {
		font-size: var(--tv-joinurl);
		font-weight: 800;
		color: var(--ink);
		margin: 3vh 0 0;
		overflow-wrap: anywhere;
	}

	.strip {
		/*
		 * In normal flow at the foot of the .lobby column now, not `position: absolute; bottom: 0`. It
		 * still spans the full width (it is the column's own width) and keeps its full-bleed fade to the
		 * bottom edge, but its height is part of layout, which is what reserves the band above it (#98).
		 */
		flex: none;
		/*
		 * The BACKDROP is deliberately full-bleed (it is the column's full width and its fade runs to the
		 * bottom edge) so it reaches the edge of the panel, but the CONTENT inside it must not be. Padding
		 * carries the safe-area inset, because a set that overscans would otherwise crop the roster — the
		 * one place a guest confirms the room actually saw them join. A guard that only inspects edge
		 * OFFSETS cannot catch this shape, which is why it survived the first pass of the stage scale.
		 */
		padding: 22px var(--tv-safe-x) calc(var(--tv-safe-y) * 0.6);
		/* rgba(11,11,18,0.9) was --bg at 90%; color-mix keeps the fade on the theme's background. */
		background: linear-gradient(transparent, color-mix(in srgb, var(--bg) 90%, transparent) 40%);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 16px;
		flex-wrap: nowrap;
		/*
		 * The display cap (MAX_CHIPS in the script) already keeps this to at most two rows at any name
		 * length, so this max-height is a SAFETY NET, not the mechanism — and there is deliberately no
		 * `overflow: hidden`: with the roster bounded before layout nothing needs clipping, and a hard clip
		 * is what silently ate roster members (and the "+N more" chip) at the 32-char ceiling.
		 */
		max-height: 20vh;
	}
	.label {
		font-size: var(--tv-eyebrow);
		letter-spacing: 0.2em;
		text-transform: uppercase;
		color: var(--ink-dim);
		font-weight: 700;
	}
	/*
	 * A NAME AND A DOT, not a pill.
	 *
	 * Each roster entry used to be a bordered, filled chip. Five of them made the bottom of the screen
	 * read as a row of buttons on a surface that has no input at all — and the pill's surface was doing
	 * no work the dot and the name were not already doing. Dropping it removes furniture from the one
	 * screen whose job is to feel like an invitation, and the singer's own hue still separates one
	 * person from the next.
	 */
	.person {
		display: inline-flex;
		align-items: center;
		gap: 0.42em;
		font-size: var(--tv-body);
		font-weight: 700;
		/*
		 * Bound the chip WIDTH so one very long name (the join path admits up to 32 chars) cannot blow a
		 * row out and, combined with the MAX_CHIPS count cap, force the strip to a height that eats the
		 * stack above (#98). A name past this is clipped with an ellipsis on the NAME only — the dot (the
		 * singer's identity) is flex:none and always shows. A 32-char name is not readable across a room
		 * regardless, so truncating the tail loses nothing a guest could use.
		 */
		max-width: 16ch;
		min-width: 0;
	}
	.person .name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.person.more {
		color: var(--ink-dim);
		font-weight: 600;
	}
	/*
	 * Away: recessed, never hidden. The dot keeps its hue (that is the singer's identity, and fading it
	 * would read as a different person) while the name recedes, so a glance separates "here now" from
	 * "still in the room" without having to read every entry.
	 */
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
		color: var(--ink-dim);
		opacity: 0.8;
	}
	.swatch {
		width: 0.62em;
		height: 0.62em;
		border-radius: 50%;
		flex: none;
		background: var(--singer);
		/*
		 * A hairline ring so a dot never dissolves into the background. Guests choose their own hue now,
		 * and although the picker's pinned lightness guarantees at least 3:1 against the surfaces, this
		 * dot is the ONLY thing distinguishing one singer from another on a screen read from across a
		 * room — so it gets a defined edge rather than relying on fill contrast alone.
		 *
		 * Sized in `em` now that it rides beside the name rather than inside a fixed-height pill, so it
		 * tracks the name at every resolution instead of being a 22px dot next to 4K type.
		 */
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 25%, transparent);
	}
</style>
