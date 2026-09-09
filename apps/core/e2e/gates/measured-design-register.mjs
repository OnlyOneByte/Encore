/*
 * THE CONTROL REGISTER AND THE MEASURED NUMBERS — data only, no driving.
 *
 * Split out of `measured-design.mjs` so two different readers can use it: the gate itself, which
 * measures against it, and `apps/core/src/lib/measured-design-gate.test.ts`, which runs inside
 * `bun test` on every box and asserts this register is non-vacuous, that every quarantine entry
 * carries a substantive reason, and that the gate is actually wired into the gate list. A register
 * that only the gate can read is a register nobody checks when the gate does not run.
 *
 * ── WHY A QUARANTINE EXISTS AT ALL ─────────────────────────────────────────────────────────────
 *
 * Issue #823 moved four honour-system claims onto real measurement. The first thing a real
 * measurement did was find four control classes the source scan had been waving through for as long
 * as it has existed — because `touch-targets.test.ts`'s structural arm skips any rule that declares
 * no hard height, and every one of these four sizes itself from padding or a UA default.
 *
 * Fixing them is a production change with its own design questions (you do not "raise a checkbox to
 * 44px"; you make its label the target), and issue #831 already owns strengthening the touch-target
 * guard. So they are QUARANTINED here with the number each one actually measures, and the gate's job
 * is that the set never grows and never gets worse. This is the annotated-baseline shape the repo
 * already uses when a widened guard surfaces pre-existing violations — the alternative, shipping a
 * red gate, blocks every lane on work this issue was not dispatched to do.
 *
 * ── AN IMPROVEMENT IS A FINDING TOO ────────────────────────────────────────────────────────────
 *
 * The gate FAILS when a quarantined control reaches the 44px floor, not just when it regresses. A
 * quarantine entry whose defect no longer reproduces is a guard that can no longer fail, which is
 * what XR-VER-07 exists to stop; and because these numbers come from a real browser, "no longer
 * reproduces" can also mean "this box ships a different UA default", which is equally something a
 * reader must be told rather than a green run. Either way the resolution is to re-decide the entry
 * on the record, never to nudge a number.
 */

/** Encore's own tap floor, stricter than WCAG 2.2 SC 2.5.8's 24px. Read live from `--tap` too. */
export const TAP = 44;

/** The 16px iOS-zoom threshold — XR-VER-10. A WebKit behaviour, not a published success criterion. */
export const MIN_FIELD_PX = 16;

/** The sheet cap, as a FRACTION of the visual viewport: `max-height: 82dvh`. XR-VER-11. */
export const SHEET_CAP_FRACTION = 0.82;

/** A simulated home-indicator inset, in px, used to prove the safe-area term is really composed in. */
export const SIMULATED_BOTTOM_INSET = 34;

/**
 * The viewports every control is measured at — XR-VER-09's acceptance names these three.
 * @type {{ name: string, w: number, h: number }[]}
 */
export const VIEWPORTS = [
	{ name: 'iphone-14', w: 390, h: 844 },
	{ name: 'small-android', w: 360, h: 740 },
	{ name: 'iphone-14-pro-max', w: 430, h: 932 }
];

/**
 * What counts as an interactive control. Derived from the roles a user can actually operate, not
 * from a hand-listed class allowlist — that is the mistake `touch-targets.test.ts` was already
 * corrected for once (#400), and re-introducing it here would re-introduce the blindness.
 */
export const CONTROL_SELECTOR = [
	'button',
	'a[href]',
	'input:not([type="hidden"])',
	'select',
	'textarea',
	'[role="button"]',
	'[tabindex]:not([tabindex="-1"])'
].join(', ');

/** Text-entry input types, for XR-VER-10. A range or colour input has no text to zoom. */
export const TEXT_INPUT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'number', 'password', ''];

/*
 * ── THREE PLATFORM PREDICATES, SINGLE-SOURCED HERE RATHER THAN IN contract.ts ──────────────────
 *
 * `contract.test.ts` bans a hand-written selector literal in any e2e driver, and it is right to: a
 * selector naming Encore's own markup rots the moment that markup moves, which is why every surface
 * anchor comes from `SEL`. These three are not that. `[inert]`, `label` and `:focus-visible` are DOM
 * and CSS constructs — they cannot drift with Encore's markup, and two of them (`label`, and a
 * pseudo-class that exists only while an element is focused) have no anchor in any .svelte file for
 * `contract.ts`'s anchor-resolution guard to bind to. So they live beside CONTROL_SELECTOR, in the one
 * module that is the gate's own single source, instead of being spelled out at each call site.
 */

/** A subtree the user cannot reach — behind an open modal. A reading there is legitimately 0. */
export const INERT_SELECTOR = '[inert]';

/** The wrapper whose text names a bare control (a checkbox has no accessible name of its own). */
export const LABEL_SELECTOR = 'label';

/** The state XR-VER-12 is about. An element not in it is UNMEASURED, never satisfied (XR-VER-03). */
export const FOCUS_VISIBLE = ':focus-visible';

/**
 * Known sub-floor controls, each with the number it measures and why it is not fixed here.
 *
 * `where` is the surface the gate drove to reach it. `match` is matched against the reading's own
 * identity fields, all of which must be present and equal — a partial match is not a match, so a
 * quarantine cannot silently absorb a NEW offender that happens to share a tag.
 *
 * `measured` is the worst hit extent observed across every viewport. The gate fails if a reading is
 * more than 1px worse (sub-pixel layout differs between viewport widths) and fails if a reading
 * reaches TAP.
 *
 * @type {{ where: string, match: { tag: string, type?: string | null, cls?: string, near?: string }, measured: number, reason: string }[]}
 */
export const QUARANTINE = [
	{
		where: '/',
		match: { tag: 'input', type: null, cls: '', near: 'Search a song or artist' },
		measured: 22,
		reason:
			'The search field is a bare <input> inside `div.card.searchbox`, which carries the padding that makes the box look tappable. The wrapper is a div, not a label, so tapping its padding focuses nothing — the real hit extent is the input text line, 22px. The structural arm of touch-targets.test.ts cannot see this: the input rule declares no height at all, so it is skipped before any comparison. Fixing it means either min-height on the input or making the wrapper a label, both of which change the searchbox layout; issue #831 owns the touch-target guard and this belongs with it.'
	},
	{
		where: '/settings',
		match: { tag: 'select', type: null },
		measured: 41,
		reason:
			"Every <select> on /settings sizes from the UA default plus the route's own padding and lands at 41px — 3px short. `min-height: var(--tap)` would close it, but a native select's intrinsic box is browser-owned, so the fix has to be verified on a real render rather than declared; that verification is what this gate now provides, and the change itself is the touch-target work in #831."
	},
	{
		where: '/settings',
		match: { tag: 'input', type: 'checkbox', cls: '', near: 'Song intro before each turn' },
		measured: 18,
		reason:
			'The song-intro toggle is a bare 18px checkbox. A checkbox is the one control you do NOT raise to 44px by resizing it — the fix is to make its wrapping label the target, which is a markup change to the settings row and a design decision about the whole label-plus-control pattern on that page. Recorded here rather than guessed at.'
	},
	{
		where: '/settings',
		match: { tag: 'input', type: 'text', cls: 'text', near: 'Address phones join at' },
		measured: 35,
		reason:
			'The join-address field on the Server tab measures 35px. Its own rule sets font-size and padding but no height, which is exactly the shape the structural scan skips. Same fix and same owner as the search field above (#831).'
	}
];

/**
 * NON-VACUITY FLOORS FOR THE GATE ITSELF — XR-VER-05 applies to a measured guard as much as to a
 * source scan. A driver that navigates successfully but finds no controls (a changed selector, a
 * route that now redirects, a join that silently failed) would otherwise report every assertion
 * satisfied over an empty set. Measured on 2026-09-09 against `origin/main` d325c64: 7 controls on
 * the collapsed home route, 22 on /settings You, 1 on /metrics, 62 in total across the whole drive
 * at one viewport. The floors sit well under those so ordinary UI churn does not trip them.
 *
 * A firing floor here is a FINDING, never a number to adjust — see XR-VER-06.
 */
export const FLOORS = {
	/** interactive controls measured, summed over every surface and every viewport */
	controlsMeasured: 90,
	/** distinct surfaces the drive actually reached and swept */
	surfacesSwept: 4,
	/** text-entry fields whose computed font-size was read */
	fieldsMeasured: 3,
	/** elements focused and whose focus indicator was read */
	focusedMeasured: 10
};
