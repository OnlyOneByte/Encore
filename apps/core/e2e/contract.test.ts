// guard: the e2e flow must stay aimed at the app it claims to test.
//
// This is the half of stage 5 that runs everywhere, on every change, with no browser and no
// environment setup. It is here because the previous e2e failed in the worst possible way: not by
// going red, but by going stale. It drove a `Library` tab deleted when search was unified around
// readiness, picked a colour by an aria-label of `color #ff5cae` after the label became
// `violet swatch`, and read rows from `.result` after the component started rendering `.row`. Three
// selector families had moved and `bun test` stayed green throughout, because nothing in the suite
// ever looked at the script.
//
// A browser test cannot fill this role. It needs a live server and a Chromium, so on any machine
// missing either it skips — and a permanently-skipped test is indistinguishable from the silent rot it
// was supposed to prevent.
import { test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOOKS, PRESET_COLOUR_NAMES, SEL } from './contract';

const CORE = join(import.meta.dir, '..');

test('every file the e2e depends on still exists', () => {
	const missing = HOOKS.filter((h) => !existsSync(join(CORE, h.file))).map(
		(h) => `${h.id}: ${h.file}`
	);
	expect(missing).toEqual([]);
});

test('every selector the e2e drives still has an anchor in the source', () => {
	const broken: string[] = [];
	for (const h of HOOKS) {
		const p = join(CORE, h.file);
		if (!existsSync(p)) continue; // reported by the test above
		if (!readFileSync(p, 'utf8').includes(h.anchor)) {
			broken.push(`${h.id} — "${h.anchor}" is gone from ${h.file}\n    (the flow needs it: ${h.why})`);
		}
	}
	expect(broken).toEqual([]);
});

/**
 * The exact rot that happened, pinned as its own case. The generic anchor check above would catch it,
 * but naming it means a future reader learns what went wrong rather than just seeing a rule.
 */
test('the e2e does not reference UI that was removed', () => {
	// Comments first: this file's own header explains the rot by naming the dead selectors, and a guard
	// that flags its own documentation gets deleted rather than fixed.
	const flow = stripComments(readFileSync(join(import.meta.dir, 'party.mjs'), 'utf8'));

	// the Library tab was deleted when search was unified around readiness — there is no source switch
	expect(flow).not.toContain("name: 'Library'");
	// colours are addressed by accessible NAME; a hex label has not existed since the picker was rebuilt
	expect(flow).not.toMatch(/name: `color #/);
	// results render as .row, not .result
	expect(flow).not.toContain('.result');
});

/** Blank comments out, keeping newlines so any reported line numbers stay true. */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/(^|[^:'"\\`])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
}

test('the flow imports the contract instead of hard-coding selectors', () => {
	// If the flow keeps its own copy of the selectors, the guard is checking one thing and the browser
	// another — which is precisely how they drifted apart the first time.
	const flow = readFileSync(join(import.meta.dir, 'party.mjs'), 'utf8');
	expect(flow).toMatch(/from '\.\/contract(\.ts)?'/);
});

test('the colour names in the contract match the ones the picker announces', () => {
	// PRESET_COLOUR_NAMES is what the flow queries by. If the picker renames a colour, the flow must
	// fail here rather than in a browser nobody has run.
	// Extracted from /join so the profile sheet offers the same control; the names live with it.
	const picker = readFileSync(join(CORE, 'src/lib/components/ColourPicker.svelte'), 'utf8');
	const declared = /PRESET_NAMES\s*=\s*\[([^\]]*)\]/.exec(picker)?.[1] ?? '';
	const names = [...declared.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
	expect(names).toEqual([...PRESET_COLOUR_NAMES]);
});

test('the swatch selector asks for the accessible name the picker actually renders', () => {
	// THE BUG THIS EXISTS FOR. The test above compares the two NAME LISTS, which is not the same as
	// checking the SELECTOR is right: SEL.swatch wraps each name in a format, and that wrapper drifted
	// twice without either list changing. First the driver kept asking for `color #ff5cae` after the
	// label became "violet swatch"; then it kept asking for "violet swatch" after the label was
	// shortened to "violet" (role=radio already says "radio", so the word was screen-reader noise).
	// Both times every unit test stayed green and only a real browser run failed -- and the e2e drivers
	// are not part of `bun test`, so nothing failed until someone drove the app by hand.
	//
	// So assert the format against the component's own expression: the radio's aria-label is
	// `colorName(c)`, and `colorName` must return the bare name with nothing appended.
	const picker = readFileSync(join(CORE, 'src/lib/components/ColourPicker.svelte'), 'utf8');

	// The swatch radio names itself from colorName(), not from a literal or a template.
	expect(picker).toMatch(/aria-label=\{colorName\(c\)\}/);

	// colorName returns an entry of PRESET_NAMES unmodified -- no ` swatch`, no other suffix. A
	// template literal in its return is exactly how the stale wrapper got there, so reject one.
	const body = /export function colorName\([^)]*\)[^{]*\{([\s\S]*?)\n\t\}/.exec(picker)?.[1] ?? '';
	expect(body).not.toBe('');
	expect(body).not.toMatch(/`/);

	// And the selector helper must not re-add one on its side either.
	expect(SEL.swatch('pink').name).toBe('pink');
});

test('the contract exposes a hook for each surface the flow has to reach', () => {
	// A cheap completeness check: the flow spans join, remote and TV, so all three must be represented.
	const files = new Set(HOOKS.map((h) => h.file));
	expect([...files].some((f) => f.includes('join'))).toBe(true);
	expect([...files].some((f) => f.endsWith('routes/+page.svelte'))).toBe(true);
	expect([...files].some((f) => f.includes('routes/tv'))).toBe(true);
	// and the selector map must not have gone empty through a bad refactor
	expect(Object.keys(SEL).length).toBeGreaterThan(10);
});
