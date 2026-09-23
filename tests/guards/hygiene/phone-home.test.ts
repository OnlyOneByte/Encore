// Rendered-DOM guards for the phone now-playing surface and the queue rows around it.
//
// These MOUNT the components under the repo's happy-dom + compiled-Svelte harness rather than scanning their
// source, because every claim below is about what RENDERS: whether the song is a heading, whether the progress row
// exists, whether a disclosure ended up between a singer and a control they need mid-song. A measurement claim
// cannot be satisfied by a source scan, and this repo's record is that the defects which shipped were invisible to
// a passing suite.
//
// ── ONE PERMANENTLY-MOUNTED SHEET, NOT TWO SURFACES ──────────────────────────────────────────────
//
// The band and the drawer it expanded into are one vaul drawer with snap points (`'80px'` = the band strip, a
// clamped fraction at most `0.82` = pulled up), with `NowPlayingBand` composed as the content's first child. Three
// consequences, each handled at its site:
//
//   A. THERE IS NO CLOSED STATE. `open` defaults true and never changes, so `.np-drawer` is in the document at all
//      times and the old `openOnMount: false` arm modelled nothing.
//   B. THE WHOLE BODY STAYS MOUNTED at either height — below the fold is not out of the tree. Asserted rather than
//      assumed, and it is what surfaced the duplicate "Nothing playing" the idle arm pins: two elements in ONE
//      dialog saying the same thing, invisibly, to a screen reader.
//   C. IT NEEDS A `ResizeObserver` TO RENDER AT ALL, because `.band-slot` carries `bind:clientHeight`. That one is
//      LENT for the duration of a mount rather than swallowed — see `withResizeObserver`.
//
// ── TWO THINGS THE DRAWER CHANGES ABOUT MOUNTING ─────────────────────────────────────────────────
//
// 1. IT PORTALS. vaul moves the content to the end of `document.body`, so the host `mount()` was given holds
//    nothing. Every query runs against the one `[data-slot="drawer-content"]` element `openDrawer()` locates —
//    which also means a leaked portal from a previous test reds (it asserts there is exactly one) rather than
//    quietly satisfying a query.
//
// 2. IT MEASURES, incidentally, on no path this file asserts about: bits-ui's body-scroll-lock reads
//    `documentElement.clientWidth`, and the Bits UI Slider inside GuidingTrack reads `offsetWidth`. Both fire AFTER
//    the content tree is fully built — measured, with the throw let through, the rendered content carries
//    everything down to the deepest child — so `openDrawer()` swallows that ONE class of error, matched on the
//    refusal's own message, and rethrows anything else.
//
//    THAT IS NOT FAKING GEOMETRY, which is why it is allowed: the refusal still throws, no zero is produced, and no
//    assertion here reads a geometry value. Claims that DO depend on the slider's geometry stay on rung L, and the
//    last test in this file BOUNDS the swallowed refusals by name — so a future edit that makes the drawer measure
//    something new reds here instead of being absorbed alongside the two known reads.
import { test, expect, afterEach } from 'bun:test';
import { read } from '@encore/test-support';
import { mount, unmount, flushSync } from '$setup/svelte-client';
import QueueRow from '$lib/components/QueueRow.svelte';
import NowPlayingDrawerHarness from './phone-home.harness.svelte';
import { waitShort } from '$lib/phrasing/position-sentence';
import { SNAP_BAND as SHEET_SNAP_BAND } from '$lib/sheet-snap';
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

/** The preload's refusal message. Matched on, never suppressed globally. */
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
 * `ResizeObserver` is deliberately ABSENT from the preload, and `mount-rung.test.ts` holds it absent: happy-dom
 * ships one whose `observe()` is a no-op, so installing it suite-wide would give `bind:clientHeight` a silent path
 * to its initial value.
 *
 * WHY IT CANNOT BE SWALLOWED LIKE `offsetWidth`: `.band-slot` carries `bind:clientHeight`, and Svelte's size
 * binding constructs the observer inside a RENDER effect — so the `ReferenceError` aborts the whole effect flush
 * before bits-ui's portal effect runs, and `Drawer.Content` never reaches the document. The geometry swallow works
 * only because those reads happen AFTER the tree is complete; this one happens instead of it.
 *
 * LENDING IT FABRICATES NOTHING, which is why it is allowed: a ResizeObserver is a NOTIFICATION API, not a
 * measurement one. This stub notifies nobody and every geometry accessor still throws, so there is no path to a
 * fabricated zero — `bandH` keeps its declared default and nothing here reads a bound size.
 *
 * SCOPED and self-policing: installed for one call, deleted in a `finally`, and it asserts the global was ABSENT on
 * entry, so a leak reds here rather than quietly making other mounts measurable.
 *
 * ONE HONEST RESIDUE: Svelte's size binding goes through a module-level singleton that caches its observer on first
 * use, so the stub instance outlives this helper inside Svelte's module state for the rest of the process. It still
 * measures nothing; what protects a later file is the `clientHeight` accessor's own throw.
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
 * vaul identifies a snap point by VALUE, not by index, so these are the values `NowPlayingDrawer`'s own
 * `snapPoints` array carries. Duplicated here rather than imported because the component does not
 * export them, and a test that reached into the component for its expectation would be asserting the
 * component against itself.
 *
 * SNAP 1 IS NO LONGER A LITERAL, and this comment used to say it was. It is now
 * `min(0.82, (vh - 176) / vh)` — the clamp that stops a pulled-up sheet covering the page's own
 * top-of-page controls on a short window — so `0.82` is its CEILING rather than its value, reached on
 * any window taller than ~977px. That is exactly what this file needs and no more: the claim every arm
 * below makes is that the mounted DOM does not vary with the snap point AT ALL, so `at` is a placement
 * argument whose job is to be a plausible snap-1 value, not to be the one this viewport would compute.
 * An arm that depended on the number would belong on the layout rung with the transform offsets.
 */
/*
 * Snap 0 — collapsed, the band strip alone on screen. Still a true constant; see the component.
 *
 * IMPORTED RATHER THAN RESTATED (2026-09-21). It was a local `'80px'`, and the band grew to 88 to make room
 * above the header content — which left this file seating a value that is not IN the snapPoints array the
 * drawer builds from `$lib/sheet-snap`. vaul looks the active point up by strict string equality, so a
 * stale copy here is an index of -1: no snap, silently, in the one harness that exists to place the sheet.
 * Nothing red, because no arm in this file depends on the number. One fact, one home.
 */
const SNAP_BAND = SHEET_SNAP_BAND;
/** Snap 1 — pulled up. The clamp's ceiling, which is its value on a tall window. */
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
 * Deliberately NOT applied to the QueueRow arms further down, which are unchanged
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
test('the drawer names the song ONCE, in the band row, and names itself by label', () => {
	const content = openDrawer(PLAYING);
	/*
	 * TRANSFORMED TWICE, and the second time the claim inverted — so the old form is recorded here rather
	 * than just replaced.
	 *
	 * It began as `host.querySelector('h1')`: the hero was a page-level card and owned the page's heading.
	 * It became "the head's `Drawer.Title` is the dialog's `aria-labelledby` target", which was stronger —
	 * a title rendered but not announced as the name would have passed the `h1` lookup.
	 *
	 * The head no longer renders a Title (2026-09-21). With the sheet open it carried THREE second copies
	 * of the band row, stacked 40px below it: an eyebrow ("Now singing · Maya") against the band's byline
	 * ("Maya is singing · Queen Official"), the Title against the band's `.title`, and a Description
	 * ("Queen Official · G major") whose artist is in that byline and whose key is stated again above the ±
	 * keycaps. Reported on sight as the now playing/now singing being duplicated.
	 *
	 * WHAT IS ASSERTED NOW IS THE COUNT, because "the song is named" was never the thing at risk — being
	 * named twice was. The band row is the copy that survives: it is on screen at BOTH snap points, so the
	 * identity never moves or disappears, and it is the collapsed face of this surface.
	 */
	expect(content.textContent).toContain('Bohemian Rhapsody');
	const titles = [...content.querySelectorAll('.band .title')];
	expect(titles.length, 'the band row must name the song exactly once').toBe(1);
	expect(titles[0].textContent).toBe('Bohemian Rhapsody');
	// …and nowhere else in the dialog. A screen reader reads the whole tree, so a second copy below the fold
	// is heard even when nothing on screen shows it twice — which is how the idle "Nothing playing" duplicate
	// (pinned by its own arm below) was found.
	const occurrences = (content.textContent ?? '').split('Bohemian Rhapsody').length - 1;
	expect(occurrences, 'the song title must appear once in the whole dialog').toBe(1);
	// The singer, likewise once: the head's eyebrow said it a second way ("Now singing · Maya").
	expect(content.textContent).toContain('Maya is singing');
	expect(content.textContent).not.toContain('Now singing');

	/*
	 * THE DIALOG IS NAMED BY `aria-label`, AT EVERY STATE. bits-ui sets `aria-labelledby` only once a
	 * `Drawer.Title` mounts and registers its id (`dialog.svelte.js:207`); with no Title the attribute is
	 * absent and the label wins the accessible-name cascade. Both halves are asserted, because the failure
	 * mode is a dialog that announces itself as nothing at all.
	 */
	expect(content.getAttribute('aria-labelledby'), 'no Title should register an id now').toBeNull();
	expect(content.getAttribute('aria-label')).toBe('Now playing');

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
	/*
	 * the primitive-adoption pass: the four byte-identical identity dots became app.css's shared
	 * `.singer-dot`, which is where `flex: 0 0 auto` — the "cannot collapse" half of this claim — lives.
	 *
	 * RE-POINTED AT THE BAND'S DOT (2026-09-21). The subject was `.eyebrow .singer-dot` in the drawer HEAD,
	 * and that eyebrow is deleted: it stated the singer a second way ("Now singing · Maya") 40px under the
	 * band row's byline ("Maya is singing · Queen Official"). The claim is unchanged and its subject is the
	 * band's own dot, which carries the same colour through the same custom property and cannot collapse for
	 * the same reason — `flex: 0 0 var(--space-md)` in NowPlayingBand, the rule the byline row depends on.
	 * There is exactly ONE dot in this dialog now, which is the point of the deletion.
	 */
	const dot = content.querySelector('.band .byline .dot') as HTMLElement | null;
	expect(count(content, '.band .byline .dot')).toBe(1);
	expect(count(content, '.eyebrow'), 'the head must not state the singer a second way').toBe(0);
	// The colour arrives as the custom property the rule reads, so a long name cannot silently drop it.
	expect(dot!.getAttribute('style')).toContain('#33d6a6');
});

test('an unknown song length hides the progress row rather than pinning a bar at zero', () => {
	// durationSec 0 is the real shape for a local file or an older catalog row.
	const unknown = openDrawer({ ...PLAYING, durationSec: 0 });
	expect(count(unknown, '.seekrow')).toBe(0);
	expect(count(unknown, '[role="progressbar"]')).toBe(0);

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
	/*
	 * ONE PLAY/PAUSE, AND IT IS THE BAND'S DISC — with restart and skip now BESIDE it in the same row
	 * (2026-09-21) rather than in a row of their own in the sheet's body.
	 *
	 * Three arrangements preceded this and each was reported on sight: the pair alone in a body row with
	 * play/pause only on the disc (one transport split across two rows and two corners); that row given its
	 * own play/pause (two identical play buttons ~100px apart); the disc hidden at snap 1 to fix that (a
	 * nearly-empty band row above a group floating mid-body). The pair moved up to the disc instead.
	 *
	 * THE DISC IS ADDRESSED BY CLASS because its accessible name alternates ("Play" / "Pause"); restart and
	 * skip are addressed by their fixed labels, which is what the e2e drives them by too.
	 *
	 * `canStart` LIVES ON THE DISC and nothing else, which is the substantive claim here: it is the "a queue
	 * exists but nothing is current, press to start" case, and it is the thing a future rearrangement would
	 * quietly drop — the first version of the body row did exactly that.
	 */
	const disc = (root: HTMLElement) => root.querySelector('.disc') as HTMLButtonElement;
	// No second play/pause anywhere in the tree. The COUNT is the assertion rather than the absence of some
	// particular label: two of the three earlier arrangements shipped a duplicate, under two different
	// labels, and a guard written against either literal would have passed through the other.
	const plays = (root: HTMLElement) => root.querySelectorAll('button[aria-label="Play"], button[aria-label="Pause"]');

	const empty = openDrawer(IDLE);
	expect(btn(empty, 'Restart').disabled).toBe(true);
	expect(btn(empty, 'skip').disabled).toBe(true);
	expect(disc(empty).disabled).toBe(true);
	expect(plays(empty).length, 'the app must carry exactly one play/pause').toBe(1);

	// …but play stays live when a queue is waiting to start: "start when it is ready" is a real intent.
	dropDrawer();
	const waiting = openDrawer({ ...IDLE, canStart: true });
	expect(disc(waiting).disabled).toBe(false);
	expect(btn(waiting, 'skip').disabled).toBe(true);

	dropDrawer();
	const playing = openDrawer(PLAYING);
	expect(btn(playing, 'Restart').disabled).toBe(false);
	expect(btn(playing, 'skip').disabled).toBe(false);
	expect(disc(playing).disabled).toBe(false);
	expect(plays(playing).length).toBe(1);
	// The mark follows the state, so the disc cannot be left drawing "play" over a playing song.
	expect(disc(playing).getAttribute('aria-label')).toBe('Pause');
});

/*
 * TRANSFORMED, AND BACK ON THIS RUNG. The claim used to be 'the live controls render in the
 * disclosure BODY, never in its summary', and S5 moved it to
 * `tests/e2e/probes/p16-hero-live-controls.mjs` because the hero's disclosure was a Bits UI
 * Collapsible reading `getBoundingClientRect()` — so the hero could not be mounted here at all.
 *
 * The drawer has NO DISCLOSURE. Its live controls sit directly in the body, and the range visualizer
 * sits directly below the key row rather than behind a second disclosure of its own (ratified
 * 2026-09-14). So "the control is not in the toggle" has no toggle to be about; what survives it is
 * the stronger structural claim below — that no disclosure exists between a singer and a control they
 * need mid-song — plus the adjacency the ruling was about. p16 keeps the degradation arms,
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
 * hides them is a transform offset on a full-height box, which is a LAYOUT-rung claim and
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
	/*
	 * NOTHING is above the band row now, which satisfies this whitelist more strictly than the old
	 * `['drawer-handle']` did. The vendored `drawer-content.svelte` used to render its own grab bar at
	 * the top of the content box, and composing the band into the sheet added a second one inside
	 * `.band-slot` — two lines, stacked, visible on sight. The vendored one was removed, so the handle
	 * a thumb actually reaches now lives INSIDE the band row rather than above it. The rule this arm
	 * exists for is unchanged: a card, an alert or a second row landing above the band row still reds.
	 */
	expect(above.map((el) => el.getAttribute('data-slot') ?? el.tagName)).toEqual([]);
	// …and the handle is still present, one level down, so "nothing above" is not "no handle at all".
	expect(collapsed.querySelectorAll('[data-slot="drawer-handle"]').length).toBe(1);
	// …and the head and the body are BELOW it in document order rather than absent, which is the fact
	// that replaces "closed renders nothing". Below the fold is not out of the tree.
	const head = collapsed.querySelector('[data-slot="drawer-header"]') as HTMLElement | null;
	expect(head, 'the drawer head did not render').not.toBeNull();
	expect(
		collapsed.querySelector('.band-slot')!.compareDocumentPosition(head!) & Node.DOCUMENT_POSITION_FOLLOWING
	).toBeTruthy();
	expect(count(collapsed, '.tools-body')).toBe(1);
	/*
	 * ONE PLAY/PAUSE IN THE WHOLE TREE, AND THE TRANSPORT IS IN THE BAND ROW WITH IT (2026-09-21).
	 *
	 * The count is the assertion rather than the absence of some particular label, because this row has now
	 * held three arrangements and two of them shipped a second play/pause — one under
	 * `aria-label="play/pause"` (deleted), one under the same alternating expression as the disc. A guard
	 * written against either literal would have gone on passing through the other.
	 *
	 * RESTART AND SKIP ARE IN THE TREE AT BOTH HEIGHTS, hidden at the collapsed one by CSS rather than by a
	 * branch — which is what keeps the census arm below true, and is why they are counted here at snap 0
	 * where they are mounted but not visible. Visibility is a LAYOUT claim and belongs to `gate:measured`;
	 * presence is what this rung can honestly say.
	 */
	expect(
		collapsed.querySelectorAll('button[aria-label="Play"], button[aria-label="Pause"]').length,
		'expected exactly one play/pause in the app'
	).toBe(1);
	expect(count(collapsed, '.disc')).toBe(1);
	// restart + skip, beside the disc, addressed by STRUCTURE: the group holds the disc and these two, so a
	// `.btn` inside it IS one of the pair. It was `.tp .tp-side` until that class went with the retired
	// reveal (2026-09-22) — a class with no rule behind it cannot stay in the markup, and the pair needs no
	// rule of its own now that it is never hidden.
	expect(count(collapsed, '.tp .btn')).toBe(2);
	expect(count(collapsed, '.transport'), 'the body transport row is gone — the pair is in the band row').toBe(0);

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
 * took its live controls as a SNIPPET and the constraint was about where a range input may
 * live. The drawer takes props instead and renders those controls itself — so the thing that used to
 * need a harness-supplied snippet is now the drawer's own output, and this asserts it: with candidates
 * handed in and no snippet anywhere, lyrics re-selection renders inside the live-controls body.
 */
test('the drawer NAMES the lyrics source and does not re-pick it', () => {
	/*
	 * INVERTED (2026-09-21). This asserted that the sheet renders `<LyricsReselect>` itself, from props,
	 * with no snippet supplied — which was the right claim while the sheet owned that control.
	 *
	 * It does not any more, and it is a deletion rather than a move: `/song/[mediaId]` already renders the
	 * same component under its own "Lyrics" heading, and the `···` on the seek row is the door to it, so the
	 * sheet's copy was the second one. Re-picking lyrics is a decision made ONCE about a song, sitting
	 * still; the sheet is what a singer reaches for mid-performance, and a disclosure inside it was a second
	 * level of revealing inside the one this sheet is supposed to be.
	 *
	 * WHAT SURVIVES IS THE FACT: which source the words on the TV came from, as a pill. So the arm asserts
	 * the provenance is STATED and the control is ABSENT — either half alone would pass a sheet that had
	 * quietly lost the information along with the disclosure.
	 */
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
	expect(count(body!, '.reselect'), 'the sheet must not carry the re-selection control').toBe(0);
	expect(count(body!, '.lyricsrc .encore-chip'), 'the lyrics source pill did not render').toBe(1);
	expect(body!.querySelector('.lyricsrc')?.textContent?.trim()).toBe('Synced lyrics');

	/*
	 * THE OVERRIDE WINS OVER THE AUTO PICK, in the order the server resolves them: a guest who chose a
	 * source must see THEIR choice named. And the tone follows `isAuthoritativeText`, which is the judgement
	 * worth more than the string — an auto-transcribed guess is the case a singer should know about before
	 * trusting the screen, so it is not painted like authored words.
	 */
	dropDrawer();
	const overridden = openDrawer({
		...PLAYING,
		candidates: [
			{ ref: 'a', textSource: 'lrclib', timing: 'word', textConfidence: 'high' },
			{ ref: 'b', textSource: 'asr', timing: 'line', textConfidence: 'low' }
		],
		chosenRef: 'a',
		overrideRef: 'b'
	});
	const pill = overridden.querySelector('.lyricsrc .encore-chip') as HTMLElement | null;
	expect(pill?.textContent?.trim()).toBe('Auto-transcribed');
	expect(pill?.className).toContain('encore-chip-warn');
	expect(
		(overridden.querySelector('.lyricsrc .encore-chip') as HTMLElement).className,
		'an auto-transcribed guess must not wear the authored-words tone'
	).not.toContain('encore-chip-ok');

	// An idle room has no song whose lyrics could be named, so it gets no pill — and a chosen ref matching
	// no candidate gets none either, because a pill reading "undefined" is worse than no pill.
	dropDrawer();
	expect(count(openDrawer(IDLE), '.lyricsrc')).toBe(0);
	dropDrawer();
	expect(
		count(openDrawer({ ...PLAYING, candidates: [], chosenRef: 'a' }), '.lyricsrc'),
		'no candidates means nothing honest to name'
	).toBe(0);
});

// ── the wait on the byline, and its honest degradation ───────────────────────────────────────────
/*
 * FOUR ARMS BECAME TWO, AND THE SUBJECT MOVED (2026-09-22). They rendered `MyPositionCard` — a card above
 * the queue reading "3rd · You're up after Sam. · Roughly 11 minutes." — and asserted its ordinal, its
 * lead, its wait, the ABSENCE of the wait when any length ahead was unknown, and that it de-emphasised the
 * wait with a token rather than subtree opacity.
 *
 * The card is deleted: it restated the queue row a few pixels below it (the same ordinal in the row's own
 * bubble, the same "up next" in its byline), and its one unique line was the wait. The wait is now a clause
 * on that row's byline, built by `waitShort` from the same sum the sentence form used.
 *
 * What is dropped with the card is what was ABOUT the card: the ordinal (the row's bubble owns it, asserted
 * by the seq arms), the lead sentence (the row's "up next" badge says it), and the opacity arm (the byline
 * is `.who`, whose colour contrast.test.ts already walks). What SURVIVES is the honest degradation, which is
 * the claim that mattered — and it survives at the same strength, on the element that renders it now.
 */
test('a known wait renders as a byline clause after the up-next badge', () => {
	const host = render(QueueRow, {
		...ROW,
		singerName: 'You',
		mine: true,
		up: true,
		subtitle: `up next · ${waitShort(120, [200, 341])}`
	});
	const byline = host.querySelector('.who')?.textContent ?? '';
	expect(byline).toContain('up next');
	expect(byline).toContain('~11 min');
	// The separators are real middots between real parts, never a stray one from an absent clause.
	expect(byline).not.toContain('· ·');
});

test('an unknown wait renders NO clause — not a zero, not a guess', () => {
	// One entry ahead with no resolvable length makes the whole sum unknown, so the formatter returns null…
	expect(waitShort(120, [200, null])).toBeNull();
	// …and the row renders the badge alone, with nothing where the clause would have been.
	const host = render(QueueRow, { ...ROW, singerName: 'You', mine: true, up: true, subtitle: 'up next' });
	const byline = host.querySelector('.who')?.textContent ?? '';
	expect(byline).toContain('up next');
	expect(byline.toLowerCase()).not.toContain('min');
	expect(byline).not.toContain('NaN');
	expect(byline).not.toContain('null');
});

// ── the unconfirmed marker says which mutation it is waiting on ───────────────────────
/*
 * `reorderable`, `canUp` and `canDown` LEFT THIS FIXTURE (2026-09-21) with the props they named: the arrow
 * pair is retired and whether a row can move is `grip` (the caller's `gripVisible()` predicate), while
 * whether it may move right now is `pending`. Passing props a component no longer declares is how a fixture
 * comes to describe a row that cannot exist.
 */
const ROW = {
	seq: 3,
	title: 'Wonderwall',
	singerName: 'You',
	singerColor: '#5cb8ff',
	mine: true,
	removable: true,
	/*
	 * The grip publishes `data-grip={gripId}`, and Svelte omits an attribute whose value is undefined — so a
	 * fixture without an id renders a grip that no `[data-grip]` query can find. It is the entry id in the
	 * app, and the drag's focus return re-finds the grip by it (see driven-find 5).
	 */
	gripId: 'entry-1'
};

test('a pending REORDER says "moving…", never "adding…"', () => {
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

test('a row awaiting confirmation makes its own reorder controls inert', () => {
	/*
	 * "…and its reorder controls are inert" is part of the requirement: a second reorder of a move that has
	 * not landed would issue an op against a position the server has not agreed to yet.
	 *
	 * RE-POINTED AT THE GRIP (2026-09-21). The controls were a `move up` / `move down` pair inside the row's
	 * `{#if !pending}` gate; they are retired, and the reorder — drag AND keyboard — is the grip, which leads
	 * the row from its media slot OUTSIDE that gate. So it carries its own `{#if grip && !pending}`, and this
	 * arm is what proves it: the claim is unchanged, its subject moved.
	 */
	const moving = render(QueueRow, { ...ROW, grip: true, pending: 'move' });
	expect(moving.querySelector('[data-grip]')).toBeNull();
	expect(moving.querySelector('button[aria-label="remove from queue"]')).toBeNull();

	// …and it is present once confirmed, so the assertion above is about the pending state and not about the
	// props never rendering a grip at all.
	const settled = render(QueueRow, { ...ROW, grip: true, pending: null });
	expect(settled.querySelector('[data-grip]')).not.toBeNull();
	// The retired pair stays retired — a reader grepping for it lands here rather than on a silent pass.
	expect(settled.querySelector('button[aria-label="move up"]')).toBeNull();
	expect(settled.querySelector('button[aria-label="move down"]')).toBeNull();
});

test('the pending state is signalled on the row SURFACE, not by dimming its subtree', () => {
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
	 * The PAIR is the point for the wait: "no minutes clause" is only judgeable against the clause it
	 * replaces, so a gallery with only the happy branch cannot show the degradation at all. That pair used
	 * to be two `<MyPositionCard>` fixtures; the card is deleted and the wait is a byline clause, so it is
	 * now two QueueRow `subtitle` fixtures — same pair, same reason, on the element that renders it.
	 */
	const gallery = read('src/routes/components/+page.svelte');
	expect(gallery).toContain('<NowPlayingDrawer');
	expect(gallery).not.toContain('<MyPositionCard');
	// The import too, separately: dropping it breaks `build` and leaves `bun test` green, so without this
	// the fixtures could be orphaned by a tidy-up that no named test objects to.
	expect(gallery).toMatch(/import NowPlayingDrawer from '\$lib\/components\/NowPlayingDrawer\.svelte';/);
	/*
	 * TRANSFORMED (fixture shape changed, claim unchanged). Was `<NowPlayingHero title="Nothing
	 * playing"`: five hero cards could sit side by side, so the idle state was its own inline fixture.
	 * A drawer is portalled and fixed to the viewport, so two open at once occupy the same 82dvh and a
	 * stack of them would show one frame with the rest invisible underneath. The gallery therefore
	 * drives ONE drawer through a `drawerHasSong` state and a trigger per state — so what has to be
	 * pinned is that the idle arm is still REACHABLE, which is the same guarantee (the empty
	 * state is a designed state, not an accident of no data).
	 */
	expect(gallery).toMatch(/drawerHasSong = false;/);
	expect(gallery).toMatch(/hasSong=\{drawerHasSong\}/);

	const rows = [...gallery.matchAll(/<QueueRow[\s\S]*?\/>/g)].map((m) => m[0]);
	// one branch with a known wait on the byline…
	expect(rows.some((r) => /subtitle="[^"]*~\d+ min"/.test(r))).toBe(true);
	// …one with the sub-minute phrase…
	expect(rows.some((r) => /subtitle="[^"]*<1 min"/.test(r))).toBe(true);
	// …and one with NO clause at all, which is the honest-degradation arm: an unknown wait renders nothing.
	expect(rows.some((r) => /subtitle=""/.test(r))).toBe(true);
});

// ── the swallow stays honest ─────────────────────────────────────────────────────────────────────
test('nothing beyond the KNOWN incidental geometry reads was swallowed', () => {
	/*
	 * `openDrawer` lets the mount rung's geometry refusal through so the rendered content can be
	 * asserted at all. That catch is narrow — anything that is not the refusal rethrows — but it would
	 * still absorb a NEW measuring dependency, and a component that started measuring its own layout
	 * belongs on rung L rather than here. So the swallowed names are bounded.
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
