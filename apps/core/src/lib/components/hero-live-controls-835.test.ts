// XR-PH-15's honest degradation, measured on the render (issue #835).
//
// The relocation itself landed with #832: the guide level, the key row and the range bar are already
// LIVE controls for the playing song, already in the hero's disclosure BODY, and
// `phone-home-shell-832.test.ts` pins that. What #835 adds is the clause the relocation could not
// satisfy — "when a song has no isolated vocals stem, the guide-vocal control renders disabled with
// the reason plus a statement that pitch and range still work; it does not vanish".
//
// The reason lives on the HERO, beside the control group, rather than inside `GuidingTrack.svelte`.
// That is the owner's ruling on this issue's Q1 (arm D). It matters because #253 deliberately DELETED
// an equivalent line from inside the component and `drawer-ui-cleanup-253.test.ts:45-56` pins its
// absence there; arm D is the only arm that satisfies the new row without reversing that ruling or
// re-anchoring its guard. So this file asserts the sentence renders on the hero AND that #253's guard
// subject is untouched — a future edit that "fixes" this by moving the line back into the component
// reds both.
//
// These MOUNT rather than scan (XR-PH-21): every claim is about what renders and where it sits in the
// tree. The one exception is the route rung at the bottom, where the derivation and the copy live and
// `+page.svelte` is not mountable (it imports `$app`) — that half is a source scan by necessity, and
// says so.
import { test, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mount, unmount, flushSync } from '../../../../../test-setup/svelte-client';
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

/** Open the live-controls disclosure, the way a singer reaching for the controls does. */
function openTools(host: HTMLElement): void {
	const toggle = host.querySelector('.tools-toggle') as HTMLButtonElement | null;
	expect(toggle).not.toBeNull();
	toggle!.click();
	flushSync();
}

const NOTE = 'No isolated vocals for this song, so the guiding track stays off. Key and vocal range still work.';

// ── the degraded arm: disabled, present, and explained ───────────────────────────────────────────
test('a song with no isolated stem keeps the guide control, disabled, and states why (XR-PH-15)', () => {
	const host = render(HeroControls, { available: false, controlsNote: NOTE });
	openTools(host);

	// It does NOT vanish: the row and its slider are both on screen…
	const slider = host.querySelector('input[type="range"]') as HTMLInputElement | null;
	expect(slider).not.toBeNull();
	expect(slider!.disabled).toBe(true);
	// …and the readout says the level is dead rather than showing a live-looking number.
	expect(host.querySelector('.gt-val')?.textContent).toBe('Off');

	// The reason is on screen, and so is the second clause — what still works. Both halves are
	// asserted, because a reason alone leaves a singer thinking the whole control group is dead.
	const note = host.querySelector('.tools-note') as HTMLElement | null;
	expect(note).not.toBeNull();
	expect(note!.textContent).toBe(NOTE);
	expect(note!.textContent!.toLowerCase()).toContain('no isolated vocals');
	expect(note!.textContent!.toLowerCase()).toContain('still work');
});

test('the reason sits OUTSIDE the subtree the disabled control dims with opacity (XR-PH-03)', () => {
	// The hazard this test exists for: `.gt.disabled { opacity: 0.5 }` flattens its whole subtree into
	// one buffer, so a sentence rendered inside it paints at roughly half the contrast its token was
	// measured at. `.key.disabled` does the same in the route. The structural claim — the note is a
	// SIBLING of the control group, not a descendant of a dimmed control — is what keeps the painted
	// contrast equal to the measured contrast, and it is checkable here where a stylesheet is not.
	const host = render(HeroControls, { available: false, controlsNote: NOTE });
	openTools(host);
	const note = host.querySelector('.tools-note') as HTMLElement;
	const gt = host.querySelector('.gt') as HTMLElement;

	expect(gt.classList.contains('disabled')).toBe(true);
	expect(note.closest('.gt')).toBeNull();
	// Nor does anything between the note and the card root carry an inline opacity, the dimension a
	// CSS-rule scan structurally cannot see (the same argument as phone-inventory's XR-PH-03 arm).
	for (let el: HTMLElement | null = note; el; el = el.parentElement) {
		expect(el.style.opacity).toBe('');
		if (el.classList.contains('hero')) break;
	}

	// In the body, and ahead of the control it explains: read before the dead slider, not after it.
	expect(note.closest('.tools-body')).not.toBeNull();
	expect(note.compareDocumentPosition(gt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

// ── the arms where no sentence is owed ───────────────────────────────────────────────────────────
test('a song WITH an isolated stem gets a live control and no explanation (XR-PH-15)', () => {
	// The note is the route's business, not the hero's: with a stem the route passes null, and the hero
	// must then render no empty element holding a gap open under the label.
	const host = render(HeroControls, { available: true, controlsNote: null });
	openTools(host);
	const slider = host.querySelector('input[type="range"]') as HTMLInputElement;
	expect(slider.disabled).toBe(false);
	expect(host.querySelector('.tools-note')).toBeNull();
	expect((host.textContent ?? '').toLowerCase()).not.toContain('no isolated vocals');
});

test('nothing playing offers no live control and no sentence about one', () => {
	// `hasSong` already gates the disclosure (#832). The note must not escape that gate and explain a
	// control that is not on screen — an idle room stating "the guiding track stays off" is noise.
	const host = render(HeroControls, { available: false, controlsNote: NOTE, hasSong: false });
	expect(host.querySelector('.tools')).toBeNull();
	expect(host.querySelector('.tools-note')).toBeNull();
	expect((host.textContent ?? '').toLowerCase()).not.toContain('no isolated vocals');
});

test('the sentence is in the disclosure BODY, never in the collapsed summary', () => {
	// The summary is a peek at VALUES. A reason there would push the values off a 320px row, and the
	// reason has nothing to say until the control it explains is visible.
	const host = render(HeroControls, {
		available: false,
		controlsNote: NOTE,
		controlsSummary: 'Range C3–A4'
	});
	const toggle = host.querySelector('.tools-toggle') as HTMLButtonElement;
	expect(toggle.getAttribute('aria-expanded')).toBe('false');
	expect(host.textContent).toContain('Range C3–A4');
	expect(host.querySelector('.tools-note')).toBeNull();
	expect(toggle.textContent?.toLowerCase()).not.toContain('no isolated vocals');

	openTools(host);
	expect(host.querySelector('.tools-toggle .tools-note')).toBeNull();
	expect(host.querySelector('.tools-body .tools-note')).not.toBeNull();
});

// ── the route rung: the derivation and the copy ───────────────────────────────────────────────────
const SRC = new URL('../../', import.meta.url).pathname;
const PAGE = readFileSync(`${SRC}routes/+page.svelte`, 'utf8');
/**
 * Comments stripped, exactly as `drawer-ui-cleanup-253.test.ts` does and for the same reason: the
 * component's own prose NAMES the line #253 removed, so an unstripped read would trip a ban the
 * shipped code satisfies. Stripping keeps the two guards reading the same subject.
 */
const GUIDING_TRACK = readFileSync(`${SRC}lib/components/GuidingTrack.svelte`, 'utf8')
	.replace(/<!--[\s\S]*?-->/g, '')
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('the route derives the sentence from a media row, not from the flag alone (#835 Q1-D)', () => {
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

test('#253 stays reversed-proof: the reason is on the hero, NOT back inside GuidingTrack', () => {
	// The whole point of arm D. `drawer-ui-cleanup-253.test.ts` bans this phrase from the component and
	// pins its hint to `available ? … : ''`; this asserts the same boundary from the other side, so a
	// future edit that relocates the sentence into the component reds here as well as there.
	//
	// Non-vacuity first: a component that had been deleted or renamed would satisfy every ban below by
	// being absent, which is the failure mode a bare `not.toMatch` cannot distinguish from compliance.
	expect(GUIDING_TRACK).toContain('class="gt-slider"');
	expect(GUIDING_TRACK).toContain('disabled={!available}');
	expect(GUIDING_TRACK).not.toMatch(/no isolated vocals/i);
	expect(GUIDING_TRACK).not.toContain('controlsNote');
});
