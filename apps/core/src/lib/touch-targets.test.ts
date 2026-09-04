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
const CONTROL = /(^|[\s,>])(button|\.btn-accent|\.chip\b|\.act\b|\.remove\b|\.ic\b|\.gear\b|\.back\b|\.add\b|\.sing\b|\.mic-btn\b|\.browse-toggle\b|\.swatch\b|\.disclose\b)/;

test('every phone control that sizes its own box reaches 44px', () => {
	const offenders: string[] = [];
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		// crude rule-block split is enough: these are hand-written scoped stylesheets, not minified CSS
		for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
			const sel = m[1]!.trim();
			const body = m[2]!;
			if (!CONTROL.test(sel)) continue;
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
 */
test('the controls that previously fell short declare 44px explicitly', () => {
	const phone = readFileSync(join(SRC, 'routes', '+page.svelte'), 'utf8');
	const settings = readFileSync(join(SRC, 'routes', 'settings', '+page.svelte'), 'utf8');

	// the settings gear was ~18px, under even the 24px WCAG minimum
	expect(/\.gear\s*\{[^}]*min-(?:width|height):\s*44px/s.test(phone)).toBe(true);
	// the readiness chips were ~30px
	expect(/\.chip\s*\{[^}]*min-height:\s*44px/s.test(phone)).toBe(true);
	// the browse disclosure is new and must not repeat the mistake
	expect(/\.browse-toggle\s*\{[^}]*min-height:\s*44px/s.test(phone)).toBe(true);
	// the settings back link was ~26px
	expect(/\.back\s*\{[^}]*min-(?:width|height):\s*44px/s.test(settings)).toBe(true);
});
