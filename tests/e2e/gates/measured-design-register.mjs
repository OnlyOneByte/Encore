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
 * This gate moved four honour-system claims onto real measurement. The first thing a real
 * measurement did was find four control classes the source scan had been waving through for as long
 * as it has existed — because `touch-targets.test.ts`'s structural arm skips any rule that declares
 * no hard height, and every one of these four sizes itself from padding or a UA default.
 *
 * Fixing them is a production change with its own design questions (you do not "raise a checkbox to
 * 44px"; you make its label the target), and a separate issue already owns strengthening the touch-target
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

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
// The repo root, by walking up for `bunfig.toml` — the same marker the test harness uses, so this driver
// and the runner agree on the root. Was `join(import.meta.dirname, …)`, which encoded this file's distance
// from `apps/core` and broke the moment the e2e tree moved under `tests/`.
const REPO_ROOT = (() => {
	let dir = import.meta.dirname;
	for (let i = 0; i < 10; i += 1) {
		if (existsSync(join(dir, 'bunfig.toml'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`no bunfig.toml above ${import.meta.dirname}`);
})();


/**
 * Encore's own tap floor, stricter than WCAG 2.2 SC 2.5.8's 24px — READ OUT OF `--tap`.
 *
 * The line here used to be `export const TAP = 44` under a comment that said "Read live from `--tap`
 * too". The gate does read the token live per box; THIS constant did not, so the sentence was true of
 * the gate and false of the register, and the two agreed on 44 only because nobody had moved the token.
 * `--tap: 48px` moved the design and left this measuring against 44, which is the same
 * pinned-number/unbound-expression defect XR-PH-01 names in the components.
 *
 * `TAP_FLOOR` is the half that must stay a written-down number: it is the commitment, not the current
 * value, so raising `--tap` is allowed and lowering it below the commitment is not.
 */
export const TAP_FLOOR = 44;
export const TAP = readTapToken();

function readTapToken() {
	const css = readFileSync(join(REPO_ROOT, 'apps', 'core', 'src', 'app.css'), 'utf8');
	const m = css.match(/--tap:\s*([0-9.]+)px\s*;/);
	if (!m) throw new Error('app.css declares no `--tap: <n>px` token — the measured gate has no floor to read');
	const tap = Number(m[1]);
	// a token below the commitment would quietly lower the measured floor for every control on every
	// viewport, and the gate would report a clean pass while doing it.
	if (tap < TAP_FLOOR) {
		throw new Error(`--tap is ${tap}px, below the ${TAP_FLOOR}px floor this app committed to (XR-VER-09)`);
	}
	return tap;
}

/** The 16px iOS-zoom threshold — XR-VER-10. A WebKit behaviour, not a published success criterion. */
export const MIN_FIELD_PX = 16;

/*
 * RETIRED — `SHEET_CAP_FRACTION = 0.82`, the queue sheet's cap as a fraction of the visual
 * viewport (XR-VER-11). Its source declaration was `max-height: 82dvh` in QueueSheet.svelte, and the
 * whole drawer surface was deleted, so the number had nothing left to mirror and its CLAIM 3 arm was
 * removed rather than re-pointed: nothing docked caps itself in a viewport fraction now — the docked
 * band is sized by its own content and published as --dock-h. Do not re-add it without a surface that
 * actually declares a viewport-fraction cap.
 */

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
 * corrected for once, and re-introducing it here would re-introduce the blindness.
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
 * ── EMPTIED ────────────────────────────────────────────────────────────────────────────────────
 *
 * The four entries this gate first surfaced are all resolved now, and each is recorded in RETIRED
 * below rather than deleted — XR-VER-06/07: a quarantine whose defect no longer reproduces is
 * re-decided on the record, never a number nudged and never a line silently dropped. Three were real
 * CSS shortfalls closed by one declaration each (min-height: var(--tap)); the fourth was a false
 * positive of the gate's own reader, closed by crediting the wrapping label's hit extent in
 * measured-design.mjs. An empty QUARANTINE means the gate now holds EVERY control it drives to the
 * 44px floor with no exceptions.
 *
 * @type {{ where: string, match: { tag: string, type?: string | null, cls?: string, near?: string }, measured: number, reason: string }[]}
 */
export const QUARANTINE = [];

/**
 * Controls that WERE quarantined and are now resolved, kept on the record (XR-VER-06/07). The same
 * shape as `non-vacuity-floors.test.ts`'s RETIRED map: `was` is the number it measured while
 * quarantined and `reason` names what changed so a reader sees why it left the set rather than a
 * silent deletion. `measured-design-gate.test.ts` checks each reason is substantive.
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
