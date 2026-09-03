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

	interface Props {
		qrDataUrl: string;
		joinUrl: string;
		/** Present singers, already capped + ordered by `lobbyRoster`. */
		roster: RosterMember[];
		/** How many present singers did not fit in `roster`. */
		overflow?: number;
	}

	let { qrDataUrl, joinUrl, roster, overflow = 0 }: Props = $props();

	const count = $derived(roster.length + overflow);
	// With a rehydrated queue but nobody reconnected, the roster is empty — say something true
	// rather than "0 in the room".
	const sub = $derived(
		count > 0
			? `${count} in the room · search on your phone and tap ＋ Turn`
			: 'Scan to join, then search on your phone and tap ＋ Turn'
	);
</script>

<div class="lobby">
	<div class="stack">
		<JoinBadge {qrDataUrl} {joinUrl} placement="hero" size={238} />
		<div class="copy">
			<h1>Waiting for someone to pick a song…</h1>
			<p class="sub">{sub}</p>
		</div>
	</div>

	{#if roster.length > 0}
		<div class="strip">
			<span class="label">In the room</span>
			{#each roster as member (member.id)}
				<span class="chip">
					<span class="swatch" style="background: {member.color}"></span>{member.displayName}
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
		background: radial-gradient(80% 60% at 50% 30%, #1b1430 0%, var(--bg) 70%);
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
		font-size: 2.2rem;
		margin: 0;
	}
	.sub {
		font-size: 1.05rem;
		color: var(--ink-dim);
		margin: 6px 0 0;
	}

	.strip {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		padding: 22px 40px;
		background: linear-gradient(transparent, rgba(11, 11, 18, 0.9) 40%);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 16px;
		flex-wrap: wrap;
	}
	.label {
		font-size: 0.8rem;
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
		font-size: 1.15rem;
		font-weight: 600;
	}
	.chip.more {
		padding: 10px 18px;
		color: var(--ink-dim);
	}
	.swatch {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		flex: none;
	}
</style>
