// The honest degradation of the guiding track, at the address that owns it: `NowPlayingDrawer.svelte`, one
// permanently-mounted sheet with two snap points, the band strip being snap 0.
//
// The file keeps the `hero-` stem because it is one half of a PAIR with
// `tests/e2e/probes/p16-hero-live-controls.mjs`, which holds the four arms that need a real layout engine and
// is registered under that name in three places. Renaming one half alone would leave the pair unfindable.
//
// THE CAPABILITY BOUNDARY: THIS DRAWER CANNOT BE MOUNTED AT ALL, which is why five of the six arms are source
// scans. `.band-slot` carries `bind:clientHeight={bandH}`, Svelte implements a size binding with a
// `ResizeObserver`, and the mount rung deliberately does not install one — so this is the COMPONENT's own
// measurement, which makes every rendered claim about it a layout-rung claim. See
// docs/GUARDS.md#the-rungs-and-what-each-can-honestly-decide.
//
// The boundary is arm 2, an ASSERTION rather than this paragraph: a future Svelte, a future vaul, or a drawer
// that stops measuring itself reds there and sends the next reader here to move the rendered claims home.
// What it costs is stated plainly — a source scan cannot see a cascade, so the arms prove the drawer DECLARES
// the right structure, not that no stylesheet overrides it.
import { test, expect } from 'bun:test';
import { mount, flushSync } from '$setup/svelte-client';
import { read } from '@encore/test-support';
import DrawerHarness from './hero-live-controls.harness.svelte';

/**
 * Comments stripped, as drawer-ui-cleanup.test.ts does: both the drawer and `GuidingTrack` carry prose that
 * NAMES the sentence under test, so every guard on this subject reads the same bytes.
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
 * Everything between the script and the style block. Needed because `MARKUP` starts AT `<Drawer.Root`, so a
 * conditional wrapped AROUND the sheet would sit outside it and be invisible to every scan below — which is
 * exactly what arm 1's permanent-mount claim is about.
 */
const TEMPLATE = DRAWER.slice(DRAWER.indexOf('</script>') + '</script>'.length, DRAWER.indexOf('<style>'));

// Two clauses, two facts: why the control is dead, and what still works. The second half is load-bearing and
// is why this is not just 'off'.
const NOTE = 'No isolated vocals, so no guiding track. Key and range still work.';

/**
 * vaul's snap values, by VALUE and not by index. Snap 1 is `min(0.82, (vh - 176) / vh)` in the component, so
 * 0.82 is its CEILING; both arms below need only a plausible snap-1 PLACEMENT — arm 1 never mounts, and arm 2
 * asserts that mounting throws at either placement, which is a claim about the rung and not about the offset.
 */
const SNAP_BAND = '80px';
const SNAP_OPEN = 0.82;

/**
 * THE MOUNT RUNG'S REFUSAL, IN EITHER OF ITS TWO SHAPES — an API it declines to INSTALL arrives as a bare
 * `ReferenceError`, one it REPLACES arrives as the preload's own message. Which a component hits first is a
 * property of effect order, so the claim is that mounting is REFUSED and the refusal names the rung.
 *
 * Both alternatives stay exact, so a missing module or a real component bug still reds. Not anchored at the
 * END: Svelte appends its component trace to anything thrown inside an effect.
 */
const ABSENT_OBSERVER = /^(?:ResizeObserver is not defined\b|offsetWidth cannot measure on the MOUNT rung\b)/;

/**
 * Every rule body in `css` whose selector list mentions `.cls` as a whole token — ALL of them, not the first:
 * `.np-body` is declared twice in this component, and a ban that reads one of the two is a ban with a hole in
 * it. The style block has no at-rules and no nesting, so a flat `selector { body }` walk is exact.
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
 * Every identifier in the drawer's script that carries the SNAP STATE, so arm 1's ban is on the state rather
 * than on a hand-written list of names: the two bindable props, plus any `$derived` READING `activeSnapPoint`.
 * Derived rather than hard-coded because a ban on an identifier a tidy-up deleted is a vacuous
 * `not.toContain`, while this way a NEW reading of the snap state is banned the moment it is written.
 */
function snapIdentifiers(drawer: string): string[] {
	const out = ['open', 'activeSnapPoint'];
	for (const [, name, body] of drawer.matchAll(/const (\w+) = \$derived\(([\s\S]*?)\);/g)) {
		if (/\bactiveSnapPoint\b/.test(body) && !out.includes(name!)) out.push(name!);
	}
	return out;
}

/**
 * Try to mount the harness with the sheet PLACED at `snap` and report what the attempt left behind. Returns
 * rather than throws, because arm 2's claim is a conjunction a bare `expect(fn).toThrow()` cannot carry.
 * `drawerNodes` is a COUNT rather than an element (docs/GUARDS.md#accidental-green-and-its-mirror), and the
 * document is swept back to its prior contents so a half-built portal cannot be read as a render by the next
 * placement.
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
		'[data-slot="drawer-content"],.np-drawer,.band-slot, [data-slot="slider"],.tools-note'
	).length;
	host.remove();
	for (const node of Array.from(document.body.childNodes)) {
		if (!before.has(node)) node.remove();
	}
	return { threw, sentinel, drawerNodes };
}

// arm 1 — permanent mount: the DOM does not vary with the snap point.
test('the sheet is PERMANENTLY MOUNTED, and no snap state gates anything inside it', () => {
	/*
	 * A snap-pointed sheet keeps its whole body in the document and TRANSLATES it below the fold, so at snap 0
	 * the body, the guide row and its Slider are all mounted: the container no longer supplies the "a Slider
	 * must not mount while hidden" guarantee and nothing else does. That claim is RETIRED, not reworded — its
	 * rendered successor is a TRANSFORM OFFSET, a layout-rung claim, in tests/e2e/probes/.
	 *
	 * What IS decidable here is the DOM half: the mounted tree does not depend on the snap point at all. It
	 * needs no geometry but cannot be rendered either (arm 2), so it is read from the source's conditionals,
	 * and a gate naming a snap identifier is exactly how the tree WOULD come to vary.
	 */
	// Not vacuous: the content whose mounting is at stake is really declared.
	expect(MARKUP).toContain('<GuidingTrack');
	expect(MARKUP).toContain('class="tools-note"');

	// (a) born open, permanently. `open` defaults TRUE and no gate below may read it.
	expect(DRAWER).toMatch(/open = \$bindable\(true\)/);
	// (b) the snap state exists and is bindable, so the identifiers banned below are LIVE state a gate could
	//     plausibly be written against rather than names that happen to be absent.
	expect(DRAWER).toMatch(/activeSnapPoint = \$bindable\(null\)/);
	expect(DRAWER).toMatch(/snapPoints=\{\[SNAP_BAND, SNAP_OPEN\]\}/);

	// (c) the sheet itself is not behind a conditional — a `{#if}` wrapped AROUND `<Drawer.Root>` would sit
	//     outside MARKUP entirely, so the region before it is read separately.
	const rootAt = TEMPLATE.indexOf('<Drawer.Root');
	expect(rootAt).toBeGreaterThanOrEqual(0);
	expect(TEMPLATE.slice(0, rootAt)).not.toContain('{#if');

	// (d) and no gate INSIDE the sheet reads the snap state, so every element it mounts is mounted at
	//     both heights.
	const inside = gates(MARKUP);
	// Non-vacuity, both halves: the gate collector really found this component's conditionals — including the
	// one gate the body genuinely has — and the ban list really names live state.
	expect(inside.length).toBeGreaterThanOrEqual(8);
	expect(inside).toContain('hasSong');
	const banned = snapIdentifiers(DRAWER);
	expect(banned.length).toBeGreaterThanOrEqual(2);
	for (const id of banned) {
		const token = new RegExp(`\\b${id}\\b`);
		expect(inside.filter((g) => token.test(g))).toEqual([]);
	}

	/*
	 * Mutation-tested: gating `.tools-body` on the snap state, wrapping `<Drawer.Root>` in an `{#if}`, flipping
	 * `open` to `$bindable(false)`, making `activeSnapPoint` a plain `let`, deleting `snapPoints`, or breaking
	 * the `gates()` regex each red exactly this arm. Deleting the unused `collapsed` derived does NOT — which is
	 * the point of deriving the ban list rather than hard-coding it.
	 */
});

// arm 2 — the boundary, asserted rather than narrated.
test('MOUNTING the drawer is NOT decidable on the mount rung, and says which API blocks it', () => {
	// Mounted the way the app mounts it, which is the only way there is: born open, at a snap point. Both
	// placements are attempted, and the pair is the point rather than repetition — the boundary must not be a
	// function of where the sheet sits. `hasSong: true` is deliberate: the blocker is inside the sheet's body.
	for (const snap of [SNAP_BAND, SNAP_OPEN]) {
		const { threw, sentinel } = attemptMount(snap);
		// The harness itself mounted and the placement arrived, so the absence below is the DRAWER's rather than a
		// dead harness reporting nothing. Declared ahead of the drawer, so it survives the drawer's throw.
		expect(sentinel).toBe(String(snap));
		expect(threw).toMatch(ABSENT_OBSERVER);
		// THE SHEET IS NOT USABLE, WHICH IS THE CLAIM — not that the document is untouched. The blocker sits deep
		// inside GuidingTrack, so the portal HAS attached by the time the throw lands. Pinning a node count would
		// pin the throw SITE; the rung claim rests entirely on the throw, which a partial mount cannot satisfy.
		expect(threw, 'a partial mount must still be a refusal, not a silent success').toBeString();
	}

	// …and the API is named from the SOURCE too, so the story above is checked rather than narrated: the size
	// binding sits on `.band-slot`, outside every gate, and its target is the `bandH` the layout publishes.
	expect(MARKUP).toMatch(/<div class="band-slot"[^>]*bind:clientHeight=\{bandH\}/);
	expect(DRAWER).toMatch(/bandH = \$bindable\(\d+\)/);
	expect(LAYOUT).toContain('bind:bandH={dockH}');

	/*
	 * Mutation-tested: deleting `bind:clientHeight={bandH}` from `.band-slot` reds this arm, and so does
	 * installing a no-op `ResizeObserver` before the mount — which stands in for the rung gaining one, or the
	 * drawer stopping measuring itself. That second one is the whole promise of the header: the boundary is not
	 * narrated, it is the thing that fails when the boundary moves.
	 */
});

// arm 3 — the sentence comes from the SONG, never from a bare flag.
test('the drawer derives the sentence from the song, not from the flag alone (Q1-D, re-pointed)', () => {
	// Two halves, both pinned because either alone is satisfiable by a bare flag: (a) the drawer conjoins the
	// flag with "there IS a song", so an idle room does not announce that its guiding track is off; and (b) the
	// flag is a MEDIA-ROW READING — mirrored from `hasGuidingTrack(media)`, whose answer is the row's stem refs.
	expect(DRAWER).toMatch(/const guideNote = \$derived\(\s*hasSong && !guideEnabled/);
	// Both clauses live in one string, so neither can be dropped without the other being noticed.
	expect(DRAWER).toContain(NOTE);
	// And it reaches the markup, or the derivation is dead code.
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
	 * OPEN FINDING, recorded rather than asserted (the fix is outside this file's remit). `guideEnabled` is also
	 * false for a playing entry whose MEDIA ROW has not reached this client's catalog, where "no isolated
	 * vocals" is a guess rather than a reading. `+layout.svelte` mirrors `hasSong = !!entry` while `guideEnabled
	 * = !!media && hasGuidingTrack(media)`, so the conjunct is the ENTRY rather than the ROW and the drawer can
	 * state a fact about a stem it has never seen. Asserting it would red on shipped code, and rewriting the
	 * assertion to accept `!!entry` as the same guarantee is laundering. The one-line fix is in `+layout.svelte`:
	 * mirror `hasSong` from `!!media`, or pass the row's presence separately and gate `guideNote` on it. When
	 * that lands, promote this into a real assertion.
	 */
});

// arm 4 — placement: the reason is read BEFORE the dead control, and only when a song is playing.
test('the sentence renders BEFORE the control it explains, inside the hasSong gate', () => {
	/*
	 * Both halves are decidable from the markup's ORDER, exactly-once first so an index comparison cannot be
	 * satisfied by a second copy of either element somewhere harmless. THE GATE IS FOUND BACKWARDS FROM
	 * `.tools-body`: a forward `indexOf('{#if hasSong}')` assumed the tools gate was the FIRST such gate, and
	 * the header wraps `<Drawer.Title>` in its own (the title is the dialog's accessible name, so it cannot
	 * carry idle copy), so the old anchor found the title's `{/if}` in between and red.
	 */
	expect(occurrences(MARKUP, 'class="tools-note"')).toBe(1);
	expect(occurrences(MARKUP, '<GuidingTrack')).toBe(1);

	const body = MARKUP.indexOf('class="tools-body"');
	const note = MARKUP.indexOf('class="tools-note"');
	const control = MARKUP.indexOf('<GuidingTrack');
	const gate = MARKUP.lastIndexOf('{#if ', body);

	expect(body).toBeGreaterThanOrEqual(0);
	expect(gate).toBeGreaterThanOrEqual(0);
	// The gate immediately above the tools body is the hasSong one, with nothing between the two.
	const TOOLS = 'class="tools-body"';
	expect(MARKUP.slice(gate, body + TOOLS.length)).toMatch(new RegExp(String.raw`^\{#if hasSong\}\s*<div ${TOOLS}$`));
	// The idle guarantee, structurally: the note is nested inside that `{#if hasSong}` block, so a room with
	// nothing playing cannot reach it. No `{/if}` between the two means the block is still open.
	expect(note).toBeGreaterThan(body);
	expect(MARKUP.slice(gate, note)).not.toContain('{/if}');
	// And the reason precedes the control it explains, rather than trailing it.
	expect(control).toBeGreaterThan(note);
});

// arm 5 — dimmed by a token, never by an alpha on it or on anything above it.
test('the sentence is dimmed by an ink token, never by an opacity on it or an ancestor', () => {
	// The note carries its own `--ink-dim`, and no rule on it or on any of its ancestors in this component
	// declares an alpha: an ancestor `opacity` flattens the sentence and the surface behind it into one buffer,
	// so measured contrast stops being what is painted.
	const noteRules = rulesFor(CSS, 'tools-note');
	expect(noteRules.length).toBe(1);
	expect(noteRules[0]).toMatch(/color:\s*var\(--ink-dim\)/);

	// Every ancestor of the note this component styles. Each must be FOUND (or the ban is vacuous against a
	// renamed class) and each must be alpha-free. `.band-slot` is a sibling, not an ancestor.
	for (const cls of ['tools-body', 'np-body', 'np-drawer']) {
		const rules = rulesFor(CSS, cls);
		expect(rules.length).toBeGreaterThan(0);
		for (const body of rules) expect(body).not.toMatch(/(^|[^-])\bopacity\s*:/);
	}
	// The note itself, too — a token plus an alpha is still an alpha.
	expect(noteRules[0]).not.toMatch(/(^|[^-])\bopacity\s*:/);

	/*
	 * And the containment half: the note is a SIBLING of the control rather than a child, so nothing
	 * `GuidingTrack` does to its own subtree can reach the sentence. `<GuidingTrack … />` is self-closing, so it
	 * HAS no subtree in this file — that is the structural form of the guarantee.
	 */
	expect(MARKUP).toMatch(/<GuidingTrack[^>]*\/>/);
	expect(GUIDING_TRACK).not.toMatch(/\.gt(\.disabled)?\s*\{[^{}]*\bopacity\s*:/);
});

// arm 6 — reversed-proof: the reason stays on the drawer.
test('stays reversed-proof: the reason is on the drawer, NOT back inside GuidingTrack', () => {
	// drawer-ui-cleanup.test.ts bans this phrase from the component; this asserts the same boundary from the
	// other side, so an edit relocating the sentence into the component reds in both places. Non-vacuity first:
	// a deleted or renamed component would satisfy every ban below by being absent.
	expect(GUIDING_TRACK).toContain('<Slider');
	expect(GUIDING_TRACK).toContain('variant="guiding"');
	expect(GUIDING_TRACK).toContain('disabled={!available}');
	expect(GUIDING_TRACK).not.toMatch(/no isolated vocals/i);
	// `controlsNote` is the hero-era prop name; the sentence is the drawer's own `guideNote` now, so the
	// reversal to guard against is either identifier appearing here.
	expect(GUIDING_TRACK).not.toContain('guideNote');
	expect(GUIDING_TRACK).not.toContain('controlsNote');
});
