<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	/*
	 * THE NOW-PLAYING DRAWER — what the band pulls up into. Same song identity, seek row, transport and live
	 * controls the queue used to carry at the top of home; none of it occupies the queue now.
	 *
	 * THE BAND ROW IS THE DRAG SURFACE, AND `.np-fit` IS EXCLUDED. vaul drags to dismiss from anywhere in its
	 * content, and this body is sliders — a drag surface under a slider is the same gesture twice, and the
	 * drawer wins because it is the ancestor. So ONE `data-vaul-no-drag` on `.np-fit` covers the head, the body
	 * and every control ever added below the band row. (It only works because a real `Drawer.Handle` renders
	 * inside `.band-slot`; shadcn's copy-in ships a decorative div — see drawer-handle.svelte.)
	 *
	 * GuidingTrack's Slider reads `offsetWidth`, which the mount rung replaces with a throw, so it must not
	 * mount while hidden. A drawer's content is portalled on open and destroyed on close, so that constraint is
	 * met by the container rather than by a condition anyone has to remember.
	 *
	 * THE "···" IS THE ONLY HEADER AFFORDANCE — three dots rather than a cog or an ⓘ because of where it sits:
	 * every other surface here has a round icon-only control column on the right, so a second round glyph
	 * reads as a sibling of it (an ⓘ was mistaken for app settings on sight). It NAVIGATES and closes the
	 * drawer on the way, because this component lives in the layout and survives the route change, so leaving
	 * it open would cover the page it just opened. It renders only with a `mediaId`.
	 */
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
		/**
		 * The band's measured height, which IS snap point 0 — bindable so the layout can publish it as
		 * `--dock-h` and keep exactly one writer of that token. The default is a plausible band height
		 * rather than 0: snap 0 is `${bandH}px`, so a first paint at 0 would collapse the sheet to
		 * nothing before the measurement lands.
		 */
		bandH?: number;
		/**
		 * Which snap point the sheet is at — the value (`'80px'` or `0.82`), not an index, because that is
		 * what vaul writes. Bindable so a MOUNT-RUNG harness can put the sheet at a height: `open` no
		 * longer distinguishes anything (the sheet is permanently mounted), so this is the only handle a
		 * test has on collapsed-versus-pulled-up. Safe to bind now that snap 0 is a constant; binding a
		 * re-measured value is what broke the snap lookup in the first place.
		 */
		activeSnapPoint?: number | string | null;
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
		/*
		 * `candidates`/`chosenRef`/`overrideRef` stay because the sheet NAMES the lyrics source as a pill; it no
		 * longer changes it. That control is on /song/[mediaId], which the seek row's `···` opens.
		 */
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

	/*
	 * WHICH HEIGHT THE SHEET IS AT. `open` distinguishes nothing — the sheet is permanently mounted, so
	 * `.np-drawer` is present at all times — and vaul writes this as the snap VALUE (the `${bandH}px` string or
	 * the 0.82 fraction), not an index. `null` lets vaul seat the first snap point itself rather than guessing a
	 * string that has to stay byte-equal to the one in `snapPoints`.
	 */
	/*
	 * SNAP 0 IS A CONSTANT, as a correctness requirement rather than a simplification: building it from the
	 * band's MEASURED height cannot work against this version of vaul. Two mechanisms decide it —
	 *
	 *   1. `snapToPoint()` writes a transform with NO null guard, triggered by a LAZY watcher that never
	 *      retries. Seat the snap point before `Drawer.Content` has bound its ref and the write lands on
	 *      `null`, silently, forever (measured: content at top 850 in an 844px viewport, and dragging the
	 *      handle moved it DOWN).
	 *   2. the snap lookup is strict equality on the string, so a re-measured `'78px'` looked up in
	 *      `['72px', 0.82]` returns -1 and no snap happens — also silently.
	 *
	 * So the band's height is FIXED, in `$lib/sheet-snap`, which is also where `.band-slot` gets it in CSS
	 * (through `--snap-band`) rather than the number being copied into a stylesheet. It was never really
	 * variable — a `--tap`-sized control row plus padding — and pinning it also stops the strip growing by a
	 * line when a byline appears. `--dock-h` is still measured off the rendered element, so the reservation
	 * contract is unchanged.
	 *
	 * SNAP 1 IS NOT a constant (see `SNAP_OPEN`), so both hazards apply to it and both are handled explicitly:
	 * hazard 1 by never touching the array before mount, hazard 2 by re-seating on the NEW array value after a
	 * resize instead of restoring the stale one. The rule both follow: the array is only ever replaced while
	 * nothing points into it.
	 */

	/*
	 * SNAP 1 IS CLAMPED, which is why it is derived rather than a constant like its sibling. A flat `0.82` means
	 * "18% of the window, whatever that is" — 162px tall on a 900px window, 126px on a 700px one — while the
	 * page's own top controls do not shrink with it. So the sheet cleared the search box at 900 by three pixels
	 * and COVERED it at 700, and a click at the input's centre hit a span inside the sheet.
	 *
	 * The arithmetic lives in `$lib/sheet-snap` because it is the half that can be wrong at a height nobody
	 * tried: a rendered offset is a layout-rung claim, and this component cannot be mounted on that rung, so a
	 * formula written inline could only be guarded as a string. As a pure function it is swept across every
	 * viewport height. The window height is state because `snapPoints` is a prop vaul reads reactively.
	 */
	let viewportH = $state(0);
	/*
	 * THE SHEET'S NATURAL HEIGHT, so snap 1 cannot open to five times its own content. Measured off `.np-fit`
	 * rather than the content box, which is `height: 100dvh` with `max-height: none` and so always answers "the
	 * viewport". `bandH` is added because the band row is snap 0 and part of the same box, and
	 * `OPEN_CONTENT_SLACK_PX` covers padding applied to the box rather than to the measured block. 0 until the
	 * first measurement, which `openSnapFraction` reads as "not measured".
	 */
	let fitH = $state(0);
	const contentH = $derived(fitH > 0 ? bandH + fitH + OPEN_CONTENT_SLACK_PX : 0);
	const SNAP_OPEN = $derived(openSnapFraction(viewportH, contentH));

	/*
	 * RE-SEAT WHEN THE CONTENT CHANGES HEIGHT, with the same discipline as `armResizeReseat`: snap 1 is DERIVED,
	 * vaul looks the active point up by strict equality, and replacing the array under a pointer into it yields
	 * index -1 — no snap, silently, and a handle click that does nothing. A song starting or ending changes the
	 * body's height, so this is a real trigger.
	 *
	 * Only when the sheet is at the open point and the active value is a NUMBER: snap 0 is a px STRING, so a
	 * numeric value that is not the current fraction is exactly the stale-pointer case. `null` first, then the
	 * new value after a tick, so the array is only replaced while nothing points into it. `untrack` on the read
	 * so the effect cannot re-enter itself.
	 */
	$effect(() => {
		const open = SNAP_OPEN;
		const at = untrack(() => activeSnapPoint);
		if (typeof at !== 'number' || at === open) return;
		activeSnapPoint = null;
		void tick().then(() => {
			// Not if something else claimed the sheet between ticks — a drag released mid-change owns it.
			if (activeSnapPoint === null) activeSnapPoint = open;
		});
	});

	/*
	 * Seated ONCE after mount, which is why this is `onMount` + `tick` and not an `$effect`: the write has to
	 * land when `drawerNode` is non-null, and it must be a CHANGE (null → '80px') for the lazy watch to see it.
	 * `viewportH` is written first and synchronously, so `snapPoints` reaches its real value while
	 * `activeSnapPoint` is still `null` — see `armResizeReseat` for the discipline.
	 */
	onMount(() => {
		viewportH = window.innerHeight;
		void tick().then(() => {
			activeSnapPoint = SNAP_BAND;
		});
		return armResizeReseat();
	});

	/*
	 * RESIZING MUST RE-LAY THE SHEET OUT, and nothing in vaul does it — one missing trigger, not wrong
	 * arithmetic. `snapPointsOffset` does recompute on a resize, but the only thing that APPLIES an offset is
	 * `snapToPoint()`, whose only non-drag caller watches `[activeSnapPoint, open]`. A resize changes neither,
	 * so the sheet keeps the pixel translate it was given at the old height while the viewport moves out from
	 * under it (at 844 → 600 a collapsed sheet's translate should fall 764 → 520; unfixed it stays at 764,
	 * putting the whole box below the fold).
	 *
	 * HOW IT RE-TRIGGERS: `null`, a tick, then the value back — the watch fires on a CHANGE, and writing the
	 * same string is not one. The intermediate `null` renders nothing.
	 *
	 * DEBOUNCED, because a window drag emits a resize per frame and each re-seat starts vaul's own 0.5s
	 * transition, so an undebounced version has the sheet chasing the pointer half a second behind.
	 *
	 * IT RESTORES BY WHICH SNAP POINT WAS ACTIVE, NOT BY ITS NUMBER, which is what makes a derived snap point
	 * safe: snap 1 changes VALUE with the height, and restoring the captured fraction would restore one that is
	 * no longer in the array — index -1, no snap, a dead handle. It reads `SNAP_OPEN` after the tick, once the
	 * derived value has caught up, writing `null` first for the same reason `onMount` does.
	 */
	const RESIZE_SETTLE_MS = 120;

	function armResizeReseat(): () => void {
		let pending: ReturnType<typeof setTimeout> | null = null;

		const reseat = () => {
			pending = null;
			const target = activeSnapPoint;
			// Nothing seated yet (the mount write above has not landed) — there is no offset to refresh.
			if (target === null || target === undefined) return;
			const wasBand = target === SNAP_BAND;
			activeSnapPoint = null;
			viewportH = window.innerHeight;
			void tick().then(() => {
				// Restore only if nothing else claimed the snap point while we were between ticks — a
				// drag released mid-resize owns the sheet, and this must not drag it back.
				if (activeSnapPoint === null) activeSnapPoint = wasBand ? SNAP_BAND : SNAP_OPEN;
			});
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

	/** Collapse to the band. What `open = false` used to do, expressed as a height. */
	const collapse = () => (activeSnapPoint = SNAP_BAND);

	/*
	 * NO REVEAL HERE ANY MORE: the band's transport is visible at both heights, so there is no height state to
	 * animate and no wrapper to hold a class.
	 *
	 * THE HAZARD THAT OUTLIVES IT is still live. `.band-slot` carries `bind:clientHeight`, so ANY reactive
	 * update in that part of the template re-runs its size binding, and a geometry read on the mount rung is a
	 * deliberate throw. Both reactive spellings of "is the sheet up" took three of `phone-home`'s mounts down —
	 * `$state` written from an `$effect` (the write lands in a microtask, outside the window `openDrawer`
	 * swallows in) and a `$derived` read by a `class:` directive. So the band takes no `expanded` prop and
	 * `aria-expanded` is written as an ATTRIBUTE, which re-renders nothing. Anything that needs the sheet's
	 * height again belongs on a node ref and a class.
	 */

	// null (not 0) for an unknown length, so the seek row HIDES rather than pinning a bar at zero,
	// which reads as a stalled song.
	/* One fraction, two consumers: the seek bar at snap 1 and the transport arc on the band row at
	   snap 0. The band used to be handed a separately-computed `progress` by the layout; deriving it
	   once here is what stops the arc and the bar disagreeing mid-song. */
	const progress = $derived(progressFraction(elapsedSec, durationSec));

	// Every music string comes from the shared pure helpers; this file only decides WHEN to show each.
	const keyOriginal = $derived(originalKeyLabel(profile));
	const keySounding = $derived(soundingKeyLabel(profile, keyShift));
	const keyShifted = $derived(keyShift !== 0 && keySounding !== null && keySounding !== keyOriginal);
	const keyLabel = $derived(keyShift === 0 ? 'Key' : `Key · ${keyShift > 0 ? '+' : '−'}${Math.abs(keyShift)}`);
	const rangeText = $derived(rangeLabel(profile, keyShift));
	const octaves = $derived(rangeOctaves(profile));
	const bandSentence = $derived(voiceBandSentence(profile, keyShift));

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
	 * Stated AHEAD of the control it explains, so the reason is read before the dead row rather than after it.
	 * The row stays VISIBLE and disabled: "this song has no isolated vocals" is information, and hiding the
	 * control would leave the singer wondering where it went.
	 */
	/*
	 * WHICH LYRICS THE TV IS SHOWING, as a label. The OVERRIDE wins over the auto pick, because that is the
	 * order the server resolves them in. `lyricsSourceLabel` is the shared contract helper, so this cannot
	 * drift from the option list on /song/[mediaId].
	 *
	 * NULL when there is nothing honest to say — no candidates yet, or a chosen ref matching none of them. A
	 * pill reading "undefined" is worse than no pill.
	 */
	const chosenLyrics = $derived(candidates.find((c) => c.ref === (overrideRef ?? chosenRef)) ?? null);
	const lyricsSource = $derived(chosenLyrics ? lyricsSourceLabel(chosenLyrics) : null);
	/*
	 * The TONE carries `isAuthoritativeText`'s judgement, which is what makes the pill worth more than the
	 * string: authored synced words are the good case, an auto-transcribed guess is the one a singer should
	 * know about before trusting the screen. `warn` rather than `bad` — the words are usable, not authored.
	 */
	const lyricsSourceTone = $derived(chosenLyrics && isAuthoritativeText(chosenLyrics) ? 'ok' : ('warn' as const));

	const guideNote = $derived(
		hasSong && !guideEnabled ? 'No isolated vocals, so no guiding track. Key and range still work.' : null
	);
</script>

<!--
	ONE SURFACE AT TWO HEIGHTS, NOT TWO SURFACES. The band is snap point 0 OF THIS DRAWER, because a separate
	fixed band could not be dragged open: an outside element can START a pointer gesture but cannot hand the
	in-flight pointer to vaul, so the sheet jumped to its open height instead of tracking the thumb. `snapPoints`
	accepts px strings, which is what lets snap 0 be the band's height rather than a fraction of the viewport.

	The band is COMPOSED, not absorbed: it keeps its own file, surface and safe-area inset, and /components still
	renders five of them side by side — which a fixed, snap-pointed drawer cannot do.

	`dismissible={false}` with `open` is vaul's documented pairing for a sheet that never closes.
	`modal={false}` keeps the collapsed band from trapping focus behind a scrim on every phone surface — and
	there is NO SCRIM at either height as a result, since vaul gates the overlay on modality. That is the honest
	design: the page under this sheet is the thing the guest is using. Its edge is `border-t` plus the popover
	surface. `drawer-overlay-modality.test.ts` ties those facts together.

	`handleOnly` IS GONE and the exclusion INVERTED — the whole band row drags, which is what "let me drag from
	anywhere at the top" means. The rule is unchanged: `handleOnly` is all-or-nothing, so turning it off would
	make the body's sliders drag surfaces again (the guiding-track thumb and the dismiss would be one gesture,
	the drawer winning as the ancestor). `.np-fit` carries `data-vaul-no-drag`, which vaul resolves with
	`closest()`, so one attribute excludes everything below the band row — still a whitelist in practice ("only
	the band row drags") rather than a list someone must remember to extend. The band's own buttons are excluded
	too: vaul sets pointer capture on press, so a drag begun on the disc would fire a click on release.
-->
<Drawer.Root
	open={open}
	dismissible={false}
	modal={false}
	snapPoints={[SNAP_BAND, SNAP_OPEN]}
	bind:activeSnapPoint={activeSnapPoint}
>
	<!--
		`aria-label` IS THE DIALOG'S NAME at every state, not a fallback: the head renders no `Drawer.Title` (every
		line of it duplicated the band row's), and bits-ui sets `aria-labelledby` only once a Title has registered
		an id. The song title is still inside the dialog, in the band row, so it reads as content rather than name.
	-->
	<!--
		`trapFocus={false}` IS WHY YOU CAN TYPE IN THE SEARCH BOX. Reported as no caret in the search field, and
		focus really was being taken off the input a frame after it landed.

		`modal={false}` does not cover it: that reaches vaul's dismissal path. The focus TRAP is a layer down —
		`Drawer.Content` renders bits-ui's `Dialog.Content`, which defaults `trapFocus = true` and hands it to
		`FocusScope`. While trapped, the scope installs a document-level `focusin` capture listener for as long as
		it is enabled, and enabled is `open` — permanently true here, because this sheet never closes. So every
		focus landing outside the content was yanked back to the container, which is focusable (`tabindex: -1`).
		Measured: after clicking the input, `document.activeElement` was `div[data-slot=drawer-content]`.

		This switches the sheet's own trap off, NOT the sheet's focusability: everything inside stays in the tab
		order. What goes is the `focusin` interception, the Tab wrap-around and the re-homing observer — all
		modal-dialog behaviours, and a sheet mounted over every phone surface is the opposite of modal.
	-->
	<Drawer.Content class="np-drawer" trapFocus={false} aria-label="Now playing">
		<!--
			SNAP 0 — the band row, and the only thing on screen when the sheet is collapsed. It is the content's FIRST
			child because vaul sizes the content to the largest snap point and translates it down, so what shows at
			snap 0 is the TOP of this element. `bind:clientHeight` is what makes snap 0 the band's REAL rendered
			height, which the layout re-publishes as `--dock-h`.
		-->
		<div class="band-slot" style="--snap-band: {SNAP_BAND}" bind:clientHeight={bandH}>
			<!--
				THE SHEET'S ONE AND ONLY GRAB BAR, here rather than in `ui/drawer` because this is the row a thumb
				pulls. `drawer-content.svelte` used to render a second real Handle at the top of the content box, so
				the phone drew TWO stacked pull-up lines; only one of the two could be placed correctly, since a
				consumer cannot move a child a vendored component renders for it. It must stay vaul's REAL Handle
				rather than a decorative bar: its own `onclick` is what cycles the snap points for a guest who taps
				the bar instead of dragging it.
			-->
			<Drawer.Handle />
			<!--
				`onexpand` IS THE ONLY WAY IN WITHOUT A POINTER. vaul's `Drawer.Handle` is a `<div aria-hidden="true">`
				with no tabindex and no role — draggable by a pointer, invisible to a keyboard and a screen reader.
				Measured on the collapsed home route, everything in the sheet below the band row was unreachable by Tab.
				Raising it is a snap-point write, not an `open` toggle (`open` is permanently true), guarded so a press
				on an open sheet is a no-op rather than a re-seat that restarts vaul's transition.

				IT TOGGLES, because nothing else can collapse the sheet by tap: vaul's handle cycles snap points on
				click, and at the LAST point with `dismissible={false}` it computes `snapPoints[index + 1]` —
				`undefined`, which the seating watch ignores. Measured in Chrome: two taps with the sheet open left its
				top at 636 both times. So the app had one tap that opens and none that closes.

				NO `expanded` PROP GOES WITH IT. Naming the press direction would need the snap state as a prop, and ANY
				prop of `NowPlayingBand` that changes after mount re-runs the size bindings below — a deliberate throw
				on the mount rung, measured as three lost mounts. An `aria-expanded` written from an effect is the way
				to add direction later, because an attribute write re-renders nothing.

				(The rationale is here rather than inside the prop because a comment inside a component tag is scanned
				as part of that tag: `ui-scoped-style-reach.test.ts` walks a tag to its closing `>` tracking quote
				state, and an apostrophe in prose there swallows the rest of the file.)
			-->
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
		<!--
			`.np-fit` EXISTS TO BE MEASURED, and it is a plain block so it changes nothing about the layout:
			the head and the body keep their own padding and their own `--max-w` centring. It wraps
			everything below the band row, which is what snap 1's content cap needs the height of.
		-->
		<!--
			`data-vaul-no-drag` IS WHAT REPLACED `handleOnly` (see the Root). One attribute excludes everything below
			the band row — head, seek row, sliders, keycaps, range visualiser — because vaul resolves it with
			`closest()`, so it cannot be forgotten when the next control lands in the body.
		-->
		<div class="np-fit" data-vaul-no-drag bind:clientHeight={fitH}>
			<!--
				THE HEAD IS EMPTY AND STILL RENDERS. Every line it carried turned out to be a second copy of the band
				row's, and the `···` that was left moved into the seek row. `Drawer.Header` stays because it is what
				gives the sheet its `data-slot` structure and `phone-home` asserts a header renders below the band
				slot; it is zero-height with no padding, so it costs no space.
			-->
			<Drawer.Header class="np-head"></Drawer.Header>

			<div class="np-body">
				{#if progress !== null}
					<!-- Time REMAINING on the right: the question this surface answers is "when am I up?".
				     aria-hidden because the position card on home states the same thing in words. -->
					<!--
						THE `···` RIDES THE SEEK ROW, and the pairing is exact: this row renders only with a duration and the
						door only with a `mediaId` — both mean "a song is playing", so the door never holds a row open by
						itself.

						`aria-hidden` IS ON THE TIMES, NOT THE ROW. Hiding the clocks is right (the position is stated in
						words elsewhere), but the `···` is the app's only route to /song/[mediaId], so hiding it would make
						that page unreachable to a screen reader.
					-->
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

				<!-- Disabled when there is nothing to act on. Restart and skip need a song that is PLAYING;
			     play additionally accepts a queue with something in it, because the server decides when
			     "start when it is ready" becomes a start. -->
				<!--
				THE TRANSPORT IS IN THE BAND ROW, not here — see `.tp` in NowPlayingBand. Three arrangements were
				tried in this spot and each was reported on sight: the pair here with play/pause only on the disc (one
				transport across two rows), the pair here WITH its own play/pause (two identical buttons ~100px
				apart), and the disc hidden at snap 1 (a nearly-empty band row above a group floating mid-body). All
				three failed the same way — the controls were not in one place.
			-->

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
								<RangeBar profile={profile} keyShift={keyShift} />
							</div>
						{/if}

						<!--
							THE LYRICS SOURCE IS A PILL, NOT A DISCLOSURE. This was `<LyricsReselect>`, a collapsible listing
							every candidate plus a paste-your-own path — and re-picking lyrics is a decision you make once about
							a song, sitting still, while the sheet is what you reach for mid-performance. Nothing was lost:
							/song/[mediaId] renders the same component and the `···` above is the door to it.

							What survives is the FACT, not the control — which source the words came from, which a singer wants
							mid-song ("are these real lyrics or a guess?"). A pill rather than a labelled row, because the
							string names itself.
						-->
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
	/*
	 * The content box. `--max-w` for the same reason the band tracks it: this is bottom-docked chrome,
	 * and on a laptop a full-bleed sheet would put the transport at the far edge of the window,
	 * pointing at nothing. The surface stays full-bleed (the vendored Content paints it) and only the
	 * inner measure is capped.
	 */
	/*
	 * THE BAND ROW AT SNAP 0. Layout, plus one job: stopping the band painting a SECOND surface inside the one
	 * that already exists. The band is bottom chrome in its own right, so it carries a `--card` fill, a top
	 * border and a shadow — and the drawer content carries all three too, which put a hairline across the sheet
	 * below the handle and stacked two shadows on one edge.
	 *
	 * Suppressed with `:global()` here rather than by editing the band, because it still renders standalone in
	 * /components where it genuinely needs its own surface.
	 *
	 * `padding-bottom: env(safe-area-inset-bottom)` is deliberately NOT suppressed: it is the app's only
	 * home-indicator inset, and this element's measured height becomes `--dock-h`, so it must be inside the
	 * measurement.
	 */
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
	/*
	 * NO TRANSPORT KEYFRAMES HERE ANY MORE. Worth keeping from them: revealing a control in this row is a LAYOUT
	 * change, and neither `display` nor a reflow is transitionable while `width`/`gap`/`inset` are outside the
	 * composited allowlist `motion.test.ts` enforces. The way through was a FLIP without the measuring step —
	 * state the from-position in `transform` only, distances as token arithmetic, so nothing reads geometry.
	 */
	/*
	 * FULL-HEIGHT CONTENT, AND `max-height` DEFEATED — this is what makes the snap offsets land. vaul positions a
	 * snap point by TRANSLATING the content down by `containerHeight - snapHeight`, which assumes the content
	 * spans the viewport. The vendored `drawer-content.svelte` sets `h-auto` with `max-h-[82dvh]` instead:
	 * measured in an 844px viewport, `h-auto` made the box 214px and sent it wholesale off-screen, and
	 * `height: 82dvh` gave the right 692px but a static top of 152px, so vaul's correct 764px transform put it
	 * at 916. The transform was never wrong; the box was 692px instead of 844.
	 *
	 * So the content spans the viewport, the cap is released, and the OPEN height comes from the snap point.
	 */
	:global([data-slot='drawer-content'].np-drawer) {
		height: 100dvh;
		max-height: none;
	}
	:global([data-slot='drawer-content'].np-drawer) {
		/*
		 * ELEVATION, because without it the drawer read as a DUPLICATE of the band rather than its expansion: both
		 * surfaces are `--card` with the same top border and radius, so a sheet sliding up over the band showed two
		 * matching top edges for the length of the transition. Nothing was duplicated — sampling the DOM through
		 * the open found one content node — the two surfaces were simply indistinguishable. The shadow is the
		 * band's own `--shadow`, so the pair reads as one surface lifting off another.
		 */
		box-shadow: var(--shadow);
		/*
		 * THE DRAWER COVERS THE BAND, deliberately. It reserved space underneath until a captured frame showed the
		 * content is portalled to the end of the body at a higher stacking level — it was never going to open
		 * ABOVE the band, and `--dock-h` of padding was 89px of empty surface at the bottom of every drawer.
		 *
		 * Covering is also right: the band is a one-line glance at the song and the drawer is the same song with
		 * its controls, so showing both states it twice. The drawer is therefore the bottom-most element while
		 * open and carries the home-indicator inset itself — which does not break the one-env() rule, because the
		 * two are never bottom-most at the same time and nothing measures the drawer into --dock-h.
		 */
		padding-bottom: calc(env(safe-area-inset-bottom, 0px) + var(--space-lg));
	}
	/*
	 * REDUCE MOTION FOR THE SHEET'S SLIDE, and it HAS to be `!important`: vaul sets
	 * `transition: transform 0.5s …` as an INLINE style from JS, which no author rule can reach otherwise. It is
	 * also invisible to `motion.test.ts`, which scans declared CSS and cannot see a style a dependency writes at
	 * runtime — so the app's largest movement honoured no motion preference and no guard could say so.
	 *
	 * `transition-duration: 0s` rather than `transition: none`, so vaul's own bookkeeping still sees a transition
	 * it can complete instantly. The sheet still ARRIVES; it just does not travel.
	 */
	@media (prefers-reduced-motion: reduce) {
		:global([data-slot='drawer-content']) {
			transition-duration: 0s !important;
		}
	}

	/*
	 * THE MEASURE, SHARED BY THE HEAD AND THE BODY — one rule, two selectors, and they must STAY one rule.
	 *
	 * A rule once inserted BETWEEN these two selectors dropped the head out of the list, so it kept the
	 * declarations of whatever followed and went full-bleed above `--max-w`: title and `···` pinned to the window
	 * edges with the controls centred 280px inside them. Nothing caught it — the class still resolved to a rule,
	 * and no measured arm reads the head's width. If you add a rule near here, add it AFTER this block.
	 */
	:global(.np-head),
	.np-body {
		width: 100%;
		max-width: var(--max-w);
		margin-inline: auto;
		/* A nowrap child must not set a floor this box cannot go under — the band's own defect class. */
		min-width: 0;
	}
	/*
	 * THE MEASURED BLOCK — the wrapper holding the head and the body, whose height is snap 1's content cap.
	 *
	 * FULL WIDTH on purpose: the two children cap and centre themselves, so capping this too would be a second
	 * measure saying the same thing.
	 *
	 * `flex: 0 0 auto` is load-bearing: as a flex child it would otherwise inherit `flex-shrink: 1`, so a body
	 * grown past the viewport would SHRINK the wrapper, `clientHeight` would under-report, and the cap would be
	 * computed from a height smaller than the content it caps — clipping a control instead of leaving space,
	 * which is the one direction it must never err in.
	 */
	.np-fit {
		flex: 0 0 auto;
		min-width: 0;
	}
	/*
	 * ZERO-HEIGHT: the head renders (see the markup note for why it must) and shows nothing. The vendored
	 * `Drawer.Header` ships its own padding and a `gap`, all of which would be blank space at the top of
	 * every open sheet now that the identity lives in the band row and the `···` rides the seek row.
	 */
	:global(.np-head) {
		padding: 0;
		gap: 0;
	}
	.np-body {
		padding: 0 var(--space-2xl);
	}
	/*
	 * THE HEAD IS THE `···` AND NOTHING ELSE, right-aligned in its own flex row so the affordance sits where it
	 * always sat. The six rules for a title column, byline and eyebrow went with the markup they styled — each
	 * was a second copy of something the band row states 40px higher. The `···` keeps its `margin-right: -10px`,
	 * which aligns it optically with the column edge.
	 */
	/*
	 * THE DOOR, as the seek row's last item. `flex: 0 0 auto` so the bar keeps taking the width; the negative
	 * right margin is the same optical pull it had in the head (matching PageHeader's back-slot), which lines
	 * the glyph up with the column edge rather than the button's box.
	 *
	 * The row's `gap` is 9px and the remaining-time is `tabular-nums`, so the door cannot shift as the clock
	 * counts down — which is why it can sit after the time rather than needing its own corner.
	 */
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
	/*
	 * The provenance pill, right-aligned at the foot of the tools. Right because everything above it that
	 * carries a VALUE sits right (the key readout, the range's octave count) and everything that carries a
	 * LABEL sits left — the pill is a value with no label, so it belongs on that side.
	 */
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
	/* Dimmed with the INK token, never with `opacity` on a subtree — an ancestor alpha flattens the
	   sentence and the surface behind it into one buffer, so measured contrast stops being what is
	   painted. */
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
