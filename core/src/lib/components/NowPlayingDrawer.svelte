<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	/* One surface at two heights, whose collapsed height IS the docked band. The snap-point model, the
	   drag-exclusion rules and the three drawer props are in docs/FRONTEND.md#shared-components. */
	import * as Drawer from '$lib/components/ui/drawer';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import { Badge } from '$lib/components/ui/badge';
	import Icon from '$lib/ui/Icon.svelte';
	import NowPlayingBand from '$lib/components/NowPlayingBand.svelte';
	import GuidingTrack from '$lib/components/GuidingTrack.svelte';
	import RangeBar from '$lib/components/RangeBar.svelte';
	import { formatClock, formatRemaining, progressFraction } from '$lib/clock';
	import { SNAP_BAND, OPEN_CONTENT_SLACK_PX, openSnapFraction } from '$lib/sheet-snap';
	import {
		originalKeyLabel,
		soundingKeyLabel,
		rangeLabel,
		rangeOctaves,
		voiceBandSentence,
		isAuthoritativeText,
		lyricsSourceLabel,
		type LyricsCandidate,
		type SongProfile
	} from '$lib/contract';

	interface Props {
		open?: boolean;
		/** Bindable, so the layout publishes it as `--dock-h` and stays that token's only writer. The default is a
		 * plausible band height rather than 0: a first paint at 0 collapses the sheet before the measure lands. */
		bandH?: number;
		/** The VALUE vaul writes, not an index. `open` distinguishes nothing (the sheet is permanently mounted),
		 * so this is the only handle a test has on collapsed-versus-pulled-up. */
		activeSnapPoint?: number | string | null;
		title?: string | null;
		artist?: string | null;
		singerName?: string | null;
		singerColor?: string | null;
		profile?: SongProfile | null;
		keyShift?: number;
		/** ±key needs separated stems; there is nothing to re-pitch before that. */
		keyShiftEnabled?: boolean;
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
		onrestart?: () => void;
		ontoggleplay?: () => void;
		onskip?: () => void;
		onkey?: (semitones: number) => void;
		onguide?: (level: number) => void;
	}

	let {
		open = $bindable(true),
		bandH = $bindable(72),
		activeSnapPoint = $bindable(null),
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
		onrestart,
		ontoggleplay,
		onskip,
		onkey,
		onguide
	}: Props = $props();

	/* THE SNAP ARRAY IS ONLY EVER REPLACED WHILE NOTHING POINTS INTO IT, and both failure modes are silent.
	   See docs/FRONTEND.md#the-now-playing-drawer-one-surface-at-two-heights. */
	let viewportH = $state(0);
	/* Measured off `.np-fit`, not the content box, which spans the viewport and so always answers "the
	   viewport". 0 reads as "not measured". */
	let fitH = $state(0);
	const contentH = $derived(fitH > 0 ? bandH + fitH + OPEN_CONTENT_SLACK_PX : 0);
	const SNAP_OPEN = $derived(openSnapFraction(viewportH, contentH));

	/* A RE-SEAT'S SECOND HALF, shared by the content-height and the resize paths below. Both must CLEAR
	   `activeSnapPoint` first, because vaul's lazy watch only acts on a change, and both must land the new value a
	   tick later — but only while nothing else has claimed the sheet, since a drag released mid-change owns it. */
	function seatAfterClear(target: number | string): void {
		void tick().then(() => {
			if (activeSnapPoint === null) activeSnapPoint = target;
		});
	}

	/* Re-seat on a content height change, and only for a NUMBER: snap 0 is a px string, so a number that is not
	   the current fraction is exactly the stale-pointer case. `untrack` so this cannot re-enter itself. */
	$effect(() => {
		const open = SNAP_OPEN;
		const at = untrack(() => activeSnapPoint);
		if (typeof at !== 'number' || at === open) return;
		activeSnapPoint = null;
		seatAfterClear(open);
	});

	/* Seated ONCE, `onMount` plus `tick` and never an `$effect`: the write must land after the content has bound
	   its ref, and must be a CHANGE for vaul's lazy watch to see it. */
	onMount(() => {
		viewportH = window.innerHeight;
		void tick().then(() => {
			activeSnapPoint = SNAP_BAND;
		});
		return armResizeReseat();
	});

	/* Debounced, because a window drag emits a resize per frame and each re-seat restarts vaul's transition. IT
	   RESTORES BY WHICH SNAP POINT WAS ACTIVE, NEVER BY ITS VALUE: snap 1's value changes with the height. */
	const RESIZE_SETTLE_MS = 120;

	function armResizeReseat(): () => void {
		let pending: ReturnType<typeof setTimeout> | null = null;

		const reseat = () => {
			pending = null;
			const target = activeSnapPoint;
			// Nothing seated yet (the mount write above has not landed) — there is no offset to refresh.
			if (target === null || target === undefined) return;
			const wasBand = target === SNAP_BAND;
			// CLEARED BEFORE THE VIEWPORT WRITE: the height change re-derives SNAP_OPEN, and the effect above would
			// otherwise see a seated number that no longer matches and queue a second re-seat against this one.
			activeSnapPoint = null;
			viewportH = window.innerHeight;
			seatAfterClear(wasBand ? SNAP_BAND : SNAP_OPEN);
		};

		const onResize = () => {
			if (pending) clearTimeout(pending);
			pending = setTimeout(reseat, RESIZE_SETTLE_MS);
		};

		window.addEventListener('resize', onResize);
		return () => {
			if (pending) clearTimeout(pending);
			window.removeEventListener('resize', onResize);
		};
	}

	/* COLLAPSED MEANS OUT OF THE TAB ORDER, not merely off-screen. The sheet is permanently open with
	   `trapFocus={false}`, vaul-svelte never sets `inert`/`visibility`/`aria-hidden` on its content, and only
	   `.band-slot` clips — so while a song played and the sheet was down, Tab walked through "More about this song",
	   the guiding-track thumb and both keycaps, all invisible below the fold, with no way to know where focus went.
	   The measured focus-ring gate cannot catch it either: those elements are outside the viewport.
	   `null` (before the mount write seats snap 0) deliberately reads as NOT hidden, so nothing is inerted pre-seat. */
	const bodyHidden = $derived(activeSnapPoint === SNAP_BAND);

	/** Collapse to the band, expressed as a height because the sheet never closes. */
	const collapse = () => (activeSnapPoint = SNAP_BAND);

	/* THE MOUNT RUNG: `.band-slot` carries `bind:clientHeight`, so nothing in that part of the template may be
	   driven by a reactive prop or a `class:` directive — an attribute write re-renders nothing and is the way to
	   add state. See docs/FRONTEND.md#the-mount-rung-and-the-rule-it-puts-on-size-bindings. */

	/* One fraction, two consumers — the seek bar at snap 1 and the transport arc at snap 0 — so the two cannot
	   disagree mid-song. `null` and never 0 for an unknown length: the seek row HIDES rather than pinning a bar. */
	const progress = $derived(progressFraction(elapsedSec, durationSec));

	const keyOriginal = $derived(originalKeyLabel(profile));
	const keySounding = $derived(soundingKeyLabel(profile, keyShift));
	const keyShifted = $derived(keyShift !== 0 && keySounding !== null && keySounding !== keyOriginal);
	const keyLabel = $derived(keyShift === 0 ? 'Key' : `Key · ${keyShift > 0 ? '+' : '−'}${Math.abs(keyShift)}`);
	const rangeText = $derived(rangeLabel(profile, keyShift));
	const octaves = $derived(rangeOctaves(profile));
	const bandSentence = $derived(voiceBandSentence(profile, keyShift));

	/* While a finger is on the slider the LOCAL value wins, or the thumb fights the throttled websocket echo. */
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

	/* The OVERRIDE wins over the auto pick, because that is the order the server resolves them in. `null` when
	   there is nothing honest to say, because a pill reading "undefined" is worse than no pill. */
	const chosenLyrics = $derived(candidates.find((c) => c.ref === (overrideRef ?? chosenRef)) ?? null);
	const lyricsSource = $derived(chosenLyrics ? lyricsSourceLabel(chosenLyrics) : null);
	/* `warn` rather than `bad`: an auto-transcribed guess is worth knowing about, but the words are still usable. */
	const lyricsSourceTone = $derived(chosenLyrics && isAuthoritativeText(chosenLyrics) ? 'ok' : ('warn' as const));

	const guideNote = $derived(
		hasSong && !guideEnabled ? 'No isolated vocals, so no guiding track. Key and range still work.' : null
	);
</script>

<!-- `dismissible={false}` with `open` is vaul's pairing for a sheet that never closes; `modal={false}` is a
	necessity tied to the absent scrim — a modal sheet with no overlay traps the page — and `handleOnly` is deliberately
	ABSENT because it is all-or-nothing and the body's sliders would become drag surfaces. -->
<Drawer.Root
	open={open}
	dismissible={false}
	modal={false}
	snapPoints={[SNAP_BAND, SNAP_OPEN]}
	bind:activeSnapPoint={activeSnapPoint}
>
	<!-- `aria-label` IS THE DIALOG'S NAME at every state, not a fallback: the head renders no Drawer.Title, and
		the primitive sets `aria-labelledby` only once a Title has registered an id. `trapFocus={false}` is why you
		can type in the search box. -->
	<Drawer.Content class="np-drawer" trapFocus={false} aria-label="Now playing">
		<!-- SNAP 0 — the band row, and it must stay the content's FIRST child: vaul sizes the content to the largest
			snap point and translates it down, so what shows at snap 0 is the TOP of this element. -->
		<div class="band-slot" style="--snap-band: {SNAP_BAND}" bind:clientHeight={bandH}>
			<!-- vaul's REAL Handle, not a decorative bar: its click handler is what cycles the snap points for a tap. -->
			<Drawer.Handle />
			<!-- `onexpand` IS THE ONLY WAY IN WITHOUT A POINTER: vaul's Handle is an aria-hidden div with no role. It
				TOGGLES because nothing else can collapse the sheet by tap. NO `expanded` PROP MAY GO WITH IT — a prop that
				changes after mount re-runs the size bindings above, which throw on the mount rung. -->
			<NowPlayingBand
				title={title}
				artist={artist}
				singerName={singerName}
				singerColor={singerColor}
				progress={progress}
				isPlaying={isPlaying}
				canStart={canStart}
				ontoggleplay={ontoggleplay}
				onrestart={onrestart}
				onskip={onskip}
				onexpand={() => (activeSnapPoint = activeSnapPoint === SNAP_OPEN ? SNAP_BAND : SNAP_OPEN)}
			/>
		</div>
		<!-- `.np-fit` EXISTS TO BE MEASURED — snap 1's content cap needs the height of everything below the band row.
			Its `data-vaul-no-drag` is what excludes the whole body from the drag (see the Root). -->
		<!-- `inert` as an ATTRIBUTE, which is the mount rung's own sanctioned mechanism: this element carries
			`bind:clientHeight`, so a `class:` directive or a reactive prop here would re-run the size binding and throw.
			An attribute write re-renders nothing. `inert` does not affect layout, so `fitH` stays measurable. -->
		<div class="np-fit" data-vaul-no-drag inert={bodyHidden || undefined} bind:clientHeight={fitH}>
			<!-- The head is EMPTY and still renders: it gives the sheet its data-slot structure and `phone-home`
				asserts a header renders below the band slot. Zero-height, so it costs no space. -->
			<Drawer.Header class="np-head"></Drawer.Header>

			<div class="np-body">
				{#if progress !== null}
					<!-- `aria-hidden` IS ON THE TIMES, NEVER THE ROW: the clocks are restated in words elsewhere, but the `···`
						is the app's only route to the song page. Time REMAINING on the right answers "when am I up?". -->
					<div class="seekrow">
						<span class="time" aria-hidden="true">{formatClock(elapsedSec)}</span>
						<div class="bar-slot" aria-hidden="true"><Progress value={progress * 100} size="sm" /></div>
						<span class="time r" aria-hidden="true">{formatRemaining(elapsedSec, durationSec)}</span>
						{#if hasSong && mediaId}
							<div class="more-slot">
								<Button
									variant="ghost"
									size="icon"
									href={`/song/${mediaId}`}
									aria-label="More about this song"
									onclick={collapse}
								>
									<Icon name="dots" />
								</Button>
							</div>
						{/if}
					</div>
				{/if}

				<!-- THE TRANSPORT LIVES IN THE BAND ROW, never here: split across the two heights it reads as two transports
					or as an empty band. The live controls below exist only for a song playing NOW. -->
				{#if hasSong}
					<div class="tools-body">
						{#if guideNote}<p class="tools-note">{guideNote}</p>{/if}
						<GuidingTrack pct={guidePct} available={guideEnabled} oninput={onGuideInput} oncommit={onGuideCommit} />

						{#if keyOriginal}
							<div class="key-head">
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
								<!-- THE LABEL IS NOT DECORATION HERE. `Icon` is `aria-hidden` by default, so both keycaps computed to
										the bare word "semitone" and a screen-reader user could not tell which one lowers the key — on the
										app's signature control. The visible text stays as it is; only the accessible name gains a direction. -->
								<Button
									variant="keycap"
									size="block"
									aria-label="Lower the key one semitone"
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
									aria-label="Raise the key one semitone"
									disabled={!keyShiftEnabled || keyShift >= 7}
									onclick={() => onkey?.(keyShift + 1)}
								>
									<Icon name="plus" /> semitone
								</Button>
							</div>
						</div>

						<!-- DIRECTLY BELOW KEY, with no disclosure: the picture answers "can I sing this, in this key?" and the ±
							buttons are what it answers about, so a tap between them splits one question in two. -->
						{#if rangeText}
							<div class="range">
								<div class="range-facts">
									<span class="range-label">{rangeText}</span>
									{#if octaves !== null}<span class="range-oct">{octaves} oct</span>{/if}
								</div>
								{#if bandSentence}<p class="range-band">{bandSentence}</p>{/if}
								<RangeBar profile={profile} keyShift={keyShift} />
							</div>
						{/if}

						<!-- THE LYRICS SOURCE IS A FACT HERE, NOT A CONTROL: re-picking lyrics is a decision made once about a song,
							and this sheet is what a singer reaches for mid-performance. The picker lives on the song page. -->
						{#if lyricsSource}
							<div class="lyricsrc">
								<Badge variant={lyricsSourceTone}>{lyricsSource}</Badge>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</Drawer.Content>
</Drawer.Root>

<style>
	/* The band paints its own fill, top border and shadow, all three of which the sheet already carries —
	   suppressed HERE rather than in the band, which still renders standalone in the gallery. Its
	   `padding-bottom: env(safe-area-inset-bottom)` is deliberately NOT suppressed: it is the app's only
	   home-indicator inset, and this element's measured height becomes --dock-h. */
	.band-slot {
		position: relative;
		/* From `$lib/sheet-snap`'s BAND_SNAP_PX, so the rendered strip and snap 0 cannot drift. */
		height: var(--snap-band);
		overflow: hidden;
	}
	.band-slot :global(.band) {
		background: transparent;
		border-top: 0;
		box-shadow: none;
	}
	/* FULL-HEIGHT CONTENT WITH `max-height` DEFEATED, which is what makes the snap offsets land: vaul translates
	   the content down by (container height − snap height), so a shorter box puts its transform below the fold. */
	:global([data-slot='drawer-content'].np-drawer) {
		height: 100dvh;
		max-height: none;
		/* Elevation, or the sheet reads as a DUPLICATE of the band: both surfaces are --card with the same top
		   border and radius, so without a shadow two matching top edges show for the length of the transition. */
		box-shadow: var(--shadow);
		/* THE DRAWER COVERS THE BAND, so it carries the home-indicator inset itself. That does not break the
		   one-env() rule: the two are never bottom-most at once, and nothing measures the drawer into --dock-h. */
		padding-bottom: calc(env(safe-area-inset-bottom, 0px) + var(--space-lg));
	}
	/* `!important` IS REQUIRED: vaul writes its transition as an INLINE style from JS. `transition-duration: 0s`
	   rather than `transition: none`, so vaul's own bookkeeping still sees a transition it completes instantly. */
	@media (prefers-reduced-motion: reduce) {
		/* ANCHORED on `.np-drawer` like the two rules above it. Unanchored, this reached every vaul drawer in the app —
		   the exact unanchored-`:global()` reach trap the sibling rules avoid. */
		:global([data-slot='drawer-content'].np-drawer) {
			transition-duration: 0s !important;
		}
	}

	/* THE MEASURE, SHARED BY THE HEAD AND THE BODY — one rule, two selectors, and they must STAY one rule.
	   Inserting anything BETWEEN these two selectors drops the head out of the list, so it silently takes the
	   declarations of whatever follows and goes full-bleed above --max-w. Add a rule AFTER this block. */
	:global(.np-head),
	.np-body {
		width: 100%;
		max-width: var(--max-w);
		margin-inline: auto;
		/* A nowrap child must not set a floor this box cannot go under — the band's own defect class. */
		min-width: 0;
	}
	/* Snap 1's content cap is this block's height. `flex: 0 0 auto` is load-bearing: the default shrink lets an
	   over-tall body SHRINK this wrapper, so `clientHeight` under-reports and the cap clips a control. */
	.np-fit {
		flex: 0 0 auto;
		min-width: 0;
	}
	/* Zero-height: the head renders and shows nothing, so the vendored header's own padding and gap would be
	   blank space at the top of every open sheet. */
	:global(.np-head) {
		padding: 0;
		gap: 0;
	}
	.np-body {
		padding: 0 var(--space-2xl);
	}
	/* THE DOOR, as the seek row's last item. `flex: 0 0 auto` so the bar keeps taking the width; the negative
	   right margin is the optical pull that lines the glyph up with the column edge, not the button's box. */
	.more-slot {
		flex: 0 0 auto;
		display: flex;
		margin-right: -10px;
		color: var(--ink-dim);
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
	.lyricsrc {
		display: flex;
		justify-content: flex-end;
		margin-top: var(--space-sm);
	}
	.tools-body {
		margin-top: var(--space-lg);
		border-top: 1px solid var(--line);
		padding-top: var(--space-sm);
		padding-bottom: var(--space-2xs);
	}
	/* Dimmed with the INK token, never with `opacity` on a subtree: an ancestor alpha flattens the text and the
	   surface behind it into one buffer, so measured contrast stops being what is painted. */
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
