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
	import { processStageLabel } from '$lib/phrasing/process-phrasing';

	interface Props {
		qrDataUrl: string;
		joinUrl: string;
		/** Present singers, already capped + ordered by `lobbyRoster`. */
		roster: RosterMember[];
		/** How many present singers did not fit in `roster`. */
		overflow?: number;
		/**
		 * Queued entries that cannot play yet — processing, or waiting on a worker.
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
	 * FULL ROSTER, NO TRUNCATION (XR-TV-14).
	 *
	 * The lobby shows EVERY guest — the reason to show the roster at all is that it must not degrade as
	 * the party grows, so a "+N more" fold (the previous behaviour) is exactly the degradation to avoid.
	 * The route now passes the whole roster (lobbyRoster with no cap), so `overflow` is 0 and this
	 * renders one chip per present singer.
	 *
	 * THE STEP-DOWN IS A RULE, not a discovery at a party. Measured: 10 guests still fit two rows at the
	 * 56px chip; headroom is ~12 before the chips must shrink. Above CHIP_STEPDOWN the roster switches to
	 * a smaller chip tier (the `.roster.dense` modifier) so 13+ guests still fit without clipping or
	 * overflowing the title-safe area, rather than letting a bigger party push chips off-screen.
	 *
	 * A COUNT IS NOT THE CONSTRAINT — TOTAL WIDTH IS, and keying only on the count clipped the roster.
	 * The "~12" headroom was measured with names of a typical length, but `displayName` is user-typed and
	 * `repository.ts` admits up to 32 characters. At that ceiling a chip is roughly three times as wide,
	 * so NINE guests already overflow the two rows `max-height: 26vh` allows, while the count rule sits
	 * quiet until 13 — and `overflow: hidden` then cut the tail off silently. `e2e/lobby-overlap` caught
	 * it at every viewport below 1080p: nine 32-character names clipped 9 chips at 720p, 7 at 768p.
	 *
	 * So the rule now keys on the thing that actually wraps: total characters across the roster.
	 * CHAR_BUDGET is CHIP_STEPDOWN × a typical name, which keeps the measured behaviour for ordinary
	 * parties — 12 guests at ~10 characters is still not dense — and steps down early exactly when the
	 * names are what consume the row. Still a rule, still no geometry read: `.dense` is derived from the
	 * data, never from measuring the rendered strip.
	 */
	const CHIP_STEPDOWN = 12;
	const CHAR_BUDGET = 120;
	const rosterChars = $derived(roster.reduce((n, m) => n + m.displayName.length, 0));
	const dense = $derived(roster.length > CHIP_STEPDOWN || rosterChars > CHAR_BUDGET);
	/* Scheme-less AND query-less, matching attract: nobody types "http://" or the redundant ?room=CODE
	   off a wall (the QR carries the full URL). Stripping the query is also what keeps the address to one
	   line so it cannot collide with a full roster below it. */
	const joinShort = $derived(joinUrl.replace(/^https?:\/\//, '').replace(/\?.*$/, ''));
	/** Somebody has picked, it just is not singable yet. Different situation, different words. */
	const processing = $derived(pendingCount > 0);

	// The process line comes from process-phrasing — the ONE guest-facing process vocabulary, shared with the
	// phone — so the lobby and the phone say the same thing. The TV knows only a coarse "something is
	// processing" state, so it passes the least-committal in-flight value 'queued' (which resolves to
	// "Making karaoke…") rather than naming a worker step it cannot know. The "· N in line" count is a
	// lobby-only addition the phone has no equivalent for, so it stays here.
	const headline = $derived(
		processing
			? pendingCount === 1
				? processStageLabel('queued')
				: `${processStageLabel('queued')} · ${pendingCount} in line`
			: 'Waiting for someone to pick a song…'
	);

	// With a rehydrated queue but nobody reconnected, the roster is empty — say something true
	// rather than "0 in the room".
	const sub = $derived(
		processing
			? // Do NOT tell them to pick a song here: they already did, and the honest answer is that the
				// wait is the karaoke being made, not them. "karaoke", not "the vocals"/"separation" — the
				// guest word, matching process-phrasing and the phone.
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
				<JoinBadge
					qrDataUrl={qrDataUrl}
					joinUrl={joinUrl}
					placement="hero"
					size="var(--tv-attract-qr)"
					unreachable={true}
				/>
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
				<JoinBadge
					qrDataUrl={qrDataUrl}
					joinUrl={joinUrl}
					placement="hero"
					size="var(--tv-attract-qr)"
					unreachable={false}
				/>
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
		<div class="strip" class:dense={dense}>
			<span class="label">In the room</span>
			{#each roster as member (member.id)}
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
		</div>
	{/if}
</div>

<style>
	.lobby {
		position: absolute;
		inset: 0;
		z-index: var(--z-tv-screen);
		display: flex;
		/*
		 * COLUMN, not a single centred box. The stack takes a flex region that ENDS where the roster
		 * strip begins; the strip flows beneath it in normal order. Centring the stack across the full
		 * `inset: 0` box while the strip was pinned `bottom: 0` and grew upward as names wrapped meant the
		 * two intersected on short panels (≤768px), and DOM order painted the strip's backdrop and chips
		 * over the typed join address — the only way in when a camera won't read the QR. With the
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
		gap: var(--space-lg);
		margin-bottom: 2.4vh;
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
		 * --tv-name (not --tv-hero): the lobby now shows the WHOLE roster below, so the headline
		 * yields height to the roster rather than owning the reel-adjacent hero tier. Still well above the
		 * ten-foot floor; it is read once, not sung along to.
		 */
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
	/* The typed join address. Same 44px budget and no-break rule as the attract's .jt-url (XR-TV-19):
	   an address is one unbreakable token, so it is sized to fit one line rather than wrapped mid-octet.
	   The query is already stripped in the script, so this is host:port/join — short enough at --tv-name. */
	.url {
		font-size: var(--tv-name);
		font-weight: 800;
		color: var(--ink);
		margin: 1.6vh 0 0;
	}

	.strip {
		/*
		 * In normal flow at the foot of the .lobby column, not `position: absolute; bottom: 0`. Its height
		 * is part of layout, which reserves the band above it. It now shows the WHOLE roster
		 * (XR-TV-14), so it WRAPS to multiple rows rather than clipping — a party is not truncated.
		 */
		flex: none;
		/*
		 * The BACKDROP is deliberately full-bleed (it is the column's full width and its fade runs to the
		 * bottom edge) so it reaches the edge of the panel, but the CONTENT inside it must not be. Padding
		 * carries the safe-area inset, because a set that overscans would otherwise crop the roster — the
		 * one place a guest confirms the room actually saw them join. A guard that only inspects edge
		 * OFFSETS cannot catch this shape, which is why it survived the first pass of the stage scale.
		 *
		 * RESERVE THE CORNER CONTROLS (XR-TV-14 blocker). The fullscreen button (.fs-btn) and the
		 * join corner badge are `position: absolute` in the bottom-right at `right: var(--tv-safe-x)`,
		 * ABOVE this strip in the paint order (--z-tv-card > --z-tv-reel). A wrapped roster's rightmost
		 * chip used to land UNDER the button (elementFromPoint returned .fs-btn at 10–12 guests), which is
		 * worse than the "+N more" it replaced — a name hidden under a control. So the horizontal padding
		 * clears the control's whole footprint (its 88px cap + the safe inset + a gap), applied to BOTH
		 * sides so the centred roster stays centred and reaches neither bottom corner.
		 */
		padding: 22px var(--tv-strip-corner-clear) calc(var(--tv-safe-y) * 0.6);
		/* rgba(11,11,18,0.9) was --bg at 90%; color-mix keeps the fade on the theme's background. */
		background: linear-gradient(transparent, color-mix(in srgb, var(--bg) 90%, transparent) 40%);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2xl);
		/*
		 * WRAP the full roster. No cap, no clip: every guest is shown. The step-down (`.dense`
		 * below) is what keeps a large party inside the title-safe band — the chips shrink rather than
		 * the roster being truncated or clipped off-screen.
		 */
		flex-wrap: wrap;
		/*
		 * A vh max-height so the wrapped strip cannot grow UPWARD past its band into the corner controls
		 * either (the horizontal clear handles the same-row case; this handles the extra-rows case). NO
		 * `overflow: hidden` — with the step-down keeping 13+ inside two rows this is a safety net, not a
		 * clip, and a hard clip is what silently ate roster members in the previous design.
		 */
		max-height: 26vh;
	}
	/*
	 * THE CHIP STEP-DOWN RULE (XR-TV-14). Above CHIP_STEPDOWN (12) guests the chip type and dot
	 * step down a tier, so 13+ still fit two rows inside the title-safe area instead of pushing chips
	 * off-screen. A RULE, applied by the `dense` class the script derives, rather than a size a party
	 * discovers by overflowing. Written as `.dense .name` / `.dense .swatch` (not `.dense .person`) so
	 * the smaller tier tracks the type and the identity dot together.
	 */
	.strip.dense {
		gap: var(--space-xl);
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
		 * row out. A name past this is clipped with an ellipsis on the NAME only — the dot (the singer's
		 * identity) is flex:none and always shows. A 32-char name is not readable across a room anyway, so
		 * truncating the tail loses nothing a guest could use, and the roster wraps rather than overflowing.
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
