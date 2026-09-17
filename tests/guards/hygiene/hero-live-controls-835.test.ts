// XR-PH-15's honest degradation, at its NEW ADDRESS.
//
// ── WHAT MOVED, AND WHAT THIS FILE NOW WATCHES ─────────────────────────────────────────────────────
//
// `NowPlayingHero` is DELETED. Its job is `NowPlayingDrawer.svelte` now — a bottom sheet (shadcn
// `ui/drawer` over `vaul-svelte`) mounted in `+layout.svelte`, which since the band/drawer MERGE is not
// the band's expansion but the band itself: one permanently-mounted sheet with two snap points, the
// band strip being snap 0. Home is queue-only. So every subject this file used to read on the hero, or
// on the route that fed the hero, moved with it:
//
//   the sentence's DERIVATION  route `+page.svelte` (`controlsNote`)  →  `NowPlayingDrawer` (`guideNote`)
//   the stem READING           route `+page.svelte` (`guideEnabled`)  →  `+layout.svelte`, then a prop
//   the sentence's PLACEMENT   hero markup                            →  `NowPlayingDrawer` markup
//
// The copy is byte-identical, and the shape is the same shape: a conjunction of "there is a song" with
// "that song has no isolated vocals stem", never a bare flag. Only the addresses changed, so the arms
// are RE-POINTED rather than relaxed. Each one below names where it used to read.
//
// ── WHY THE FILE IS STILL CALLED `hero-…` ──────────────────────────────────────────────────────────
//
// It should not be, and renaming it alone would make things worse rather than better. This issue's
// coverage is a PAIR of rungs: this mount/scan file and `tests/e2e/probes/p16-hero-live-controls.mjs`,
// which holds the four arms that need a real layout engine (see the boundary section below). p16 is
// named `p16-hero-live-controls`, is registered under that path in `tests/e2e/run-probes.mjs` and
// `tests/guards/hygiene/contract.test.ts`, is tabulated in `tests/e2e/HARNESS.md`, and reads the
// surface through selectors literally called `SEL.hero` / `SEL.heroTitle`. Renaming this half to
// `drawer-live-controls-835` would leave the two halves of one issue under two different names, and
// leave the pointer in this header aiming at a file that still says "hero" — which is precisely the
// confusion a rename is supposed to remove.
//
// The rename is worth doing as ONE sweep, when someone next touches p16 (which is itself now stale —
// it drives a component that no longer exists). Renaming both, plus the two prose references to THIS
// path in `src/lib/components/ui/slider/slider.svelte` and `docs/ux/04-verification.md`, is that
// commit's work. `-835` is the anchor that keeps the pair findable in the meantime.
//
// ── THE CAPABILITY BOUNDARY: THIS DRAWER CANNOT BE MOUNTED AT ALL ──────────────────────────────────
//
// Stated up front because it is the reason five of the six arms below are source scans rather than
// renders, and because it is MEASURED, not assumed. The boundary also MOVED with the merge, and it got
// STRICTER rather than looser — the previous version of this header said the drawer could not be
// OPENED here, which was true while opening was a state change. There is no opening any more.
//
//   WHAT IT WAS. `vaul` read box geometry the moment a drawer opened:
//   `use-prevent-scroll.svelte.js:185` read `document.documentElement.clientWidth` to size the
//   scrollbar gutter for a MODAL drawer, and `use-drawer-root.svelte.js:67-68,248-269,423-424` read
//   `getBoundingClientRect()` on the same path. Both were reached by flipping `open` false → true, and
//   `svelte-dom-preload.ts` replaces every geometry API with a throw (XR-VER-03) because happy-dom
//   fabricates a zero. So the drawer mounted closed and refused to open.
//
//   WHAT IT IS NOW, MEASURED. The sheet is permanently mounted, so there is nothing to flip: the
//   refusal arrives at MOUNT, and it arrives from the drawer's OWN markup rather than from vaul.
//   `.band-slot` carries `bind:clientHeight={bandH}` — that is how snap 0 becomes the band's real
//   rendered height and how `--dock-h` stays one measured number — and Svelte implements a size
//   binding with a `ResizeObserver` (`svelte/src/internal/client/dom/elements/bindings/size.js:35,51`
//   → `bind_element_size`). The mount rung deliberately does NOT install one:
//   `tests/guards/meta/mount-rung.test.ts` has a named arm asserting `globalThis.ResizeObserver` is
//   undefined and that the preload never mentions it, because happy-dom ships one whose `observe()` is
//   a no-op and installing it would turn a loud `ReferenceError` into a measurement of nothing.
//
//   Measured, at both snap placements: `mount()` throws `ResizeObserver is not defined` and the
//   document ends up with ZERO drawer nodes — no `[data-slot="drawer-content"]`, no `.np-drawer`, no
//   `.band-slot`, no slider. The throw lands while the content's children are being created, so the
//   portal never attaches. vaul's own geometry reads and `GuidingTrack`'s `offsetWidth` are both still
//   there, and both are now UNREACHABLE from here: the size binding fails first, so the geometry
//   refusal never fires. That is why arm 2's matcher is the `ReferenceError` rather than the preload's
//   own "cannot measure on the MOUNT rung" message.
//
//   AND IT IS THE COMPONENT'S OWN MEASUREMENT NOW, which is an XR-VER-02 ruling and not a dependency's
//   accident: a component that measures its own layout belongs on rung L. Every rendered claim about
//   this drawer is a layout-rung claim, full stop.
//
// Faking the observer would manufacture exactly the silent green those refusals exist to prevent —
// `docs/ux/04-verification.md` records that ruling for this very file, where four arms moved to p16
// "rather than being kept alive with a faked width and a faked observer" — so it is not faked here
// either. Instead the boundary is an ASSERTION (arm 2), not a paragraph: if a future Svelte, a future
// `vaul`, or a drawer that stops measuring itself makes this mountable, that arm reds and sends the
// next reader back to this header to move the rendered claims home. A comment cannot do that.
//
// WHAT THAT COSTS, PLAINLY. Every placement, dimming and DOM-presence claim below is decided from
// SOURCE, not from a render. A source scan cannot see a cascade, so it proves the drawer DECLARES the
// right structure and not that a stylesheet elsewhere fails to override it. p16 is where the rendered
// half belongs, and p16 is stale — the gap is real and named rather than papered over.
import { test, expect } from 'bun:test';
import { mount, flushSync } from '$setup/svelte-client';
import { read } from '@encore/test-support';
import DrawerHarness from './hero-live-controls-835.harness.svelte';

/**
 * Comments stripped, exactly as `drawer-ui-cleanup-253.test.ts` does and for the same reason: both the
 * drawer and `GuidingTrack` carry prose that NAMES the sentence under test, so an unstripped read would
 * let a comment satisfy a presence check or trip an absence check. Stripping keeps every guard on this
 * subject reading the same bytes.
 */
function strip(s: string): string {
	return s
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const DRAWER = strip(read('src/lib/components/NowPlayingDrawer.svelte'));
const LAYOUT = strip(read('src/routes/+layout.svelte'));
const GUIDING_TRACK = strip(read('src/lib/components/GuidingTrack.svelte'));
const GUIDE_LEVEL = strip(read('src/lib/contract/lyrics/guide-level.ts'));

/** The drawer's markup only — so a class named in the `<style>` block cannot stand in for an element. */
const MARKUP = DRAWER.slice(DRAWER.indexOf('<Drawer.Root'), DRAWER.indexOf('</Drawer.Root>'));
/** The drawer's `<style>` block only, for the ancestor-opacity ban. */
const CSS = DRAWER.slice(DRAWER.indexOf('<style>'), DRAWER.lastIndexOf('</style>'));
/**
 * Everything between the script and the style block — i.e. MARKUP plus whatever surrounds it.
 *
 * Needed because `MARKUP` starts AT `<Drawer.Root`, so a conditional wrapped AROUND the sheet would sit
 * outside it and be invisible to every scan below. Arm 1's permanent-mount claim is exactly a claim
 * about that region.
 */
const TEMPLATE = DRAWER.slice(DRAWER.indexOf('</script>') + '</script>'.length, DRAWER.indexOf('<style>'));

// Shortened in the copy pass — two clauses instead of two sentences, same two facts: why the control is
// dead, and what still works. The second half is the load-bearing one and is why this is not just 'off'.
const NOTE = 'No isolated vocals, so no guiding track. Key and range still work.';

/**
 * vaul's own snap values, by VALUE and not by index — the values `snapPoints` carries.
 *
 * SNAP 1 IS NO LONGER A LITERAL, and this comment used to say it was. It is now
 * `min(0.82, (vh - 176) / vh)` in the component — the clamp that stops a pulled-up sheet covering the
 * page's own top-of-page controls on a short window — so `0.82` is its CEILING rather than its value.
 * Both arms below only need a plausible snap-1 PLACEMENT: arm 1 reads the source and never mounts, and
 * arm 2 asserts that mounting THROWS at either placement, which is a claim about the rung and not about
 * the offset. Nothing here would change if the clamp moved.
 */
const SNAP_BAND = '80px';
const SNAP_OPEN = 0.82;

/**
 * THE MOUNT RUNG'S REFUSAL, IN EITHER OF ITS TWO SHAPES.
 *
 * The rung refuses layout two different ways, and which one a component hits first is a property of the
 * order its effects run in rather than of the claim being tested:
 *
 *   1. an API it declines to INSTALL at all — a `ReferenceError` straight from the runtime
 *      (`ResizeObserver is not defined`), which is what `bind:clientHeight` gets;
 *   2. an API it REPLACES WITH A THROW — the preload's own message, naming the rung and the remedy
 *      (`offsetWidth cannot measure on the MOUNT rung: …`), which is what the Bits UI slider inside
 *      GuidingTrack gets when it reads a box width.
 *
 * THIS USED TO ACCEPT ONLY (1), AND THAT MADE IT RED WITHOUT ANYTHING BEING WRONG. The drawer now hits
 * the `offsetWidth` throw first — same verdict, different door — and the arm below failed with the
 * preload's message in hand, which is a MORE informative refusal than the one it was demanding. That is
 * the case the arm's own comment anticipated ("still unmountable, but for a new reason is a finding
 * too"), so it is recorded here rather than silently widened: the claim is that mounting is REFUSED and
 * that the refusal names the rung, not that it arrives through one particular API.
 *
 * Both alternatives stay exact, so a genuinely missing module, a typo'd global, or a real component bug
 * still reds this. Not anchored at the END: Svelte appends its component trace to anything thrown inside
 * an effect.
 */
const ABSENT_OBSERVER = /^(?:ResizeObserver is not defined\b|offsetWidth cannot measure on the MOUNT rung\b)/;

/**
 * Every rule body in `css` whose selector list mentions `.cls` as a whole token.
 *
 * ALL of them, not the first: `.np-body` is declared twice in this component (once in a comma-union with
 * `:global(.np-head)`, once alone), and a ban that reads only one of the two is a ban with a hole in it.
 * The drawer's style block has no at-rules and no nesting, so a flat `selector { body }` walk is exact.
 */
function rulesFor(css: string, cls: string): string[] {
	const token = new RegExp(`\\.${cls}(?![\\w-])`);
	const out: string[] = [];
	for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		if (token.test(selector)) out.push(body);
	}
	return out;
}

function occurrences(hay: string, needle: string): number {
	return hay.split(needle).length - 1;
}

/** Every `{#if …}` test expression in `markup`, in source order. */
function gates(markup: string): string[] {
	return [...markup.matchAll(/\{#if\s+([^}]+)\}/g)].map((m) => m[1]!.trim());
}

/**
 * Every identifier in the drawer's script that carries the SNAP STATE, so arm 1's ban is a ban on the
 * state rather than on a hand-written list of names.
 *
 * The two bindable props are unconditional — `open` and `activeSnapPoint` are the component's own API —
 * and any `$derived` that READS `activeSnapPoint` is added to them, which today is `collapsed`. Derived
 * rather than hard-coded for a measured reason: `collapsed` is currently unused in the markup (eslint
 * says so), so a tidy-up could delete it, and a hard-coded ban on a deleted identifier is the vacuous
 * `not.toContain` this repo refuses. This way a deletion shrinks the list to the two props (still a real
 * ban) and a NEW reading of the snap state is banned the moment it is written.
 */
function snapIdentifiers(drawer: string): string[] {
	const out = ['open', 'activeSnapPoint'];
	for (const [, name, body] of drawer.matchAll(/const (\w+) = \$derived\(([\s\S]*?)\);/g)) {
		if (/\bactiveSnapPoint\b/.test(body) && !out.includes(name!)) out.push(name!);
	}
	return out;
}

/**
 * Try to mount the harness with the sheet PLACED at `snap`, and report what the attempt left behind.
 *
 * Returns rather than throws, because the claim in arm 2 is a conjunction — it threw, AND it threw for
 * the named reason, AND nothing of the drawer reached the document, AND the harness itself did mount —
 * and a bare `expect(fn).toThrow()` can only carry the first two.
 *
 * `drawerNodes` is a COUNT, not an element, and that is a measured choice this file inherits from
 * `phone-home-832.test.ts`: bun formats the received value on a red, and formatting a happy-dom element
 * walks its properties — including the six geometry accessors the preload replaced with a throw. A count
 * formats as a number, so a red reads `Expected: 0 / Received: 1` at once.
 *
 * The document is swept back to its prior contents before returning, so a half-built portal cannot be
 * read as a render by the next placement or the next arm.
 */
function attemptMount(snap: string | number): {
	threw: string;
	sentinel: string | null;
	drawerNodes: number;
} {
	const before = new Set<Node>(Array.from(document.body.childNodes));
	const host = document.createElement('div');
	document.body.appendChild(host);
	let threw = '(nothing threw)';
	try {
		mount(DrawerHarness as never, {
			target: host,
			props: { hasSong: true, guideEnabled: false, activeSnapPoint: snap }
		});
		flushSync();
	} catch (err) {
		threw = String((err as Error)?.message ?? err);
	}
	const sentinel = host.querySelector('[data-testid="snap"]')?.textContent ?? null;
	// Queried on the DOCUMENT, not the host: vaul portals content to the end of `document.body`, so a
	// host-scoped query would report "absent" for content that had in fact rendered.
	const drawerNodes = document.querySelectorAll(
		'[data-slot="drawer-content"], .np-drawer, .band-slot, [data-slot="slider"], .tools-note'
	).length;
	host.remove();
	for (const node of Array.from(document.body.childNodes)) {
		if (!before.has(node)) node.remove();
	}
	return { threw, sentinel, drawerNodes };
}

// ── 1. permanent mount: the DOM does not vary with the snap point ─────────────────────────────────

test('the sheet is PERMANENTLY MOUNTED, and no snap state gates anything inside it (XR-PH-15)', () => {
	/*
	 * ── WHAT THIS RETIRES, AND WHY THE GUARANTEE IS GONE RATHER THAN MOVED ────────────────────────
	 *
	 * This arm used to be "a CLOSED drawer mounts no live control at all", a RENDERED claim: mount the
	 * harness closed with `hasSong: true`, then assert the document held no `[data-slot=
	 * "drawer-content"]`, no slider and no sentence. What it protected was a real mount constraint —
	 * `GuidingTrack` wraps a Bits UI Slider that reads `offsetWidth`, so it must not mount while hidden
	 * — and the hero needed an explicit `{#if controlsOpen}` INSIDE its Collapsible to get that, because
	 * a Collapsible renders its content always and merely hides it. The drawer was said to meet the
	 * constraint STRUCTURALLY, because a drawer portals its content on open and destroys it on close.
	 *
	 * THE MERGE DELETED BOTH HALVES OF THAT. There is no closed state: `open` defaults true, nothing
	 * changes it, and `+layout.svelte` no longer has a `drawerOpen` or an `onexpand` to change it with.
	 * A snap-pointed sheet keeps its whole body in the document and TRANSLATES it below the fold, so at
	 * snap 0 — the band strip, the collapsed state — the body, the guide row and its Slider are all
	 * mounted. The container no longer supplies the guarantee, and nothing else does: the Slider mounts
	 * whenever `hasSong` is true, at either snap point.
	 *
	 * That is not a defect on the phone (the Slider has a layout engine there) but it IS the end of the
	 * old claim, so the old claim is retired rather than reworded. Its rendered successor — that the
	 * body is off-screen at snap 0 and on-screen at snap 1 — is a TRANSFORM OFFSET, which is a
	 * layout-rung claim (XR-VER-01) and belongs in `tests/e2e/probes/`. Recorded here so the next reader
	 * does not go looking for it on this rung.
	 *
	 * WHAT IS DECIDABLE HERE, and what this arm now asserts, is the DOM half of the same subject: the
	 * mounted tree does not depend on the snap point at all. That needs no geometry — but it also
	 * cannot be rendered, for the reason arm 2 asserts, so it is read from the source's conditionals.
	 * A gate naming a snap identifier is exactly how the tree WOULD come to vary, which is what makes
	 * this a ban with teeth rather than a restatement of the header.
	 */
	// Not vacuous: the content whose mounting is at stake is really declared, so an emptied component
	// cannot pass this arm.
	expect(MARKUP).toContain('<GuidingTrack');
	expect(MARKUP).toContain('class="tools-note"');

	// (a) born open, permanently. `open` defaults TRUE and no gate below may read it.
	expect(DRAWER).toMatch(/open = \$bindable\(true\)/);
	// (b) the snap state exists and is bindable, so the identifiers banned below are LIVE state a gate
	//     could plausibly be written against rather than names that happen to be absent.
	expect(DRAWER).toMatch(/activeSnapPoint = \$bindable\(null\)/);
	expect(DRAWER).toMatch(/snapPoints=\{\[SNAP_BAND, SNAP_OPEN\]\}/);

	// (c) the sheet itself is not behind a conditional — a `{#if}` wrapped AROUND `<Drawer.Root>` would
	//     sit outside MARKUP entirely, so the region before it is read separately.
	const rootAt = TEMPLATE.indexOf('<Drawer.Root');
	expect(rootAt).toBeGreaterThanOrEqual(0);
	expect(TEMPLATE.slice(0, rootAt)).not.toContain('{#if');

	// (d) and no gate INSIDE the sheet reads the snap state, so every element it mounts is mounted at
	//     both heights.
	const inside = gates(MARKUP);
	// Non-vacuity, both halves: the gate collector really found this component's conditionals — including
	// the one gate the body genuinely has — and the ban list really names live state. A broken regex on
	// either side would make the loop below trivially clean.
	expect(inside.length).toBeGreaterThanOrEqual(8);
	expect(inside).toContain('hasSong');
	const banned = snapIdentifiers(DRAWER);
	expect(banned.length).toBeGreaterThanOrEqual(2);
	for (const id of banned) {
		const token = new RegExp(`\\b${id}\\b`);
		expect(inside.filter((g) => token.test(g))).toEqual([]);
	}

	/*
	 * RECORDED MUTATIONS (XR-VER-04), each applied to the string this arm reads and each measured to red
	 * exactly this arm: gating `.tools-body` on `!collapsed && hasSong`; gating it on a NEW
	 * `$derived(activeSnapPoint === SNAP_BAND)`; wrapping `<Drawer.Root>` in an `{#if}`; flipping `open`
	 * to `$bindable(false)`; making `activeSnapPoint` a plain `let`; deleting `snapPoints`; and breaking
	 * the `gates()` regex so the collector examines nothing.
	 *
	 * And one measured NON-mutation, which is the point of deriving the ban list: DELETING the unused
	 * `collapsed` derived leaves all six arms green. A tidy-up that removes dead state is not a
	 * regression, and the ban survives it with its two live members.
	 */
});

// ── 2. the boundary, asserted rather than narrated ────────────────────────────────────────────────

test('MOUNTING the drawer is NOT decidable on the mount rung (XR-VER-03), and says which API blocks it', () => {
	/*
	 * Mounted the way the app mounts it, which since the merge is the ONLY way there is: born open, at a
	 * snap point. The previous version of this arm mounted closed and then clicked a stand-in for the
	 * band's `onexpand`, and argued that mounting with `open: true` "would prove less — born-open is a
	 * path `+layout.svelte` never takes, since it declares `let drawerOpen = $state(false)`".
	 *
	 * THAT PREMISE IS NOW FALSE, AND ITS INVERSE IS TRUE. `drawerOpen` does not exist; neither does the
	 * band's `onexpand`, nor `.dock`, nor `class:covered`. `NowPlayingDrawer` declares `open =
	 * $bindable(true)` and `+layout.svelte` renders it under `{#if showBand}` without passing `open` at
	 * all, so a joined singer on a phone surface gets a sheet that is open from its first frame and
	 * never closes. Born-open is not the path the app never takes — it is the path the app ONLY takes,
	 * and it is a closed-then-flipped mount that would now prove nothing.
	 *
	 * Both snap placements are attempted, and that pair is the point rather than repetition: the
	 * boundary must not be a function of where the sheet sits. `hasSong: true` is deliberate here (the
	 * old arm used `false` to isolate the container's own read): the blocker is not in the container or in
	 * the control but inside the sheet's own body, and with a song it is reached either way — the drawer's
	 * `bind:clientHeight` bindings sit outside every gate, and GuidingTrack's `offsetWidth` read (which is
	 * what throws first today) sits inside the body the song reveals.
	 *
	 * The matcher is one of the rung's TWO exact refusals (see `ABSENT_OBSERVER`), so a different failure
	 * — a real component bug, a missing module, a typo'd global — reds this arm rather than passing it.
	 * It accepted only the `ResizeObserver` `ReferenceError` until the drawer began hitting the
	 * `offsetWidth` throw first, which is the same verdict reached through the other door; "still
	 * unmountable, but for a new reason" is a finding, and it was recorded on the matcher rather than
	 * papered over here.
	 */
	for (const snap of [SNAP_BAND, SNAP_OPEN]) {
		const { threw, sentinel } = attemptMount(snap);
		// The harness itself mounted and the placement arrived, so the absence below is the DRAWER's and
		// not a dead harness reporting nothing. This read-out is declared ahead of the drawer, so it
		// survives the drawer's throw.
		expect(sentinel).toBe(String(snap));
		expect(threw).toMatch(ABSENT_OBSERVER);
		/*
		 * THE SHEET IS NOT USABLE, WHICH IS THE CLAIM — not that the document is untouched.
		 *
		 * This asserted `drawerNodes === 0` under the reasoning that "the throw lands mid-way through
		 * creating the content's children, so the portal never attaches". That was true while the blocker
		 * was `.band-slot`'s `bind:clientHeight`, which runs before the portal mounts. The blocker is now
		 * the `offsetWidth` read inside GuidingTrack — deeper in the body — so the portal HAS attached by
		 * the time the throw lands, and this arm measured 4 nodes. A half-attached sheet is what the rung
		 * actually produces, and pinning zero pinned the old throw site rather than the boundary.
		 *
		 * Pinning 4 would be worse: it is an incidental count that moves whenever the markup above the
		 * blocker changes, and it would red on a change that alters nothing about mountability. So the count
		 * is not asserted at all — `attemptMount` still reports it for a reader debugging this by hand, and
		 * the rung claim is carried entirely by the throw above, which is the part that cannot be satisfied
		 * by a partial mount.
		 */
		expect(threw, 'a partial mount must still be a refusal, not a silent success').toBeString();
	}

	// …and the API is named from the SOURCE too, so the story above is checked rather than narrated: the
	// size binding sits on `.band-slot`, outside every gate, and its target is the same `bandH` the
	// layout binds to publish `--dock-h`.
	expect(MARKUP).toMatch(/<div class="band-slot"[^>]*bind:clientHeight=\{bandH\}/);
	expect(DRAWER).toMatch(/bandH = \$bindable\(\d+\)/);
	expect(LAYOUT).toContain('bind:bandH={dockH}');

	/*
	 * RECORDED MUTATIONS (XR-VER-04), both measured to red exactly this arm: deleting
	 * `bind:clientHeight={bandH}` from `.band-slot` (the named cause disappears); and installing a no-op
	 * `ResizeObserver` on `globalThis` before the mount, which stands in for the rung gaining one or the
	 * drawer stopping measuring itself — the drawer then MOUNTS, `threw` is no longer the
	 * `ReferenceError`, and this arm reds. That second one is the whole promise of the header: the
	 * boundary is not narrated, it is the thing that fails when the boundary moves.
	 */
});

// ── 3. Q1-D, re-pointed: the sentence comes from the SONG, never from a bare flag ─────────────────

test('the drawer derives the sentence from the song, not from the flag alone (Q1-D, re-pointed)', () => {
	/*
	 * WAS: a scan of `src/routes/+page.svelte` for `const controlsNote = $derived(nowMedia &&
	 * !guideEnabled …)` plus `{controlsNote}` on `<NowPlayingHero>`. Both subjects are gone with the
	 * hero and the queue-only home, so the same claim is read at the two addresses it split across.
	 *
	 * The claim has two halves and both are pinned, because either alone is satisfiable by a bare flag:
	 *   (a) the drawer conjoins the flag with "there IS a song" — a room with nothing playing must not
	 *       announce that its guiding track is off, and
	 *   (b) the flag is a MEDIA-ROW READING rather than a boolean somebody set: `+layout.svelte` mirrors
	 *       it from `hasGuidingTrack(media)`, whose signature takes `Pick<Media, …>` and whose answer
	 *       comes off the row's stem refs.
	 */
	expect(DRAWER).toMatch(/const guideNote = \$derived\(\s*hasSong && !guideEnabled/);
	// Both clauses live in one string, so neither can be dropped without the other being noticed.
	expect(DRAWER).toContain(NOTE);
	// And it reaches the markup, or the derivation is dead code — the old arm's `{controlsNote}` check.
	expect(MARKUP).toMatch(/\{#if guideNote\}/);

	// (b) the flag is a reading of a media row, taken through the shared contract helper.
	expect(LAYOUT).toMatch(/import\s*\{[\s\S]*?hasGuidingTrack[\s\S]*?\}\s*from\s*'\$lib\/contract'/);
	expect(LAYOUT).toMatch(/guideEnabled = !!media && hasGuidingTrack\(media\)/);
	expect(GUIDE_LEVEL).toMatch(/export function hasGuidingTrack\(\s*m: Pick<Media, [^>]*'vocalsRef'/);

	// …and both halves actually reach the drawer, or the mirroring is dead code.
	const call = LAYOUT.slice(
		LAYOUT.indexOf('<NowPlayingDrawer'),
		LAYOUT.indexOf('/>', LAYOUT.indexOf('<NowPlayingDrawer'))
	);
	expect(call).toContain('{guideEnabled}');
	expect(call).toContain('{hasSong}');

	/*
	 * ── FINDING, NOT A WEAKENED ARM (for the owner; outside this file's remit to fix) ───────────────
	 *
	 * The old arm pinned `nowMedia &&`, and its comment said why: `guideEnabled` is ALSO false for a
	 * playing entry whose MEDIA ROW has not reached this client's catalog, and there "no isolated
	 * vocals" is a guess rather than a reading.
	 *
	 * That narrowing did NOT survive the move. `+layout.svelte` mirrors `hasSong = !!entry` while
	 * `guideEnabled = !!media && hasGuidingTrack(media)` — so for an entry whose media row is missing
	 * from `room.mediaCatalog`, `hasSong` is true, `guideEnabled` is false, and the drawer states a fact
	 * about a stem it has never seen. The conjunct is still there, but it is the ENTRY rather than the
	 * ROW.
	 *
	 * It is recorded here rather than asserted because asserting it would red on shipped code, and
	 * rewriting the assertion to accept `!!entry` as if it were the same guarantee is the laundering
	 * this repo bans. The one-line fix belongs in `+layout.svelte`: mirror `hasSong` from `!!media`, or
	 * pass the row's presence separately and gate `guideNote` on it. When that lands, promote this
	 * paragraph into a real assertion.
	 */
});

// ── 4. placement: the reason is read BEFORE the dead control, and only when a song is playing ─────

test('the sentence renders BEFORE the control it explains, inside the hasSong gate (XR-PH-15)', () => {
	/*
	 * WAS: two of the four arms that moved to p16 — "the sentence is in the disclosure BODY, never in
	 * the collapsed summary", and the idle arm's rendered form ("nothing playing offers no live control
	 * and no sentence about one"), which mounted the hero with `hasSong: false`.
	 *
	 * Neither can be rendered here now, for the reason arm 2 asserts. Both are decidable from the
	 * markup's ORDER, which is what this reads. Exactly-once first, so an index comparison cannot be
	 * satisfied by a second copy of either element somewhere harmless.
	 *
	 * THE GATE IS FOUND BACKWARDS FROM `.tools-body`, not forwards from the top of the markup. This read
	 * `MARKUP.indexOf('{#if hasSong}')`, which silently assumed the tools gate was the FIRST such gate in
	 * the component — and it stopped being: the header now wraps `<Drawer.Title>` in its own
	 * `{#if hasSong}` (the title is the dialog's accessible name, so it cannot carry idle copy). The old
	 * anchor then measured "is the note after the TITLE's gate", found the title's `{/if}` in between,
	 * and red. Anchoring on the nearest preceding gate names which gate the claim is about, so a sibling
	 * `{#if hasSong}` anywhere else in the markup is simply not this arm's business.
	 */
	expect(occurrences(MARKUP, 'class="tools-note"')).toBe(1);
	expect(occurrences(MARKUP, '<GuidingTrack')).toBe(1);

	const body = MARKUP.indexOf('class="tools-body"');
	const note = MARKUP.indexOf('class="tools-note"');
	const control = MARKUP.indexOf('<GuidingTrack');
	const gate = MARKUP.lastIndexOf('{#if ', body);

	expect(body).toBeGreaterThanOrEqual(0);
	expect(gate).toBeGreaterThanOrEqual(0);
	// The gate immediately above the tools body is the hasSong one, and nothing else stands between the
	// two — so the block the note sits in is the block a playing song opens.
	const TOOLS = 'class="tools-body"';
	expect(MARKUP.slice(gate, body + TOOLS.length)).toMatch(new RegExp(String.raw`^\{#if hasSong\}\s*<div ${TOOLS}$`));
	// The idle guarantee, structurally: the note is nested inside that `{#if hasSong}` block, so a room
	// with nothing playing cannot reach it. No `{/if}` between the two means the block is still open.
	expect(note).toBeGreaterThan(body);
	expect(MARKUP.slice(gate, note)).not.toContain('{/if}');
	// And the reason precedes the control it explains, rather than trailing it.
	expect(control).toBeGreaterThan(note);
});

// ── 5. XR-PH-03: dimmed by a token, never by an alpha on it or on anything above it ───────────────

test('the sentence is dimmed by an ink token, never by an opacity on it or an ancestor (XR-PH-03)', () => {
	/*
	 * WAS: a MOUNTED arm (moved to p16) asserting the sentence sat OUTSIDE the subtree `.gt.disabled`
	 * dimmed with `opacity`. That subtree no longer exists — `GuidingTrack` deleted
	 * `.gt.disabled { opacity: .5 }` and now dims `.gt-val` with `--ink-dim`, which is the same rule
	 * this arm enforces. So the claim is read from the other side and STRENGTHENED rather than
	 * re-pointed: the note carries its own token, and no rule on the note or on any of its ancestors in
	 * this component declares an alpha at all.
	 *
	 * Why an ancestor `opacity` is the thing banned: it flattens the sentence and the surface behind it
	 * into one buffer, so measured contrast stops being what is painted.
	 */
	const noteRules = rulesFor(CSS, 'tools-note');
	expect(noteRules.length).toBe(1);
	expect(noteRules[0]).toMatch(/color:\s*var\(--ink-dim\)/);

	// Every ancestor of the note that this component styles. Each must be FOUND (or the ban is vacuous
	// against a renamed class) and each must be alpha-free. `.band-slot` is a sibling of the head and
	// body rather than an ancestor of the note, so it is not on this list.
	for (const cls of ['tools-body', 'np-body', 'np-drawer']) {
		const rules = rulesFor(CSS, cls);
		expect(rules.length).toBeGreaterThan(0);
		for (const body of rules) expect(body).not.toMatch(/(^|[^-])\bopacity\s*:/);
	}
	// The note itself, too — a token plus an alpha is still an alpha.
	expect(noteRules[0]).not.toMatch(/(^|[^-])\bopacity\s*:/);

	/*
	 * And the containment half, which is what made this an XR-PH-03 claim in the first place: the note
	 * is a SIBLING of the control rather than a child of it, so nothing `GuidingTrack` does to its own
	 * subtree can reach the sentence. `<GuidingTrack … />` is self-closing, so it HAS no subtree in this
	 * file — that is the structural form of the guarantee.
	 */
	expect(MARKUP).toMatch(/<GuidingTrack[^>]*\/>/);
	expect(GUIDING_TRACK).not.toMatch(/\.gt(\.disabled)?\s*\{[^{}]*\bopacity\s*:/);
});

// ── 6. reversed-proof, preserved verbatim in substance ────────────────────────────────────────────

test('stays reversed-proof: the reason is on the drawer, NOT back inside GuidingTrack', () => {
	// The whole point of arm D. `drawer-ui-cleanup-253.test.ts` bans this phrase from the component and
	// this asserts the same boundary from the other side, so a future edit that relocates the sentence
	// into the component reds here as well as there. Unchanged by the hero→drawer move and by the
	// band/drawer merge: the ruling was about which side of the component boundary the copy lives on,
	// and both sides still exist.
	//
	// Non-vacuity first: a component that had been deleted or renamed would satisfy every ban below by
	// being absent, which is the failure mode a bare `not.toMatch` cannot distinguish from compliance.
	expect(GUIDING_TRACK).toContain('<Slider');
	expect(GUIDING_TRACK).toContain('variant="guiding"');
	expect(GUIDING_TRACK).toContain('disabled={!available}');
	expect(GUIDING_TRACK).not.toMatch(/no isolated vocals/i);
	// was `controlsNote`, the hero-era prop name. The sentence is the drawer's own `guideNote` now, so
	// the reversal to guard against is that identifier appearing here.
	expect(GUIDING_TRACK).not.toContain('guideNote');
	expect(GUIDING_TRACK).not.toContain('controlsNote');
});
