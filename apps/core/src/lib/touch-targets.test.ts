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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..'); // src/
const TAP = 44;

function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) out.push(...svelteFiles(p));
		else if (ent.name.endsWith('.svelte')) out.push(p);
	}
	return out;
}

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

/*
 * Only the PHONE surfaces. The TV is not touched — its controls are a phone in someone's hand, and its
 * own scale is enforced by stage-scale.test.ts.
 */
const FILES = [
	...svelteFiles(join(SRC, 'lib', 'components')),
	join(SRC, 'routes', '+page.svelte'),
	join(SRC, 'routes', 'join', '+page.svelte'),
	join(SRC, 'routes', 'settings', '+page.svelte')
];

/** Selectors that are unambiguously interactive controls. */
const CONTROL = /(^|[\s,>])(button|\.btn-accent|\.chip\b|\.act\b|\.remove\b|\.ic\b|\.gear\b|\.back\b|\.add\b|\.sing\b|\.mic-btn\b|\.browse-toggle\b|\.swatch\b|\.disclose\b|input\[type=['"]range['"]\])/;

test('every phone control that sizes its own box reaches 44px', () => {
	const offenders: string[] = [];
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		// crude rule-block split is enough: these are hand-written scoped stylesheets, not minified CSS
		for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
			const sel = m[1]!.trim();
			const body = m[2]!;
			if (!CONTROL.test(sel)) continue;
			// a ::pseudo-element (slider track/thumb) is a cosmetic sub-part, never the touch target
			// itself — the interactive box is the parent selector, which is examined on its own rule.
			if (sel.includes('::')) continue;
			// a rule that declares no box has not taken a position on target size
			const declaresBox = /(min-height|height|padding)\s*:/.test(body);
			if (!declaresBox) continue;
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
	// the settings back link was ~26px
	expect(declares(settings, 'back', 'min-(?:width|height)')).toBe(true);

	// the stage-colour hue slider was 22px tall with a 28px thumb — a 28px hit area (issue #133).
	// Pinned by the exact selector so reverting the input box to a hard sub-44px height reds this,
	// which the structural test above can miss because it waves through any var()-driven height.
	const hue = new RegExp(
		`input\\[type=['"]range['"]\\]\\.hue\\s*\\{[^}]*height:\\s*${SIZE}`,
		's'
	);
	expect(hue.test(settings)).toBe(true);
});

/*
 * The tap target and the thumb-centring move INDEPENDENTLY, so pinning only the 44px box lets the
 * exact state issue #133's fix had to correct back in: box raised to 44px, but the 28px WebKit thumb
 * still anchored to the top of its now-off-centre 22px runnable-track, hanging ~3.75px low. A rendered
 * measurement is the ideal instrument, but this repo deliberately does NOT gate on a browser (see
 * e2e/contract.test.ts's header: a test needing a live Chromium skips on any machine missing one, and
 * a permanently-skipped test is indistinguishable from the rot it was meant to catch). So this is a
 * source pin — but pinned to the EXACT centring value, not merely the presence of margin-top, because
 * a wrong value would hang the thumb just as badly as a missing one. The value is not a magic number:
 * it is (track - thumb) / 2 = (22 - 28) / 2 = -3px, the identical arithmetic ColourPicker.svelte:213
 * and the sibling :not(.hue) rule both carry. ::-moz-range-thumb needs none — Gecko centres on the
 * track — so only the WebKit thumb is pinned.
 */
test('the stage-colour hue thumb is centred on its runnable-track (issue #133)', () => {
	const settings = readFileSync(join(SRC, 'routes', 'settings', '+page.svelte'), 'utf8');
	const webkitThumb = new RegExp(
		`input\\[type=['"]range['"]\\]\\.hue::-webkit-slider-thumb\\s*\\{[^}]*margin-top:\\s*-3px`,
		's'
	);
	expect(webkitThumb.test(settings)).toBe(true);
});
