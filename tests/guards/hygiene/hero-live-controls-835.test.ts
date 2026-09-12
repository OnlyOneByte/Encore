// XR-PH-15's honest degradation, measured on the render.
//
// The relocation itself already landed: the guide level, the key row and the range bar are already
// LIVE controls for the playing song, already in the hero's disclosure BODY, and
// `phone-home-shell-832.test.ts` pins that. What XR-PH-15 adds is the clause the relocation could not
// satisfy — "when a song has no isolated vocals stem, the guide-vocal control renders disabled with
// the reason plus a statement that pitch and range still work; it does not vanish".
//
// The reason lives on the HERO, beside the control group, rather than inside `GuidingTrack.svelte`.
// That is the owner's ruling on this issue's Q1 (arm D). It matters because the drawer UI cleanup deliberately DELETED
// an equivalent line from inside the component and `drawer-ui-cleanup-253.test.ts:45-56` pins its
// absence there; arm D is the only arm that satisfies the new row without reversing that ruling or
// re-anchoring its guard. So this file asserts the sentence renders on the hero AND that the cleanup's guard
// subject is untouched — a future edit that "fixes" this by moving the line back into the component
// reds both.
//
// These MOUNT rather than scan (XR-PH-21): every claim is about what renders and where it sits in the
// tree. The one exception is the route rung at the bottom, where the derivation and the copy live and
// `+page.svelte` is not mountable (it imports `$app`) — that half is a source scan by necessity, and
// says so.
import { test, expect, afterEach } from 'bun:test';
import { mount, unmount, flushSync } from '../../../tests/setup/svelte-client';
import { read } from '@encore/test-support';
import HeroControls from './hero-live-controls-835.harness.svelte';

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

/*
 * `openTools` was deleted with the four arms that used it. Opening the disclosure is only
 * meaningful for a claim about what is INSIDE it, and every such claim now runs on the layout rung in
 * `tests/e2e/probes/p16-hero-live-controls.mjs` — the hero cannot be mounted here at all while its
 * disclosure is a Bits UI Collapsible, which reads getBoundingClientRect (XR-VER-03).
 */

const NOTE = 'No isolated vocals for this song, so the guiding track stays off. Key and vocal range still work.';

/*
 * ── FOUR ARMS MOVED TO THE LAYOUT RUNG (XR-VER-03/XR-VER-07) ───────────────────────────────
 *
 * These four claims used to mount the hero here:
 *
 *   - a song with no isolated stem keeps the guide control, disabled, and states why (XR-PH-15)
 *   - a song WITH an isolated stem gets a live control and no explanation (XR-PH-15)
 *   - the reason sits OUTSIDE the subtree the disabled control dims with opacity (XR-PH-03)
 *   - the sentence is in the disclosure BODY, never in the collapsed summary
 *
 * They live in `tests/e2e/probes/p16-hero-live-controls.mjs` now, and this is NOT a relocation of
 * convenience. The Slider adoption moved GuidingTrack's control onto shadcn's <Slider>, which is Bits UI, and Bits UI
 * needs a real layout engine in two independent ways the mount rung deliberately refuses to provide:
 * it reads `offsetWidth`, which the preload replaces with a throw because happy-dom fabricates a zero;
 * and it observes its track with `ResizeObserver`, which the preload does not install and
 * `mount-rung.test.ts` has a live arm ASSERTING is absent. Faking both to keep these tests here would
 * manufacture exactly the silent green those two refusals exist to prevent.
 *
 * The cost is stated plainly rather than buried: these four assertions no longer run on a box with no
 * Chromium. In exchange they now run against a real browser, a real cook, and a real song with no
 * vocals stem — reached through the new `FAKE_NO_VOCALS=1` on the fake stems worker, since
 * `hasGuidingTrack()` is `isPlayable(m) && !!m.vocalsRef`. p16 records the mutations that prove it can
 * still fail.
 *
 * What stays HERE is everything decidable without a layout engine: the route's derivation of the
 * sentence, the copy itself, and the drawer-cleanup source scans below.
 */
// ── the arm that needs no layout engine: nothing playing, so nothing mounts ───────────────────────


// ── the arms where no sentence is owed ───────────────────────────────────────────────────────────

test('nothing playing offers no live control and no sentence about one', () => {
	// `hasSong` already gates the disclosure. The note must not escape that gate and explain a
	// control that is not on screen — an idle room stating "the guiding track stays off" is noise.
	const host = render(HeroControls, { available: false, controlsNote: NOTE, hasSong: false });
	expect(host.querySelector('.tools')).toBeNull();
	expect(host.querySelector('.tools-note')).toBeNull();
	expect((host.textContent ?? '').toLowerCase()).not.toContain('no isolated vocals');
});


// ── the route rung: the derivation and the copy ───────────────────────────────────────────────────
const PAGE = read('src/routes/+page.svelte');
/**
 * Comments stripped, exactly as `drawer-ui-cleanup-253.test.ts` does and for the same reason: the
 * component's own prose NAMES the line the cleanup removed, so an unstripped read would trip a ban the
 * shipped code satisfies. Stripping keeps the two guards reading the same subject.
 */
const GUIDING_TRACK = read('src/lib/components/GuidingTrack.svelte')
	.replace(/<!--[\s\S]*?-->/g, '')
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('the route derives the sentence from a media row, not from the flag alone (Q1-D)', () => {
	// `guideEnabled` is ALSO false for a playing entry whose media row has not reached this client's
	// catalog, and there a missing stem is a guess rather than a reading. `nowMedia &&` is what keeps
	// the sentence honest, so it is pinned: dropping it makes the phone assert a fact it does not have.
	expect(PAGE).toMatch(/const controlsNote = \$derived\(\s*nowMedia && !guideEnabled/);
	// Both clauses live in one string, so neither can be dropped without the other being noticed.
	expect(PAGE).toContain(NOTE);
	// And it reaches the hero, or the derivation is dead code.
	const hero = PAGE.slice(PAGE.indexOf('<NowPlayingHero'), PAGE.indexOf('</NowPlayingHero>'));
	expect(hero).toContain('{controlsNote}');
});

test('stays reversed-proof: the reason is on the hero, NOT back inside GuidingTrack', () => {
	// The whole point of arm D. `drawer-ui-cleanup-253.test.ts` bans this phrase from the component and
	// pins its hint to `available ? … : ''`; this asserts the same boundary from the other side, so a
	// future edit that relocates the sentence into the component reds here as well as there.
	//
	// Non-vacuity first: a component that had been deleted or renamed would satisfy every ban below by
	// being absent, which is the failure mode a bare `not.toMatch` cannot distinguish from compliance.
	// was `class="gt-slider"`. The control is <Slider variant="guiding"> now, whose geometry
	// lives in ui/slider. This arm cares that the CONTROL is still present, not how it is spelled.
	expect(GUIDING_TRACK).toContain('<Slider');
	expect(GUIDING_TRACK).toContain('variant="guiding"');
	expect(GUIDING_TRACK).toContain('disabled={!available}');
	expect(GUIDING_TRACK).not.toMatch(/no isolated vocals/i);
	expect(GUIDING_TRACK).not.toContain('controlsNote');
});
