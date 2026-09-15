// XR-PH-15's honest degradation, at its NEW ADDRESS.
//
// ── WHAT MOVED, AND WHAT THIS FILE NOW WATCHES ─────────────────────────────────────────────────────
//
// `NowPlayingHero` is DELETED. Its job is `NowPlayingDrawer.svelte` now — a bottom drawer (shadcn
// `ui/drawer` over `vaul-svelte`) mounted in `+layout.svelte` as the expansion of the persistent
// now-playing band. Home is queue-only. So every subject this file used to read on the hero, or on the
// route that fed the hero, moved with it:
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
// ── THE CAPABILITY BOUNDARY: THIS DRAWER CANNOT BE OPENED ON THE MOUNT RUNG ────────────────────────
//
// Stated up front because it is the reason three of the six arms below are source scans rather than
// renders, and because it is MEASURED, not assumed. `vaul` reads box geometry the moment it opens, and
// `svelte-dom-preload.ts` deliberately replaces every geometry API with a throw (XR-VER-03) because
// happy-dom fabricates a zero. Two independent reads, both unavoidable from here:
//
//   1. THE DRAWER ITSELF. `vaul-svelte/dist/use-prevent-scroll.svelte.js:185` reads
//      `document.documentElement.clientWidth` to size the scrollbar gutter when a MODAL drawer opens.
//      `NowPlayingDrawer` does not pass `modal={false}`, and it is not this file's business to make it.
//      `use-drawer-root.svelte.js:67-68,248-269,423-424` reads `getBoundingClientRect()` on the same
//      path. Measured: opening throws with `hasSong: false`, so the blocker is the CONTAINER and holds
//      even for a drawer with no controls in it at all.
//   2. THE CONTROL. With `hasSong: true` the body mounts `GuidingTrack`, whose Bits UI `Slider` reads
//      `offsetWidth` and observes its track with `ResizeObserver` — the same pair `slider.svelte:17-24`
//      and `docs/ux/04-verification.md` already record as what pushed four of this issue's arms onto
//      the layout rung. `mount-rung.test.ts` has a live arm asserting `ResizeObserver` is ABSENT.
//
// Faking either would manufacture exactly the silent green those refusals exist to prevent, so neither
// is faked. Instead the boundary is an ASSERTION (arm 2), not a paragraph: if a future `vaul`, or a
// `modal={false}`, makes the drawer openable here, that arm reds and sends the next reader back to this
// header to move the rendered claims home. A comment cannot do that.
//
// WHAT THAT COSTS, PLAINLY. The three placement/dimming claims below are decided from SOURCE, not from
// a render. A source scan cannot see a cascade, so it proves the drawer DECLARES the right structure
// and not that a stylesheet elsewhere fails to override it. p16 is where the rendered half belongs, and
// p16 is stale — the gap is real and named rather than papered over.
import { test, expect, afterEach } from 'bun:test';
import { mount, unmount, flushSync } from '$setup/svelte-client';
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

const NOTE = 'No isolated vocals for this song, so the guiding track stays off. Key and vocal range still work.';

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

let live: Array<{ comp: unknown; host: HTMLElement }> = [];
afterEach(() => {
	for (const { comp, host } of live) {
		void unmount(comp as never);
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

// ── 1. the mount arm: a closed drawer, and why that is a claim rather than a formality ────────────

test('a CLOSED drawer mounts no live control at all — the container is the mount constraint', () => {
	/*
	 * WHAT THIS REPLACES. The hero needed an explicit `{#if controlsOpen}` INSIDE its Collapsible,
	 * because a Collapsible renders its content always and merely hides it — and `GuidingTrack`'s
	 * Slider must not mount while hidden (it reads `offsetWidth`). `NowPlayingDrawer`'s header claims
	 * that condition is now met STRUCTURALLY, because a drawer portals its content on open and destroys
	 * it on close, so there is nothing left to remember.
	 *
	 * This arm is that claim, executable. It is NOT vacuous and it is NOT a tautology: if the drawer
	 * ever rendered its body while closed, `GuidingTrack` would mount, the Slider would read
	 * `offsetWidth`, and the XR-VER-03 hardening would make THIS TEST THROW rather than quietly find an
	 * extra element. `hasSong: true` is therefore load-bearing — it is the arm where a body exists to
	 * leak.
	 */
	// Not vacuous: the content asserted absent is really declared, so an emptied component cannot pass.
	expect(MARKUP).toContain('<GuidingTrack');
	expect(MARKUP).toContain('class="tools-note"');

	const host = render(DrawerHarness, { hasSong: true, guideEnabled: false });

	// The expand affordance mounted, so the harness itself is alive and the queries below mean something.
	expect(host.querySelector('[data-testid="expand"]')).not.toBeNull();
	// Queried on the DOCUMENT, not the host: vaul portals to the end of `document.body`, so a
	// host-scoped query would report "absent" for content that had in fact rendered.
	expect(document.querySelector('[data-slot="drawer-content"]')).toBeNull();
	expect(document.querySelector('[data-slot="slider"]')).toBeNull();
	expect(document.querySelector('.tools-note')).toBeNull();
	expect((document.body.textContent ?? '').toLowerCase()).not.toContain('no isolated vocals');
});

// ── 2. the boundary, asserted rather than narrated ────────────────────────────────────────────────

test('opening the drawer is NOT decidable on the mount rung (XR-VER-03), and says which API blocks it', () => {
	/*
	 * Opened the way the app opens it: mounted CLOSED, then flipped by the harness's stand-in for the
	 * band's `onexpand`. Mounting with `open: true` would prove less — born-open is a path
	 * `+layout.svelte` never takes, since it declares `let drawerOpen = $state(false)`.
	 *
	 * `hasSong: false` is deliberate: the body — and therefore `GuidingTrack`'s Slider — is gated behind
	 * `{#if hasSong}`, so this arm isolates the DRAWER's own geometry read. It throwing here is what
	 * proves the blocker is the container and not the control, which is why arms 4 and 5 are scans even
	 * for claims that have nothing to do with a slider.
	 *
	 * The matcher is the rung's own message, so a DIFFERENT failure (a missing `ResizeObserver`, say)
	 * reds this arm rather than passing it — "still unopenable, but for a new reason" is a finding too,
	 * and the assertion text is where the next reader is told to re-read the header.
	 */
	const host = render(DrawerHarness, { hasSong: false, guideEnabled: false });
	const expand = host.querySelector('[data-testid="expand"]') as HTMLElement | null;
	expect(expand).not.toBeNull();

	// The debris of a half-mounted drawer is swept before the next arm can read it as a render.
	const before = new Set<Node>(Array.from(document.body.childNodes));
	expect(() => {
		expand?.click();
		flushSync();
	}).toThrow(/cannot measure on the MOUNT rung/);
	for (const node of Array.from(document.body.childNodes)) {
		if (!before.has(node)) node.remove();
	}
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
	 */
	expect(occurrences(MARKUP, 'class="tools-note"')).toBe(1);
	expect(occurrences(MARKUP, '<GuidingTrack')).toBe(1);

	const gate = MARKUP.indexOf('{#if hasSong}');
	const body = MARKUP.indexOf('class="tools-body"');
	const note = MARKUP.indexOf('class="tools-note"');
	const control = MARKUP.indexOf('<GuidingTrack');

	expect(gate).toBeGreaterThanOrEqual(0);
	// The idle guarantee, structurally: the note is nested inside the `{#if hasSong}` block, so a room
	// with nothing playing cannot reach it. No `{/if}` between the two means the block is still open.
	expect(body).toBeGreaterThan(gate);
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
	// against a renamed class) and each must be alpha-free.
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
	// into the component reds here as well as there. Unchanged by the hero→drawer move: the ruling was
	// about which side of the component boundary the copy lives on, and both sides still exist.
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
