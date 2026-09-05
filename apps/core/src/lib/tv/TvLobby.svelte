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
	<div class="stack">
		<JoinBadge {qrDataUrl} {joinUrl} placement="hero" size="var(--tv-qr)" {unreachable} />
		{#if !unreachable}
			<div class="copy">
				<h1>{headline}</h1>
				<p class="sub">{sub}</p>
				<!--
					The address in text as well as in the QR. The attract screen prints it and this screen did
					not, which left the lobby — the state a latecomer actually walks in on — with no way to join
					when a camera will not scan the code. Same treatment as attract so the two screens do not
					disagree about what the address looks like.
				-->
				<p class="url">{joinUrl}</p>
			</div>
		{/if}
	</div>

	{#if roster.length > 0}
		<div class="strip">
			<span class="label">In the room</span>
			{#each roster as member (member.id)}
				<!--
				  An away singer is GREYED, not removed. Before this the roster was pure socket count, so a
				  locked phone erased its owner from the screen — the one place a guest confirms the room
				  saw them join. "away" is spelled out rather than implied by opacity alone: dimming is not
				  a legible signal across a room, and it is invisible to anyone reading the chip aloud.
				-->
				<span class="chip" class:away={member.state === 'away'}>
					<span class="swatch" style="--singer: {member.color}"></span>{member.displayName}
					{#if member.state === 'away'}<span class="tag">away</span>{/if}
				</span>
			{/each}
			{#if overflow > 0}
				<span class="chip more">+{overflow} more</span>
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
		align-items: center;
		justify-content: center;
		background: radial-gradient(80% 60% at 50% 30%, var(--stage-glow) 0%, var(--bg) 70%);
	}
	.stack {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 34px;
	}
	.copy {
		text-align: center;
	}
	h1 {
		font-size: var(--tv-name);
		margin: 0;
	}
	.sub {
		font-size: var(--tv-label);
		color: var(--ink-dim);
		margin: 6px 0 0;
	}
	/* Matches the attract screen's treatment of the same string. */
	.url {
		font-size: var(--tv-body);
		color: var(--accent2);
		margin: 10px 0 0;
		overflow-wrap: anywhere;
	}

	.strip {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		/*
		 * The BACKDROP is deliberately full-bleed (bottom: 0) so its fade reaches the edge of the panel,
		 * but the CONTENT inside it must not be. Padding carries the safe-area inset instead of the
		 * offset, because a set that overscans would otherwise crop the roster — the one place a guest
		 * confirms the room actually saw them join. A guard that only inspects edge OFFSETS cannot catch
		 * this shape, which is why it survived the first pass of the stage scale.
		 */
		padding: 22px var(--tv-safe-x) calc(var(--tv-safe-y) * 0.6);
		/* rgba(11,11,18,0.9) was --bg at 90%; color-mix keeps the fade on the theme's background. */
		background: linear-gradient(transparent, color-mix(in srgb, var(--bg) 90%, transparent) 40%);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 16px;
		flex-wrap: wrap;
	}
	.label {
		font-size: var(--tv-label);
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--ink-dim);
	}
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		padding: 10px 18px 10px 12px;
		border-radius: 999px;
		background: var(--card);
		border: 1px solid var(--line);
		font-size: var(--tv-body);
		font-weight: 600;
	}
	.chip.more {
		padding: 10px 18px;
		color: var(--ink-dim);
	}
	/*
	 * Away: recessed, never hidden. The dot keeps its hue (that is the singer's identity, and fading it
	 * would read as a different person) while the surface and name recede, so a glance separates "here
	 * now" from "still in the room" without having to read every chip.
	 */
	.chip.away {
		background: transparent;
		color: var(--ink-dim);
		font-weight: 500;
	}
	.chip.away .swatch {
		opacity: 0.55;
	}
	.tag {
		font-size: var(--tv-label);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--ink-dim);
		opacity: 0.8;
	}
	.swatch {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		flex: none;
		background: var(--singer);
		/*
		 * A hairline ring so a dot never dissolves into the chip. Guests choose their own hue now, and
		 * although the picker's pinned lightness guarantees at least 3:1 against the surfaces, this dot
		 * is the ONLY thing distinguishing one singer from another on a screen read from across a room —
		 * so it gets a defined edge rather than relying on fill contrast alone.
		 */
		/* rgba(255,255,255,0.25) was a translucent-white ring; --ink is the theme's near-white. */
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 25%, transparent);
	}
</style>
