// guard: the app set itself a 44px touch standard, so hold it to it.
//
// THE BUG THIS EXISTS FOR. The 44px decision was made and honoured in the places someone happened to
// look at — the queue reorder actions carry a comment saying they were raised from 30px because that
// was below the reliable-tap threshold — and then quietly missed at the top of the home page. The
// settings gear was ~18px (under even the 24px WCAG 2.5.8 floor), the settings back link ~26px, the
// readiness chips ~30px, and the search field had no min-height at all. A standard nobody checks is a
// preference, not a standard.
//
// Scope: interactive rules that declare their own box. A control sized by its content (a text link in
// a paragraph) is out of scope — this looks for rules that set a height or padding and therefore have
// already taken a position on how big the target is.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TAP, markupControls, svelteFiles } from './test-helpers';

const SRC = join(import.meta.dir, '..'); // src/

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

/*
 * The interactive-control derivation — `markupControls`, plus the bare-tag allowlist it consults —
 * lives in ./test-helpers (#841, XR-VER-14). It was a private copy here; it decides which CSS rules
 * this guard even looks at, so a drift between it and any other consumer silently narrows the
 * population one guard examines while the others keep their own answer.
 */

/*
 * Only the PHONE surfaces. The TV is not touched — its controls are a phone in someone's hand, and its
 * own scale is enforced by stage-scale.test.ts.
 */
const FILES = [
	...svelteFiles(join(SRC, 'lib', 'components')),
	join(SRC, 'routes', '+page.svelte'),
	join(SRC, 'routes', 'join', '+page.svelte'),
	join(SRC, 'routes', 'settings', '+page.svelte'),
	// The operator metrics pages are phone surfaces by their own CSS's admission (they harden for the
	// 320px layout) and each has exactly one navigation control, yet neither was ever scanned — which
	// is how both shipped at 32px (issue #140).
	join(SRC, 'routes', 'metrics', '+page.svelte'),
	join(SRC, 'routes', 'metrics', '[mediaId]', '+page.svelte')
];

// Is a CSS selector's SUBJECT (its last compound, after the final combinator) an interactive control,
// per the markup-derived set? Class tokens are matched hash-agnostically: `.chip`, `.chip.active`, and
// the compiled `.chip.svelte-xyz` all count as targeting `.chip`. A leading tag (`button {`, `a {`)
// counts only when the markup actually used that tag interactively.
function subjectIsControl(sel: string, ctrl: { tags: Set<string>; classes: Set<string> }): boolean {
	const subject = sel.split(/[\s>+~]+/).pop() ?? '';
	// strip pseudos/attribute-suffixes so `.chip:active` and `.chip[data-x]` reduce to their classes
	const cleaned = subject.replace(/::?[\w-]+(\([^)]*\))?/g, '').replace(/\[[^\]]*\]/g, '');
	const leadingTag = cleaned.match(/^([a-zA-Z][\w-]*)/);
	if (leadingTag && ctrl.tags.has(leadingTag[1]!.toLowerCase())) return true;
	for (const cls of cleaned.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
		if (ctrl.classes.has(cls[1]!)) return true;
	}
	return false;
}

test('every phone control that sizes its own box reaches 44px', () => {
	const offenders: string[] = [];
	let controlRulesSeen = 0;
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		const ctrl = markupControls(src);
		// crude rule-block split is enough: these are hand-written scoped stylesheets, not minified CSS
		for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
			const sel = m[1]!.trim();
			const body = m[2]!;
			// a ::pseudo-element (slider track/thumb) is a cosmetic sub-part, never the touch target
			// itself — the interactive box is the parent selector, which is examined on its own rule.
			if (sel.includes('::')) continue;
			// derive "is this a control?" from the markup, not a literal allowlist (issue #400)
			if (!sel.split(',').some((s) => subjectIsControl(s.trim(), ctrl))) continue;
			// a rule that declares no box has not taken a position on target size
			const declaresBox = /(min-height|height|padding)\s*:/.test(body);
			if (!declaresBox) continue;
			controlRulesSeen++;
			// an explicit min-height/height at or above the standard passes
			const explicit = [...body.matchAll(/(?:min-)?height:\s*([0-9.]+)px/g)].map((x) => Number(x[1]));
			if (explicit.some((h) => h >= TAP)) continue;
			// so does a percentage/auto/var-driven box, which we cannot resolve statically
			if (/(?:min-)?height:\s*(?:var\(|100%|auto|1em)/.test(body)) continue;
			// a hard height BELOW the standard is a real offender
			const tooShort = explicit.filter((h) => h < TAP && h > 0);
			if (tooShort.length) {
				offenders.push(`${f.replace(SRC, 'src')}: ${sel} → height ${tooShort[0]}px < ${TAP}px`);
			}
		}
	}
	expect(offenders).toEqual([]);
	// a broken markup walk (empty tag/class sets) would silently measure nothing and pass vacuously;
	// pin a floor so the guard fails loudly if the derivation ever stops finding controls.
	expect(controlRulesSeen).toBeGreaterThan(10);
	// …and pin the SCANNED POPULATION too (#841, XR-VER-14 Acceptance). FILES is a tree walk over
	// lib/components PLUS five hand-named route pages, so a walk that stops finding components still
	// leaves five files — and five files carry enough control rules to clear the floor above. The two
	// floors fail on different regressions: `controlRulesSeen` on a broken derivation, this one on a
	// narrowed walk. 12 files today.
	expect(FILES.length).toBeGreaterThanOrEqual(10);
});

/**
 * The specific controls that regressed before, asserted by name. A structural rule can be satisfied
 * while the exact control that broke slips through a gap in it, so these are pinned.
 *
 * `44px` OR `var(--tap)` satisfies each one. Pinning only the literal made this guard fight the
 * design system it belongs to: once app.css named the standard as `--tap: 44px`, expressing a control
 * in the token FAILED the very test that exists to enforce the token's value. A guard that punishes
 * the correct spelling teaches people to work around it, so both forms are accepted and `--tap` is
 * checked to still BE 44px -- which is the part that actually matters.
 */
test('the controls that previously fell short declare 44px explicitly', () => {
	const phone = readFileSync(join(SRC, 'routes', '+page.svelte'), 'utf8');
	const settings = readFileSync(join(SRC, 'routes', 'settings', '+page.svelte'), 'utf8');
	const metrics = readFileSync(join(SRC, 'routes', 'metrics', '+page.svelte'), 'utf8');
	// The back link is now a single shared control in PageHeader (issue #644), adopted by /settings,
	// /stats, /metrics and /metrics/[mediaId]. Its 44px box is pinned here, at its one source.
	const pageHeader = readFileSync(join(SRC, 'lib', 'ui', 'PageHeader.svelte'), 'utf8');
	const css = readFileSync(join(SRC, 'app.css'), 'utf8');

	// If --tap ever drifts off the standard, accepting it below would silently lower the bar.
	expect(css).toMatch(new RegExp(`--tap:\\s*${TAP}px\\s*;`));

	const SIZE = `(?:${TAP}px|var\\(--tap\\))`;
	const declares = (src: string, cls: string, prop: string) =>
		new RegExp(`\\.${cls}\\s*\\{[^}]*${prop}:\\s*${SIZE}`, 's').test(src);

	// the settings gear was ~18px, under even the 24px WCAG minimum
	expect(declares(phone, 'gear', 'min-(?:width|height)')).toBe(true);
	// the readiness chips were ~30px
	expect(declares(phone, 'chip', 'min-height')).toBe(true);
	// the browse disclosure is new and must not repeat the mistake
	expect(declares(phone, 'browse-toggle', 'min-height')).toBe(true);
	// the back link (formerly ~26px in settings and 32px on the audit page, issue #140) is now the
	// single shared PageHeader control, adopted by /settings /stats /metrics /metrics/[mediaId] (#644)
	expect(declares(pageHeader, 'back', 'min-(?:width|height)')).toBe(true);
	// the /metrics slowest-songs links and the audit-page back link were both 32px (issue #140), and
	// neither page was in FILES, so the structural test above never saw them. Pinned by name here.
	expect(declares(metrics, 'cooks a', 'min-height')).toBe(true);

	// The stage-colour control was a 22px-tall hue slider with a 28px thumb — a 28px hit area (issue
	// #133). #425 replaced it with a native colour input, so the pin moves to that control rather than
	// being dropped: the underlying mistake (a sub-44px box on the one settings control whose whole job
	// is being tapped) is just as available to a colour input, whose browser default swatch is smaller
	// still. Pinned by the exact selector, which the structural test above can miss because it waves
	// through any var()-driven height.
	const colour = new RegExp(`input\\[type=['"]color['"]\\]\\.colour\\s*\\{[^}]*height:\\s*${SIZE}`, 's');
	expect(colour.test(settings)).toBe(true);
});

/*
 * The companion to the pin above, and it changed subject in #425. It used to pin the hue slider's
 * thumb-CENTRING: the tap box and the thumb offset moved independently, so pinning only the 44px box
 * let the exact state #133's fix had to correct back in — box raised to 44px, but the 28px WebKit thumb
 * still anchored to the top of its off-centre 22px runnable-track, hanging ~3.75px low.
 *
 * A colour input has no thumb and no runnable-track, so that specific arithmetic has no subject any
 * more. What survives is the REASON it existed: the stage-colour control must present one full-size
 * target with nothing smaller inside it. So this now pins the two ways that can regress — a shrunken
 * box, and a reinstated `.hue` range whose 22px track would reintroduce the sub-44px hit area under a
 * selector the pin above does not read.
 *
 * A rendered measurement would be the ideal instrument, but this repo deliberately does NOT gate on a
 * browser (see e2e/contract.test.ts's header: a test needing a live Chromium skips on any machine
 * missing one, and a permanently-skipped test is indistinguishable from the rot it was meant to catch).
 * So this stays a source pin.
 */
test('the stage-colour control is one full-size target with no sub-44px part (issue #133/#425)', () => {
	const settings = readFileSync(join(SRC, 'routes', 'settings', '+page.svelte'), 'utf8');

	// The control itself is the colour input, and it is padded rather than filled edge to edge, so its
	// box is the target. Pinned to var(--tap) so it tracks the token instead of a literal that can drift.
	expect(/input\[type=['"]color['"]\]\.colour\s*\{[^}]*height:\s*var\(--tap\)/s.test(settings)).toBe(true);

	// And the retired hue slider must stay retired. Its 22px runnable-track is what produced the 28px
	// hit area in the first place; leaving those rules behind would let a future edit reattach a
	// `class="hue"` range and reproduce #133 under a selector nothing else here reads.
	expect(/input\[type=['"]range['"]\]\.hue/.test(settings)).toBe(false);
	expect(/class="hue"/.test(settings)).toBe(false);
});
