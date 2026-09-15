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
	for (const { comp, host } of live) {
		// `void`: unmount returns a promise (it can await outro transitions) and nothing here has any, so
		// the teardown is synchronous in practice — but a floating promise is a lint error either way.
		// Wrapped because tearing the drawer down runs the same measuring effects (MEASURED: the portal
		// is removed either way, so a leaked portal still reds in the next test's `openDrawer`).
		swallowGeometryRefusal(() => void unmount(comp as never));
		host.remove();
	}
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
 * Every geometry API refused while this file ran, in first-seen order.
 *
 * Recorded rather than discarded so the LAST test can assert the exact set. That assertion is what
 * keeps the swallow honest: a new measuring dependency inside the drawer would otherwise be absorbed
 * silently by the same catch that absorbs the two known incidental reads.
 */
const refusedApis: string[] = [];

/**
 * Run `fn`, letting the mount rung's geometry refusal through and rethrowing everything else.
 *
 * The narrow match is the point. A component error, a missing module, a bad prop — anything that is
 * not the preload's own "cannot measure" refusal — still fails the test.
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
 * Mount the drawer through its harness and return the ONE portalled content element.
 *
 * Non-vacuous by construction: exactly one `[data-slot="drawer-content"]` must be in the document, so
 * a drawer that rendered nothing (or a portal leaked from a previous test) fails here rather than
 * letting every `querySelector` below return null and pass.
 */
function openDrawer(props: Record<string, unknown> = {}): HTMLElement {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const comp = mount(NowPlayingDrawerHarness as never, { target: host, props });
	live.push({ comp, host });
	swallowGeometryRefusal(() => flushSync());
	const found = document.querySelectorAll('[data-slot="drawer-content"]');
	expect(found.length, 'expected exactly one open drawer in the document').toBe(1);
	return found[0] as HTMLElement;
}

/** Mount the drawer CLOSED. Returns nothing: the claim is that nothing was added to the document. */
function closedDrawer(props: Record<string, unknown> = {}): void {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const comp = mount(NowPlayingDrawerHarness as never, { target: host, props: { ...props, openOnMount: false } });
	live.push({ comp, host });
	swallowGeometryRefusal(() => flushSync());
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
	swallowGeometryRefusal(() => void unmount(live.pop()!.comp as never));
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
	swallowGeometryRefusal(() => void unmount(live.pop()!.comp as never));
	const waiting = openDrawer({ ...IDLE, canStart: true });
	expect(btn(waiting, 'play/pause').disabled).toBe(false);
	expect(btn(waiting, 'skip').disabled).toBe(true);

	swallowGeometryRefusal(() => void unmount(live.pop()!.comp as never));
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
	expect((idle.textContent ?? '').match(/Nothing playing/g)?.length).toBe(1);
	// TRANSFORMED (prop gone, copy unchanged). The sentence arrived as the hero's `hint` prop; the
	// drawer owns it. Asserting it with NOTHING passed in is the stronger form — the caller can no
	// longer forget to supply the one line that says what to do next.
	expect(idle.textContent).toContain('Queue a song to start the party');
});

/*
 * TRANSFORMED FROM THE DELETED `controlsSummary` PEEK ASSERTIONS.
 *
 * The hero's disclosure had a `controlsSummary` prop that stood in for the controls while collapsed,
 * and the guarantee attached to it was: BEFORE the reveal, the control is not on screen. The prop and
 * the collapsed state are both gone, so the guarantee is re-anchored to the drawer's own two states —
 * closed renders no content whatsoever. That is strictly stronger than "hidden behind a summary": the
 * controls are not in the document, so nothing can reach them by accident, and the persistent glance
 * is the band (its own component, with its own guards) rather than a summary line.
 */
test('a closed drawer puts nothing on screen — no controls, no transport, no title', () => {
	closedDrawer(PLAYING);
	expect(count(document, '[data-slot="drawer-content"]')).toBe(0);
	expect(count(document, '.tools-body')).toBe(0);
	expect(count(document, '.gt')).toBe(0);
	expect(count(document, 'button[aria-label="play/pause"]')).toBe(0);
	expect(document.body.textContent).not.toContain('Bohemian Rhapsody');
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
	swallowGeometryRefusal(() => void unmount(live.pop()!.comp as never));
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
test('nothing beyond the two KNOWN incidental geometry reads was swallowed (XR-VER-03)', () => {
	/*
	 * `openDrawer` lets the mount rung's geometry refusal through so the rendered content can be
	 * asserted at all. That catch is narrow — anything that is not the refusal rethrows — but it would
	 * still absorb a NEW measuring dependency, and a component that started measuring its own layout
	 * belongs on rung L rather than here (XR-VER-02). So the swallowed names are bounded.
	 *
	 * Both known entries are DEPENDENCIES' reads, on paths this file asserts nothing about:
	 *   offsetWidth — the Bits UI Slider inside GuidingTrack, which mounts whenever hasSong is true.
	 *   clientWidth — bits-ui body-scroll-lock's scrollbar-width compensation, on
	 *                 document.documentElement, when a modal dialog opens.
	 *
	 * A SUBSET, plus one required member, rather than an exact set — and that asymmetry is MEASURED,
	 * not a hedge. `offsetWidth` is deterministic: this file always opens a playing drawer, so the
	 * Slider always mounts. `clientWidth` is NOT: bits-ui's lock bookkeeping is module-global, so
	 * whether the scrollbar computation runs here depends on whether an earlier FILE in the same
	 * process already locked the body. Measured — refused when this file runs alone, absent in a full
	 * `bun run test`. Pinning it exactly made this arm pass alone and fail in the suite, which is a
	 * property of the run scope rather than of the drawer.
	 *
	 * If this reds with a THIRD name, do not add it here reflexively: read what measures, and decide
	 * whether the claim that depends on it has to move to `tests/e2e/probes/`.
	 */
	const known = ['clientWidth', 'offsetWidth'];
	expect(refusedApis.filter((api) => !known.includes(api))).toEqual([]);
	// Non-vacuity: the swallow really did fire, so this arm is not passing because nothing was caught.
	expect(refusedApis).toContain('offsetWidth');
});
