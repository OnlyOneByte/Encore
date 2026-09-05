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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

/*
 * THE GUARD THIS FILE IS ABOUT, made non-vacuous.
 *
 * Everything above checks HOOKS — the hand-maintained (file, anchor) list — plus the swatch FORMAT.
 * It never resolved SEL, the map the drivers (party.mjs, capture.mjs) actually query the DOM with.
 * That gap was theatre with a proof: pointing SEL.songRow at a class that exists nowhere left the
 * whole suite green, 7 pass 0 fail, while a real capture run would have failed on step one. HOOKS and
 * SEL are two hand-kept copies of the same truth, and only one was ever checked.
 *
 * This resolves EVERY concrete SEL selector against the whole apps/core/src source tree, so a
 * selector aimed at a class or attribute that no longer exists fails HERE, in `bun test`, instead of
 * silently in a browser run nobody triggers. It reads SEL directly — not HOOKS — precisely because
 * SEL is the thing that rotted unwatched.
 */

/** Every .svelte source file under apps/core/src — the whole surface the flow can drive. */
function allSvelte(dir: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) out.push(...allSvelte(p));
		else if (ent.name.endsWith('.svelte')) out.push(p);
	}
	return out;
}

/**
 * Does `token` appear as a CLASS anywhere in `src`? A class is reached three ways in Svelte source —
 * a static `class="a b c"` list, a `class:token` directive, or a `.token` rule in <style> — and the
 * flow's `.token` query matches an element that got the class by ANY of them, so all three count.
 * Matched on a word boundary so `.row` is not satisfied by `.rowdy`.
 */
function classPresent(src: string, token: string): boolean {
	const t = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	// inside a class="..." attribute (token as a whole word within the quoted list)
	if (new RegExp(`class="[^"]*\\b${t}\\b[^"]*"`).test(src)) return true;
	// class:token directive
	if (new RegExp(`class:${t}\\b`).test(src)) return true;
	// a .token rule in <style>
	if (new RegExp(`\\.${t}\\b`).test(src)) return true;
	return false;
}

/**
 * Turn one SEL selector string into the source anchor(s) it needs, and report whether any source file
 * carries it. Returns null for a shape this resolver does not model, so the caller can flag it rather
 * than silently pass it.
 */
function selectorResolves(selector: string, sources: string[]): boolean | null {
	// `tag[attr="v"]` / `tag[attr^="v"]` — an attribute selector.
	const attr = /\[([a-zA-Z-]+)(\^?)=["']([^"']+)["']\]/.exec(selector);
	if (attr) {
		const [, name, prefix, value] = attr;
		// `^=` means the source value STARTS WITH `value`; an exact `=` means it equals it. In both the
		// source text contains `name="value` — for `^=` as a prefix, for `=` as the start of an exact
		// match. So `name="value` is the anchor either way, and the `prefix` only documents intent.
		void prefix;
		const anchor = `${name}="${value}`;
		return sources.some((s) => s.includes(anchor));
	}
	// A CSS class selector, possibly compound (`.row .t`, `.lyrics .word.active`). EVERY class token in
	// it must exist somewhere — a compound selector that names a dropped descendant is still broken.
	if (selector.startsWith('.')) {
		const tokens = selector
			.split(/\s+/)
			.flatMap((part) => part.split('.').filter(Boolean));
		if (tokens.length === 0) return null;
		return tokens.every((tok) => sources.some((s) => classPresent(s, tok)));
	}
	return null;
}

test('every SEL selector resolves to an anchor in the source (the guard, non-vacuous)', () => {
	const sources = allSvelte(join(CORE, 'src')).map((f) => readFileSync(f, 'utf8'));

	/*
	 * Explicit, documented exemptions — honest about what this resolver cannot check by source scan,
	 * rather than a guard that silently skips whatever it fails to find. Each MUST state why it is safe:
	 * an unexplained exemption is how a real regression gets waved through.
	 */
	const EXEMPT: Record<string, string> = {
		// FUNCTIONS. Not literal selectors — they build one from a runtime argument. The two below have
		// their real anchors covered elsewhere, named here so a reader knows where.
		swatch:
			'a (name) => {role,name} helper; its FORMAT is asserted against ColourPicker in the swatch test above, and the aria-label anchor is a HOOK',
		setting: 'a (id) => `#${id}` helper; each concrete id is checked via SETTING_IDS below',
		// DATA, not a selector.
		SETTING_IDS: 'the raw id list, resolved element-by-element in the SETTING_IDS assertion below'
	};

	const unresolved: string[] = [];
	const unmodelled: string[] = [];

	for (const [key, value] of Object.entries(SEL)) {
		if (key in EXEMPT) continue;

		if (typeof value === 'string') {
			const ok = selectorResolves(value, sources);
			if (ok === null) unmodelled.push(`${key}: ${value} — resolver does not model this selector shape`);
			else if (!ok) unresolved.push(`${key}: ${value} — points at a class/attribute no source carries`);
		} else if (value instanceof RegExp) {
			// A regex selector (the flow matches an element's TEXT against it, e.g. /Start singing/).
			// Only a plain literal pattern is a source anchor; a pattern with metacharacters is not a
			// substring, so require the driver's regexes to stay literal and match the source text.
			if (/[\\^$.*+?()[\]{}|]/.test(value.source)) {
				unmodelled.push(`${key}: /${value.source}/ — non-literal regex cannot be resolved as a source anchor`);
			} else if (!sources.some((s) => s.includes(value.source))) {
				unresolved.push(`${key}: /${value.source}/ — no source contains this text`);
			}
		} else if (value && typeof value === 'object' && 'name' in value) {
			// A {role, name} object: the accessible name is an aria-label the source must render.
			const name = (value as { name: string }).name;
			const anchor = `aria-label="${name}"`;
			if (!sources.some((s) => s.includes(anchor))) {
				unresolved.push(`${key}: role/name "${name}" — no source renders ${anchor}`);
			}
		} else if (typeof value !== 'function') {
			// Anything else that is neither a string, a role/name object, nor an exempt function is a
			// shape this guard was not written for — surface it rather than skip it.
			unmodelled.push(`${key}: ${JSON.stringify(value)} — unhandled SEL shape`);
		}
	}

	// A shape the resolver cannot model is a hole in the guard, not a pass. Fail loudly so the resolver
	// is extended rather than the selector quietly going unchecked.
	expect(unmodelled).toEqual([]);
	expect(unresolved).toEqual([]);
});

test('every settings id the flow drives exists as an element id', () => {
	// SETTING_IDS is exempt from the resolver above because it is raw data; this is where each id is
	// resolved. The flow queries `#<id>`, so the source must carry `id="<id>"`.
	const sources = allSvelte(join(CORE, 'src')).map((f) => readFileSync(f, 'utf8'));
	const missing = SEL.SETTING_IDS.filter((id) => !sources.some((s) => s.includes(`id="${id}"`)));
	expect(missing).toEqual([]);
});
