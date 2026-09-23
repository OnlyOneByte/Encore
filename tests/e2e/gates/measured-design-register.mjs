/*
 * THE CONTROL REGISTER AND THE MEASURED NUMBERS — data only, no driving.
 *
 * Read by two callers: `measured-design.mjs`, which measures against it, and
 * `tests/guards/wiring/measured-design-gate.test.ts`, which runs in `bun test` on every box and asserts
 * this register is non-vacuous, that every quarantine entry carries a substantive reason, and that the
 * gate is wired into the gate list — a register only the gate can read is a register nobody checks when
 * the gate does not run. The quarantine rules are in docs/E2E.md#gates.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot as REPO_ROOT } from '../lib/repo-root.mjs';

/**
 * Encore's own tap floor, stricter than WCAG 2.2 SC 2.5.8's 24px. TWO HALVES, deliberately: `TAP` is READ
 * OUT OF the `--tap` token so moving the design moves the measurement, and `TAP_FLOOR` stays a written-down
 * number because it is the COMMITMENT — raising `--tap` is allowed, lowering it below the floor is not.
 */
export const TAP_FLOOR = 44;
export const TAP = readTapToken();

function readTapToken() {
	const css = readFileSync(join(REPO_ROOT, 'src', 'app.css'), 'utf8');
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

/** The 16px iOS-zoom threshold. A WebKit behaviour, not a published success criterion. */
export const MIN_FIELD_PX = 16;

/** A simulated home-indicator inset, in px, used to prove the safe-area term is really composed in. */
export const SIMULATED_BOTTOM_INSET = 34;

/**
 * The viewports every control is measured at — the acceptance names these three.
 * @type {{ name: string, w: number, h: number }[]}
 */
export const VIEWPORTS = [
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

/** Text-entry input types, for. A range or colour input has no text to zoom. */
export const TEXT_INPUT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'number', 'password', ''];

/*
 * THREE PLATFORM PREDICATES, single-sourced here rather than in contract.ts. The driver ban is about
 * selectors naming Encore's own markup, which rot when that markup moves; `[inert]`, `label` and
 * `:focus-visible` are DOM and CSS constructs that cannot drift with it, and two of them have no anchor
 * in any .svelte file for the contract's resolver to bind to.
 */

/** A subtree the user cannot reach — behind an open modal. A reading there is legitimately 0. */
export const INERT_SELECTOR = '[inert]';

/** The wrapper whose text names a bare control (a checkbox has no accessible name of its own). */
export const LABEL_SELECTOR = 'label';

/** The state is about. An element not in it is UNMEASURED, never satisfied. */
export const FOCUS_VISIBLE = ':focus-visible';

/**
 * Known sub-floor controls, each with the number it measures and why it is not fixed here. EMPTY today,
 * which means the gate holds every control it drives to the floor with no exceptions.
 *
 * `where` is the surface the gate drove to reach it. `match` is matched against the reading's own identity
 * fields, ALL of which must be present and equal — a partial match is not a match, so a quarantine cannot
 * silently absorb a new offender that happens to share a tag. `measured` is the worst hit extent seen
 * across every viewport; the gate fails if a reading is more than 1px worse (sub-pixel layout differs
 * between widths) AND fails if a reading reaches TAP.
 *
 * @type {{ where: string, match: { tag: string, type?: string | null, cls?: string, near?: string }, measured: number, reason: string }[]}
 */
export const QUARANTINE = [];

/**
 * Controls that WERE quarantined and are now resolved, kept on the record — the same shape as
 * tests/guards/meta/non-vacuity-floors.test.ts's RETIRED map. `was` is the number it measured while
 * quarantined and `reason` names what changed, so leaving the set is visible rather than a silent
 * deletion; the wiring guard checks each reason is substantive.
 *
 * @type {{ where: string, match: { tag: string, type?: string | null, cls?: string, near?: string }, was: number, reason: string }[]}
 */
export const RETIRED = [
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
 * NON-VACUITY FLOORS FOR THE GATE ITSELF: a driver that navigates successfully but finds no controls — a
 * changed selector, a route that now redirects, a join that silently failed — would otherwise report every
 * assertion satisfied over an empty set. The floors sit well under the real counts so ordinary UI churn
 * does not trip them, and a firing floor is a FINDING, never a number to adjust.
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
