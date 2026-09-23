<script lang="ts">
	import JoinBadge from './JoinBadge.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import type { RosterMember } from './screen';
	import { processStageLabel } from '$lib/phrasing/process-phrasing';
	import { joinAddressLabel } from './join-address';

	interface Props {
		qrDataUrl: string;
		joinUrl: string;
		/** Present singers, already capped + ordered by `lobbyRoster`. */
		roster: RosterMember[];
		/** How many present singers did not fit in `roster`. */
		overflow?: number;
		/**
		 * Queued entries that cannot play yet — processing, or waiting on a worker. The lobby covers TWO
		 * situations: `tvScreen()` routes a queued-but-unplayable entry here, so a headline that only describes
		 * "nobody has picked" contradicts the phone, which is saying "You're next once it's ready".
		 */
		pendingCount?: number;
		/** The advertised join address is unroutable — render the operator notice, not a dead QR. */
		unreachable?: boolean;
		/**
		 * The room code — the typed way in. The attract screen prints it as the largest element on the stage, so
		 * without it here the state a latecomer walks in on is the one state with no code.
		 */
		roomCode?: string | null;
	}

	let {
		qrDataUrl,
		joinUrl,
		roster,
		overflow = 0,
		pendingCount = 0,
		unreachable = false,
		roomCode = null
	}: Props = $props();

	const count = $derived(roster.length + overflow);

	/*
	 * FULL ROSTER, NO TRUNCATION: the reason to show it at all is that it must not degrade as the party grows.
	 *
	 * A COUNT IS NOT THE CONSTRAINT — TOTAL WIDTH IS. `displayName` admits up to 32 characters, where a chip
	 * is roughly three times as wide, so NINE guests already overflow the two rows `max-height: 26vh` allows
	 * while a count rule sits quiet until 13 and `overflow: hidden` cuts the tail off silently. So the rule
	 * keys on total CHARACTERS: CHAR_BUDGET is CHIP_STEPDOWN times a typical name, which keeps ordinary
	 * parties un-dense. Derived from the DATA, never from measuring the rendered strip.
	 */
	const CHIP_STEPDOWN = 12;
	const CHAR_BUDGET = 120;
	const rosterChars = $derived(roster.reduce((n, m) => n + m.displayName.length, 0));
	const dense = $derived(roster.length > CHIP_STEPDOWN || rosterChars > CHAR_BUDGET);
	/* Scheme-less AND query-less, matching attract. Stripping the query is also what keeps the address to ONE
	   line, so it cannot collide with a full roster below it. */
	const joinShort = $derived(joinAddressLabel(joinUrl));
	/** Somebody has picked, it just is not singable yet. Different situation, different words. */
	const processing = $derived(pendingCount > 0);

	// From process-phrasing — the ONE guest-facing vocabulary, shared with the phone. The TV knows only a
	// coarse "something is processing" state, so it passes the least-committal in-flight value rather than
	// naming a worker step it cannot know.
	const headline = $derived(
		processing
			? pendingCount === 1
				? processStageLabel('queued')
				: `${processStageLabel('queued')} · ${pendingCount} in line`
			: 'Waiting for someone to pick a song…'
	);

	// With a rehydrated queue but nobody reconnected the roster is empty, so say something true rather than
	// "0 in the room".
	//
	// THE PROMPT SAYS "pick a song", NOT "tap Turn": there is no control called Turn — SongRow's actions are
	// ICON-ONLY and the words survive only as `aria-label`s — so naming one instructs a whole room to look for
	// a label no phone displays. The verb is borrowed from `headline` one block up.
	const sub = $derived(
		processing
			? // Do NOT tell them to pick a song here: they already did, and the honest answer is that the
				// wait is the karaoke being made. "karaoke", not "the vocals"/"separation" — the guest word.
				count > 0
				? `${count} in the room · making the karaoke, this takes a minute`
				: 'Making the karaoke — this takes a minute'
			: count > 0
				? `${count} in the room · search on your phone and pick a song`
				: 'Scan to join, then search on your phone and pick a song'
	);
</script>

TvLobby — "people are here, nobody has picked a song yet". The QR keeps the stage, the waiting line sits under it, and
the roster runs along the bottom as a strip, so the screen answers both questions a glancing guest has: can I join, and
who is here? The roster is PRESENCE-derived, never the full singer table — that table is append-only and file-backed, so
it would accumulate everyone who ever joined across nights.

<div class="lobby">
	<div class="stack-region">
		<div class="stack">
			<!--
				The QR renders in EVERY state, reachable or not; `JoinBadge` appends a one-line notice under it.
				Replacing the whole stack took the headline, the roster context, the address and the code with it.
			-->
			<!--
				ORDER: instruction, then the QR, then the typed address. Leading with the instruction and captioning the
				code with its own address makes the pair ONE object — the same object, at a smaller scale, that sits in
				the corner during a song, so a guest recognises it across states.
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
				unreachable={unreachable}
			/>
			<!--
				The address in TEXT as well as in the QR, so the lobby — the state a latecomer walks in on — can
				still be joined when a camera will not scan. Same treatment as attract, so the two screens agree.
			-->
			<p class="url">{joinShort}</p>
			<!--
				AND THE CODE. Same ladder as attract so the two states agree, but the VALUE is one tier down,
				because this screen also carries a headline, a roster strip and the QR.
			-->
			{#if roomCode}
				<p class="code"><span class="code-l">or enter room code</span><b class="code-v">{roomCode}</b></p>
			{/if}
		</div>
	</div>

	{#if roster.length > 0}
		<div class="strip" class:dense={dense}>
			<span class="label">In the room</span>
			{#each roster as member (member.id)}
				<!--
					An away singer is GREYED, not removed: a locked phone must not erase its owner from the one place
					a guest confirms the room saw them join. "away" is spelled OUT rather than implied by opacity
					alone — dimming is not legible across a room, and invisible to anyone reading the name aloud.
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
		 * COLUMN, not a single centred box. The stack takes a flex region that ENDS where the strip begins, and the
		 * strip flows beneath it. Centred across the full `inset: 0` box while the strip was pinned `bottom: 0` and
		 * grew upward as names wrapped, the two intersected on short panels and DOM order painted the strip's chips
		 * over the typed join address — the only way in when a camera will not read the QR. In flow, the strip's
		 * real height always reserves its band, which is correct at every resolution a fixed reserve is not.
		 */
		flex-direction: column;
		background: radial-gradient(80% 60% at 50% 30%, var(--stage-glow) 0%, var(--bg) 70%);
	}
	/* The stack owns all the space the strip does not, so on a tall panel it reads as before and on a short one
	   it slides UP out of the strip's way rather than into it. */
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
		 * No flex `gap`: the rhythm is deliberately UNEVEN — instruction, a beat, the QR, a smaller beat, its
		 * address — and one gap would force all three intervals equal. Per-child margins in vh, so the proportions
		 * hold at 720p and 4K. Mirrors the attract stack: the two idles are the same screen.
		 */
	}
	/* In flow at the head of the stack, exactly as on attract — the two idles are the same screen. */
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
		/* --tv-name, not --tv-hero: the whole roster shows below, so the headline yields height to it rather than
		   owning the reel-adjacent hero tier. Still well above the ten-foot floor; it is read once. */
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
	/* Same budget and no-break rule as attract's `.jt-url`: an address is ONE unbreakable token, sized to fit
	   one line rather than wrapped mid-octet. */
	.url {
		font-size: var(--tv-name);
		font-weight: 800;
		color: var(--ink);
		margin: 1.6vh 0 0;
	}
	/*
	 * THE CODE LINE. One block, label above value, so the pair cannot separate as the stack reflows, with a
	 * tighter gap than the address's because the two belong together as one typed path.
	 *
	 * THE VALUE IS `--tv-name`, NOT attract's `--tv-code`: this screen also carries a headline, a sub, the QR
	 * and the roster strip, so the display tier would outweigh the roster the screen exists to show. The
	 * LETTER-SPACING is what makes it transcribable at this size.
	 */
	/*
	 * `text-align: center` IS LOAD-BEARING, not a default restated. `.stack` is a flex COLUMN with
	 * `align-items: center`, so this <p> is a shrink-to-fit item sized by its WIDER child — the label — and its
	 * two block children then inherit the stage's left alignment.
	 */
	.code {
		margin: 1.2vh 0 0;
		text-align: center;
	}
	/*
	 * THE `padding-left` COMPENSATES THE TRAILING LETTER-SPACE: `letter-spacing` adds its space AFTER the last
	 * glyph as well as between, and a centred line box includes it, so the glyphs sit left of true centre by
	 * half the tracking. One letter-space of left padding is exactly that error, so each value must match its
	 * own tracking.
	 */
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
		/*
		 * In normal flow at the foot of the column, NOT `position: absolute`, so its height is part of layout and
		 * reserves the band above it. It WRAPS rather than clipping: a party is not truncated.
		 */
		flex: none;
		/*
		 * The BACKDROP is deliberately full-bleed, but the CONTENT inside it must not be: the padding carries the
		 * safe-area inset, or a set that overscans crops the roster — the one place a guest confirms the room saw
		 * them join. A guard that only inspects edge OFFSETS cannot catch this shape.
		 *
		 * IT ALSO RESERVES THE CORNER CONTROLS, which are absolute in the bottom-right and ABOVE this strip in
		 * paint order, so a wrapped roster's rightmost chip landed UNDER the fullscreen button — a name hidden
		 * under a control. Applied to BOTH sides, so the centred roster stays centred.
		 */
		padding: 22px var(--tv-strip-corner-clear) calc(var(--tv-safe-y) * 0.6);
		background: linear-gradient(transparent, color-mix(in srgb, var(--bg) 90%, transparent) 40%);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2xl);
		/* WRAP the full roster: no cap, no clip. The `.dense` step-down is what keeps a large party inside the
		   title-safe band — the chips shrink rather than the roster being truncated. */
		flex-wrap: wrap;
		/* A vh max-height so the wrapped strip cannot grow UPWARD into the corner controls (the horizontal clear
		   handles the same-row case). Deliberately NO `overflow: hidden` — a hard clip is what silently ate roster
		   members before. */
		max-height: 26vh;
	}
	/* Above the budget the chip type and dot step down a tier, so a large party still fits two rows inside the
	   title-safe area. Written as `.dense .name` / `.dense .swatch` so type and dot track together. */
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
	/* A NAME AND A DOT, not a pill: bordered filled chips made the bottom of the screen read as a row of
	   buttons on a surface that has no input at all. The singer's own hue still separates one from the next. */
	.person {
		display: inline-flex;
		align-items: center;
		gap: 0.42em;
		font-size: var(--tv-body);
		font-weight: 700;
		/* Bound the chip WIDTH so one very long name cannot blow a row out. The NAME ellipsises; the dot is the
		   singer's identity, so it is flex:none and always shows. */
		max-width: 16ch;
		min-width: 0;
	}
	.person .name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	/* Away: recessed, never hidden. The DOT keeps its hue — that is the singer's identity, and fading it would
	   read as a different person — while the name recedes. */
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
		 * A hairline ring so a dot never dissolves: the picker's pinned lightness guarantees 3:1 against the
		 * surfaces, but this dot is the ONLY thing distinguishing one singer from another on a screen read across a
		 * room. Sized in `em`, so it tracks the name rather than being a 22px dot next to 4K type.
		 */
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 25%, transparent);
	}
</style>
