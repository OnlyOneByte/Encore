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
	 * THE BAND ROW IS THE DRAG SURFACE, AND `.np-fit` IS EXCLUDED. vaul drawers drag-to-dismiss from
	 * anywhere in their content by default, and this drawer's body is sliders — the guiding-track thumb
	 * and, on the way past, the range visualizer. A drag surface underneath a slider is precisely what
	 * XR-PH-15 bans: the two gestures are the same gesture, and the drawer wins because it is the
	 * ancestor. This was `handleOnly` — dragging restricted to the 6px grab bar — until the top edge of a
	 * sheet that plainly looks draggable was reported as not being. So the exclusion inverted: ONE
	 * `data-vaul-no-drag` on `.np-fit` covers the head, the body and every control ever added below the
	 * band row, which is still a whitelist in effect ("only the band row drags") rather than a list
	 * someone has to remember to extend.
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
		/*
		 * `newerExists`, `onpicklyrics` and `onpastelyrics` RETIRED (2026-09-21) with the re-selection
		 * disclosure they served. `candidates`/`chosenRef`/`overrideRef` stay because the sheet still NAMES the
		 * source as a pill — it just no longer changes it. The control lives on /song/[mediaId], which the `···`
		 * on the seek row opens, and the layout's `room.reselectLyrics` wiring moved there with it.
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
		onrestart,
		ontoggleplay,
		onskip,
		onkey,
		onguide
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

	/*
	 * IS THE SHEET UP — the only thing the band row needs to know, and it is deliberately NOT a prop of
	 * `NowPlayingBand`.
	 *
	 * It is what REVEALS RESTART AND SKIP in the band row. The band renders the pair at all times and hides
	 * it at rest (`.tp-side { display: none }`), so the collapsed bar keeps exactly the controls it always
	 * had — title, magnifier, disc — and the sheet being up is the one thing that brings the rest of the
	 * transport out. The disc is untouched at either height: it is still the app's only play/pause.
	 *
	 * A CLASS AND A CSS RULE, NOT A PROP — which is what makes this legal at all. The band cannot take an
	 * `expanded` prop: any prop of it that CHANGES after mount re-runs the size bindings on `.band-slot` /
	 * `.np-fit`, and a geometry read on the mount rung is a throw by design (XR-VER-03). Measured: a
	 * reactive prop took three of `phone-home-832`'s mounts down. The file already records the same escape
	 * hatch for `aria-expanded` ("an attribute write re-renders nothing"). It also keeps the DOM tree
	 * identical at both heights, which is what the census arm in `phone-home-832` asserts.
	 *
	 * HELD THROUGH THE `null` BLIP. `activeSnapPoint` is written to `null` for one tick by every re-seat
	 * (see `armResizeReseat` and the content-height effect), and `null` is not a height — reading it as
	 * "collapsed" would blink the pair away on every resize. So this only ever updates on a real value.
	 *
	 * AN IMPERATIVE ATTRIBUTE WRITE, NOT A `class:` DIRECTIVE — AND THAT IS MEASURED, TWICE.
	 *
	 * Both reactive forms reopen the hazard the CSS route exists to avoid, because `.band-slot` carries
	 * `bind:clientHeight` and ANY reactive update in that part of the template re-runs its size binding —
	 * which on the mount rung is a deliberate throw (XR-VER-03):
	 *
	 *   1. `$state` + `$effect`: the write lands in a MICROTASK, so the refusal is raised from
	 *      `run_micro_tasks`, outside the synchronous window `openDrawer` swallows it in. Three of
	 *      `phone-home-832`'s mounts went down.
	 *   2. `$derived` read by `class:sheet-up={…}`: same three mounts. Bisected by deleting the directive
	 *      alone, with the derived left in place — 18/18 passed. So it is the reactive DOM UPDATE that
	 *      costs, not the state or the effect, which is the same mechanism the note on `expanded` below
	 *      records for a band prop and the same escape hatch it names: "an attribute write re-renders
	 *      nothing".
	 *
	 * So the class is toggled on a node ref. The effect reads `activeSnapPoint` (reading is free) and
	 * writes only to the DOM, so no template expression depends on it and nothing is invalidated.
	 *
	 * HELD THROUGH THE `null` BLIP in an untracked local, for the reason above: `activeSnapPoint` goes
	 * `null` for one tick on every re-seat and `null` is not a height, so reading it as "collapsed" would
	 * flash the disc back on every resize.
	 *
	 * `faceEl` IS A PLAIN `let`, not `$state`: `bind:this` assigns it once at mount, and the effect's first
	 * run is after that, so nothing here needs to be reactive — and a `$state` ref would put a reactive
	 * write back into the mount path, which is hazard 1 again.
	 */
	/*
	 * THE EXIT IS ANIMATED TOO, and it needs a class of its own because `display: none` leaves nothing to
	 * animate. Reported: the pair appears beautifully and then vanishes.
	 *
	 * `sheet-down` HOLDS THE OPEN LAYOUT for the length of the animation — the pair stays `display: grid`,
	 * so the row keeps its full width — while transforms move the magnifier and the disc to exactly where
	 * they will land and the pair fades out in place. When the class drops, the layout collapses to a state
	 * the screen is ALREADY showing, so the snap is invisible. It is the same FLIP as the entry, run
	 * backwards: the distances are the same two tokens and nothing is measured.
	 *
	 * THE TIMER MUST MATCH THE CSS, so `TP_ANIM_MS` and the `260ms` in the keyframe rules are one fact in
	 * two places — the shell guard asserts they agree rather than trusting it.
	 *
	 * SKIPPED ENTIRELY UNDER REDUCE MOTION. With no animation declared, holding the open layout for 260ms
	 * would just be a stutter before the pair blinks out, so the class is never added and the collapse is
	 * immediate. `matchMedia` is a preference read, not a geometry read — safe on the mount rung.
	 */
	const TP_ANIM_MS = 260;
	let faceEl: HTMLElement | undefined;
	let lastSeated: number | string = SNAP_BAND;
	$effect(() => {
		const at = activeSnapPoint;
		if (at !== null && at !== undefined) lastSeated = at;
		// Snap 0 is a px STRING and snap 1 is a fraction, which is the same discriminator the re-seat
		// effect above uses.
		const up = typeof lastSeated === 'number';
		const el = faceEl;
		if (!el) return;
		const wasUp = el.classList.contains('sheet-up');
		el.classList.toggle('sheet-up', up);
		el.classList.remove('sheet-down');
		if (!wasUp || up || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		el.classList.add('sheet-down');
		const timer = setTimeout(() => el.classList.remove('sheet-down'), TP_ANIM_MS);
		// Cleared on re-run as well as teardown: a guest who pulls the sheet straight back up must not have
		// the old timer strip `sheet-down` out from under the new state.
		return () => {
			clearTimeout(timer);
			el.classList.remove('sheet-down');
		};
	});

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
	 * Stated AHEAD of the control it explains, so the reason is read before the dead row rather than
	 * after it, and never dimmed by an ancestor `opacity` — XR-PH-03. This is the XR-PH-15 degradation:
	 * the guide row stays VISIBLE and disabled, because "this song has no isolated vocals" is
	 * information, and hiding the control would leave the singer wondering where it went.
	 */
	/*
	 * WHICH LYRICS THE TV IS SHOWING, as a label — the one thing the retired re-selection disclosure said
	 * that is worth saying mid-song.
	 *
	 * The OVERRIDE wins over the auto pick, because that is the order the server resolves them in: a guest
	 * who has chosen a source should see their choice named, not the one the ranker would have taken.
	 * `lyricsSourceLabel` is the shared contract helper, so this cannot drift from the option list on
	 * /song/[mediaId] — they were two copies of the same strings until it moved.
	 *
	 * NULL WHEN THERE IS NOTHING HONEST TO SAY: no candidates yet (the karaoke is still being made), or a
	 * chosen ref that matches none of them. A pill reading "undefined" is worse than no pill.
	 */
	const chosenLyrics = $derived(candidates.find((c) => c.ref === (overrideRef ?? chosenRef)) ?? null);
	const lyricsSource = $derived(chosenLyrics ? lyricsSourceLabel(chosenLyrics) : null);
	/*
	 * The TONE carries the same judgement `isAuthoritativeText` encodes, which is what makes the pill worth
	 * more than the string alone: authored, synced words are the good case; an auto-transcribed guess or
	 * low-confidence captions are the one a singer should know about before they trust the screen. `warn`
	 * rather than `bad` — the words are usable, just not authored.
	 */
	const lyricsSourceTone = $derived(chosenLyrics && isAuthoritativeText(chosenLyrics) ? 'ok' : ('warn' as const));

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

	`handleOnly` IS GONE, AND THE EXCLUSION INVERTED — the whole BAND ROW is the drag surface now, which is
	what "let me drag from anywhere at the top" means. The 6px grab bar (44px of hit area) was the only
	place a thumb could take hold of a sheet whose entire top edge looks draggable.

	XR-PH-15 IS UNCHANGED, and this is the part that needed care rather than courage. `handleOnly` is
	all-or-nothing in vaul — it simply skips the CONTENT's pointer handlers — so turning it off makes the
	body's sliders drag surfaces again, which is exactly the ban: the guiding-track thumb and the drawer
	dismiss would be one gesture, with the drawer winning as the ancestor. So `.np-fit` carries
	`data-vaul-no-drag`, and vaul resolves that with `closest()` (`use-drawer-root.svelte.js:87`), so ONE
	attribute excludes the head, the body, the sliders and everything ever added below the band row.

	THAT IS STILL A WHITELIST IN PRACTICE, which is what the old note argued for: the rule is not "these
	controls are excluded" (a list someone must remember to extend) but "only the band row drags". A control
	added to the sheet goes in `.np-fit` and is excluded by construction — the same property, from the other
	side, and the reason this is not the blacklist that note warned about.

	THE BAND'S OWN BUTTONS ARE EXCLUDED TOO (see NowPlayingBand): vaul sets pointer CAPTURE on press, so a
	drag begun on the disc would retarget its `pointerup` back to the button and fire a click — pausing the
	song on the way to opening the sheet.
-->
<Drawer.Root
	open={open}
	dismissible={false}
	modal={false}
	snapPoints={[SNAP_BAND, SNAP_OPEN]}
	bind:activeSnapPoint={activeSnapPoint}
>
	<!--
		`aria-label` IS THE DIALOG'S NAME, at every state — and it is no longer a fallback.

		It arrived as one, because the head's `Drawer.Title` was conditional on a song and bits-ui sets
		`aria-labelledby` only once a Title has mounted and registered its id (`dialog.svelte.js:207`). The
		head no longer renders a Title at all — every line of it was a second copy of the band row's, see the
		note there — so no Title ever mounts, the attribute is never set, and this names the surface. The song
		title is still inside the dialog, in the band row, so it is read as content rather than as the name.
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
				snap point 0, so the bar has to be inside it. It must still be vaul's REAL Handle rather than a
				decorative bar: `handleOnly` is gone, but the handle's own `onclick` is what cycles the snap
				points for a guest who taps the bar instead of dragging it.
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

				THE DRAG IS WIDER THAN IT WAS: the whole band row takes hold of the sheet now, and the body of
				sliders is still not a drag surface (XR-PH-15) — see `data-vaul-no-drag` on `.np-fit`. This
				press path is what a guest who cannot drag at all uses, and it is the only one that can
				CLOSE the sheet by tap.

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
			<!--
				`.band-face` CARRIES THE "SHEET IS UP" STATE, AND IT IS A SEPARATE ELEMENT FROM `.band-slot` FOR A
				MEASURED REASON.

				The class started on `.band-slot` itself, which is the element carrying `bind:clientHeight`, and
				that reopened the hazard the whole CSS route exists to avoid: updating the bound element re-runs
				its size binding, and a geometry read on the mount rung is a throw by design (XR-VER-03). Three
				of `phone-home-832`'s mounts went down with the refusal escaping `openDrawer`'s swallow — the
				same failure shape a reactive `expanded` PROP produced, which is what the note on `onexpand`
				below records. So the state lives one level in, on an element nothing measures.

				`display: contents`, so the wrapper is invisible to layout: `.band-slot`'s box, its fixed height
				and the strip inside it are exactly as they were, and only the CSS descendant path changes.
			-->
			<div class="band-face" bind:this={faceEl}>
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
					onrestart={onrestart}
					onskip={onskip}
					onexpand={() => (activeSnapPoint = activeSnapPoint === SNAP_OPEN ? SNAP_BAND : SNAP_OPEN)}
				/>
			</div>
		</div>
		<!--
			`.np-fit` EXISTS TO BE MEASURED, and it is a plain block so it changes nothing about the layout:
			the head and the body keep their own padding and their own `--max-w` centring. It wraps
			everything below the band row, which is what snap 1's content cap needs the height of.
		-->
		<!--
			`data-vaul-no-drag` IS WHAT REPLACED `handleOnly` (see the Root above). Everything below the band
			row — the head, the seek row, the transport's siblings, the guiding-track slider, the ± keycaps,
			the range visualiser — is excluded from dragging by this ONE attribute, because vaul resolves it
			with `closest()`. That is what keeps XR-PH-15 satisfied while the band row above becomes the drag
			surface, and it cannot be forgotten when the next control lands in the body.
		-->
		<div class="np-fit" data-vaul-no-drag bind:clientHeight={fitH}>
			<!--
				THE HEAD IS EMPTY, AND IT STILL RENDERS — which needs saying, because an empty element is normally
				a deletion waiting to happen.

				It carried the song identity until every line of it turned out to be a second copy of the band row's
				(an eyebrow against the band's byline, a `Drawer.Title` against its title, a `Drawer.Description`
				whose artist was in that byline and whose key is stated again above the ± keycaps) — reported as the
				now playing/now singing being duplicated. That left the `···` alone in it, which is a whole row of
				sheet for one 44px control, reported in turn. So the `···` moved into the SEEK ROW (see below) and
				nothing is left here.

				WHY THE ELEMENT STAYS. `Drawer.Header` is what bits-ui/vaul give the sheet its `data-slot`
				structure from, and `phone-home-832` asserts a header renders BELOW the band slot — the fact that
				replaced "closed renders nothing" when the sheet became permanently mounted. It is zero-height with
				no padding, so it costs no space; deleting the component instead would red that arm for a reason
				that has nothing to do with what this sheet shows.
			-->
			<Drawer.Header class="np-head"></Drawer.Header>

			<div class="np-body">
				{#if progress !== null}
					<!-- Time REMAINING on the right: the question this surface answers is "when am I up?".
				     aria-hidden because the position card on home states the same thing in words. -->
					<!--
						THE `···` RIDES THE SEEK ROW, and the pairing is exact rather than convenient: this row renders
						only when there is a duration to show, and the door renders only with a `mediaId` — both are
						"a song is playing", so the door never has to hold a row open by itself. It had its own row
						above this one until that was reported as a whole row for one control.

						`aria-hidden` MOVED OFF THE ROW AND ONTO THE TIMES. It was on the whole row, because the
						position card on home states the same thing in words and a screen reader should not hear it
						twice. That reasoning covers the CLOCKS, not a link — and the `···` is the app's only route
						to /song/[mediaId], so hiding it here would make the song page unreachable to a screen
						reader. So the two spans carry the attribute and the door stays announced.
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
				THERE IS NO TRANSPORT ROW HERE ANY MORE — it moved INTO THE BAND ROW (ratified 2026-09-21), where it
				sits with the magnifier as one header cluster. See `.tp` in NowPlayingBand.

				THE HISTORY, because this spot has now held three different answers and each was reported on sight.
				First the row was Restart + Skip with play/pause only on the band's disc: one transport split across
				two rows and two corners of the same sheet. Then it grew its own `iconPrimary` play/pause and was
				centred here: that put two identical play buttons on screen about 100px apart. Then the disc was
				hidden at snap 1 to resolve that: no duplication, but on a laptop the band row sat nearly empty while
				a three-button group floated in the middle of the body below it.
				All three failed the same way — the controls were not in one place. So the pair went up to the disc
				instead of the disc coming down to the pair, which is the one arrangement that puts every control in
				the row the guest is already looking at and keeps the collapsed bar unchanged.
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
							THE LYRICS SOURCE IS A PILL, NOT A DISCLOSURE (ratified 2026-09-21).

							This was `<LyricsReselect>`: a collapsible listing every candidate with its provenance and timing,
							plus a paste-your-own path. Reported as not belonging in the sheet — and it did not: re-picking
							lyrics is a decision you make ONCE about a song, sitting still, and the sheet is what you reach for
							mid-performance. It also asked a singer to open a second disclosure inside the one level of
							revealing this sheet is supposed to be.

							NOTHING WAS LOST, WHICH IS WHY THIS IS A DELETION RATHER THAN A MOVE. `/song/[mediaId]` already
							renders the same component under its own "Lyrics" heading, and the `···` on the seek row above is
							the door to it. The sheet's copy was the second one.

							WHAT SURVIVES IS THE FACT, not the control: which source the words on the TV came from. It is
							provenance a singer wants mid-song ("are these real lyrics or a guess?") and it answers in one
							glance, so it is a pill rather than a row with a label — the string names itself.
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
	.band-face {
		/* Layout-neutral by construction — see the markup note for why the state cannot live on
		   `.band-slot`, the element whose height is snap 0. */
		display: contents;
	}
	/*
	 * THE SHEET BEING UP IS WHAT REVEALS RESTART AND SKIP. The band renders the pair at all times and hides
	 * it (`.tp-side { display: none }`); this is the one rule that brings it back, so the collapsed bar keeps
	 * exactly the controls it always had and /components — five bands with no drawer — is untouched.
	 *
	 * IT REACHES INTO THE BAND ON PURPOSE, the same `:global()` composition as `.band-slot :global(.band)`
	 * above: the band is right in BOTH call sites and only the composition site can tell them apart.
	 *
	 * `display: grid` restores what `.btn` gives the pair (`place-items: center` comes with it from the
	 * band's own rule; only the `display` is overridden). It beats the band's `.btn.tp-side { display: none }`
	 * on specificity — three classes to two — rather than on source order, which is what that rule had to be
	 * compounded for in the first place (see its note there).
	 *
	 * A CSS REVEAL, NOT A PROP — see `sheetUp` for the measured reason: a prop of the band that changes
	 * after mount re-runs the size bindings, and a geometry read on the mount rung is a throw (XR-VER-03).
	 */
	.band-face:global(.sheet-up) :global(.tp-side) {
		display: grid;
	}
	/*
	 * THE REVEAL IS ANIMATED — the magnifier slides aside and the pair grows in behind it.
	 *
	 * KEYFRAMES, NOT A TRANSITION, and that is forced. The whole change is a LAYOUT one: `display: none` →
	 * `grid` widens the row, which moves the magnifier and the disc by reflow. Neither `display` nor a
	 * reflow is transitionable, and `width`/`gap`/`inset` are outside the composited allowlist
	 * motion.test.ts enforces (transform, opacity, background, color, box-shadow — nothing else). A
	 * keyframe can state the FROM position explicitly, so the layout jump happens instantly and the
	 * animation replays the distance each element just travelled, in `transform` only. That is a FLIP
	 * without the measuring step — the distances are `--tp-grow` and `--tp-disc-shift`, declared on
	 * `.strip` from `--tap` and `--space-md`, so nothing here reads geometry (XR-VER-03).
	 *
	 * GATED ON `no-preference`, which is how this file's other motion is suppressed: with Reduce Motion on,
	 * no `animation` is declared at all and the pair simply appears. Nothing to reset.
	 *
	 * ONE DIRECTION ONLY, stated rather than hidden: collapsing sets `display: none` on the same frame, so
	 * there is no element left to animate out. The sheet's own half-second slide is what the eye follows
	 * down, and it is going the other way anyway.
	 *
	 * The names are `-global-` prefixed because the selectors that use them are `:global()` — a scoped
	 * keyframe name would be rewritten for this component's own elements and these are the band's.
	 */
	@media (prefers-reduced-motion: no-preference) {
		.band-face:global(.sheet-up) :global(.btn:not(.tp-side)) {
			animation: tp-slide-aside 260ms cubic-bezier(0.32, 0.72, 0, 1) both;
		}
		.band-face:global(.sheet-up) :global(.disc) {
			animation: tp-disc-shift 260ms cubic-bezier(0.32, 0.72, 0, 1) both;
		}
		.band-face:global(.sheet-up) :global(.tp-side) {
			animation: tp-grow-in 260ms cubic-bezier(0.32, 0.72, 0, 1) both;
		}
	}
	/*
	 * The magnifier's whole journey: it starts where it sat with the pair hidden — `--tp-grow` to the RIGHT
	 * of where it has just landed — and travels to its new place.
	 */
	@keyframes -global-tp-slide-aside {
		from {
			transform: translateX(var(--tp-grow, 0));
		}
		to {
			transform: none;
		}
	}
	/* The disc moves less: only the restart that arrives on its left pushes it. */
	@keyframes -global-tp-disc-shift {
		from {
			transform: translateX(var(--tp-disc-shift, 0));
		}
		to {
			transform: none;
		}
	}
	/*
	 * The pair itself, growing out from under the disc rather than fading in place: `scale` is composited,
	 * and starting slightly right puts restart where the disc was a moment ago, which is what makes the two
	 * read as one movement instead of two.
	 */
	@keyframes -global-tp-grow-in {
		from {
			opacity: 0;
			transform: translateX(calc(var(--tp-disc-shift, 0) * -0.35)) scale(0.72);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
	/*
	 * THE COLLAPSE, which is the entry run backwards — and the reason it needs its own class rather than a
	 * reversed direction on the same one: `display: none` arrives on the same frame as the state change, so
	 * there would be nothing left to animate. `sheet-down` keeps the pair displayed (and therefore the row
	 * at its open width) while the transforms carry the magnifier and the disc to their collapsed positions;
	 * the class is removed after `TP_ANIM_MS` and the layout catches up with what is already on screen.
	 *
	 * `both` fill mode is what holds that end state for the handover. Without it the elements would snap
	 * back to `transform: none` — their OPEN positions — for the frame between the animation ending and the
	 * class dropping.
	 */
	.band-face:global(.sheet-down) :global(.tp-side) {
		display: grid;
	}
	@media (prefers-reduced-motion: no-preference) {
		.band-face:global(.sheet-down) :global(.btn:not(.tp-side)) {
			animation: tp-slide-back 260ms cubic-bezier(0.32, 0.72, 0, 1) both;
		}
		.band-face:global(.sheet-down) :global(.disc) {
			animation: tp-disc-back 260ms cubic-bezier(0.32, 0.72, 0, 1) both;
		}
		.band-face:global(.sheet-down) :global(.tp-side) {
			animation: tp-shrink-out 260ms cubic-bezier(0.32, 0.72, 0, 1) both;
		}
	}
	@keyframes -global-tp-slide-back {
		from {
			transform: none;
		}
		to {
			transform: translateX(var(--tp-grow, 0));
		}
	}
	@keyframes -global-tp-disc-back {
		from {
			transform: none;
		}
		to {
			transform: translateX(var(--tp-disc-shift, 0));
		}
	}
	@keyframes -global-tp-shrink-out {
		from {
			opacity: 1;
			transform: none;
		}
		to {
			opacity: 0;
			transform: translateX(calc(var(--tp-disc-shift, 0) * -0.35)) scale(0.72);
		}
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
	 * THE HEAD IS THE `···` AND NOTHING ELSE now the song identity lives only in the band row. Right-aligned
	 * in its own flex row, so the affordance sits where it always sat and the seek row below is unmoved.
	 *
	 * `.titlerow`, `.titlecol`, `.eyebrow`, `.singer-dot`, `.np-song` and `.np-byline` went with the markup
	 * they styled — six rules for a title column, a byline and a singer eyebrow that were each a second copy
	 * of something the band row states 40px higher. What they had learned and is worth keeping: the column
	 * needed `min-width: 0` so a two-line clamped title could not set a floor the flex row cannot go under,
	 * and the affordance needed `margin-right: -10px` to align optically with the column edge — which it
	 * still carries below, because that part is about the `···`, not about the text beside it.
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
