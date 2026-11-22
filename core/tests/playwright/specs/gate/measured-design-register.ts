/*
 * THE CONTROL REGISTER AND THE MEASURED NUMBERS — data only, no driving. Every entry carries its reason.
 * The quarantine rules are in docs/E2E.md#gates.
 *
 * ITS VERIFIER IS GONE. The register used to be read by `tests/guards/wiring/measured-design-gate.test.ts`,
 * which ran in `bun test` on every box and asserted the register is non-vacuous, that every quarantine entry
 * carries a substantive reason, and that the gate is still in the gate list. That whole tree is deleted, so
 * the protection its own rationale named — "a register only the gate can read is a register nobody checks
 * when the gate does not run" — went with it. The register-shape assertions it made are now the first test in
 * `measured-design-register.spec.ts`, so at least the GATE refuses to run against an empty or vacuous
 * register. That is strictly weaker than the guard was (it no longer runs in `bun test` on every box) and it
 * is recorded here rather than papered over.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The repo root as the foundation already finds it, rather than a second copy of the same walk.
import { repoRoot } from '../../world/core';

/**
 * Encore's own tap floor, stricter than WCAG 2.2 SC 2.5.8's 24px. TWO HALVES, deliberately: `TAP` is READ
 * OUT OF the `--tap` token so moving the design moves the measurement, and `TAP_FLOOR` stays a written-down
 * number because it is the COMMITMENT — raising `--tap` is allowed, lowering it below the floor is not.
 */
export const TAP_FLOOR = 44;

function readTapToken(): number {
	const css = readFileSync(join(repoRoot, 'src', 'app.css'), 'utf8');
	const m = css.match(/--tap:\s*([0-9.]+)px\s*;/);
	if (!m) throw new Error('app.css declares no `--tap: <n>px` token — the measured gate has no floor to read');
	const tap = Number(m[1]);
	// A token below the commitment would quietly lower the measured floor for every control on every
	// viewport, and the gate would report a clean pass while doing it.
	if (tap < TAP_FLOOR) {
		throw new Error(`--tap is ${tap}px, below the ${TAP_FLOOR}px floor this app committed to`);
	}
	return tap;
}

export const TAP = readTapToken();

/** The 16px iOS-zoom threshold. A WebKit behaviour, not a published success criterion. */
export const MIN_FIELD_PX = 16;

/** A simulated home-indicator inset, in px, used to prove the safe-area term is really composed in. */
export const SIMULATED_BOTTOM_INSET = 34;

/** The viewports every control is measured at — the acceptance names these three. */
export const VIEWPORTS: { name: string; w: number; h: number }[] = [
	{ name: 'iphone-14', w: 390, h: 844 },
	{ name: 'small-android', w: 360, h: 740 },
	{ name: 'iphone-14-pro-max', w: 430, h: 932 }
];

/**
 * What counts as an interactive control — derived from the roles a user can OPERATE, never a hand-listed
 * class allowlist, which is the blindness tests/guards/a11y/touch-targets.test.ts was corrected for once.
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

/** Text-entry input types only: a range or colour input has no text to zoom. */
export const TEXT_INPUT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'number', 'password', ''];

/*
 * THREE PLATFORM PREDICATES, here rather than in selectors.ts: the driver ban is about selectors naming
 * Encore's own markup, and these are DOM/CSS constructs that cannot drift with it. Two of them have no
 * anchor in any .svelte file for a resolver to bind to.
 */

/** A subtree the user cannot reach — behind an open modal. A reading there is legitimately 0. */
export const INERT_SELECTOR = '[inert]';

/** The wrapper whose text names a bare control (a checkbox has no accessible name of its own). */
export const LABEL_SELECTOR = 'label';

/** The state CLAIM 4 is about. An element that cannot be driven into it is UNMEASURED, never satisfied. */
export const FOCUS_VISIBLE = ':focus-visible';

/** Every field of `match` must be present and equal — a partial match is not a match. */
export interface ControlMatch {
	tag: string;
	type?: string | null;
	cls?: string;
	near?: string;
}

export interface QuarantineEntry {
	/** The surface the gate drove to reach it. */
	where: string;
	match: ControlMatch;
	/** The worst hit extent seen across every viewport. */
	measured: number;
	reason: string;
}

export interface RetiredEntry {
	where: string;
	match: ControlMatch;
	/** What it measured while it was quarantined. */
	was: number;
	reason: string;
}

/**
 * Known sub-floor controls. EMPTY today, so the gate holds every control it drives to the floor.
 *
 * `where` is the surface the gate drove to reach it. Every field of `match` must be present and equal — a
 * partial match is not a match, so a quarantine cannot silently absorb a new offender sharing a tag.
 * `measured` is the worst hit extent seen across every viewport; the gate fails on a reading more than 1px
 * worse (sub-pixel layout differs between widths) AND on one that reaches TAP.
 */
export const QUARANTINE: QuarantineEntry[] = [];

/**
 * Controls that WERE quarantined and are now resolved, kept on the record so leaving the set is visible
 * rather than a silent deletion. Each `reason` must be substantive; the register spec checks that, since the
 * wiring guard that used to is deleted.
 */
export const RETIRED: RetiredEntry[] = [
	{
		where: '/ (searched)',
		match: { tag: 'input', type: null, cls: '', near: 'Search a song or artist' },
		was: 22,
		reason:
			'FIXED. The dock search field is a bare <input> in `div.card.searchbox`; its rule declared no height, so the real hit extent was the 22px text line while the div carried the tappable-looking padding. The `.searchbox input` rule now sets `min-height: var(--tap)`, and the narrow-breakpoint searchbox rose from 42px to var(--tap) so it is not clipped. The gate measures it live at var(--tap) now, and touch-targets.test.ts sees it too: the `.searchbox input` rule is examined by the min-height arm there, so a revert reds the structural scan.'
	},
	{
		where: '/settings',
		match: { tag: 'select', type: null },
		was: 41,
		reason:
			'FIXED. Every <select> on /settings sized from the UA default plus the route padding and landed at 41px — 3px short. The shared `select, .text, .name-input` rule now sets `min-height: var(--tap)` with box-sizing:border-box, which closes all eight selects at once. A native select box is browser-owned, so this is verified on the real render by gate:measured (now live, not quarantined) rather than declared.'
	},
	{
		where: '/settings',
		match: { tag: 'input', type: 'checkbox', cls: '', near: 'Song intro before each turn' },
		was: 18,
		reason:
			'FALSE POSITIVE of the gate, since closed. The song-intro checkbox is wrapped by `<label class="check">`, which already carries `min-height: var(--tap)` on `main` — tapping the 44px label toggles it. The gate read 18px because its own() counted only the glyph and its descendants. measured-design.mjs now credits the wrapping label as the tap target for a checkbox/radio glyph, so the live reading is the label extent (>= var(--tap)). No markup change was needed; resizing the glyph to 44px was explicitly the WRONG fix.'
	},
	{
		where: '/settings',
		match: { tag: 'input', type: 'text', cls: 'text', near: 'Address phones join at' },
		was: 35,
		reason:
			'FIXED. The join-address field on the Server tab measured 35px — its own text-class rule set font-size and padding but no height, the shape the structural scan skipped. It shares the `select, .text, .name-input` rule that now carries `min-height: var(--tap)`, so the same one edit that closed the selects closed this field, and the structural arm catches it via that shared rule.'
	}
];

/**
 * NON-VACUITY FLOORS FOR THE GATE ITSELF: a drive that navigates but finds no controls would otherwise
 * report every assertion satisfied over an empty set. They sit well under the real counts, so a firing
 * floor is a FINDING, never a number to adjust.
 */
export const FLOORS = {
	/** interactive controls measured, summed over every surface and every viewport */
	controlsMeasured: 90,
	/** distinct surfaces the drive actually reached and swept. Raised 4 → 5 when /library was added: the floor
	 *  stays well under the eight the drive really reaches (verified by temporarily setting it to 8), per the
	 *  note above — it rises with the surface count so that deleting a surface outright still trips it. */
	surfacesSwept: 5,
	/** text-entry fields whose computed font-size was read */
	fieldsMeasured: 3,
	/** elements focused and whose focus indicator was read */
	focusedMeasured: 10,
	/** Placements of the join gate read by CLAIM 7 — one per (viewport, host). That drive takes TEN (five
	 *  viewports x two hosts), and six is the floor because the failure this guards against is a drive that
	 *  reached only ONE host: the claim is a COMPARISON, so five readings of `/` alone would report every
	 *  equality satisfied against nothing. Dropping one VIEWPORT does not trip it, and is not meant to — CLAIM 7
	 *  also asserts the exact count against the viewport list it drove, which is the arm that holds the list. */
	joinPlacementsMeasured: 6,
	/** Dock readings CLAIM 3 takes, where a reading is one (surface, strip state, inset) triple. That drive takes
	 *  NINETEEN and twelve is the floor, because the failure this guards against is a drive that never reaches the
	 *  strip-PRESENT state: the strip needs a real indexed library row queued before it renders, and without it
	 *  every arm would report satisfied over the one state the drive did reach — including the four CROSS-STATE arms
	 *  that are the whole reason CLAIM 3 is one test. The claim pairs this count with an arm asserting both sides of
	 *  the branch were seen, since a count alone cannot say which states they were. */
	dockStatesMeasured: 12
};
