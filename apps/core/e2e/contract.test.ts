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

/**
 * Blank comments out, keeping newlines so any reported line numbers stay true. Covers JS block/line
 * comments AND Svelte/HTML `<!-- -->` comments: a `.svelte` source carries both (the media-element
 * note in TvPlayer.svelte lives in an HTML comment), and a selector that appears only in comment prose
 * — of either kind — must NOT count as a rendered anchor.
 */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/(^|[^:'"\\`])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
}

/**
 * The exact source array the SEL-resolution guard resolves against: every .svelte file under src,
 * comments blanked. The regression test below consumes THIS builder (not a private copy) so the test
 * exercises the same composition the guard does — reverting the stripComments wrapper here reds it.
 */
function guardSources(): string[] {
	return allSvelte(join(CORE, 'src')).map((f) => stripComments(readFileSync(f, 'utf8')));
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
	/*
	 * A comma-separated list is a UNION, so at least one branch has to exist — not all of them. The
	 * driver's `video, audio` is exactly this case and is deliberately written to cover both: the TV
	 * plays an instrumental through an <audio>, and pinning the read to a bare `video` once returned -1
	 * forever and silently cost every playing frame in the gallery. Requiring both would fail on a
	 * correct selector; requiring one proves the read can land.
	 */
	if (selector.includes(',')) {
		const branches = selector.split(',').map((s) => s.trim()).filter(Boolean);
		if (branches.length === 0) return null;
		const resolved = branches.map((b) => selectorResolves(b, sources));
		if (resolved.some((r) => r === true)) return true;
		// Only report unmodelled if NO branch was even modellable; otherwise it is a genuine miss.
		return resolved.every((r) => r === null) ? null : false;
	}
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
	/*
	 * A bare TAG selector. `body` and `html` are guaranteed by HTML itself and appear in no component,
	 * so they need no source anchor; any other tag must actually be rendered somewhere, or the read is
	 * aimed at an element the app does not produce.
	 */
	if (/^[a-z][a-z0-9]*$/.test(selector)) {
		if (selector === 'body' || selector === 'html') return true;
		return sources.some((s) => new RegExp(`<${selector}\\b`).test(s));
	}
	return null;
}

test('every SEL selector resolves to an anchor in the source (the guard, non-vacuous)', () => {
	// Strip comments first: the flow resolves against RENDERED source, so a selector that appears only in
	// comment prose must not count as an anchor. Without this the driver scans (which already strip, :47/:368)
	// and this resolution disagree about what is source, and a dead selector living in a comment stays green.
	const sources = guardSources();

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
		settingsTab:
			'a (id) => `#tab-${id}` helper; the page interpolates the id (`id="tab-{t.id}"`) so no grep can resolve it — its FORMAT is asserted against that attribute below, and settings-scopes.test.ts pins the ids to the TABS registry',
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

test('a selector whose only occurrence is a comment does not resolve (the guard strips comments)', () => {
	// The rot this locks out: a dead selector kept alive by comment prose. In the real tree TvPlayer.svelte
	// carries `<video` ONLY in comments — the rendered media element is `<audio>` — so SEL.mediaEl =
	// 'video, audio' passes today only because the `audio` branch renders. If comments were treated as
	// source, the `video` branch would resolve against comment text and the union would stay green over a
	// read that can never land. This asserts the guard reads RENDERED source, the same way it does above.

	// `stripped` is the guard's OWN source builder (guardSources), the exact array the resolver runs over,
	// so reverting the stripComments wrapper inside guardSources reds this test — the guard and this test
	// can no longer drift. `raw` stays unstripped inline: the raw-vs-stripped asymmetry is the whole point.
	const stripped = guardSources();
	const raw = allSvelte(join(CORE, 'src')).map((f) => readFileSync(f, 'utf8'));

	// Precondition for this to be a meaningful guard: `<video` really does exist in the raw source (in
	// comments) but never as a rendered element. If either stops holding, this test must be revisited.
	expect(
		raw.some((s) => /<video\b/.test(s)),
		'this guard depends on `<video` living only in comment prose (TvPlayer.svelte / routes/tv/+page.svelte); if that note is removed, update this test rather than deleting the assertion'
	).toBe(true);

	// The masked read: over RAW source the bare `video` tag falsely resolves against comment text...
	expect(selectorResolves('video', raw)).toBe(true);
	// ...but over comment-stripped source — what the guard actually feeds — it does not.
	expect(selectorResolves('video', stripped)).toBe(false);

	// And a genuinely-rendered tag still resolves after stripping, so the fix does not over-tighten.
	expect(selectorResolves('audio', stripped)).toBe(true);
});

test('every settings id the flow drives exists as an element id', () => {
	// SETTING_IDS is exempt from the resolver above because it is raw data; this is where each id is
	// resolved. The flow queries `#<id>`, so the source must carry `id="<id>"`.
	// Strip comments first: the flow resolves against RENDERED source, so a selector that appears only in
	// comment prose must not count as an anchor. Without this the driver scans (which already strip, :47/:368)
	// and this resolution disagree about what is source, and a dead selector living in a comment stays green.
	const sources = guardSources();
	const missing = SEL.SETTING_IDS.filter((id) => !sources.some((s) => s.includes(`id="${id}"`)));
	expect(missing).toEqual([]);
});

test('the scope-tab selector matches the id the settings page actually interpolates', () => {
	// SEL.settingsTab builds `#tab-<id>`, and the page writes that id as `id="tab-{t.id}"` — a template,
	// so `id="tab-you"` appears nowhere and a source grep cannot resolve it. This is therefore a FORMAT
	// assertion, the same shape as the swatch test above and for the same reason: the two sides can only
	// drift in the wrapper around the id, not in the id itself (settings-scopes.test.ts already pins the
	// ids to the TABS registry). Keeping a copy of that registry here would be one more hand-maintained
	// duplicate of the same vocabulary, which is the habit this repo keeps paying for.
	const src = readFileSync(join(CORE, 'src/routes/settings/+page.svelte'), 'utf8');
	const interpolated = /id="tab-\{([a-zA-Z.]+)\}"/.exec(src);
	expect(interpolated, 'the settings page no longer interpolates a tab id into id="tab-{...}"').not.toBeNull();
	// The helper must produce exactly that prefix and append nothing else.
	expect(SEL.settingsTab('you')).toBe('#tab-you');
});

/*
 * THE LITERAL BAN — the guard that would have caught the rot the guard above missed.
 *
 * Everything before this point checks selectors the drivers reach THROUGH the contract. It says nothing
 * about a selector a driver spells out for itself, and a literal is invisible to every check here by
 * construction: it is not in SEL, so the resolver never sees it, and it is not in HOOKS, so the anchor
 * check never sees it either. That is not a hypothetical hole. It is how `party.mjs` came to wait on
 * `.url` — the LOBBY's address — as its test for an EMPTY room, fail on every fresh server it demanded,
 * and blame leftover guests for it, while 48 sibling selectors went through the contract and stayed
 * honest. `.hint` was there too, asserting a ten-foot floor against an element the TV does not render
 * at all.
 *
 * So: a selector-shaped string literal anywhere in a driver is a failure, and the fix is to put it in
 * SEL where both halves of this file can see it.
 */
const DRIVERS = ['party.mjs', 'capture.mjs'];

/**
 * Literals that are selector-SHAPED but are not selectors. Each needs a reason: an unexplained
 * exemption is a hole with a comment on it.
 *
 * Only the FIRST rule below (the shape rule) consults this map, and only for a literal with no
 * interpolation — `` `.png${i}` `` head-stripping to `.png` and being waved through would be an
 * exemption swallowing a real class selector.
 */
const NOT_A_SELECTOR: Record<string, string> = {
	'.cache': 'a filesystem path segment — join(homedir(), ".cache", "ms-playwright") finds Chromium'
};

/**
 * Functions whose first argument IS a selector, by definition — the DOM's own query methods plus the
 * driver methods in cdp.mjs that forward to them.
 *
 * This is the rule that carries the invariant, and it is deliberately a CALL-SITE rule rather than a
 * syntax rule. A shape rule has to guess what a selector looks like, and every guess is a hole: the
 * first version of this guard required a literal to START with `.` or `#`, which let
 * `querySelectorAll('video, audio')` — a tag-led, comma-separated selector that had ALREADY rotted once
 * from a bare `video` — sit unguarded in capture.mjs while the test claimed no driver spelled a selector
 * out for itself. Compound descendant selectors (`.row .t`) are the dominant style in SEL, so
 * `'.sheet .peek'` would have escaped too. Asking "what is this string being USED as" needs no such
 * guess.
 *
 * Deliberately NOT listed: clickByText and clickByLabel, whose argument is visible text or an
 * accessible name, not a selector.
 */
const SELECTOR_TAKING = [
	'querySelector',
	'querySelectorAll',
	// The getElement* family takes an id/class/tag/name as its only argument, which is a selector by
	// any other name. Listed because `getElementById` is the NATURAL api for the `id="tab-…"` elements
	// the contract now drives, so it is the likeliest next literal — and neither the shape rule nor a
	// querySelector-only call-site rule can see it.
	'getElementById',
	'getElementsByClassName',
	'getElementsByTagName',
	'getElementsByName',
	'closest',
	'matches',
	'click',
	'fill',
	'count',
	'css',
	'text',
	'texts',
	'pressKey',
	'setRange'
];

test('no driver spells a selector out for itself — every one comes from the contract', () => {
	const offenders: string[] = [];
	const callSite = new RegExp(`\\.?\\b(${SELECTOR_TAKING.join('|')})\\(\\s*(['"\`])([^'"\`]*)\\2`, 'g');

	for (const name of DRIVERS) {
		const src = stripComments(readFileSync(join(import.meta.dir, name), 'utf8'));
		src.split('\n').forEach((line, i) => {
			/*
			 * RULE 1 — shape. A quoted string that begins with `.` or `#` and then an identifier
			 * character, or that is an attribute selector. Template placeholders count: a `#tab-${id}`
			 * inside backticks is exactly as unguarded as a plain string, and was one of the eight found
			 * here.
			 */
			for (const m of line.matchAll(/(['"`])((?:[.#][A-Za-z][\w$.{}\-]*)|(?:\[[a-zA-Z-]+\^?=[^'"`\]]*\]))\1/g)) {
				const literal = m[2]!;
				const interpolated = /\$\{/.test(literal);
				if (!interpolated && literal in NOT_A_SELECTOR) continue;
				offenders.push(`${name}:${i + 1} — ${m[0]} (selector-shaped literal)`);
			}
			/*
			 * RULE 2 — call site. Any selector-taking function invoked with a string LITERAL, whatever
			 * that literal's shape. This is what catches a tag-led or compound selector, which rule 1
			 * cannot see.
			 */
			for (const m of line.matchAll(callSite)) {
				const fn = m[1]!;
				const literal = m[3]!;
				if (/\$\{/.test(literal)) {
					// An interpolated argument still has to come from the contract, but its static head is
					// not the whole selector, so report it by the call rather than by the token.
					offenders.push(`${name}:${i + 1} — ${fn}(\`${literal}\`) (interpolated selector literal)`);
					continue;
				}
				offenders.push(`${name}:${i + 1} — ${fn}('${literal}') (literal in a selector position)`);
			}
		});
	}

	// Deduplicate: a literal can be caught by both rules, and one line reported twice reads as two bugs.
	const unique = [...new Set(offenders)].sort();
	expect(unique).toEqual([]);
});
