// Rendered-DOM guards for the phone now-playing surface and the queue rows around it.
//
// These MOUNT the components under the repo's happy-dom + compiled-Svelte harness (tests/setup/,
// wired by the root bunfig.toml) rather than scanning their source, because every claim below is
// about what RENDERS: whether the song is a heading, whether the progress row exists, whether a
// disclosure ended up between a singer and a control they need mid-song. XR-PH-21 is explicit that a
// measurement claim cannot be satisfied by a source scan, and this repo's own record is that the
// defects that shipped were invisible to a passing suite.
//
// ── RE-POINTED FROM `NowPlayingHero` TO `NowPlayingDrawer` ────────────────────────────────────────
//
// NowPlayingHero was DELETED. Its job moved into NowPlayingDrawer, a bottom drawer mounted in
// `+layout.svelte` as the expansion of the persistent now-playing band; home is queue-only now. This
// file imported the deleted component, so it FAILED TO LOAD and its 15 tests silently stopped
// running — a coverage hole, not a passing state. Every assertion below is the same assertion,
// re-pointed; the handful whose SUBJECT genuinely no longer exists were transformed to the assertion
// that now carries the same guarantee, and each of those says so at its site.
//
// ── ONE PERMANENTLY-MOUNTED SHEET, NOT TWO SURFACES: WHAT THAT CHANGED HERE ──────────────────────
//
// The persistent band and the drawer it expanded into were MERGED into one vaul drawer with snap
// points (`'80px'` = the band strip, `0.82` = pulled up), and `NowPlayingBand` is COMPOSED as the
// content's first child. Three consequences for this file, each handled at its site:
//
//   A. THERE IS NO CLOSED STATE. `open` defaults true and never changes, so `.np-drawer` is in the
//      document at all times and the harness's old `openOnMount: false` arm modelled nothing. The
//      guarantee it carried ("before the reveal, the control is not on screen") has no mount-rung
//      expression left; see the retirement comment on the collapsed arm below.
//   B. THE WHOLE BODY STAYS MOUNTED at either height — below the fold is not out of the tree. That is
//      asserted, not assumed, and it is what surfaced the duplicate "Nothing playing" the idle arm
//      pins: two elements in ONE dialog said the same thing, invisibly, to a screen reader.
//   C. IT NEEDS A `ResizeObserver` TO RENDER AT ALL, because `.band-slot` carries `bind:clientHeight`.
//      That one is lent for the duration of a mount rather than swallowed — see `withResizeObserver`
//      for why swallowing it leaves every query below running against an empty document.
//
// ── TWO THINGS THE DRAWER CHANGES ABOUT MOUNTING, AND HOW THIS FILE HANDLES THEM ──────────────────
//
// 1. IT PORTALS. vaul moves the content to the end of `document.body`, so the host element `mount()`
//    was given holds nothing. Every query therefore runs against the ONE `[data-slot="drawer-content"]`
//    element `openDrawer()` locates in the document — which also means a leaked portal from a previous
//    test reds (`openDrawer` asserts there is exactly one) instead of quietly satisfying a query.
//
// 2. IT MEASURES — INCIDENTALLY, AND NOT ON ANY PATH THIS FILE ASSERTS ABOUT. Opening the drawer
//    reaches two geometry reads the mount rung deliberately replaces with a throw (XR-VER-03,
//    tests/setup/svelte-dom-preload.ts):
//
//      - `document.documentElement.clientWidth`, from bits-ui's body-scroll-lock, which computes
//        scrollbar-width compensation when a modal dialog opens
//        (node_modules/bits-ui/dist/internal/body-scroll-lock.svelte.js:97, inside a `watch`). Fires
//        for EVERY open drawer, idle or playing.
//      - `offsetWidth`, from the Bits UI Slider inside GuidingTrack, which mounts whenever
//        `hasSong` is true.
//
//    Both fire AFTER the content tree is fully built — MEASURED: with the throw let through, the
//    rendered content carries the eyebrow, the title, the byline, the seek row, the transport, the
//    guiding track, the key row, the range bar and its axis labels, i.e. everything down to the last
//    element of the deepest child. So `openDrawer()` swallows that ONE class of error — matched on
//    the refusal's own message — and rethrows anything else.
//
//    THIS IS NOT FAKING GEOMETRY, and the distinction is the whole reason it is allowed here.
//    `hero-live-controls-835.test.ts` moved four arms to rung L rather than install a zero-returning
//    `offsetWidth` and a no-op `ResizeObserver`, because a fabricated measurement is a silent green.
//    Nothing is fabricated here: the refusal still throws, no zero is produced, and no assertion in
//    this file reads a geometry value. What is skipped is a dependency's scrollbar padding and the
//    slider thumb's pixel position — neither of which any claim below is about. Every claim that DOES
//    depend on the slider's own geometry stays on rung L, in
//    `tests/e2e/probes/p16-hero-live-controls.mjs`, and the last test in this file BOUNDS the swallowed
//    refusals by name, so a future edit that makes the drawer itself measure something new reds here
//    instead of being absorbed alongside the two known reads.
import { test, expect, afterEach } from 'bun:test';
import { read } from '@encore/test-support';
import { mount, unmount, flushSync } from '$setup/svelte-client';
import MyPositionCard from '$lib/components/MyPositionCard.svelte';
import QueueRow from '$lib/components/QueueRow.svelte';
import NowPlayingDrawerHarness from './phone-home-832.harness.svelte';
import { positionWords } from '$lib/phrasing/position-sentence';
import type { SongProfile } from '$lib/contract';

let live: Array<{ comp: unknown; host: HTMLElement }> = [];
afterEach(() => {
	// One lend around the whole loop, not one per unmount: `withResizeObserver` refuses to nest (it
	// asserts the global is absent on entry), and tearing a drawer down re-runs the same binding
	// cleanups the mount armed.
	withResizeObserver(() => {
		for (const { comp, host } of live) {
			// `void`: unmount returns a promise (it can await outro transitions) and nothing here has any, so
			// the teardown is synchronous in practice — but a floating promise is a lint error either way.
			// Wrapped because tearing the drawer down runs the same measuring effects (MEASURED: the portal
			// is removed either way, so a leaked portal still reds in the next test's `openDrawer`).
			swallowGeometryRefusal(() => void unmount(comp as never));
			host.remove();
		}
	});
	live = [];
});

function render<P extends Record<string, unknown>>(Comp: unknown, props: P): HTMLElement {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const comp = mount(Comp as never, { target: host, props });
	flushSync();
	live.push({ comp, host });
	return host;
}

// ── the mount rung's geometry refusal, let through rather than faked ─────────────────────────────

/** The preload's refusal message (XR-VER-03). Matched on, never suppressed globally. */
const GEOMETRY_REFUSAL = /^(\S+?)(?:\(\))? cannot measure on the MOUNT rung/;

/**
 * The OTHER shape the mount rung's refusal could take: an API it declines to install at all.
 *
 * DELIBERATELY NOT MATCHED HERE, and this note is why. The merged sheet needs a `ResizeObserver` to
 * render at all, and that arrives as a bare `ReferenceError` rather than as the preload's message. It
 * is NOT swallowed: swallowing it would leave every assertion below querying an empty document (see
 * `withResizeObserver` for the measurement). So the observer is lent for the duration of a mount and
 * this catch stays narrowed to the "cannot measure" refusal, meaning a `ReferenceError` reaching it —
 * from a genuinely missing global, or from the lend failing — still fails the test loudly.
 */

/**
 * Every geometry API refused while this file ran, in first-seen order.
 *
 * Recorded rather than discarded so the LAST test can assert the exact set. That assertion is what
 * keeps the swallow honest: a new measuring dependency inside the drawer would otherwise be absorbed
 * silently by the same catch that absorbs the known incidental reads.
 */
const refusedApis: string[] = [];

/**
 * Run `fn`, letting the mount rung's geometry refusals through and rethrowing everything else.
 *
 * The narrow match is the point. A component error, a missing module, a bad prop — anything that is
 * not one of the two refusal shapes above — still fails the test.
 */
function swallowGeometryRefusal(fn: () => void): void {
	try {
		fn();
	} catch (err) {
		const message = String((err as Error)?.message ?? err);
		const hit = GEOMETRY_REFUSAL.exec(message);
		if (!hit) throw err;
		if (!refusedApis.includes(hit[1]!)) refusedApis.push(hit[1]!);
	}
}

/**
 * The ONE notification API the mount rung has to be lent for this drawer to render at all.
 *
 * `ResizeObserver` is deliberately ABSENT from the preload, and `tests/guards/meta/mount-rung.test.ts`
 * has a named arm holding it absent: happy-dom ships one whose `observe()` is a no-op, so installing it
 * suite-wide would give `bind:clientHeight` a silent path to its initial value.
 *
 * WHY IT CANNOT SIMPLY BE SWALLOWED LIKE `offsetWidth`. The merged sheet's `.band-slot` carries
 * `bind:clientHeight` (it is what publishes `--dock-h`), and Svelte's size binding constructs a
 * `ResizeObserver` inside a RENDER effect. MEASURED: the resulting `ReferenceError` aborts the whole
 * effect flush before bits-ui's portal effect runs, so `Drawer.Content` never reaches the document and
 * the host is left holding eight empty anchors and nothing else. The geometry swallow works only
 * because those reads happen AFTER the tree is complete; this one happens instead of it.
 *
 * WHY LENDING IT FABRICATES NOTHING, which is the whole reason it is allowed. A `ResizeObserver` is a
 * NOTIFICATION API, not a measurement one. This stub notifies nobody, and all six geometry accessors
 * XR-VER-03 enumerates — `clientHeight` included — still throw, so there is no path to a fabricated
 * zero: `bandH` simply keeps the default `NowPlayingDrawer` declares for it, and NOTHING in this file
 * reads a bound size. That is the distinction `hero-live-controls-835.test.ts` drew when it refused a
 * zero-returning `offsetWidth`; a stub that measures nothing is not a stub that measures wrong.
 *
 * SCOPED, and self-policing. It is installed for the duration of one call and deleted in a `finally`,
 * and it asserts the global was ABSENT on entry — so a leak from this file or anywhere else reds here
 * rather than quietly making the suite's other mounts measurable. `mount-rung.test.ts`'s two claims
 * (the global is undefined; the preload never names it) both stay true.
 *
 * ONE HONEST RESIDUE, recorded rather than hidden: Svelte's size binding goes through a MODULE-LEVEL
 * `ResizeObserverSingleton` that caches its observer instance on first use
 * (`svelte/src/internal/client/dom/elements/bindings/size.js`). So the stub instance outlives this
 * helper inside Svelte's own module state for the rest of the process. It still notifies nobody and
 * still reads no geometry, so it cannot turn any measurement into a number — but a later file mounting
 * a `bind:clientHeight` component in the same run gets a constructed observer instead of a
 * `ReferenceError`, and the thing protecting it there is the `clientHeight` accessor's own throw.
 */
function withResizeObserver<T>(fn: () => T): T {
	const g = globalThis as Record<string, unknown>;
	expect(g.ResizeObserver, 'a ResizeObserver leaked into the global scope — see mount-rung.test.ts').toBeUndefined();
	g.ResizeObserver = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	};
	try {
		return fn();
	} finally {
		delete g.ResizeObserver;
	}
}

/*
 * ── PLACING THE SHEET, now that there is no open state ───────────────────────────────────────────
 *
 * vaul identifies a snap point by VALUE, not by index, so these are the literals `NowPlayingDrawer`'s
 * own `snapPoints` array carries. Duplicated here rather than imported because the component does not
 * export them, and a test that reached into the component for its expectation would be asserting the
 * component against itself.
 */
/** Snap 0 — collapsed, the band strip alone on screen. */
const SNAP_BAND = '80px';
/** Snap 1 — pulled up. */
const SNAP_OPEN = 0.82;

/**
 * Mount the drawer through its harness and return the ONE portalled content element.
 *
 * WAS `openDrawer` IN THE OPEN/CLOSED SENSE, AND IS NOT ANY MORE. The band and the drawer are one
 * permanently-mounted sheet with two snap points, so `open` defaults true, never changes, and there is
 * no transition to drive: mounting the harness IS opening. What `at` does is place the sheet at a
 * HEIGHT, which is the only distinction the component still makes — and, as the collapsed arm below
 * says at its own site, it changes nothing about which elements are mounted.
 *
 * Non-vacuous by construction: exactly one `[data-slot="drawer-content"]` must be in the document, so
 * a drawer that rendered nothing (or a portal leaked from a previous test) fails here rather than
 * letting every `querySelector` below return null and pass.
 */
function openDrawer(props: Record<string, unknown> = {}, at: number | string = SNAP_OPEN): HTMLElement {
	const host = document.createElement('div');
	document.body.appendChild(host);
	withResizeObserver(() => {
		const comp = mount(NowPlayingDrawerHarness as never, { target: host, props: { activeSnapPoint: at, ...props } });
		live.push({ comp, host });
		swallowGeometryRefusal(() => flushSync());
	});
	const found = document.querySelectorAll('[data-slot="drawer-content"]');
	expect(found.length, 'expected exactly one drawer in the document').toBe(1);
	return found[0] as HTMLElement;
}

/**
 * Tear the most recently mounted drawer down, so the next `openDrawer` has the document to itself.
 *
 * Several arms below mount twice in one test. `openDrawer` allows exactly one drawer in the document,
 * which is also what proves the first one really went away.
 */
function dropDrawer(): void {
	withResizeObserver(() => swallowGeometryRefusal(() => void unmount(live.pop()!.comp as never)));
}

/**
 * How many elements match — the shape every presence/absence claim about the drawer uses below.
 *
 * NOT `expect(root.querySelector(sel)).toBeNull()`, and that is a MEASURED choice rather than taste.
 * When such an assertion fails, bun formats the received value, and formatting a happy-dom element
 * walks its properties — including the six geometry accessors the preload replaced with a throw. On
 * the drawer's tree that took FIFTY-ONE SECONDS to print one red assertion in one mutation run, and
 * SIGABRTed the whole runner in two others: the mutation WAS detected, but the failure was
 * unreadable. A count formats as a number, so a red reads `Expected: 0 / Received: 1` at once.
 * Deliberately NOT applied to the QueueRow and MyPositionCard arms further down, which are unchanged
 * from before this file was re-pointed and mount far smaller trees.
 */
function count(root: ParentNode, selector: string): number {
	return root.querySelectorAll(selector).length;
}

/*
 * The playing fixture.
 *
 * `byline` is GONE as a prop — the drawer derives it from `artist` plus the song's own detected key —
 * so the fixture supplies a profile whose key spells `G major` (tonic 7, major, above the confidence
 * floor) and the old `'Queen Official · G major'` expectation is unchanged on screen. `hint`,
 * `controlsSummary` and `controlsNote` are gone for the same reason: the drawer owns that copy.
 */
const PROFILE: SongProfile = {
	keyTonic: 7, // G
	keyMode: 'major',
	keyConfidence: 0.82,
	lowMidi: 48, // C3
	highMidi: 72, // C5
	p05Midi: 55, // G3
	p95Midi: 67, // G4
	histogram: null,
	loudnessLufs: -11.2
};

const PLAYING = {
	title: 'Bohemian Rhapsody',
	artist: 'Queen Official',
	singerName: 'Maya',
	singerColor: '#33d6a6',
	profile: PROFILE,
	keyShiftEnabled: true,
	guideEnabled: true,
	guideServerPct: 20,
	elapsedSec: 30,
	durationSec: 120,
	isPlaying: true,
	hasSong: true
};

/** Nothing playing. The drawer supplies its own idle copy, so there is no `hint` to pass. */
const IDLE = { hasSong: false, title: null, artist: null, singerName: null };

// ── the drawer is a surface of its own, not a row ────────────────────────────────────────────────
test('the drawer renders the playing song as a heading, with the singer named', () => {
	const content = openDrawer(PLAYING);
	/*
	 * TRANSFORMED (subject moved, guarantee strengthened). Was `host.querySelector('h1')` — the hero
	 * was a page-level card and owned the page's heading. A drawer is a dialog, and its title is
	 * <Drawer.Title>: an element with `role="heading"` that the dialog ALSO points at through
	 * `aria-labelledby`, so it is both the heading and the surface's accessible name. Asserting the
	 * link rather than the tag is what a bare `h1` lookup could not say: a title rendered but not
	 * announced as the dialog's name would have passed the old check.
	 */
	const titleId = content.getAttribute('aria-labelledby');
	expect(titleId, 'the drawer names itself with no title element').toBeTruthy();
	const title = content.querySelector(`#${titleId}`) as HTMLElement | null;
	expect(title?.getAttribute('role')).toBe('heading');
	expect(title?.textContent).toBe('Bohemian Rhapsody');
	expect(content.textContent).toContain('Now singing · Maya');
	expect(content.textContent).toContain('Queen Official · G major');
	// A surface, not a list item: no seq bubble and no row geometry class. This is what "now-playing is
	// its own surface, NOT a row" means structurally — rebuilding it as a QueueRow-shaped element reds.
	expect(count(content, '.seq')).toBe(0);
	expect(count(content, '.qrow')).toBe(0);
	/*
	 * TRANSFORMED (subject renamed, same claim). Was `section.hero`. The surface is the vendored
	 * drawer content carrying this component's own `np-drawer` class, and it is a dialog — which is the
	 * stronger half, because a "drawer" that announced itself as nothing would be a different surface.
	 */
	expect(content.classList.contains('np-drawer')).toBe(true);
	expect(content.getAttribute('role')).toBe('dialog');
});

test('the drawer carries the singer identity colour on a dot that cannot collapse', () => {
	const content = openDrawer(PLAYING);
	// the primitive-adoption pass: the four byte-identical identity dots became app.css's shared
	// `.singer-dot`, which is where `flex: 0 0 auto` — the "cannot collapse" half of this claim — now
	// lives. The claim is unchanged, and the shared rule is what QueueRow and ProcessingCard already read.
	const dot = content.querySelector('.eyebrow .singer-dot') as HTMLElement | null;
	expect(count(content, '.eyebrow .singer-dot')).toBe(1);
	// The colour arrives as the custom property the rule reads, so a long name cannot silently drop it.
	expect(dot!.getAttribute('style')).toContain('#33d6a6');
});

test('an unknown song length hides the progress row rather than pinning a bar at zero', () => {
	// durationSec 0 is the real shape for a local file or an older catalog row.
	const unknown = openDrawer({ ...PLAYING, durationSec: 0 });
	expect(count(unknown, '.seekrow')).toBe(0);
	expect(count(unknown, '[role="progressbar"]')).toBe(0);

	// S6: the bar is <Progress> now — the same hand-rolled idiom lived in three components, and it
	// finally carries role="progressbar" with aria-valuenow. The claim is unchanged; the fill is found by
	// the vendored bar's data-slot rather than by `.track > i`.
	//
	// Two mounts in one test, so the first is torn down before the second opens — `openDrawer` allows
	// exactly one drawer in the document, which is also what proves the first one really went away.
	dropDrawer();
	const known = openDrawer(PLAYING);
	expect(count(known, '[role="progressbar"]')).toBe(1);
	const bar = known.querySelector('[role="progressbar"]') as HTMLElement;
	// 30s of 120s is a quarter. Written out, not computed with progressFraction — the same operation
	// the component performs cannot be the source of the expectation (an earlier change).
	expect(bar.getAttribute('aria-valuenow')).toBe('25');
	expect(count(bar, '[data-slot="progress-indicator"]')).toBe(1);
	const fill = bar.querySelector('[data-slot="progress-indicator"]') as HTMLElement;
	expect(fill.getAttribute('style')).toContain('translateX(-75%)');
	// A transform, not width: a width animation triggers layout every frame, which motion.test.ts forbids.
	expect(fill.getAttribute('style')).not.toContain('width:');
});

test('the transport is disabled when there is nothing for it to act on', () => {
	const btn = (root: HTMLElement, label: string) =>
		root.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;

	const empty = openDrawer(IDLE);
	expect(btn(empty, 'restart').disabled).toBe(true);
	expect(btn(empty, 'skip').disabled).toBe(true);
	expect(btn(empty, 'play/pause').disabled).toBe(true);

	// …but play stays live when a queue is waiting to start: "start when it is ready" is a real intent.
	dropDrawer();
	const waiting = openDrawer({ ...IDLE, canStart: true });
	expect(btn(waiting, 'play/pause').disabled).toBe(false);
	expect(btn(waiting, 'skip').disabled).toBe(true);

	dropDrawer();
	const playing = openDrawer(PLAYING);
	expect(btn(playing, 'restart').disabled).toBe(false);
	expect(btn(playing, 'skip').disabled).toBe(false);
});

/*
 * TRANSFORMED, AND BACK ON THIS RUNG. The claim used to be 'the live controls render in the
 * disclosure BODY, never in its summary (XR-PH-15)', and S5 moved it to
 * `tests/e2e/probes/p16-hero-live-controls.mjs` because the hero's disclosure was a Bits UI
 * Collapsible reading `getBoundingClientRect()` — so the hero could not be mounted here at all.
 *
 * The drawer has NO DISCLOSURE. Its live controls sit directly in the body, and the range visualizer
 * sits directly below the key row rather than behind a second disclosure of its own (ratified
 * 2026-09-14). So "the control is not in the toggle" has no toggle to be about; what survives it is
 * the stronger structural claim below — that no disclosure exists between a singer and a control they
 * need mid-song — plus the adjacency the ruling was about. p16 keeps the XR-PH-15 degradation arms,
 * which still need a real layout engine.
 */
test('no disclosure stands between the singer and the live controls', () => {
	const content = openDrawer(PLAYING);
	// The controls are on screen the moment the drawer is open — one reveal, not two.
	expect(count(content, '.tools-body'), 'the live controls did not render for a playing song').toBe(1);
	const body = content.querySelector('.tools-body') as HTMLElement;
	expect(count(body, '.gt'), 'no guiding track').toBe(1);
	expect(count(body, '.key'), 'no key row').toBe(1);
	expect(count(body, '.rangebar'), 'no range visualizer').toBe(1);
	// The hero's own disclosure class must not come back, and neither may any other disclosure idiom:
	// a Collapsible (Bits UI data-slot / data-attribute), or a native <details>/<summary>.
	for (const banned of [
		'.tools',
		'details',
		'summary',
		'[data-slot^="collapsible"]',
		'[data-collapsible-trigger]',
		'[data-collapsible-content]'
	]) {
		expect(count(content, banned), `a disclosure came back as ${banned}`).toBe(0);
	}
	// …and the range sits DIRECTLY below the key row, which is the adjacency the ruling is about: the
	// picture answers "can I sing this, in this key?" and the ± buttons are what it answers ABOUT.
	expect(String((content.querySelector('.key') as HTMLElement).nextElementSibling?.className)).toContain('range');
});

test('an idle room offers no "adjust while you sing" — there is nothing to adjust', () => {
	// Found by looking at a driven idle frame, not by a test: the disclosure rendered over an empty
	// stage. The controls are LIVE controls for the playing song, so `hasSong` gates them.
	// `.tools` -> `.tools-body`: same subject, the drawer's name for the live-controls block.
	const idle = openDrawer(IDLE);
	expect(count(idle, '.tools-body')).toBe(0);
	expect(count(idle, '.gt')).toBe(0);
	expect(idle.textContent).not.toContain('Adjust while you sing');
});

test('an idle drawer says "Nothing playing" exactly once', () => {
	// The eyebrow names WHO is singing; with nobody singing it printed "Nothing playing" directly above
	// the title saying the same thing. Also a frame finding.
	const idle = openDrawer(IDLE);
	expect(count(idle, '.eyebrow')).toBe(0);
	/*
	 * AND THE SECOND COPY WAS A REAL SOURCE DEFECT, not a stale expectation. This arm went red when the
	 * band and the drawer merged: the band row is the sheet's own first child now, so its `.title` and the
	 * head's `Drawer.Title` both sat in ONE dialog rendering the same three words. Nothing showed it twice
	 * on screen — the head is past the fold at the collapsed snap point — which is precisely why a
	 * rendered-DOM guard is what caught it: a screen reader reads the whole dialog and announced it twice.
	 *
	 * `NowPlayingDrawer` was fixed rather than this count relaxed: the head renders its title only when
	 * there IS a song, and the dialog keeps an accessible name from `aria-label` on the content when there
	 * is not. So the string has exactly one home — the band row, which is the collapsed face of the
	 * surface and the half a guest actually reads.
	 */
	expect((idle.textContent ?? '').match(/Nothing playing/g)?.length).toBe(1);
	// The band row is where it lives, and the head does not have one to repeat.
	expect(idle.querySelector('.band-slot .band .title')?.textContent).toBe('Nothing playing');
	expect(count(idle, '[data-slot="drawer-title"]')).toBe(0);
	// …and the surface is still NAMED, so the dedup did not trade a duplicate announcement for a dialog
	// with no announcement at all. `aria-labelledby` is absent because bits-ui only sets it once a Title
	// registers an id, which is what makes the `aria-label` the accessible name here.
	expect(idle.getAttribute('aria-labelledby')).toBeNull();
	expect(idle.getAttribute('aria-label')).toBe('Now playing');
	/*
	 * AND SAYS NOTHING ELSE. This used to assert the drawer contained "Queue a song to start the party"
	 * — a line that was three things at once: the state (already the title), an instruction (the
	 * magnifier is right there), and a bit of cheer. The copy is deliberately gone, so the arm asserts
	 * the decision instead of the string, which is the stronger claim: with nothing playing the drawer
	 * renders NO second line at all, so there is nowhere for filler to come back.
	 */
	expect(count(idle, '[data-slot="drawer-description"]')).toBe(0);
	expect(idle.textContent).not.toContain('start the party');
});

/*
 * RE-POINTED TWICE, AND THE SECOND TIME THE OLD SUBJECT GENUINELY CEASED TO EXIST. WHAT IT USED TO
 * PROTECT, AND WHY THAT THING IS GONE:
 *
 *   1. Originally: the hero's disclosure had a `controlsSummary` prop standing in for the controls
 *      while collapsed, and the guarantee was BEFORE THE REVEAL, THE CONTROL IS NOT ON SCREEN.
 *   2. Then: the prop and the summary went away, and the guarantee was re-anchored to the drawer's own
 *      two states — a CLOSED drawer rendered no content whatsoever, which is strictly stronger.
 *
 * There is no closed state left. The band and the drawer are ONE permanently-mounted sheet with snap
 * points, so `[data-slot="drawer-content"]` and every control inside it are in the document at all
 * times, and the old assertions (`count(document, '.tools-body')` is 0, the body does not contain
 * "Bohemian Rhapsody") are now FALSE rather than vacuous — they were deleted, not neutered.
 *
 * "The controls are not reachable while collapsed" therefore has no mount-rung expression at all: what
 * hides them is a transform offset on a full-height box, which is a LAYOUT-rung claim (XR-VER-01) and
 * lives in `tests/e2e/probes/`. Nothing here can substitute for it, and pretending otherwise is exactly
 * the green no-op this file refuses.
 *
 * What DOES survive, and is asserted instead, is the structural fact the change created and the whole
 * mechanism now rests on: the band row is COMPOSED as the sheet's first child, and the body below it
 * stays mounted at either snap point. That is load-bearing twice over — it is why the sheet can be
 * dragged between two heights at all (an outside element cannot hand vaul an in-flight pointer), and it
 * is why the drawer head may not restate what the band row says, since a screen reader reads both.
 */
test('the band row is the sheet itself, and the body stays mounted at the collapsed snap point', () => {
	const collapsed = openDrawer(PLAYING, SNAP_BAND);
	// COMPOSED, not absorbed: the band keeps its own component and its own `.band` surface, inside this
	// sheet's content. Re-inlining its markup here would take ~200 lines of CSS written against `.band`
	// with it, and /components would lose the five side-by-side band states.
	expect(count(collapsed, '.band-slot')).toBe(1);
	expect(count(collapsed, '.band-slot .band')).toBe(1);
	/*
	 * FIRST, AND THE ASSERTION IS ON THE POSITION RATHER THAN ON MERE PRESENCE. vaul sizes the content to
	 * the largest snap point and translates it DOWN, so what shows at snap 0 is the TOP of the content —
	 * the band row only equals the collapsed face while nothing of substance precedes it. Anything
	 * inserted above it silently becomes the collapsed face instead.
	 *
	 * "First of the CHILDREN THIS COMPONENT PASSES", not first element child: the vendored
	 * `drawer-content.svelte` renders vaul's real `Drawer.Handle` itself, ahead of `{@render children()}`,
	 * so the grab bar legitimately precedes the band row. Stated as a whitelist — the ONLY thing allowed
	 * above the band row is a drag handle — so a card, an alert or a second row landing there reds.
	 */
	const above = [...collapsed.children].slice(
		0,
		[...collapsed.children].indexOf(collapsed.querySelector('.band-slot')!)
	);
	expect(above.map((el) => el.getAttribute('data-slot') ?? el.tagName)).toEqual(['drawer-handle']);
	// …and the head and the body are BELOW it in document order rather than absent, which is the fact
	// that replaces "closed renders nothing". Below the fold is not out of the tree.
	const head = collapsed.querySelector('[data-slot="drawer-header"]') as HTMLElement | null;
	expect(head, 'the drawer head did not render').not.toBeNull();
	expect(
		collapsed.querySelector('.band-slot')!.compareDocumentPosition(head!) & Node.DOCUMENT_POSITION_FOLLOWING
	).toBeTruthy();
	expect(count(collapsed, '.tools-body')).toBe(1);
	expect(count(collapsed, 'button[aria-label="play/pause"]')).toBe(1);

	// SAME TREE AT EITHER HEIGHT. Asserted, not assumed: it is what makes every other arm in this file
	// free to mount at one snap point and say nothing about the other, and it is the premise of the
	// duplicate-copy finding the idle arm below pins.
	//
	// Compared as an element COUNT plus the rendered text, not as `innerHTML`. MEASURED: bits-ui and vaul
	// both mint per-instance ids (`bits-c53`, `vaul-svelte-43`), so two mounts of an identical tree never
	// produce equal markup — and a red on a 12 KB string is unreadable, the same hazard `count()` below
	// exists to avoid.
	const census = (el: HTMLElement) => ({ elements: el.querySelectorAll('*').length, text: el.textContent });
	const atBand = census(collapsed);
	expect(atBand.elements, 'the collapsed sheet rendered almost nothing').toBeGreaterThan(50);
	dropDrawer();
	expect(census(openDrawer(PLAYING, SNAP_OPEN))).toEqual(atBand);
});

/*
 * NEW, AND CARRYING THE OLD HARNESS'S REASON FOR EXISTING.
 *
 * The old harness passed a `{#snippet controls()}` block containing a range input, because the hero
 * took its live controls as a SNIPPET and XR-PH-15's constraint was about where a range input may
 * live. The drawer takes props instead and renders those controls itself — so the thing that used to
 * need a harness-supplied snippet is now the drawer's own output, and this asserts it: with candidates
 * handed in and no snippet anywhere, lyrics re-selection renders inside the live-controls body.
 */
test('the drawer renders lyrics re-selection itself, from props, with no snippet supplied', () => {
	const content = openDrawer({
		...PLAYING,
		candidates: [
			{ ref: 'a', textSource: 'lrclib', timing: 'word', textConfidence: 'high' },
			{ ref: 'b', textSource: 'asr', timing: 'line', textConfidence: 'low' }
		],
		chosenRef: 'a'
	});
	const body = content.querySelector('.tools-body') as HTMLElement | null;
	expect(count(content, '.tools-body')).toBe(1);
	expect(count(body!, '.reselect'), 'lyrics re-selection did not render').toBe(1);
	// An idle room has no song whose lyrics could be wrong, so it gets no re-selection either.
	dropDrawer();
	expect(count(openDrawer(IDLE), '.reselect')).toBe(0);
});

// ── the position card, and its honest degradation ────────────────────────────────────────────────
test('the position card states the ordinal, who you follow, and the wait (XR-PH-09)', () => {
	const host = render(MyPositionCard, {
		words: positionWords({ place: 3, beforeName: 'Sam', nowRemainingSec: 120, aheadDurationsSec: [200, 341] })
	});
	expect(host.querySelector('.big')?.textContent).toBe('3rd');
	expect(host.textContent).toContain("You're up after Sam.");
	expect(host.textContent).toContain('Roughly 11 minutes.');
	// The ordinal is a bare number on screen, so the card names itself for a screen reader.
	expect(host.querySelector('section')?.getAttribute('aria-label')).toBe('Your place in the queue');
});

test('an unknown wait renders NO minutes clause — not a zero, not a guess (XR-PH-09)', () => {
	const host = render(MyPositionCard, {
		words: positionWords({ place: 3, beforeName: 'Sam', nowRemainingSec: 120, aheadDurationsSec: [200, null] })
	});
	// The ordinal and the "after whom" half survive…
	expect(host.querySelector('.big')?.textContent).toBe('3rd');
	expect(host.textContent).toContain("You're up after Sam.");
	// …and the wait is ABSENT from the DOM, not an empty element holding a gap open.
	expect(host.querySelector('.wait')).toBeNull();
	const text = host.textContent ?? '';
	expect(text.toLowerCase()).not.toContain('roughly');
	expect(text.toLowerCase()).not.toContain('minute');
	expect(text).not.toContain('NaN');
	expect(text).not.toContain('null');
});

test('the card de-emphasises the wait with a token, never with subtree opacity (XR-PH-03)', () => {
	const host = render(MyPositionCard, {
		words: positionWords({ place: 2, beforeName: 'Maya', nowRemainingSec: 60, aheadDurationsSec: [] })
	});
	const wait = host.querySelector('.wait') as HTMLElement;
	expect(wait.textContent).toBe('Roughly 1 minute.');
	// happy-dom applies no stylesheet, so the assertion that bites is the absence of an INLINE opacity
	// on the rendered subtree; the stylesheet half is contrast.test.ts's tree-walk.
	for (const el of [host.querySelector('section')!, wait]) {
		expect(el.getAttribute('style') ?? '').not.toContain('opacity');
	}
});

test('a guest with nothing queued gets no card at all', () => {
	const host = render(MyPositionCard, { words: null });
	expect(host.querySelector('section')).toBeNull();
	expect((host.textContent ?? '').trim()).toBe('');
});

// ── the unconfirmed marker says which mutation it is waiting on (XR-PH-10) ───────────────────────
const ROW = {
	seq: 3,
	title: 'Wonderwall',
	singerName: 'You',
	singerColor: '#5cb8ff',
	mine: true,
	removable: true,
	reorderable: true,
	canUp: true,
	canDown: true
};

test('a pending REORDER says "moving…", never "adding…" (XR-PH-10)', () => {
	const moving = render(QueueRow, { ...ROW, pending: 'move' });
	expect(moving.textContent).toContain('moving…');
	expect(moving.textContent).not.toContain('adding…');

	// The add path is unchanged — this is a NEW state, not a renamed one.
	const adding = render(QueueRow, { ...ROW, pending: 'add' });
	expect(adding.textContent).toContain('adding…');
	expect(adding.textContent).not.toContain('moving…');

	// A confirmed row says neither.
	const settled = render(QueueRow, { ...ROW, pending: null });
	expect(settled.querySelector('.adding')).toBeNull();
});

test('a row awaiting confirmation makes its own reorder controls inert (XR-PH-10)', () => {
	// "…and its reorder controls are inert" is part of the requirement: a second tap on a move that has
	// not landed would issue a second op against a position the server has not agreed to yet.
	const moving = render(QueueRow, { ...ROW, pending: 'move' });
	expect(moving.querySelector('button[aria-label="move up"]')).toBeNull();
	expect(moving.querySelector('button[aria-label="move down"]')).toBeNull();
	expect(moving.querySelector('button[aria-label="remove from queue"]')).toBeNull();

	// …and they are present once confirmed, so the assertion above is about the pending state and not
	// about the props never rendering controls at all.
	const settled = render(QueueRow, { ...ROW, pending: null });
	expect(settled.querySelector('button[aria-label="move up"]')).not.toBeNull();
	expect(settled.querySelector('button[aria-label="move down"]')).not.toBeNull();
});

test('the pending state is signalled on the row SURFACE, not by dimming its subtree (XR-PH-03)', () => {
	const moving = render(QueueRow, { ...ROW, pending: 'move' });
	const root = moving.querySelector('.qrow') as HTMLElement;
	expect(root.className).toContain('pending');
	// happy-dom applies no stylesheet, so what bites here is an INLINE opacity on the rendered subtree;
	// the stylesheet half is contrast.test.ts's "no card root dims its own subtree with opacity".
	expect(root.getAttribute('style') ?? '').not.toContain('opacity');
});

// ── the gallery is where these states get looked at ──────────────────────────────────────────────
test('the gallery carries the drawer and BOTH position branches, adjacent', () => {
	/*
	 * A fixture's absence is invisible to every runtime assertion in the suite, which is exactly how
	 * two earlier `pending` rules shipped unreadable: nothing ever rendered them, so nobody measured
	 * them. Same closure as that guard — scan the real gallery source.
	 *
	 * The PAIR is the point for the position card: "no minutes clause" is only judgeable against the
	 * clause it replaces, so a gallery with only the happy branch cannot show the degradation at all.
	 */
	const gallery = read('src/routes/components/+page.svelte');
	expect(gallery).toContain('<NowPlayingDrawer');
	expect(gallery).toContain('<MyPositionCard');
	// The imports too, separately: dropping one breaks `build` and leaves `bun test` green, so without
	// this the fixtures could be orphaned by a tidy-up that no named test objects to.
	expect(gallery).toMatch(/import NowPlayingDrawer from '\$lib\/components\/NowPlayingDrawer\.svelte';/);
	expect(gallery).toMatch(/import MyPositionCard from '\$lib\/components\/MyPositionCard\.svelte';/);
	expect(gallery).toMatch(/import \{ positionWords \} from '\$lib\/phrasing\/position-sentence';/);
	/*
	 * TRANSFORMED (fixture shape changed, claim unchanged). Was `<NowPlayingHero title="Nothing
	 * playing"`: five hero cards could sit side by side, so the idle state was its own inline fixture.
	 * A drawer is portalled and fixed to the viewport, so two open at once occupy the same 82dvh and a
	 * stack of them would show one frame with the rest invisible underneath. The gallery therefore
	 * drives ONE drawer through a `drawerHasSong` state and a trigger per state — so what has to be
	 * pinned is that the idle arm is still REACHABLE, which is the same guarantee (XR-PH-08: the empty
	 * state is a designed state, not an accident of no data).
	 */
	expect(gallery).toMatch(/drawerHasSong = false;/);
	expect(gallery).toMatch(/hasSong=\{drawerHasSong\}/);

	const cards = [...gallery.matchAll(/<MyPositionCard[\s\S]*?\/>/g)].map((m) => m[0]);
	expect(cards.length).toBeGreaterThanOrEqual(2);
	// one branch where every duration ahead is known…
	expect(cards.some((c) => /aheadDurationsSec: \[\d+, \d+\]/.test(c))).toBe(true);
	// …and one where an entry ahead has none, which is the honest-degradation arm.
	expect(cards.some((c) => /aheadDurationsSec: \[[^\]]*null[^\]]*\]/.test(c))).toBe(true);
});

// ── the swallow stays honest ─────────────────────────────────────────────────────────────────────
test('nothing beyond the KNOWN incidental geometry reads was swallowed (XR-VER-03)', () => {
	/*
	 * `openDrawer` lets the mount rung's geometry refusal through so the rendered content can be
	 * asserted at all. That catch is narrow — anything that is not the refusal rethrows — but it would
	 * still absorb a NEW measuring dependency, and a component that started measuring its own layout
	 * belongs on rung L rather than here (XR-VER-02). So the swallowed names are bounded.
	 *
	 * Every known entry is a read on a path this file asserts nothing about:
	 *   offsetWidth  — the Bits UI Slider inside GuidingTrack, which mounts whenever hasSong is true.
	 *   clientHeight — Svelte's own `bind:clientHeight` on `.band-slot`, the drawer's `--dock-h` source.
	 *   clientWidth  — bits-ui body-scroll-lock's scrollbar-width compensation, on
	 *                  document.documentElement, when a MODAL dialog opens.
	 *
	 * `clientHeight` IS THE NEW ONE, AND IT IS THE PROOF THAT LENDING A `ResizeObserver` FABRICATES
	 * NOTHING. `withResizeObserver` hands the sheet a notifier so its portal effect can run; the
	 * MEASUREMENT it would notify about still refuses, right here, by name. So `bandH` never receives a
	 * number on this rung — it keeps the default the component declares — and nothing in this file reads
	 * a bound size. Its real value is measured on rung L.
	 *
	 * A SUBSET, plus two required members, rather than an exact set — and that asymmetry is MEASURED,
	 * not a hedge. `offsetWidth` and `clientHeight` are deterministic: this file always mounts a playing
	 * drawer, so the Slider always mounts, and `.band-slot` is unconditional. `clientWidth` is NOT:
	 * bits-ui's lock bookkeeping is module-global, so whether the scrollbar computation runs here depends
	 * on whether an earlier FILE in the same process already locked the body — and this drawer is
	 * `modal={false}`, so it does not lock it itself and the read has stopped appearing at all. Left in
	 * `known` rather than deleted: a suite-order change that reintroduces it is not a defect in the
	 * drawer, and this arm exists to catch NEW measuring, not to pin the run scope.
	 *
	 * If this reds with a name not listed above, do not add it here reflexively: read what measures, and
	 * decide whether the claim that depends on it has to move to `tests/e2e/probes/`.
	 */
	const known = ['clientWidth', 'offsetWidth', 'clientHeight'];
	expect(refusedApis.filter((api) => !known.includes(api))).toEqual([]);
	// Non-vacuity: the swallow really did fire, so this arm is not passing because nothing was caught.
	expect(refusedApis).toContain('offsetWidth');
	expect(refusedApis).toContain('clientHeight');
});
