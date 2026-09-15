<script lang="ts">
	/*
	 * THE NOW-PLAYING DRAWER — what the band pulls up into.
	 *
	 * It replaces `NowPlayingHero`, and the replacement is a change of PLACE rather than of content:
	 * the same song identity, the same seek row, the same transport, the same live controls. What
	 * changes is that none of it occupies the queue any more. The hero was a card at the top of home
	 * that pushed the rotation down and duplicated, once the band existed, everything the band already
	 * said at a glance.
	 *
	 * `handleOnly` IS THE LOAD-BEARING PROP. vaul drawers drag-to-dismiss from anywhere in their
	 * content by default, and this drawer's body is sliders — the guiding-track thumb and, on the way
	 * past, the range visualizer. A drag surface underneath a slider is precisely what XR-PH-15 bans:
	 * the two gestures are the same gesture, and the drawer wins because it is the ancestor. So
	 * dragging is restricted to the handle, which is a whitelist rather than a blacklist of
	 * `data-vaul-no-drag` elements — a whitelist cannot be forgotten when a control is added later.
	 * (That prop only works because `ui/drawer` now renders vaul's real Handle; shadcn's copy shipped a
	 * decorative div, which would have made `handleOnly` silently undraggable. See drawer-handle.svelte.)
	 *
	 * THE SLIDER'S MOUNT CONSTRAINT IS SATISFIED STRUCTURALLY. GuidingTrack wraps a Bits UI Slider that
	 * reads `offsetWidth`, and the mount rung replaces that with a throw (XR-VER-03), so it must not
	 * mount while hidden. The hero needed an explicit `{#if controlsOpen}` INSIDE its Collapsible for
	 * this, because Collapsible renders its content always and merely hides it. A drawer's content is
	 * portalled on open and destroyed on close, so there is nothing to guard — the constraint is met by
	 * the container rather than by a condition someone has to remember.
	 *
	 * THE RANGE SITS DIRECTLY BELOW KEY, with no disclosure of its own (ratified 2026-09-14). It used
	 * to be behind a nested "Vocal range" Collapsible inside the hero's controls Collapsible — two
	 * disclosures deep to see a picture that answers "can I sing this?" in one glance. One level of
	 * revealing is the drawer itself; a second inside it was a wall.
	 *
	 * THE "···" IS THE ONLY HEADER AFFORDANCE, and it is three dots rather than a cog or an ⓘ because of
	 * where it sits, not what it means. The header already has a round icon-only control column on the
	 * right in every other surface of this app, so a second round glyph there reads as a sibling of it —
	 * an ⓘ was mistaken for app settings on sight. Three dots say "more about this thing" without
	 * competing.
	 *
	 * It NAVIGATES, and it closes the drawer on the way. Leaving the drawer open over the song page would
	 * cover the page it just opened, since this component lives in the layout and survives the route
	 * change — which is the same persistence that makes the band work.
	 *
	 * It renders only with a `mediaId`, for the same reason the band's handle renders only with an
	 * `onexpand`: with nothing playing there is no song to be more specific about.
	 */
	import * as Drawer from '$lib/components/ui/drawer';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import Icon from '$lib/ui/Icon.svelte';
	import GuidingTrack from '$lib/components/GuidingTrack.svelte';
	import RangeBar from '$lib/components/RangeBar.svelte';
	import LyricsReselect from '$lib/components/LyricsReselect.svelte';
	import { formatClock, formatRemaining, progressFraction } from '$lib/clock';
	import {
		originalKeyLabel,
		soundingKeyLabel,
		rangeLabel,
		rangeOctaves,
		voiceBandSentence,
		type LyricsCandidate,
		type SongProfile
	} from '$lib/contract';

	interface Props {
		open?: boolean;
		title?: string | null;
		artist?: string | null;
		singerName?: string | null;
		singerColor?: string | null;
		/** The song's musical profile — this component derives every key and range string from it. */
		profile?: SongProfile | null;
		keyShift?: number;
		/** ±key needs separated stems; there is nothing to re-pitch before that. */
		keyShiftEnabled?: boolean;
		/** The room's effective guide level as a percentage, from the server. */
		guideServerPct?: number;
		/** A song with no isolated vocals stem keeps the row, disabled, with its reason stated. */
		guideEnabled?: boolean;
		elapsedSec?: number;
		durationSec?: number;
		isPlaying?: boolean;
		hasSong?: boolean;
		/** Play is live with a queue but no current song: "start when ready" is a real intent. */
		canStart?: boolean;
		/** The playing song's id. Absent means nothing is playing, so there is nothing to open. */
		mediaId?: string | null;
		candidates?: LyricsCandidate[];
		chosenRef?: string;
		overrideRef?: string;
		newerExists?: boolean;
		onrestart?: () => void;
		ontoggleplay?: () => void;
		onskip?: () => void;
		onkey?: (semitones: number) => void;
		onguide?: (level: number) => void;
		onpicklyrics?: (ref: string) => void;
		onpastelyrics?: (text: string) => void;
	}

	let {
		open = $bindable(false),
		title = null,
		artist = null,
		singerName = null,
		singerColor = null,
		profile = null,
		keyShift = 0,
		keyShiftEnabled = false,
		guideServerPct = 0,
		guideEnabled = false,
		elapsedSec = 0,
		durationSec = 0,
		isPlaying = false,
		hasSong = false,
		canStart = false,
		mediaId = null,
		candidates = [],
		chosenRef = undefined,
		overrideRef = undefined,
		newerExists = false,
		onrestart,
		ontoggleplay,
		onskip,
		onkey,
		onguide,
		onpicklyrics,
		onpastelyrics
	}: Props = $props();

	// null (not 0) for an unknown length, so the seek row HIDES rather than pinning a bar at zero,
	// which reads as a stalled song.
	const progress = $derived(progressFraction(elapsedSec, durationSec));

	// Every music string comes from the shared pure helpers; this file only decides WHEN to show each.
	const keyOriginal = $derived(originalKeyLabel(profile));
	const keySounding = $derived(soundingKeyLabel(profile, keyShift));
	const keyShifted = $derived(keyShift !== 0 && keySounding !== null && keySounding !== keyOriginal);
	const keyLabel = $derived(keyShift === 0 ? 'Key' : `Key · ${keyShift > 0 ? '+' : '−'}${Math.abs(keyShift)}`);
	const rangeText = $derived(rangeLabel(profile, keyShift));
	const octaves = $derived(rangeOctaves(profile));
	const bandSentence = $derived(voiceBandSentence(profile, keyShift));
	const byline = $derived([artist, keyOriginal].filter(Boolean).join(' · ') || null);

	/*
	 * While a finger is on the slider we show the LOCAL value, not the server's. Without this the thumb
	 * fights the throttled echo coming back over the websocket and jumps under the finger. This state
	 * is about a drag in progress, so it belongs to the surface holding the slider rather than to the
	 * room.
	 */
	let guideDragging = $state(false);
	let guideDraft = $state(0);
	const guidePct = $derived(guideDragging ? guideDraft : guideServerPct);

	const GUIDE_SEND_THROTTLE_MS = 120;
	let guideLastSent = 0;
	let guidePending: ReturnType<typeof setTimeout> | null = null;

	function sendGuide(pct: number): void {
		guideLastSent = Date.now();
		onguide?.(pct / 100);
	}
	function onGuideInput(pct: number): void {
		guideDragging = true;
		guideDraft = pct;
		const since = Date.now() - guideLastSent;
		if (since >= GUIDE_SEND_THROTTLE_MS) {
			sendGuide(pct);
			return;
		}
		// Trailing send, so the last position of a fast drag is not the one that gets dropped.
		if (guidePending) clearTimeout(guidePending);
		guidePending = setTimeout(() => {
			guidePending = null;
			sendGuide(guideDraft);
		}, GUIDE_SEND_THROTTLE_MS - since);
	}
	function onGuideCommit(pct: number): void {
		if (guidePending) {
			clearTimeout(guidePending);
			guidePending = null;
		}
		guideDraft = pct;
		sendGuide(pct);
		guideDragging = false;
	}

	/*
	 * Stated AHEAD of the control it explains, so the reason is read before the dead row rather than
	 * after it, and never dimmed by an ancestor `opacity` — XR-PH-03. This is the XR-PH-15 degradation:
	 * the guide row stays VISIBLE and disabled, because "this song has no isolated vocals" is
	 * information, and hiding the control would leave the singer wondering where it went.
	 */
	const guideNote = $derived(
		hasSong && !guideEnabled
			? 'No isolated vocals, so no guiding track. Key and range still work.'
			: null
	);
</script>

<Drawer.Root bind:open handleOnly>
	<Drawer.Content class="np-drawer">
		<Drawer.Header class="np-head">
			{#if singerName}
				<div class="eyebrow">
					<span class="singer-dot" style="--singer:{singerColor ?? 'var(--accent)'}"></span>
					<span>Now singing · {singerName}</span>
				</div>
			{/if}
			<div class="titlerow">
				<div class="titlecol">
					<Drawer.Title class="np-song">{hasSong ? title : 'Nothing playing'}</Drawer.Title>
					<!-- No filler when there is nothing to say. "Adjust while you sing" described the drawer to the
					     person who had just opened it, and "Queue a song to start the party" repeated the title
					     back with encouragement attached. -->
					{#if byline}
						<Drawer.Description class="np-byline">{byline}</Drawer.Description>
					{/if}
				</div>
				{#if hasSong && mediaId}
					<div class="more-slot">
						<Button
							variant="ghost"
							size="icon"
							href={`/song/${mediaId}`}
							aria-label="More about this song"
							onclick={() => (open = false)}
						>
							<Icon name="dots" />
						</Button>
					</div>
				{/if}
			</div>
		</Drawer.Header>

		<div class="np-body">
			{#if progress !== null}
				<!-- Time REMAINING on the right: the question this surface answers is "when am I up?".
				     aria-hidden because the position card on home states the same thing in words. -->
				<div class="seekrow" aria-hidden="true">
					<span class="time">{formatClock(elapsedSec)}</span>
					<div class="bar-slot"><Progress value={progress * 100} size="sm" /></div>
					<span class="time r">{formatRemaining(elapsedSec, durationSec)}</span>
				</div>
			{/if}

			<!-- Disabled when there is nothing to act on. Restart and skip need a song that is PLAYING;
			     play additionally accepts a queue with something in it, because the server decides when
			     "start when it is ready" becomes a start. -->
			<div class="transport">
				<Button variant="outline" size="icon" aria-label="restart" disabled={!hasSong} onclick={() => onrestart?.()}>
					<Icon name="prev" />
				</Button>
				<Button
					variant="iconPrimary"
					size="icon"
					aria-label="play/pause"
					disabled={!hasSong && !canStart}
					onclick={() => ontoggleplay?.()}
				>
					<Icon name={isPlaying ? 'pause' : 'play'} />
				</Button>
				<Button variant="outline" size="icon" aria-label="skip" disabled={!hasSong} onclick={() => onskip?.()}>
					<Icon name="next" />
				</Button>
			</div>

			<!--
				The live controls only exist for a song playing NOW, so an idle room shows the transport and
				stops there rather than offering knobs with nothing behind them.
			-->
			{#if hasSong}
				<div class="tools-body">
					{#if guideNote}<p class="tools-note">{guideNote}</p>{/if}
					<GuidingTrack pct={guidePct} available={guideEnabled} oninput={onGuideInput} oncommit={onGuideCommit} />

					{#if keyOriginal}
						<div class="key-head" class:shifted={keyShifted}>
							<span class="key-vals">
								<span class="key-orig">{keyOriginal}</span>
								{#if keyShifted}
									<span class="key-arrow"><Icon name="arrow-right" /></span>
									<span class="key-sound">{keySounding}</span>
								{/if}
							</span>
						</div>
					{/if}

					<div class="key" class:disabled={!keyShiftEnabled} class:shifted={keyShift !== 0}>
						<span class="lab">{keyLabel}</span>
						<div class="key-cell">
							<Button
								variant="keycap"
								size="block"
								disabled={!keyShiftEnabled || keyShift <= -7}
								onclick={() => onkey?.(keyShift - 1)}
							>
								<Icon name="minus" /> semitone
							</Button>
						</div>
						<div class="key-cell">
							<Button
								variant="keycap"
								size="block"
								disabled={!keyShiftEnabled || keyShift >= 7}
								onclick={() => onkey?.(keyShift + 1)}
							>
								<Icon name="plus" /> semitone
							</Button>
						</div>
					</div>

					<!--
						DIRECTLY BELOW KEY, no disclosure. The picture answers "can I sing this, in this key?" and
						the ± buttons are the thing it answers ABOUT, so putting a tap between them made the two
						halves of one question feel like two features.
					-->
					{#if rangeText}
						<div class="range">
							<div class="range-facts">
								<span class="range-label">{rangeText}</span>
								{#if octaves !== null}<span class="range-oct">{octaves} oct</span>{/if}
							</div>
							{#if bandSentence}<p class="range-band">{bandSentence}</p>{/if}
							<RangeBar {profile} {keyShift} />
						</div>
					{/if}

					{#if candidates.length}
						<LyricsReselect
							{candidates}
							{chosenRef}
							{overrideRef}
							{newerExists}
							onpick={(ref) => onpicklyrics?.(ref)}
							onpaste={(text) => onpastelyrics?.(text)}
						/>
					{/if}
				</div>
			{/if}
		</div>
	</Drawer.Content>
</Drawer.Root>

<style>
	/*
	 * The content box. `--max-w` for the same reason the band tracks it: this is bottom-docked chrome,
	 * and on a laptop a full-bleed sheet would put the transport at the far edge of the window,
	 * pointing at nothing. The surface stays full-bleed (the vendored Content paints it) and only the
	 * inner measure is capped.
	 */
	:global([data-slot='drawer-content'].np-drawer) {
		/*
		 * ELEVATION, because without it the drawer read as a DUPLICATE of the band rather than as its
		 * expansion. Both surfaces are `--card`, both carry a 1px top border and a 12px top radius, so a
		 * sheet sliding up over the band showed two matching top edges for the length of the transition
		 * and looked like a second copy of the same thing arriving. Nothing was duplicated — sampling the
		 * DOM every 40ms through the open found exactly one content node and one overlay — the two
		 * surfaces were simply indistinguishable.
		 *
		 * The shadow is the same `--shadow` the band itself casts, so the pair reads as one surface
		 * lifting off another rather than two competing panels. The band also fades under it; see
		 * `.dock.covered` in +layout.svelte.
		 */
		box-shadow: var(--shadow);
		/*
		 * THE DRAWER COVERS THE BAND, deliberately — and this reserved space for it underneath until a
		 * captured frame showed the truth: the drawer's content is portalled to the end of the body at a
		 * higher stacking level, so it was never going to open ABOVE the band, and `--dock-h` of padding
		 * was simply 89px of empty surface at the bottom of every drawer.
		 *
		 * Covering is also the right behaviour, which is why the fix is to delete the padding rather than
		 * to raise the drawer. The band is a one-line glance at the song; the drawer is the same song,
		 * larger, with its controls. Showing both at once states it twice.
		 *
		 * So the drawer becomes the bottom-most element while it is open, and it therefore has to carry
		 * the home-indicator inset itself. That does not break the one-env() rule the band records: the
		 * two are never the bottom-most element at the same time, and nothing measures the drawer into
		 * --dock-h.
		 */
		padding-bottom: calc(env(safe-area-inset-bottom, 0px) + var(--space-lg));
	}
	:global(.np-head),
	.np-body {
		width: 100%;
		max-width: var(--max-w);
		margin-inline: auto;
		/* A nowrap child must not set a floor this box cannot go under — the band's own defect class. */
		min-width: 0;
	}
	:global(.np-head) {
		padding: var(--space-md) var(--space-2xl) var(--space-sm);
		text-align: left;
	}
	.np-body {
		padding: 0 var(--space-2xl);
	}
	/* The title column takes the width; the affordance keeps its own box out of the text's flow. */
	.titlerow {
		display: flex;
		align-items: flex-start;
		gap: var(--space-md);
	}
	.titlecol {
		flex: 1;
		/* A two-line clamped title must not set a floor this column cannot go under. */
		min-width: 0;
	}
	.more-slot {
		flex: 0 0 auto;
		/* Optical alignment with the column edge, matching PageHeader's own back-slot pull. */
		margin-right: -10px;
		color: var(--ink-dim);
		display: flex;
	}
	.eyebrow {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: var(--ph-text-2xs);
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-dim);
		min-width: 0;
	}
	.eyebrow span:last-child {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* Two lines then ellipsis, so a full YouTube title cannot push the transport off screen. */
	:global(.np-song) {
		margin: var(--space-xs) 0 0;
		font-size: var(--ph-text-xl);
		font-weight: 800;
		line-height: 1.15;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	:global(.np-byline) {
		margin: var(--space-2xs) 0 0;
		font-size: var(--ph-text-sm);
		color: var(--ink-dim);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.seekrow {
		display: flex;
		align-items: center;
		gap: 9px;
		margin: var(--space-sm) 0 var(--space-3xs);
	}
	.time {
		font-size: var(--ph-text-2xs);
		color: var(--ink-dim);
		font-variant-numeric: tabular-nums;
		min-width: 30px;
	}
	.time.r {
		text-align: right;
	}
	.bar-slot {
		flex: 1;
		min-width: 0;
	}
	.transport {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		margin-top: var(--space-md);
	}
	.tools-body {
		margin-top: var(--space-lg);
		border-top: 1px solid var(--line);
		padding-top: var(--space-sm);
		padding-bottom: var(--space-2xs);
	}
	/* Dimmed with the INK token, never with `opacity` on a subtree — an ancestor alpha flattens the
	   sentence and the surface behind it into one buffer, so measured contrast stops being what is
	   painted (XR-PH-03). */
	.tools-note {
		margin: 0 0 var(--space-2xs);
		font-size: var(--ph-text-2xs);
		line-height: var(--lh-normal);
		color: var(--ink-dim);
	}
	.key {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
		margin: var(--space-xs) 0 var(--space-3xs);
		align-items: center;
	}
	/* Disabled reads through the label's own token; the keycaps carry their own disabled treatment. */
	.key.disabled .lab {
		color: var(--ink-dim);
	}
	.key .lab {
		font-size: var(--ph-text-2xs);
		color: var(--ink-dim);
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}
	.key.shifted .lab {
		color: var(--warn);
	}
	.key-cell {
		flex: 1 1 40%;
		min-width: 0;
		display: flex;
	}
	.key-head {
		display: flex;
		align-items: baseline;
		justify-content: flex-end;
		gap: var(--space-sm);
		margin: var(--space-sm) 0 0;
	}
	.key-vals {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		font-variant-numeric: tabular-nums;
	}
	.key-orig {
		font-size: var(--ph-text-sm);
		font-weight: 700;
		color: var(--ink);
	}
	.key-arrow {
		display: inline-grid;
		place-items: center;
		color: var(--ink-dim);
		font-size: var(--ph-text-sm);
	}
	.key-sound {
		font-size: var(--ph-text-sm);
		font-weight: 700;
		color: var(--warn);
	}
	.range {
		margin: var(--space-sm) 0 var(--space-3xs);
	}
	.range-facts {
		display: flex;
		align-items: baseline;
		gap: var(--space-md);
	}
	.range-label {
		font-size: var(--ph-text-base);
		font-weight: 700;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}
	.range-oct {
		font-size: var(--ph-text-xs);
		color: var(--ink-dim);
		font-variant-numeric: tabular-nums;
	}
	.range-band {
		font-size: var(--ph-text-xs);
		color: var(--ink-dim);
		margin: var(--space-2xs) 0 0;
	}
</style>
