<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
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
	 * (That prop only works because a real `Drawer.Handle` is rendered below, inside `.band-slot`;
	 * shadcn's copy-in shipped a decorative div in its `drawer-content.svelte` — and the vendored file
	 * briefly rendered a real one there too, which is how the phone came to draw TWO pull-up lines.
	 * See drawer-handle.svelte.)
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
	import NowPlayingBand from '$lib/components/NowPlayingBand.svelte';
	import GuidingTrack from '$lib/components/GuidingTrack.svelte';
	import RangeBar from '$lib/components/RangeBar.svelte';
	import LyricsReselect from '$lib/components/LyricsReselect.svelte';
	import { formatClock, formatRemaining, progressFraction } from '$lib/clock';
	import { SNAP_BAND, OPEN_CONTENT_SLACK_PX, openSnapFraction } from '$lib/sheet-snap';
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
		/** The band row's magnifier. */
		onsearch?: () => void;
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
		open = $bindable(true),
		bandH = $bindable(72),
		activeSnapPoint = $bindable(null),
		title = null,
		artist = null,
		singerName = null,
		singerColor = null,
		onsearch = undefined,
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

	/*
	 * WHICH HEIGHT THE SHEET IS AT, and the replacement for the old `open` boolean.
	 *
	 * `open` no longer means anything a driver can read: the sheet is permanently mounted, so presence
	 * of `.np-drawer` is TRUE at all times. This is the state that distinguishes collapsed from pulled
	 * up, and vaul writes it as the snap VALUE (the `${bandH}px` string or the 0.82 fraction), not an
	 * index. `null` lets vaul seat it on the first snap point itself rather than guessing a string that
	 * has to stay byte-equal to the one in `snapPoints` as `bandH` is re-measured.
	 */
	/*
	 * SNAP 0 IS A CONSTANT, and that is a correctness requirement rather than a simplification.
	 *
	 * Building snap 0 from the band's MEASURED height cannot work against this version of vaul. Two
	 * mechanisms in `use-snap-points.svelte.js` decide it:
	 *
	 *   1. `snapToPoint()` does `set(drawerNode(), { transform: … })` with NO null guard, and its only
	 *      trigger is `watch([activeSnapPoint, open])` — runed's LAZY watcher, which fires on change and
	 *      never retries. Seat the snap point before `Drawer.Content` has bound its ref and the write
	 *      lands on `null`, silently, forever. Measured symptom: content parked at top 850 in an 844px
	 *      viewport with the correct 692px height, and a drag on the handle moving it DOWN.
	 *   2. `snapPoints.findIndex((p) => p === activeSnapPoint)` is strict equality on the string. A
	 *      re-measured height updates this component's state before the prop reaches vaul's box, so
	 *      `'78px'` is looked up in `['72px', 0.82]`, returns -1, and no snap happens — also silently.
	 *
	 * So the band's height is FIXED — in `$lib/sheet-snap`, which is also where `.band-slot` gets it in
	 * CSS from (via `--snap-band`) rather than the number being copied into a stylesheet where the two
	 * could drift. The band's height was never really variable: it is a `--tap`-sized control row plus
	 * its padding, and pinning it also stops the strip growing by a line when a byline appears.
	 *
	 * `--dock-h` is still MEASURED off the rendered `.band-slot` (see the layout), so the reservation
	 * contract every docked control offsets from is unchanged — it just now measures an element whose
	 * height is deterministic.
	 *
	 * SNAP 1 IS NOT A CONSTANT, and everything above is why that needs saying out loud. It has to move
	 * with the viewport (see `SNAP_OPEN` below — a fixed fraction covers the page's top controls on a
	 * short window), so both hazards apply to it and both are handled EXPLICITLY rather than avoided:
	 * hazard 1 by never touching the array before mount (`onMount` writes the height synchronously,
	 * while `activeSnapPoint` is still `null`), and hazard 2 by re-seating on the NEW array value after
	 * every resize instead of restoring the stale one (`armResizeReseat`). The rule both follow is the
	 * same: the array is only ever replaced while nothing points into it.
	 */

	/*
	 * SNAP 1 IS CLAMPED, AND THAT IS WHY IT IS DERIVED RATHER THAN A CONSTANT LIKE ITS SIBLING.
	 *
	 * It was a flat `0.82`, and a fraction of the viewport is the one thing an open sheet must not be.
	 * vaul puts the sheet's top at `containerHeight - fraction * containerHeight`, so `0.82` means "18%
	 * of the window, whatever that is" — 162px on a 900px-tall window and 126px on a 700px one. The
	 * page's own top-of-page controls do not shrink with the window: on `/find` the search box sits at
	 * 115–159px at BOTH heights. So the sheet cleared it at 900 by three pixels and covered it at 700,
	 * and `document.elementFromPoint` at the input's centre returned a `<span>` from inside the sheet.
	 * The sheet is `position: fixed`, so covering is the whole of it — the click never reaches the input,
	 * which is the other half of "I can't type in the song search bar".
	 *
	 * THE ARITHMETIC LIVES IN `$lib/sheet-snap`, not here, because it is the half of this fix that can be
	 * WRONG at a height nobody happened to try. A rendered offset is a layout-rung claim (XR-VER-01) and
	 * this component cannot even be mounted on the rung below it, so a formula written inline could only
	 * ever be guarded as a string. As a pure function it is swept across every viewport height instead.
	 *
	 * The window height is STATE rather than read on demand, because `snapPoints` is a prop vaul reads
	 * reactively. Zero until mount — this component is server-rendered — and `openSnapFraction` answers
	 * that with the ceiling, which is the value snap 1 had before the clamp existed.
	 */
	let viewportH = $state(0);
	/*
	 * THE SHEET'S NATURAL HEIGHT, so snap 1 cannot open to five times its own content.
	 *
	 * Measured off `.np-fit`, the block holding the head and the body — everything below the band row.
	 * The content BOX itself is no use for this: it is `height: 100dvh` with `max-height: none` (see the
	 * `.np-drawer` rule and the note there about why the cap had to be released), so reading it back always
	 * answers "the viewport".
	 *
	 * `bandH` is added because the band row is snap 0 and part of the same box, and `OPEN_CONTENT_SLACK_PX`
	 * covers the content's own bottom padding, which is applied to the box rather than to the measured
	 * block — see that constant for why the slack errs generous.
	 *
	 * 0 until the first measurement lands, which `openSnapFraction` reads as "not measured" and answers
	 * with the viewport caps alone. So the first paint behaves exactly as it did before this existed.
	 */
	let fitH = $state(0);
	const contentH = $derived(fitH > 0 ? bandH + fitH + OPEN_CONTENT_SLACK_PX : 0);
	const SNAP_OPEN = $derived(openSnapFraction(viewportH, contentH));

	/*
	 * RE-SEAT WHEN THE CONTENT CHANGES HEIGHT, for the same reason `armResizeReseat` re-seats on a resize
	 * and with the same discipline: snap 1 is DERIVED, vaul looks the active point up by strict equality
	 * (`snapPoints.findIndex((p) => p === activeSnapPoint)`), and replacing the array under a pointer into
	 * it yields index -1 — no snap, silently, and a handle click that does nothing.
	 *
	 * A song starting or ending changes the body's height (the seek row, the ± keycaps, the range bar and
	 * the guiding track all come and go), so this is a real trigger and not a theoretical one.
	 *
	 * ONLY WHEN THE SHEET IS AT THE OPEN POINT, and only when the active value is a NUMBER: snap 0 is a px
	 * STRING, so a numeric value that is not the current fraction is exactly the stale-pointer case and
	 * nothing else. `null` first, then the new value after a tick — the array is only ever replaced while
	 * nothing points into it. `untrack` on the read so this effect is driven by the derived snap point
	 * alone and cannot re-enter itself by writing what it reads.
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
	 * WHICH HEIGHT THE SHEET IS AT, and the replacement for the old `open` boolean. `open` no longer
	 * means anything a driver can read: the sheet is permanently mounted, so `.np-drawer` is present at
	 * all times. vaul writes this as the snap VALUE, not an index.
	 */

	/*
	 * Seated ONCE, after mount, which is the whole point of `onMount` + `tick` here rather than an
	 * `$effect`: the write has to happen when `drawerNode` is non-null, and it must be a CHANGE
	 * (null → '80px') for the lazy watch to see it at all. `tick()` covers the ref binding landing
	 * a microtask after the children mount.
	 *
	 * `viewportH` is written FIRST and synchronously, so `snapPoints` reaches its real value while
	 * `activeSnapPoint` is still `null` — nothing can be pointing at an entry the array is about to
	 * replace. That ordering is the whole re-seating discipline for the derived snap 1; see
	 * `armResizeReseat`.
	 */
	onMount(() => {
		viewportH = window.innerHeight;
		void tick().then(() => {
			activeSnapPoint = SNAP_BAND;
		});
		return armResizeReseat();
	});

	/*
	 * RESIZING MUST RE-LAY THE SHEET OUT, and nothing in vaul does it. This is the fix for "the bottom
	 * gets cut off on resize", and the cause is one missing trigger rather than wrong arithmetic.
	 *
	 * In `use-snap-points.svelte.js`, `snapPointsOffset` is `$derived` and DOES recompute on a resize —
	 * the file keeps its own `windowDimensions` state behind a `window` resize listener for exactly that.
	 * But the only thing that ever applies an offset to the element is `snapToPoint()`, and its only
	 * caller outside a drag is `watch([() => activeSnapPoint.current, () => open.current])`. A resize
	 * changes NEITHER of those, so the recomputed offset is never written: the sheet keeps the PIXEL
	 * translate it was given at the old height while the viewport moves out from under it.
	 *
	 * Both snap points move, which is why this re-seats whichever one is active rather than only the
	 * fraction. `SNAP_OPEN` is `0.82` and its offset is `containerHeight - 0.82 * containerHeight`, so it
	 * scales with the height directly; `SNAP_BAND` is a px string, and its offset is still
	 * `containerHeight - 80` — a viewport-dependent number built from a viewport-independent snap. At
	 * 844 → 600 the collapsed sheet's translate should fall 764 → 520, and unfixed it stays at 764,
	 * which puts a 600px-tall box entirely below the fold.
	 *
	 * HOW IT RE-TRIGGERS: `null`, a tick, then the same value back. The watch is runed's, so it fires on
	 * a CHANGE of the value it tracks; writing the same string is not a change, and the intermediate
	 * `null` is a deliberate no-op rather than a state anything renders (`snapToPoint` is not reached —
	 * the watch's own `if (!activeSnapPoint.current) return` handles it, and `activeSnapPointIndex`
	 * simply reads -1 for one tick). The `tick()` is what makes the two writes two separate changes.
	 *
	 * DEBOUNCED, because a desktop window drag emits a resize per frame and each re-seat starts vaul's
	 * own 0.5s transform transition — so an undebounced version would have the sheet chasing the pointer
	 * a half-second behind. One settle at the end is both cheaper and what a resize actually means.
	 *
	 * SSR-safe by construction: this is armed from `onMount`, which does not run on the server, and it
	 * returns the teardown so the listener and any pending timer die with the component.
	 *
	 * IT ALSO RE-SEATS SNAP 1 ONTO ITS NEW VALUE, which is what makes a DERIVED snap point safe. Snap 1
	 * is `min(0.82, (vh - headroom) / vh)`, so a resize changes the ARRAY as well as the offsets, and
	 * vaul looks the active point up by strict equality (`snapPoints.findIndex(p => p === activeSnapPoint)`
	 * in both `use-snap-points.svelte.js` and `use-drawer-handle.svelte.js`). Restoring the value this
	 * function captured would therefore restore a fraction that is no longer IN the array: index -1, no
	 * snap, and a handle click that silently does nothing. So it restores by WHICH SNAP POINT was active
	 * rather than by its number, and it reads `SNAP_OPEN` after the tick, when the derived value has
	 * caught up with the new height.
	 *
	 * The write order is the same one `onMount` uses and for the same reason: `null` first, then the new
	 * height, so the array is only ever replaced while nothing points into it.
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
		hasSong && !guideEnabled ? 'No isolated vocals, so no guiding track. Key and range still work.' : null
	);
</script>

<!--
	ONE SURFACE AT TWO HEIGHTS, NOT TWO SURFACES.

	The band used to be its own fixed element in `+layout.svelte` and this drawer its separate
	expansion, wired together by an `onexpand` callback. That arrangement could not be dragged open:
	an outside element can START a pointer gesture, but it cannot hand the in-flight pointer to vaul,
	so the sheet jumped to its open height instead of tracking the thumb. The band's handle therefore
	carried `cursor: grab` while only accepting a click — the affordance was a lie.

	So the band is now snap point 0 OF THIS DRAWER. `snapPoints` accepts px strings ("You can also use
	px values, which doesn't take screen height into account" — vaul-svelte's own types), which is what
	lets snap 0 be the band's measured height rather than a fraction of the viewport. Dragging the
	handle moves one element between two heights, which is why it can track the thumb.

	The band is COMPOSED, not absorbed: `<NowPlayingBand>` renders as the content's first child and
	keeps its own file, its own surface and its own `env(safe-area-inset-bottom)`. Inlining its markup
	here would have moved ~200 lines of CSS whose rationale is written against `.band`, and /components
	still renders five bands side by side to show every state — which a fixed, snap-pointed drawer
	cannot do.

	`dismissible={false}` with `open` is vaul's own documented pairing for a sheet that must never
	close ("Use this in combination with the `open` prop"). `modal={false}` keeps the collapsed band from
	trapping focus behind a scrim on every phone surface.

	THERE IS NO SCRIM AT EITHER HEIGHT, and this used to claim otherwise. The Root carried
	`fadeFromIndex={1}` under a comment saying the overlay "starts at the SECOND snap point, so there is no
	scrim while the band is just sitting there" — which reads as "and there IS one once you pull it up".
	There never was: `vaul-svelte` gates the overlay on modality (`use-drawer-overlay.svelte.js`:
	`shouldRender = ctx.modal.current`), so `modal={false}` means it renders nothing at any index, and
	`fadeFromIndex` had nothing to fade. Measured on the running app: no `[data-slot='drawer-overlay']` in
	the DOM at either snap point. The prop is gone and `drawer-content.svelte` no longer includes the
	overlay at all; `drawer-overlay-modality.test.ts` ties the two facts together so they cannot drift.

	That is also the honest design: the page under this sheet is the thing the guest is using (see
	`trapFocus` below), so an un-dimmed page is correct rather than a missing feature. What the sheet leans
	on instead is its own edge — `border-t` in `border-border` plus the popover surface.

	`handleOnly` stays, and it is load-bearing rather than decorative: the body carries sliders, so a
	drag started anywhere on the content would fight them (XR-PH-15). The handle exists at both
	heights and is the one drag surface.
-->
<Drawer.Root
	open={open}
	dismissible={false}
	modal={false}
	snapPoints={[SNAP_BAND, SNAP_OPEN]}
	bind:activeSnapPoint={activeSnapPoint}
	handleOnly
>
	<!--
		`aria-label` IS THE IDLE FALLBACK NAME, and it is here because the head's title is now
		conditional (see `.titlecol` below). bits-ui sets `aria-labelledby` only once a `Drawer.Title`
		has mounted and registered its id (`dialog.svelte.js:207`), so with nothing playing the
		attribute is absent and this is what names the dialog. With a song it is inert: `aria-labelledby`
		wins the accessible-name cascade, so the song title still names the surface.
	-->
	<!--
		`trapFocus={false}` IS WHY YOU CAN TYPE IN THE SEARCH BOX. Reported as "I can't type in the song
		search bar and I can't even see the cursor", and the caret really was not there: focus was being
		taken off the input a frame after it landed.

		`modal={false}` was already set for the neighbouring problem and does NOT cover this one. It
		reaches vaul's own `onFocusOutside` / `onInteractOutside` (`use-drawer-content.svelte.js`), which
		`preventDefault()` when the drawer is non-modal — that is the DISMISSAL path. The focus TRAP is a
		separate mechanism one layer down: `Drawer.Content` renders `bits-ui`'s `Dialog.Content`, which
		defaults `trapFocus = true` (`dialog-content.svelte:24`) and hands it to `FocusScope`. Nothing
		vaul exposes on the Root touches it — `autoFocus` (default false) only cancels the ONE
		open-autofocus, which is why the collapsed band looked innocent.

		WHAT THE TRAP DOES, from `focus-scope.svelte.js`: when `trap` is set it installs a
		DOCUMENT-LEVEL `focusin` capture listener for as long as the scope is `enabled`, and `enabled` is
		`open.current` — permanently true here, because this sheet never closes. Every focus landing
		outside the content is treated as an escape and yanked back: `e.preventDefault()` then
		`lastFocused.focus()`, falling through to `(firstTabbable || firstFocusable || container).focus()`.
		The container is the fallback and it is focusable (the scope gives it `tabindex: -1`), which is
		exactly what was measured — after clicking the input, `document.activeElement` was
		`div[data-slot=drawer-content]`. `/find` focuses its box in `onMount`, so the very first thing a
		guest sees is a caret that appears and then vanishes.

		This is the sheet's own trap being switched off, NOT the sheet being made unfocusable. Everything
		inside it stays in the tab order — the transport buttons, the guiding-track slider, the ± keycaps,
		"More about this song" — and the container keeps its `tabindex: -1`. What is gone is the
		`focusin` interception, the `Tab` wrap-around and the MutationObserver that re-homed focus when a
		focused child was removed. All three are modal-dialog behaviours, and a sheet that is mounted over
		every phone surface at all times is the opposite of modal: the page underneath is the thing you
		are using.
	-->
	<Drawer.Content class="np-drawer" trapFocus={false} aria-label="Now playing">
		<!--
			SNAP 0 — the band row, and the only thing on screen when the sheet is collapsed. It is the
			content's FIRST child because vaul sizes the content to the largest snap point and translates
			it down: what shows at snap 0 is the TOP of this element, so anything below the band row is
			simply past the fold.

			`bind:clientHeight` here is what makes snap 0 equal the band's REAL rendered height instead of
			a guess, and the layout re-publishes it as `--dock-h` so every docked control still offsets
			from one measured number (XR-VER-11).
		-->
		<div class="band-slot" style="--snap-band: {SNAP_BAND}" bind:clientHeight={bandH}>
			<!--
				THE SHEET'S ONE AND ONLY GRAB BAR, and it lives here rather than in `ui/drawer` because this
				is the row a thumb pulls. `drawer-content.svelte` used to render a second real
				`Drawer.Handle` at the top of the content BOX as well, so the phone drew TWO stacked
				pull-up lines — reported as exactly that. Only one of the two could be placed correctly: a
				consumer cannot move a child the vendored component renders for it, and the band row is
				snap point 0, so the bar has to be inside it. `handleOnly` on the Root restricts dragging
				TO this element, which is why it must be vaul's real Handle and not a decorative bar.
			-->
			<Drawer.Handle />
			<!--
				`onexpand` IS BACK, AND IT IS THE ONLY WAY IN WITHOUT A POINTER.

				It was dropped when the band became this sheet's snap point 0, on the reasoning that there is
				no closed surface left to open — true of the SHEET, false of the guest. vaul's `Drawer.Handle`
				above is the whole affordance that replaced it, and it is a `<div aria-hidden="true">` with no
				tabindex and no role: draggable and clickable by a pointer, invisible to a keyboard and to a
				screen reader. Measured on the collapsed home route, the only drawer controls reachable by Tab
				were the band's magnifier and a play/pause button below the fold; the transport, the ± keycaps,
				the guiding track, the lyrics reselect and the `···` that is the ONLY link to /song/[mediaId]
				were all unreachable.

				Raising the sheet is a snap-point write, not an `open` toggle — `open` is permanently true here
				(`dismissible={false}`), so this seats `activeSnapPoint` on snap 1 exactly as a completed drag
				would. Guarded on it not already being there so a press on an open sheet is a no-op rather than
				a re-seat that restarts vaul's transform transition.

				Nothing about the DRAG changes: `handleOnly` still restricts dragging to the handle, so the
				body of sliders is still not a drag surface (XR-PH-15).

				IT TOGGLES, because nothing else can collapse the sheet by tap. It only opened at first, on the
				reasoning that vaul's own handle is the way back down. It is not: `use-drawer-handle.svelte.js`
				cycles snap points on click, and at the LAST point with `dismissible={false}` it computes
				`snapPoints[index + 1]`, which is `undefined`, and the seating watch then ignores it. Measured
				in Chrome: two taps on the grab bar with the sheet open left its top at 636 both times. So the
				app had one tap that opens, none that closes, and a grab bar that looks tappable and does
				nothing at that height — a drag being the only way down is exactly the affordance a guest who
				cannot drag does not have.

				NO `expanded` PROP GOES WITH IT, and the reason is worth recording because it is not obvious.
				The band's press label would ideally name its direction, which needs the snap state as a prop —
				and ANY prop of `NowPlayingBand` that changes after mount re-runs the size bindings below
				(`.band-slot`, `.np-fit`), which on the mount rung is a deliberate throw (XR-VER-03). Measured:
				a reactive prop took three of `phone-home-832`'s mounts down; the same prop as a constant
				passed. So the band's label is state-independent (see its own note) and this stays a plain
				toggle. An `aria-expanded` written onto the button from an effect here would be the way to add
				direction later — an attribute write re-renders nothing.

				(The rationale lives here rather than inside the prop because a comment inside a component tag
				is scanned as part of that tag: `ui-scoped-style-reach-913.test.ts` walks a tag to its closing
				`>` tracking quote state, and an apostrophe in prose there flips it and swallows the rest of the
				file — which reported five of this component's own plain-element classes as handed to a child.)
			-->
			<NowPlayingBand
				title={title}
				artist={artist}
				singerName={singerName}
				singerColor={singerColor}
				progress={progress}
				isPlaying={isPlaying}
				canStart={canStart}
				onsearch={onsearch}
				ontoggleplay={ontoggleplay}
				onexpand={() => (activeSnapPoint = activeSnapPoint === SNAP_OPEN ? SNAP_BAND : SNAP_OPEN)}
			/>
		</div>
		<!--
			`.np-fit` EXISTS TO BE MEASURED, and it is a plain block so it changes nothing about the layout:
			the head and the body keep their own padding and their own `--max-w` centring. It wraps
			everything below the band row, which is what snap 1's content cap needs the height of.
		-->
		<div class="np-fit" bind:clientHeight={fitH}>
			<Drawer.Header class="np-head">
				{#if singerName}
					<div class="eyebrow">
						<span class="singer-dot" style="--singer:{singerColor ?? 'var(--accent)'}"></span>
						<span>Now singing · {singerName}</span>
					</div>
				{/if}
				<div class="titlerow">
					<div class="titlecol">
						<!--
						THE HEAD NAMES THE SONG; IT DOES NOT RESTATE THE ROOM'S STATE.

						This used to render `hasSong ? title : 'Nothing playing'`, which was correct while the
						drawer was a SEPARATE surface that mounted on open — the band was a different element and
						only one of the two was ever in the document. Now the band row is this sheet's own first
						child and a snap-pointed sheet keeps its whole body mounted below the fold, so
						"Nothing playing" was in the tree TWICE: once in `.band-slot`'s `.title` and once here.
						Nothing on screen showed it twice — the head is past the fold at snap 0 — but a screen
						reader reads the whole dialog, so it announced the same three words twice in a row.

						The band row is the collapsed FACE of this surface and it already states the idle case, so
						the head is the half that gives it up: with no song there is no song identity for the head
						to carry, and its only remaining job was repetition. With a song the head keeps the title,
						because that is the dialog's accessible name (`aria-labelledby`, see `Drawer.Content`) and
						the band row's copy of it is a one-line glance rather than the heading.
					-->
						{#if hasSong}
							<Drawer.Title class="np-song">{title}</Drawer.Title>
						{/if}
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
								onclick={collapse}
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
				<!--
				RESTART · PLAY/PAUSE · SKIP, CENTRED IN ONE ROW — a whole transport, which is what this sheet
				had before and what this deliberately restores (ratified 2026-09-18).

				The row shipped for a while as restart + skip ONLY, with play/pause living exclusively on the
				band's disc, because two play buttons about 100px apart had been reported as duplicate
				playback controls. They were — but the trade that bought was a transport split across the
				surface: the two halves of one control group sat at opposite corners of the same sheet, the
				disc at the top right of the band row and its siblings at the bottom left, in a different
				shape (`rounded-md` icon buttons against the band's hand-rolled pills). Reported as the
				controls not being unified. A familiar three-up transport is worth more than the absence of a
				second glyph, so play/pause is back, in the middle, where the shape is read at a glance.

				THE DISC STAYS, AND IT IS STILL THE ONE THAT SURVIVES A COLLAPSE. It is visible at BOTH snap
				points, it carries the progress ring, and it sits in the thumb zone. Dropping it instead
				would mean hiding it when the sheet opens — a prop of `NowPlayingBand` that changes after
				mount, which the mount rung throws on (XR-VER-03; see the note on `expanded` above). So both
				are on screen while the sheet is up, by decision rather than by oversight.

				`canStart` STAYS ON THE DISC TOO rather than moving back here, which is the difference from
				the arrangement this replaces. Both buttons fire the same `ontoggleplay`, so the same
				condition belongs on both: `!hasSong && !canStart` keeps "a queue exists but nothing is
				current, press to start" pressable from either height.

				THE ACCESSIBLE NAME IS DUPLICATED ON PURPOSE, and it is the one thing to know before adding a
				third caller. Both controls are named Play/Pause because both ARE play/pause, and the e2e
				driver's `clickByLabel`/`clickByRole` resolve `.first()` — `.band-slot` precedes `.np-fit`, so
				the disc is earlier in the DOM and every existing flow still drives it. No probe was re-aimed.

				RESTART IS CALLED AND DRAWN AS RESTART. It always called `onrestart` and its label always said
				"restart", but it was once drawn with the `prev` glyph — the universal previous-track mark, for
				something this app has no concept of (a rotation has no previous).
			-->
				<div class="transport">
					<Button
						variant="outline"
						size="icon"
						aria-label="Restart"
						title="Play this song again from the beginning"
						disabled={!hasSong}
						onclick={() => onrestart?.()}
					>
						<Icon name="restart" />
					</Button>
					<Button
						variant="iconPrimary"
						size="icon"
						aria-label={isPlaying ? 'Pause' : 'Play'}
						title={isPlaying ? 'Pause' : hasSong ? 'Resume this song' : 'Start the party'}
						disabled={!hasSong && !canStart}
						onclick={() => ontoggleplay?.()}
					>
						<Icon name={isPlaying ? 'pause' : 'play'} />
					</Button>
					<Button
						variant="outline"
						size="icon"
						aria-label="skip"
						title="Skip to the next singer"
						disabled={!hasSong}
						onclick={() => onskip?.()}
					>
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
								<RangeBar profile={profile} keyShift={keyShift} />
							</div>
						{/if}

						{#if candidates.length}
							<LyricsReselect
								candidates={candidates}
								chosenRef={chosenRef}
								overrideRef={overrideRef}
								newerExists={newerExists}
								onpick={(ref) => onpicklyrics?.(ref)}
								onpaste={(text) => onpastelyrics?.(text)}
							/>
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
	 * THE BAND ROW AT SNAP 0. Layout only — plus one job: stopping the band painting a SECOND surface
	 * inside the one that already exists.
	 *
	 * `NowPlayingBand` was the app's bottom chrome in its own right, so it carries a `--card` fill, a
	 * 1px top border and `var(--shadow)`. The drawer content carries all three too. Composed one inside
	 * the other, that put a hairline straight across the sheet just below the drag handle and stacked
	 * two shadows on one edge. The content is the surface now, so the band goes transparent within it.
	 *
	 * Reached with `:global()` on purpose rather than by editing `NowPlayingBand.svelte`: the band still
	 * renders standalone in /components, five of them side by side to show every state, and there it
	 * genuinely needs its own surface. Suppressing the paint at the composition site is what lets both
	 * call sites be right — and it keeps every guard that reads `.band`'s own rule green.
	 *
	 * `padding-bottom: env(safe-area-inset-bottom)` is deliberately NOT suppressed. It is the app's only
	 * home-indicator inset, and this element's measured height is what becomes `--dock-h`, so the inset
	 * has to be inside the measurement.
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
	 * FULL-HEIGHT CONTENT, AND `max-height` DEFEATED — this is what makes the snap offsets land.
	 *
	 * vaul positions a snap point by TRANSLATING the content down by `containerHeight - snapHeight`.
	 * That arithmetic assumes the content spans the viewport, so translating it by 764 leaves the top
	 * 80px showing. The vendored `drawer-content.svelte` instead sets `h-auto` with
	 * `max-h-[82dvh]` and anchors it `bottom-0`, which is right for a plain sheet and wrong here twice
	 * over.
	 *
	 * Measured, in an 844px viewport: with `h-auto` the box was 214px and went wholesale off-screen.
	 * With `height: 82dvh` it was the right 692px but its STATIC top was 152px, so vaul's correct 764px
	 * transform put it at 916 — still below the fold. The transform was never the problem; the box it
	 * was applied to was 692px tall instead of 844.
	 *
	 * So the content spans the viewport and `max-height` is released, and the OPEN height comes from the
	 * snap point itself (`0.82`) rather than from a CSS cap. Snap 0 then shows exactly the band strip,
	 * and snap 1 shows 82% of the screen.
	 */
	:global([data-slot='drawer-content'].np-drawer) {
		height: 100dvh;
		max-height: none;
	}
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
	/*
	 * REDUCE MOTION FOR THE SHEET'S SLIDE, and it has to be `!important` — which is the whole reason this
	 * rule needs a comment rather than an apology.
	 *
	 * vaul sets `transition: transform 0.5s cubic-bezier(0.32,0.72,0,1)` as an INLINE STYLE from JS
	 * (`use-drawer-root.svelte.js:335`), so nothing in the cascade can reach it: an inline declaration
	 * outranks every author rule except `!important`. It is also invisible to `motion.test.ts`, which scans
	 * declared CSS in this repo and cannot see a style written by a dependency at runtime — so the app's
	 * largest single movement, on every phone surface, honoured no motion preference and no guard could
	 * say so. Measured in Chrome: 764 → 636 over half a second with Reduce Motion on.
	 *
	 * `transition-duration: 0s` rather than `transition: none`, so vaul's own `transitionend`-adjacent
	 * bookkeeping still sees a transition it can complete instantly rather than an absent one. The sheet
	 * still MOVES — it arrives, which is the point of a snap point — it just does not travel.
	 */
	@media (prefers-reduced-motion: reduce) {
		:global([data-slot='drawer-content']) {
			transition-duration: 0s !important;
		}
	}

	/*
	 * THE MEASURE, SHARED BY THE HEAD AND THE BODY — one rule, two selectors, and they must STAY one rule.
	 *
	 * `--max-w` for the same reason the band tracks it: this is bottom-docked chrome, and on a laptop a
	 * full-bleed sheet would put the song title at the far left of the window while its controls sat in a
	 * centred column — which is exactly what happened when a new rule was once inserted BETWEEN these two
	 * selectors. The head silently dropped out of the list, kept the declarations of whatever rule followed,
	 * and went full-bleed at every width above `--max-w`: title and `···` pinned to the window edges with
	 * the transport, the guiding track and the range centred 280px inside them. Nothing caught it — the
	 * class still resolved to a rule, so the class-resolution guard was satisfied, and no measured arm reads
	 * the head's width. It was found by looking at the screen.
	 *
	 * So: if you add a rule near here, add it AFTER this block, never inside the selector list.
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
	 * FULL WIDTH ON PURPOSE: the two children above cap and centre THEMSELVES, so capping this one too would
	 * be a second measure saying the same thing, and the first change to disagree with the other would move
	 * the column.
	 *
	 * `flex: 0 0 auto` is load-bearing rather than defensive: this is a flex child of the content column, so
	 * it would otherwise inherit `flex-shrink: 1` — and if the body ever grew past the viewport the wrapper
	 * would SHRINK, `clientHeight` would under-report, and snap 1's content cap would be computed from a
	 * height smaller than the content it is capping. That clips a control instead of leaving space, which is
	 * the one direction the cap must never err in (see OPEN_CONTENT_SLACK_PX).
	 *
	 * `min-width: 0` for the reason the two above carry it: a nowrap descendant must not set a floor this box
	 * cannot go under.
	 */
	.np-fit {
		flex: 0 0 auto;
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
	/*
	 * CENTRED, which is the half of "one transport" that CSS owns. Left-aligned, the pair read as two
	 * loose buttons parked under the head; centred, the three read as prev·play·next — the arrangement
	 * every phone player uses, and the reason the middle one is `iconPrimary` rather than `outline`.
	 * The row is the only centred block in `.np-body`, deliberately: everything below it (the guiding
	 * track, the keycaps, the range) is a labelled control that reads from the left.
	 */
	.transport {
		display: flex;
		align-items: center;
		justify-content: center;
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
