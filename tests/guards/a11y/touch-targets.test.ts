// guard: the app set itself a 44px touch standard, so hold it to it. Caught the settings gear at ~18px
// (under even the 24px WCAG 2.5.8 floor), the back link at ~26px, the readiness chips at ~30px and a search
// field with no min-height at all. Scope: interactive rules that declare their own box — a control sized by
// its content has taken no position on target size. See docs/GUARDS.md#touch-targets.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';
import {
	TAP,
	TAP_FLOOR,
	expressesTap,
	restatesTapNumber,
	markupControls,
	svelteFiles
} from '@encore/test-support/scan';

const SRC = srcDir;

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

// PHONE surfaces only; the TV's own scale is enforced by layout/stage-scale.test.ts. Nothing leaves this
// walk: a surface nobody added is one these arms never examine, which is how both metrics pages shipped
// their one navigation control at 32px.
const FILES = [
	...svelteFiles(join(SRC, 'lib', 'components')),
	...svelteFiles(join(SRC, 'lib', 'ui')),
	join(SRC, 'routes', '+page.svelte'),
	join(SRC, 'routes', 'settings', '+page.svelte'),
	// phone surfaces by their own CSS's admission — they harden for the 320px layout
	join(SRC, 'routes', 'metrics', '+page.svelte'),
	join(SRC, 'routes', 'metrics', '[mediaId]', '+page.svelte')
];

// Is a selector's SUBJECT (its last compound) an interactive control, per the markup-derived set? Classes
// match hash-agnostically, so `.chip`, `.chip.active` and `.chip.svelte-xyz` all count; a leading tag
// counts only when the markup used that tag interactively.
function subjectIsControl(sel: string, ctrl: { tags: Set<string>; classes: Set<string> }): boolean {
	const subject = sel.split(/[\s>+~]+/).pop() ?? '';
	// strip pseudos/attribute suffixes so `.chip:active` and `.chip[data-x]` reduce to their classes
	const cleaned = subject.replace(/::?[\w-]+(\([^)]*\))?/g, '').replace(/\[[^\]]*\]/g, '');
	const leadingTag = cleaned.match(/^([a-zA-Z][\w-]*)/);
	if (leadingTag && ctrl.tags.has(leadingTag[1]!.toLowerCase())) return true;
	for (const cls of cleaned.matchAll(/\.([A-Za-z_][\w-]*)/g)) {
		if (ctrl.classes.has(cls[1]!)) return true;
	}
	return false;
}

// Every CSS rule whose SUBJECT is an interactive control AND which declares its own box. Both arms below
// iterate THIS: a second private copy is how one guard ends up measuring a different population from its
// sibling while both stay green.
function* controlRules(): Generator<{ file: string; sel: string; body: string }> {
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		const ctrl = markupControls(src);
		// a crude rule-block split is enough for hand-written scoped stylesheets
		for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
			const sel = m[1]!.trim();
			const body = m[2]!;
			// a ::pseudo-element (slider track/thumb) is a cosmetic sub-part; the interactive box is the parent
			if (sel.includes('::')) continue;
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
		const explicit = [...body.matchAll(/(?:min-)?height:\s*([0-9.]+)px/g)].map((x) => Number(x[1]));
		if (explicit.some((h) => h >= TAP)) continue;
		// a percentage/auto/var-driven box cannot be resolved statically
		if (/(?:min-)?height:\s*(?:var\(|100%|auto|1em|clamp\()/.test(body)) continue;
		const tooShort = explicit.filter((h) => h < TAP && h > 0);
		if (tooShort.length) {
			offenders.push(`${file}: ${sel} → height ${tooShort[0]}px < ${TAP}px`);
		}
	}
	expect(offenders).toEqual([]);
	// This population is "control rules that size their own box IN A PAGE STYLESHEET", which shrinks on purpose
	// as controls become <Button> and inherit a box from the size axis. What it can no longer cover is the
	// controls that LEFT; a11y/button-tap-floor.test.ts is the named successor. When this reaches 0, retire it.
	expect(controlRulesSeen).toBeGreaterThan(6); // @nvf-floor controlRulesSeen
	// The two floors fail on different regressions: that one on a broken derivation, this on a narrowed walk,
	// which the first cannot see because the hand-named route pages alone clear it.
	expect(FILES.length).toBeGreaterThanOrEqual(12); // @nvf-floor FILES.length
});

// THE EXPRESSION, not the number. The arm above pins the VALUE and was green on a repo where 15 control
// declarations across five files spelled `44px` by hand, so `--tap: 48px` would have moved the token and
// left every one of them behind, silently. Both directions are bound. Only the token's own number counts,
// so a 56px primary button is not restating it.
test('every phone control expresses the tap standard as var(--tap), never the number', () => {
	const offenders: string[] = [];
	let boxRulesSeen = 0;
	for (const { file, sel, body } of controlRules()) {
		// a rule that declares no width/height sizes by padding; nothing to express here
		if (!/(?:min-)?(?:width|height)\s*:/.test(body)) continue;
		boxRulesSeen++;
		if (!restatesTapNumber(body)) continue;
		// `44px` AND `var(--tap)` on different properties of one rule is still half-bound, so report it either
		// way and say which state it is in.
		offenders.push(
			`${file}: ${sel} → restates ${TAP}px instead of var(--tap)${expressesTap(body) ? ' (mixed: the rule names the token on another property)' : ''}`
		);
	}
	expect(offenders).toEqual([]);
	// This arm filters harder than the value guard (box-declaring rules only), so it needs its own floor.
	expect(boxRulesSeen).toBeGreaterThan(6); // @nvf-floor boxRulesSeen
});

// The controls that regressed before, asserted by name: a structural rule can be satisfied while the exact
// control that broke slips through a gap in it. `SIZE` is TOKEN-ONLY, because accepting `44px` OR
// `var(--tap)` left a control able to satisfy the pin with the number forever.
test('the controls that previously fell short declare the tap standard as the token', () => {
	const phone = readFileSync(join(SRC, 'routes', '+page.svelte'), 'utf8');
	const settings = readFileSync(join(SRC, 'routes', 'settings', '+page.svelte'), 'utf8');
	const metrics = readFileSync(join(SRC, 'routes', 'metrics', '+page.svelte'), 'utf8');
	const css = readFileSync(join(SRC, 'app.css'), 'utf8');

	// `TAP` is PARSED from this declaration, so asserting it equals TAP is a tautology. The real question is
	// whether the token still holds the committed floor: lowering it to 40 silently drops every control while
	// every var(--tap) spelling stays green.
	expect(css).toMatch(/--tap:\s*[0-9.]+px\s*;/);
	expect(TAP).toBeGreaterThanOrEqual(TAP_FLOOR);

	const SIZE = `var\\(--tap\\)`;
	const declares = (src: string, cls: string, prop: string) =>
		new RegExp(`\\.${cls}\\s*\\{[^}]*${prop}:\\s*${SIZE}`, 's').test(src);

	// The gear and the search-escape controls are `<Button>`s, so their boxes live in the component's size
	// axis rather than a page rule — asserted against the SIZE STRINGS, and still in terms of the token.
	// `size="tap"` exists BECAUSE every registry size is under the floor: migrating these to `sm` drops 32px.
	const button = readFileSync(join(SRC, 'lib/components/ui/button/button.svelte'), 'utf8');
	const sizeRule = (name: string) => new RegExp(`${name}:\\s*'([^']*)'`).exec(button)?.[1] ?? '';
	// `size-tap` and `min-h-tap` are the `--spacing-tap` bridge, which is `var(--tap)`.
	expect(sizeRule('icon')).toMatch(/\bsize-tap\b/);
	expect(sizeRule('tap')).toMatch(/\bmin-h-tap\b/);
	// …and the call sites really ask for those sizes, or the pins measure a size nothing uses. The icon-only
	// one is pinned because it is an icon button in a text-entry row, where the sub-24px gear came from.
	expect(phone).toMatch(/<Button[^>]*size="icon"[^>]*href="\/settings"/s);
	expect(phone).toMatch(/<Button[^>]*size="tap"[^>]*onclick=\{clearSearch\}/s);
	expect(phone).toMatch(/<Button[^>]*size="icon"[^>]*aria-label="Clear the search"/s);
	// The band is the phone's one permanent control pair: the two controls a singer can always reach are the
	// least allowed to fall short.
	const band = readFileSync(join(SRC, 'lib/components/NowPlayingBand.svelte'), 'utf8');
	expect(band).toMatch(/\.btn,\s*\.disc\s*\{[^}]*min-height:\s*var\(--tap\)/s);
	expect(declares(metrics, 'processes a', 'min-height')).toBe(true);

	// A 22px hue slider with a 28px thumb gave a 28px hit area, and a native colour input's default swatch is
	// smaller still. Pinned by exact selector, which the structural arm misses because it waves through any
	// var()-driven height.
	const colour = new RegExp(`input\\[type=['"]color['"]\\]\\.colour\\s*\\{[^}]*height:\\s*${SIZE}`, 's');
	expect(colour.test(settings)).toBe(true);
});

test('the stage-colour control is one full-size target with no sub-44px part', () => {
	// ONE full-size target with nothing smaller inside it. Two ways that regresses: a shrunken box, and a
	// reinstated `.hue` range whose 22px runnable-track reintroduces the sub-44px hit area. A rendered
	// measurement would skip on any machine without Chromium, which is indistinguishable from the rot.
	const settings = readFileSync(join(SRC, 'routes', 'settings', '+page.svelte'), 'utf8');

	expect(/input\[type=['"]color['"]\]\.colour\s*\{[^}]*height:\s*var\(--tap\)/s.test(settings)).toBe(true);
	expect(/input\[type=['"]range['"]\]\.hue/.test(settings)).toBe(false);
	expect(/class="hue"/.test(settings)).toBe(false);
});

/*
 * THE HEIGHTLESS-INPUT HOLE. `controlRules()` only looks at a rule that already declares a box, which a text
 * field does not: an `<input>` with no height sits at one text line (the search field measured 22px) and one
 * sized by padding alone lands short (`select` 41px, the join field 35px). Each control must be sized by
 * SOME rule naming `var(--tap)`, since the height can come from a shared rule. The checkbox/radio GLYPH and
 * the range slider are out of scope — their target is the wrapping label.
 */
test('every text-entry control is sized to the tap floor by a var(--tap) rule', () => {
	// Each entry: the file, the SELECTOR TOKEN identifying the control's sizing rule, and a name.
	const CONTROLS: { file: string; token: RegExp; name: string }[] = [
		// The floor is on the INPUT rather than the `.findbox` wrapper: the field is the tap target, and the box
		// around it is 52px of padding a finger landing near the edge would miss.
		{
			file: join(SRC, 'routes', '+page.svelte'),
			token: /\.findbox\s+input\b/,
			name: 'the search input on home'
		},
		// The settings selects and text fields are <NativeSelect> and <Input>, so their appearance had to move
		// INTO those components: scoped CSS cannot reach an element inside a child component, and under
		// `source(none)` a call-site utility is minted by nothing. All three share the `.encore-field` floor.
		{
			file: join(SRC, 'lib', 'components', 'ui', 'native-select', 'native-select.svelte'),
			token: /\.encore-field\b/,
			name: 'the settings selects (NativeSelect)'
		},
		{
			file: join(SRC, 'lib', 'components', 'ui', 'input', 'input.svelte'),
			token: /\.encore-field\b/,
			name: 'the settings text fields (Input)'
		},
		// VENDORED CONTROLS MUST BE LISTED BY HAND: `controlRules()` derives "is this a control?" from the file's
		// own MARKUP, and a copied-in shadcn component renders a COMPONENT, so no `button` tag appears to find,
		// while a `:global(...)`/`[attr]` selector cleans down to nothing. Moving the settings tabs'
		// `min-height: var(--tap)` into ui/tabs left a 38px pill PASSING this whole file.
		{
			file: join(SRC, 'lib', 'components', 'ui', 'tabs', 'tabs-trigger.svelte'),
			token: /tabs-trigger/,
			name: 'the settings scope tabs (Tabs.Trigger)'
		},
		{
			file: join(SRC, 'lib', 'components', 'ui', 'slider', 'slider.svelte'),
			// `data-slot`, not a class: the root is a Bits UI component, so the scope hash lands on no element and an
			// `.encore-slider` rule was dead in the build WHILE THIS ARM PASSED, because it reads the rule text.
			// See design-system/ui-scoped-style-reach.test.ts.
			token: /data-slot='slider'/,
			name: 'the settings sliders (Slider)'
		}
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
			// a bare `44px` is the drift shape, reported even if another rule is clean
			if (restatesTapNumber(body))
				offenders.push(`${file.replace(SRC, 'src')}: ${name} → restates ${TAP}px instead of var(--tap)`);
		}
		// A control whose selector MOVED is reported as such rather than silently passing.
		if (!anyRule) offenders.push(`${file.replace(SRC, 'src')}: ${name} → no sizing rule found (selector moved?)`);
		else if (!sized)
			offenders.push(
				`${file.replace(SRC, 'src')}: ${name} → not sized to var(--tap) by any rule; a text field with no tap-floor height sits below 44px`
			);
	}
	expect(offenders).toEqual([]);
});
