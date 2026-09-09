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
import { TAP, TAP_FLOOR, expressesTap, restatesTapNumber, markupControls, svelteFiles } from './test-helpers';

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
	// `lib/ui/` was NOT walked (issue #831). PageHeader.svelte is the single source for the back link on
	// four routes, and its box survived only on a hand-written pin below — so a second control added
	// under lib/ui/ was invisible to this guard entirely. The walk closes that, and the pin it made
	// redundant is retired with it.
	...svelteFiles(join(SRC, 'lib', 'ui')),
	join(SRC, 'routes', '+page.svelte'),
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

/**
 * Every CSS rule in `FILES` whose SUBJECT is an interactive control AND which declares its own box.
 *
 * Both touch-target tests below iterate THIS, rather than each carrying its own copy of the split +
 * `subjectIsControl` + `declaresBox` sequence. A second private copy of a scan is how one guard ends up
 * measuring a different population from its sibling while both stay green (#841's finding, applied to
 * this file's own two arms).
 */
function* controlRules(): Generator<{ file: string; sel: string; body: string }> {
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
			if (!/(min-height|height|padding)\s*:/.test(body)) continue;
			yield { file: f.replace(SRC, 'src'), sel, body };
		}
	}
}

test('every phone control that sizes its own box reaches the tap standard', () => {
	const offenders: string[] = [];
	let controlRulesSeen = 0;
	for (const { file, sel, body } of controlRules()) {
		controlRulesSeen++;
		// an explicit min-height/height at or above the standard passes
		const explicit = [...body.matchAll(/(?:min-)?height:\s*([0-9.]+)px/g)].map((x) => Number(x[1]));
		if (explicit.some((h) => h >= TAP)) continue;
		// so does a percentage/auto/var-driven box, which we cannot resolve statically
		if (/(?:min-)?height:\s*(?:var\(|100%|auto|1em|clamp\()/.test(body)) continue;
		// a hard height BELOW the standard is a real offender
		const tooShort = explicit.filter((h) => h < TAP && h > 0);
		if (tooShort.length) {
			offenders.push(`${file}: ${sel} → height ${tooShort[0]}px < ${TAP}px`);
		}
	}
	expect(offenders).toEqual([]);
	// a broken markup walk (empty tag/class sets) would silently measure nothing and pass vacuously;
	// pin a floor so the guard fails loudly if the derivation ever stops finding controls.
	expect(controlRulesSeen).toBeGreaterThan(10); // @nvf-floor controlRulesSeen
	// …and pin the SCANNED POPULATION too (#841, XR-VER-14 Acceptance). FILES is a tree walk over
	// lib/components and lib/ui PLUS five hand-named route pages, so a walk that stops finding
	// components still leaves five files — and five files carry enough control rules to clear the floor
	// above. The two floors fail on different regressions: `controlRulesSeen` on a broken derivation,
	// this one on a narrowed walk. 14 files today (12 before lib/ui/ joined the walk, issue #831).
	expect(FILES.length).toBeGreaterThanOrEqual(12); // @nvf-floor FILES.length
});

/**
 * THE EXPRESSION, not the number (issue #831, XR-PH-01).
 *
 * The test above pins the VALUE, and it was green on a repo where 15 control declarations across five
 * files spelled `44px` by hand. That is the whole defect this arm exists for: `--tap` and the controls
 * agreed on 44 by coincidence, so `--tap: 48px` moved the token and left every one of those controls
 * at the old size, silently, with the value guard still green because `TAP` was hand-written 44 too.
 *
 * So this asks a different question: does the control NAME the standard? A rule that sizes its box with
 * the token's own number, written out, is the offender — it is correct today and drifts tomorrow. Both
 * directions are now bound:
 *
 *   - `--tap: 48px` in app.css alone → GREEN. `TAP` follows the token, every control names it.
 *   - any one control back to `min-height: 44px` → RED, naming that control.
 *
 * Scope note: only rules the value guard above already examines, and only the token's own number. A
 * control legitimately taller than the floor (a 56px primary button) is not restating the standard and
 * is left alone; `--tap` itself lives in app.css, which is not in FILES.
 */
test('every phone control expresses the tap standard as var(--tap), never the number', () => {
	const offenders: string[] = [];
	let boxRulesSeen = 0;
	for (const { file, sel, body } of controlRules()) {
		// a rule that declares no width/height at all sizes by padding; nothing to express here
		if (!/(?:min-)?(?:width|height)\s*:/.test(body)) continue;
		boxRulesSeen++;
		if (!restatesTapNumber(body)) continue;
		// `44px` AND `var(--tap)` on different properties of one rule is still half-bound: the literal
		// half drifts. Report it either way, and say which state it is in.
		offenders.push(
			`${file}: ${sel} → restates ${TAP}px instead of var(--tap)${expressesTap(body) ? ' (mixed: the rule names the token on another property)' : ''}`
		);
	}
	expect(offenders).toEqual([]);
	// non-vacuity: this arm filters harder than the value guard (box-declaring rules only), so it needs
	// its own floor — a derivation that stopped finding box rules would report zero offenders happily.
	expect(boxRulesSeen).toBeGreaterThan(10); // @nvf-floor boxRulesSeen
});

/**
 * The specific controls that regressed before, asserted by name. A structural rule can be satisfied
 * while the exact control that broke slips through a gap in it, so these are pinned.
 *
 * `SIZE` is TOKEN-ONLY since issue #831. It used to accept `44px` OR `var(--tap)`, for a good reason at
 * the time: pinning only the literal made this guard fight the design system it belongs to, failing a
 * control for the correct spelling. Accepting both fixed that and left the other half open — a control
 * could satisfy this pin with the number forever. Now the token is the only accepted form here, and the
 * value it resolves to is checked separately below, so neither spelling can drift unnoticed.
 */
test('the controls that previously fell short declare the tap standard as the token', () => {
	const phone = readFileSync(join(SRC, 'routes', '+page.svelte'), 'utf8');
	const settings = readFileSync(join(SRC, 'routes', 'settings', '+page.svelte'), 'utf8');
	const metrics = readFileSync(join(SRC, 'routes', 'metrics', '+page.svelte'), 'utf8');
	const css = readFileSync(join(SRC, 'app.css'), 'utf8');

	// `TAP` is PARSED from this declaration (test-helpers.ts), so asserting it equals TAP would be a
	// tautology — it cannot disagree with itself. What is still a real question is whether the token
	// holds the standard the app committed to: a `--tap` raised to 48 is a design decision, one lowered
	// to 40 silently drops every control below the floor while every var(--tap) spelling stays green.
	expect(css).toMatch(/--tap:\s*[0-9.]+px\s*;/);
	expect(TAP).toBeGreaterThanOrEqual(TAP_FLOOR);

	const SIZE = `var\\(--tap\\)`;
	const declares = (src: string, cls: string, prop: string) =>
		new RegExp(`\\.${cls}\\s*\\{[^}]*${prop}:\\s*${SIZE}`, 's').test(src);

	// the settings gear was ~18px, under even the 24px WCAG minimum
	expect(declares(phone, 'gear', 'min-(?:width|height)')).toBe(true);
	// the readiness chips were ~30px. Those chips are deleted (#833), but the `.chip` rule and this pin
	// stay: the way back out of a non-matching search ("Show all N") is a `chip ok chip-icon` button.
	expect(declares(phone, 'chip', 'min-height')).toBe(true);
	// RETIRED (#833): the `.browse-toggle` pin. Direction B deleted the browse disclosure along with the
	// artist and genre rails it hid, so the rule it named is gone from the phone stylesheet — the
	// assertion could only fail, never bite. #831 had just re-pointed this pin at `var(--tap)`; that
	// conversion is moot here rather than reverted, because the control it converted no longer exists.
	// Nothing replaces it: the search field that took its place is covered by the rendered gate (see the
	// measured-design quarantine entry for it) rather than by a declaration.
	// RETIRED (#831): the hand-written back-link pin. The back link (formerly ~26px in settings and 32px
	// on the audit page, issue #140) is the single shared PageHeader control adopted by /settings /stats
	// /metrics /metrics/[mediaId] (#644), and `lib/ui/` is in FILES now — so both arms above examine it
	// like any other control, and a pin that duplicates the walk only hides whether the walk reaches it.
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

/**
 * THE HEIGHTLESS-INPUT HOLE (issue #863).
 *
 * `controlRules()` above only looks at a rule that already declares a box (`min-height|height|padding`),
 * on the reasoning that a control sized by its content has "not taken a position on target size". That
 * reasoning holds for a `<button>` or a text link, whose content height is a comfortable tap. It does
 * NOT hold for a text field: an `<input>` with no height sits at its single text line — the `/` dock
 * search field measured 22px this way — and one sized by padding alone (`select` 41px, the join-address
 * `.text` 35px) lands short too. On top of that, `input` was absent from the bare-tag allowlist
 * `controlRules()` consults, so even a boxed rule whose subject is a bare `input` never reached the
 * comparison. Those gaps are why the rendered gate (measured-design) found four sub-floor controls the
 * source scan waved through.
 *
 * This arm closes the field half structurally, so a REVERT of the #863 CSS fixes reds here too — not
 * only in the browser gate, which skips on a machine with no Chromium. Each text-entry control must be
 * sized to the tap floor by SOME rule that names `var(--tap)` (an input's height can come from a shared
 * rule while a per-class rule only tweaks its padding, so the check is "is it reached anywhere", not
 * "does every rule name it"). Two controls are deliberately NOT in scope:
 *
 *   - the checkbox/radio GLYPH (`.check input`, an 18px square): its tap target is the wrapping <label>,
 *     which carries `min-height: var(--tap)` and is examined as its own control. Resizing the glyph is
 *     the wrong fix (issue #863).
 *   - the range slider (`.hue input`): a different control with its own `height: var(--tap)` rule and
 *     track/thumb geometry, pinned by the #133/#425 arm above.
 */
test('every text-entry control is sized to the tap floor by a var(--tap) rule (issue #863)', () => {
	// Each entry: the file, the SELECTOR TOKEN that identifies the control's sizing rule, and a human
	// name. A control passes when at least one rule whose selector contains that token names var(--tap)
	// on a height, OR sets an explicit height >= TAP.
	const CONTROLS: { file: string; token: RegExp; name: string }[] = [
		{ file: join(SRC, 'routes', '+page.svelte'), token: /\.searchbox\s+input\b/, name: 'the dock search input' },
		/*
		 * RE-ANCHORED BY #913 S2 (XR-VER-07). These three controls were `select`, `.text` and `.name-input`
		 * rules inside settings/+page.svelte. They are now <NativeSelect> and <Input>, and their appearance
		 * moved INTO those components — Svelte's scoped CSS cannot reach an element inside a child
		 * component, and under `source(none)` a utility written at a call site is minted by nothing, so the
		 * appearance had nowhere else to go.
		 *
		 * The floor itself is UNCHANGED and still spelled `min-height: var(--tap)`; only the file moved. The
		 * guard follows the control rather than the file, which is what it was for: this arm is what caught
		 * the move, reporting `no sizing rule found (selector moved?)` exactly as written.
		 *
		 * All three share the base `.encore-field` rule that carries the floor; the `comfortable` and `mono`
		 * variants only tweak padding and font, so the token deliberately matches the base rule too — the
		 * check is "is the floor reached anywhere", which is why a variant needs no floor of its own.
		 */
		{ file: join(SRC, 'lib', 'components', 'ui', 'native-select', 'native-select.svelte'), token: /\.encore-field\b/, name: 'the settings selects (NativeSelect)' },
		{ file: join(SRC, 'lib', 'components', 'ui', 'input', 'input.svelte'), token: /\.encore-field\b/, name: 'the settings text fields (Input)' }
	];
	const reachesFloor = (body: string): boolean => {
		if (expressesTap(body)) return true; // var(--tap) on width/height
		const explicit = [...body.matchAll(/(?:min-)?height:\s*([0-9.]+)px/g)].map((x) => Number(x[1]));
		return explicit.some((h) => h >= TAP);
	};
	const offenders: string[] = [];
	for (const { file, token, name } of CONTROLS) {
		const src = stripComments(readFileSync(file, 'utf8'));
		let sized = false;
		let anyRule = false;
		for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
			const sel = m[1]!.trim();
			const body = m[2]!;
			if (sel.includes('::') || !token.test(sel)) continue;
			anyRule = true;
			if (reachesFloor(body)) sized = true;
			// a bare `44px` is the drift shape XR-PH-01 names — report it even if another rule is clean.
			if (restatesTapNumber(body)) offenders.push(`${file.replace(SRC, 'src')}: ${name} → restates ${TAP}px instead of var(--tap)`);
		}
		if (!anyRule) offenders.push(`${file.replace(SRC, 'src')}: ${name} → no sizing rule found (selector moved?)`);
		else if (!sized) offenders.push(`${file.replace(SRC, 'src')}: ${name} → not sized to var(--tap) by any rule; a text field with no tap-floor height sits below 44px`);
	}
	expect(offenders).toEqual([]);
});

