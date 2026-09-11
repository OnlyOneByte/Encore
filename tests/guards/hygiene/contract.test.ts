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
import { appCore, appE2e, at } from '@encore/test-support';
import { HOOKS, PRESET_COLOUR_NAMES, SEL } from '../../../apps/core/e2e/contract';
import { classPresent, svelteFiles } from '$lib/test-helpers';

// apps/core and apps/core/e2e, anchored at the repo root. `E2E` is what this guard's own location used
// to supply as `at('apps/core/e2e')`: the e2e directory holding the drivers, party.mjs and probes/.
const CORE = appCore;
const E2E = appE2e;

test('every file the e2e depends on still exists', () => {
	const missing = HOOKS.filter((h) => !existsSync(join(CORE, h.file))).map((h) => `${h.id}: ${h.file}`);
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
	const flow = stripComments(readFileSync(join(E2E, 'party.mjs'), 'utf8'));

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
	return svelteFiles(join(CORE, 'src')).map((f) => stripComments(readFileSync(f, 'utf8')));
}

test('the flow imports the contract instead of hard-coding selectors', () => {
	// If the flow keeps its own copy of the selectors, the guard is checking one thing and the browser
	// another — which is precisely how they drifted apart the first time.
	const flow = readFileSync(join(E2E, 'party.mjs'), 'utf8');
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
	// The join surface is JoinLanding.svelte since the /join route was retired (the join UI is now the
	// unjoined branch of `/`), so match it case-insensitively rather than the old lower-case `join` path.
	const files = new Set(HOOKS.map((h) => h.file));
	expect([...files].some((f) => /join/i.test(f))).toBe(true);
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

/*
 * Every .svelte source file under apps/core/src — the whole surface the flow can drive — comes from
 * `svelteFiles` in ../src/lib/test-helpers (XR-VER-14). This file used to carry a local walker
 * that was a VERBATIM copy of it under a different name, so the two could disagree about what the
 * flow's surface even is while the design guards under src/lib kept the other answer.
 */

/*
 * `classPresent` — does a token appear as a CLASS in a Svelte source, via `class="…"`, a
 * `class:token` directive, or a `.token` rule in <style>? — is imported from
 * ../src/lib/test-helpers (XR-VER-14), where its exact-token semantics are documented.
 * The `G2` case below exercises the shared function directly, so a regression there reds here.
 */

/**
 * Does a bare TAG appear in the source? `body`/`html` are guaranteed by HTML itself and appear in no
 * component; any other tag must be rendered somewhere or the read is aimed at an element the app does
 * not produce. Shared by the top-level bare-tag branch and the descendant-part branch below (a
 * `.slot.visible audio` ends in a tag, not a class).
 */
function tagResolves(tag: string, sources: string[]): boolean {
	if (tag === 'body' || tag === 'html') return true;
	return sources.some((s) => new RegExp(`<${tag}\\b`).test(s));
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
		const branches = selector
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
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
	// A CSS class selector, possibly compound and possibly with descendant/child/sibling structure
	// (`.row .t`, `.lyrics .word.active`, `.seekrow .track > i`, `.slot.visible audio`, `.card h2 + .bars`).
	// Split into the selector's structural PARTS — on descendant whitespace, the child combinator `>`,
	// AND the adjacent-sibling combinator `+`, which for a source-existence check all ask the same
	// question: does every part's anchor exist somewhere. A combinator does not change WHAT must exist
	// (both a child `.a > .b` and a sibling `.a + .b` need `.a` and `.b` rendered), only where they sit
	// relative to each other — which no source scan can see anyway — so `+` splits exactly like `>`.
	// EVERY part must resolve; a compound that names a dropped descendant/sibling is still broken. A part
	// is either a bare tag (`audio`, `i` — resolve as a tag), a class-compound (`.slot.visible` — every
	// `.token` must be a class), or a `:not(...)` exclusion chain (see its branch below). The leading part
	// starts with `.`, so this branch owns any selector beginning with a class even when a later part is a
	// tag or a `:not()` chain.
	if (selector.startsWith('.')) {
		const parts = selector.split(/\s*>\s*|\s*\+\s*|\s+/).filter(Boolean);
		if (parts.length === 0) return null;
		const partResults = parts.map((part): boolean | null => {
			// A `:not(...)` EXCLUSION chain — checked first because it can prefix any other part shape
			// (`:not(table):not(.note):not(.scroller)`, `.bars:not(.empty)`, `span:not(.x)`). Introduced
			// for the p11-dashboards `.card h2 + :not(table):not(.note):not(.scroller)` chart-or-body
			// read. A `:not()` argument filters OUT elements, so it names nothing that HAS to be
			// rendered; the positive anchor is the BASE written before the `:not()` chain. Peel every
			// `:not(...)` suffix off and resolve only that base:
			//   • a bare chain with no base (`:not(table)…`, the p11 case — the sibling it filters is
			//     anchored by the `.card h2` parts to its left) has no positive anchor of its own and
			//     resolves true, letting the sibling parts carry the resolution;
			//   • a chain WITH a base resolves that base as a class-compound (`.bars`) or a tag (`span`),
			//     so a base naming a dropped class/tag STILL fails — the non-vacuity is in the base.
			// The excluded arguments themselves are deliberately NOT required to exist: excluding a class
			// no component renders is a harmless over-specification, not a broken anchor.
			if (/:not\(/.test(part)) {
				const notChain = /^(.*?)((?::not\([^)]*\))+)$/.exec(part);
				if (notChain) {
					const [, base] = notChain;
					if (base === '') return true; // bare exclusion — no positive anchor, siblings carry it.
					if (base.startsWith('.')) {
						const tokens = base.split('.').filter(Boolean);
						if (tokens.length === 0) return null;
						return tokens.every((tok) => sources.some((s) => classPresent(s, tok)));
					}
					if (/^[a-z][a-z0-9]*$/.test(base)) return tagResolves(base, sources);
					return null; // a base shape this resolver does not otherwise model.
				}
				return null; // a `:not()` appearing in a shape the peel regex cannot split.
			}
			if (part.startsWith('.')) {
				// A class-compound part may carry a trailing UNQUOTED attribute selector, e.g. the
				// `.err[role=alert]` the p8-presence probe reads (a class + `[role=alert]`, no quotes).
				// Peel that suffix off and require BOTH the class token(s) AND the attribute's source
				// anchor: `[name=value]` renders as `name="value"` in source, so `name="value` is the
				// anchor — the same shape the quoted `[name="value"]` branch above resolves. Requiring
				// the real anchor (not merely accepting the shape) is what keeps this non-vacuous: a
				// `.err[role=nope]` must still fail because no source carries `role="nope`.
				// Accept either spelling of the value — `[role=alert]` (the p8 probe's unquoted form) and
				// `[role="alert"]` — since both render as `role="alert"` in source. The `["']?` bracket a
				// value that carries no quote of its own, so the capture is the bare value in both cases.
				const attrMatch = /^(\.[A-Za-z][\w.-]*)?\[([a-zA-Z-]+)(\^?)=["']?([^"'\]]+)["']?\]$/.exec(part);
				if (attrMatch) {
					const [, classPortion, attrName, prefix, attrValue] = attrMatch;
					void prefix; // `^=`/`=` share the `name="value` anchor, as in the quoted branch above.
					const anchorOk = sources.some((s) => s.includes(`${attrName}="${attrValue}`));
					if (!anchorOk) return false;
					const classTokens = (classPortion ?? '').split('.').filter(Boolean);
					return classTokens.every((tok) => sources.some((s) => classPresent(s, tok)));
				}
				const tokens = part.split('.').filter(Boolean);
				if (tokens.length === 0) return null;
				return tokens.every((tok) => sources.some((s) => classPresent(s, tok)));
			}
			// A bare-tag part inside a descendant/child selector (the `audio` in `.slot.visible audio`,
			// the `i` in `.seekrow .track > i`).
			if (/^[a-z][a-z0-9]*$/.test(part)) return tagResolves(part, sources);
			// A TAG.CLASS compound part — a bare tag anchored by one or more classes, e.g. the
			// `button.ok` in `.chips button.ok` (the readiness Ready chip is `<button class="chip ok">`;
			// the `button` distinguishes it from a `<span class="chip ... ok">` state chip a SongRow's
			// own `.chips` row also renders, so the tag is load-bearing, not decorative). Require BOTH
			// that the tag is rendered somewhere AND every `.token` resolves as a class — the same
			// non-vacuity the `.err[role=alert]` branch keeps: a `button.nope` still fails because no
			// source carries the `.nope` class, and a `marquee.ok` fails because no source renders that tag.
			const tagClass = /^([a-z][a-z0-9]*)((?:\.[A-Za-z][\w-]*)+)$/.exec(part);
			if (tagClass) {
				const [, tag, classPortion] = tagClass;
				if (!tagResolves(tag, sources)) return false;
				const classTokens = classPortion.split('.').filter(Boolean);
				return classTokens.every((tok) => sources.some((s) => classPresent(s, tok)));
			}
			// Any other part shape (a universal token, an unquoted attribute) is one this resolver does
			// not model — surface it as unmodelled rather than silently pass.
			return null;
		});
		if (partResults.some((r) => r === false)) return false;
		if (partResults.some((r) => r === null)) return null;
		return true;
	}
	/*
	 * A bare TAG selector. Any tag must actually be rendered somewhere (see tagResolves), or the read is
	 * aimed at an element the app does not produce.
	 */
	if (/^[a-z][a-z0-9]*$/.test(selector)) {
		return tagResolves(selector, sources);
	}
	return null;
}

test('every SEL selector resolves to an anchor in the source (the guard, non-vacuous)', () => {
	// Strip comments first: the flow resolves against RENDERED source, so a selector that appears only in
	// comment prose must not count as an anchor. Without this the driver scans (which already strip, :47/:368)
	// and this resolution disagree about what is source, and a dead selector living in a comment stays green.
	const sources = guardSources();

	// NON-VACUITY FLOOR on the SCANNED POPULATION (XR-VER-14 Acceptance). `unresolved` and
	// `unmodelled` are both asserted EMPTY below, and an empty-array assertion is what a working guard
	// produces AND what a guard reading nothing produces. Over a NARROWED walk — a moved directory, a
	// copy-in path the walk misses — the surviving files can still carry every SEL anchor while whole
	// surfaces go unexamined, and nothing says so. The walk finds 27 `.svelte` files under
	// apps/core/src today. A firing floor is a FINDING: restore the walk's scope, never lower the
	// number (XR-VER-06).
	expect(sources.length).toBeGreaterThanOrEqual(20); // @nvf-floor sources.length

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
	const raw = svelteFiles(join(CORE, 'src')).map((f) => readFileSync(f, 'utf8'));

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
	// Non-vacuity floor: filtering an empty SETTING_IDS yields [] and passes without
	// resolving a single id. Assert the flow actually drives some settings ids.
	expect(SEL.SETTING_IDS.length).toBeGreaterThan(0);
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
/**
 * Every driver under `e2e/` and `e2e/probes/` — enumerated, not hand-listed. The previous version of
 * this guard named only `party.mjs` and `capture.mjs`, so the literal ban applied to 2 of the 24
 * drivers while `HARNESS.md` told every probe author the guard covered them all. The other 22
 * spelled selectors out for themselves, unwatched — exactly the rot this file exists to stop, filed
 * from a read-only audit that counted 110+ such literals.
 *
 * `cdp.mjs` is excluded because it is the driver LIBRARY, not a driver: it DEFINES the selector-taking
 * methods and only ever forwards `JSON.stringify(selector)` — a variable, never a literal — so it has
 * no hand-written selector of its own to guard.
 */
function allDrivers(): string[] {
	const out: string[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (ent.isDirectory()) walk(join(dir, ent.name), `${prefix}${ent.name}/`);
			else if (ent.name.endsWith('.mjs') && ent.name !== 'cdp.mjs') out.push(`${prefix}${ent.name}`);
		}
	};
	walk(E2E, '');
	return out.sort();
}
const DRIVERS = allDrivers();

/**
 * KNOWN OFFENDERS — the debt baseline (migration split to a follow-up issue).
 *
 * Widening the ban from 2 drivers to all 24 surfaces the selectors the other 22 already spell out for
 * themselves. Fixing all of them — moving ~85 distinct selectors across 16 files into SEL and rewriting
 * every `evaluate()` body to interpolate them — is a 16-file migration, far past this guard's one
 * concern. So each currently-hand-written selector is QUARANTINED here, keyed by driver, as tracked
 * debt: the guard now covers all 24 drivers, and a NEW selector literal in ANY driver — including a
 * brand-new file — REDs, because only the exact `(file, literal)` pairs listed below are waved through.
 *
 * This is the explicit-exemption discipline the header demands: "an unexplained exemption is a hole
 * with a comment on it." Every entry below is a hole with THIS comment on it, and the follow-up issue
 * is the plan to close it. Do NOT add to this map to silence a new literal — put the selector in SEL.
 */
const KNOWN_OFFENDERS: Record<string, string[]> = {
	'fuzz.mjs': ['#ff5cae', '[aria-label='],
	'lobby-overlap.mjs': [
		// Hex swatch colours the probe drives the picker with — caught by the shape rule, not selectors.
		'#a855f7',
		'#ec4899',
		'#f43f5e',
		'#f59e0b'
	],
	'playback.mjs': ['video,audio'],
	'probes/lower-third.mjs': ['#ff5cae', 'audio,video'],
	'probes/p1-gapless.mjs': [
		// Not selectors: a hex colour caught by the shape rule, and the bare media-element liveness union.
		'#ff5cae',
		'audio,video'
	],
	'probes/p10-scaling.mjs': [
		// STAYS - a bare tag query, not a UI hook.
		'button',
		// Group E of the per-driver split (tail of the SEL migration) migrated the ten resolvable
		// selectors this driver used to spell out into SEL and rewrote the p10 data arrays to
		// interpolate them, so they are gone from this list: the attract screen, the row card, the
		// row chip, the three badqr notice lines, the two scoped lower-third lines, and the two
		// up-next lines.
		//
		// One entry STAYS quarantined:
		//
		//   the badqr universal-child read — a badqr container followed by the UNIVERSAL child token.
		//     The SEL-resolution guard models class / tag / tag.class / attribute / combinator parts,
		//     but not a bare universal token: it has no anchor to resolve against (it matches every
		//     element), so putting it in SEL would either fail the resolver or force a widening that
		//     waves anything through. p10 reads it only to enumerate the notice card's descendants for
		//     an overflow check; it stays a literal.
		//
		// A follow-up pass completed Group E's deferred cleanup of the three DEAD reads that were quarantined here:
		// '.b', '.filter-chip' and '.roster' named classes no component ever declared, so they were
		// removed from p10's contrast targets outright ('.attract .idle-title' was repointed to
		// SEL.stageHeadline and '.row .a' to '.row .byline'). They are no longer in the data arrays and
		// so no longer need a quarantine entry. The G1 guard below now reds if a p10 target ever again
		// names an unresolvable class, and that same pass also tightened classPresent so '.b' can no longer
		// spuriously resolve against the 'badqr-b' fragment.
		'.badqr *'
	],
	'probes/p11-dashboards.mjs': [
		// Bare tags / a tag descendant, deliberately NOT UI selectors: `body`/`h1`/`h2` are structural
		// document chrome and `table th` is a tag descendant read for header text, not a hook.
		'body',
		'h1',
		'h2',
		'table th'
		// Group D of the SEL-migration tail migrated this driver's four real hooks into SEL — .card
		// (SEL.dashCard), .card table (SEL.dashCardTable), .tile .n (SEL.dashTileNumber), and the
		// `.card h2 + .bars, .card h2 + :not(table):not(.note):not(.scroller)` chart-or-body union
		// (SEL.dashChartOrBody) — extending the resolver to model the `+` adjacent-sibling combinator
		// and a `:not()` exclusion chain. This was the engine-heavy group; see the Group D test below.
	],
	'probes/p12-search.mjs': [
		// Hex swatch colour (shape rule), not a selector.
		'#ff5cae'
		// '.chips button.ok' was migrated to SEL.readyChip (Group C of the per-driver split, tail of the SEL migration) and then
		// RETIRED when the readiness chip row it anchored was deleted. Nothing returns here: the
		// probe reaches the same empty state by typing a non-matching query.
	],
	'probes/p13-tap-to-start.mjs': [
		' + JSON.stringify(SEL.queueRow) + ',
		' + JSON.stringify(SEL.search) + ',
		' + JSON.stringify(SEL.songRow) + ',
		'video,audio'
	],
	'probes/p14-playhead-vs-cook.mjs': ['#ff5cae', 'audio'],
	/*
	 * `shoot-913.mjs` is a CAPTURE script, not a driver: it produces the before/after evidence for an
	 * accepted visual change and asserts nothing. It still goes through this guard because the guard
	 * enumerates every driver under `e2e/` rather than a hand-kept list, which is the right default.
	 */
	'shoot-913.mjs': [
		// The join colour: a swatch VALUE, the same shape rule p2, p14 and p16 rely on.
		'#ff5cae',
		// The join/continue control, found by accessible text — it now sits on the vendored <Button>,
		// where a class belongs to the component rather than the app.
		'button',
		// A file extension, not a selector: this is the only script here that writes files.
		'.png'
	],
	'probes/p16-hero-live-controls.mjs': [
		// The join colour: a swatch VALUE, not a selector — the same shape rule p2 and p14 rely on.
		'#ff5cae',
		// The join screen's submit control, found by accessible text rather than a class: it was moved
		// onto the vendored <Button>, where a class belongs to the component rather than the app. A bare
		// tag name is not a selector the contract can own.
		'button'
	],
	'probes/p15-reload-resume.mjs': [
		// Same two non-selectors p14 carries: a bare-tag media-element query (see SEL.mediaEl for the
		// union form) and the join swatch hex colour (a shape-rule hit, not a UI selector).
		'#ff5cae',
		'audio'
	],
	'probes/p2-guiding-track.mjs': ['#ff5cae', 'audio,video'],
	'probes/p3-key-shift.mjs': [
		// Media-element liveness union, not a UI selector (see SEL.mediaEl).
		'video,audio'
	],
	'probes/p4-transport.mjs': [
		// Tag-only / attribute-fragment reads, deliberately NOT selectors:
		'[aria-label=', // truncated attribute-selector fragment built by string concat
		'audio' // a bare tag query for the media element (see SEL.mediaEl for the union form)
		// Group A of the SEL-migration tail migrated the two combinator/descendant selectors that used to
		// sit here into SEL (slotVisibleAudio, seekFill), extending the resolver to model a `>` child
		// combinator and a bare-tag descendant. Groups B–E track the rest of the tail.
	],
	'probes/p6-lyrics.mjs': [
		// Liveness reads, deliberately NOT in SEL: a bare tag-union existence check for a media element,
		// not a UI selector (the same rationale as SEL.mediaEl's `video, audio`).
		'video, audio',
		'video,audio'
	],
	'probes/p8-presence-resilience.mjs': [
		// Tag-only / attribute-fragment reads, deliberately NOT selectors moved to SEL:
		'[aria-label=', // a truncated attribute-selector fragment built by string concat, not a whole selector
		'button' // a bare tag query for "any button", not a UI-specific hook
		// '.err[role=alert]' MIGRATED to SEL.joinError in Group B of the per-driver split:
		// selectorResolves now models a class + unquoted-attribute compound, so the probe reads it from
		// the contract instead of spelling it out here.
	],
	'probes/tv-audiocontext-resume.mjs': ['audio,video']
};

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

	// A `(file, literal)` pair listed in KNOWN_OFFENDERS is tracked debt (see the map's comment) and is
	// waved through; anything else is a fresh hand-written selector and fails here.
	const quarantined = (name: string, token: string) => (KNOWN_OFFENDERS[name] ?? []).includes(token);

	for (const name of DRIVERS) {
		const src = stripComments(readFileSync(join(E2E, name), 'utf8'));
		src.split('\n').forEach((line, i) => {
			/*
			 * RULE 1 — shape. A quoted string that begins with `.` or `#` and then an identifier
			 * character, or that is an attribute selector. Template placeholders count: a `#tab-${id}`
			 * inside backticks is exactly as unguarded as a plain string, and was one of the eight found
			 * here.
			 */
			for (const m of line.matchAll(/(['"`])((?:[.#][A-Za-z][\w$.{}-]*)|(?:\[[a-zA-Z-]+\^?=[^'"`\]]*\]))\1/g)) {
				const literal = m[2]!;
				const interpolated = /\$\{/.test(literal);
				if (!interpolated && literal in NOT_A_SELECTOR) continue;
				if (quarantined(name, literal)) continue;
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
					if (quarantined(name, `INTERP:${literal}`)) continue;
					// An interpolated argument still has to come from the contract, but its static head is
					// not the whole selector, so report it by the call rather than by the token.
					offenders.push(`${name}:${i + 1} — ${fn}(\`${literal}\`) (interpolated selector literal)`);
					continue;
				}
				if (quarantined(name, literal)) continue;
				offenders.push(`${name}:${i + 1} — ${fn}('${literal}') (literal in a selector position)`);
			}
		});
	}

	// Deduplicate: a literal can be caught by both rules, and one line reported twice reads as two bugs.
	const unique = [...new Set(offenders)].sort();
	expect(unique).toEqual([]);
});

test('the driver ban is not vacuous — it covers every driver, not a shrunk list', () => {
	// The rot this file catches came from a hand-kept list going stale. A hand-kept DRIVERS array could
	// silently empty (or shrink back to 2) and the ban above would pass while guarding nothing, so pin a
	// floor: there are 24 drivers today, and the enumeration must keep finding roughly that many.
	expect(DRIVERS.length).toBeGreaterThan(20); // @nvf-floor DRIVERS.length
	// party.mjs and capture.mjs — the two the old list named — must still be in the enumerated set, so a
	// walk that regressed to matching nothing cannot pass this test either.
	expect(DRIVERS).toContain('party.mjs');
	expect(DRIVERS).toContain('capture.mjs');
	// And a spot-check that the walk reaches into probes/, the subtree the old list never covered.
	expect(DRIVERS.some((d) => d.startsWith('probes/'))).toBe(true);
});

test('Group A — p4-transport combinator/descendant selectors moved from KNOWN_OFFENDERS into SEL', () => {
	// Half 1: the two selectors are no longer quarantined for p4-transport. On base they sat in
	// KNOWN_OFFENDERS (the driver spelled them out); after the migration the ONLY honest place they may
	// live is SEL, so KNOWN_OFFENDERS must no longer wave them through.
	const p4 = KNOWN_OFFENDERS['probes/p4-transport.mjs'] ?? [];
	expect(p4).not.toContain('.slot.visible audio');
	expect(p4).not.toContain('.seekrow .track > i');

	// Half 2: the two selectors now live in SEL with their exact values, and the resolver — extended
	// here to model a bare-tag descendant and a `>` child combinator — resolves each against real
	// source (a green null/false would mean the SEL entry points at markup no component renders).
	expect(SEL.slotVisibleAudio).toBe('.slot.visible audio');
	expect(SEL.seekFill).toBe('.seekrow .track > i');
	const sources = guardSources();
	expect(selectorResolves(SEL.slotVisibleAudio, sources)).toBe(true);
	expect(selectorResolves(SEL.seekFill, sources)).toBe(true);

	// The resolver extension must be REAL, not a widening that passes anything: a descendant/child
	// selector whose tag part names an element no component renders must still FAIL to resolve, and a
	// class part that names a dropped class must still fail. This is what keeps the ban non-vacuous.
	expect(selectorResolves('.slot.visible marquee', sources)).toBe(false);
	expect(selectorResolves('.seekrow .track > blink', sources)).toBe(false);
	expect(selectorResolves('.nope-not-a-class audio', sources)).toBe(false);
});

test('Group B — p8-presence .err[role=alert] moved from KNOWN_OFFENDERS into SEL', () => {
	// Half 1: the class + UNQUOTED-attribute compound is no longer quarantined for p8-presence. On base
	// it sat in KNOWN_OFFENDERS (the probe spelled it out); after the migration the only honest place it
	// may live is SEL, so KNOWN_OFFENDERS must no longer wave it through.
	const p8 = KNOWN_OFFENDERS['probes/p8-presence-resilience.mjs'] ?? [];
	expect(p8).not.toContain('.err[role=alert]');

	// Half 2: it now lives in SEL with its exact value, and the resolver — extended here to model a
	// class + unquoted-attribute compound (`[role=alert]`, not `[role="alert"]`) — resolves it against
	// real source. The anchor is `<div class="err" role="alert">` in lib/components/JoinLanding.svelte, so a
	// green false/null here would mean the SEL entry points at markup no component renders.
	expect(SEL.joinError).toBe('.err[role=alert]');
	const sources = guardSources();
	expect(selectorResolves(SEL.joinError, sources)).toBe(true);
	// The QUOTED spelling of the same selector resolves too — the source anchor `role="alert` is shared.
	expect(selectorResolves('.err[role="alert"]', sources)).toBe(true);

	// The resolver extension must be REAL, not a widening that accepts any `.class[attr=val]` shape:
	//   • a wrong ATTRIBUTE VALUE must still fail — no source carries `role="nope`;
	//   • a wrong CLASS must still fail — no component renders a `.nope-not-a-class`;
	//   • a wrong ATTRIBUTE NAME must still fail — the `data-x="alert` anchor is not in source.
	// This is what keeps the ban non-vacuous: the compound only passes when BOTH real anchors exist.
	expect(selectorResolves('.err[role=nope]', sources)).toBe(false);
	expect(selectorResolves('.nope-not-a-class[role=alert]', sources)).toBe(false);
	expect(selectorResolves('.err[data-x=alert]', sources)).toBe(false);
});

test('Group C — the resolver still models a `tag.class` compound part (re-anchored after the readiness chip row was deleted)', () => {
	// RE-ANCHORED, ON THE RECORD (XR-VER-07). This test used to pin SEL.readyChip ('.chips button.ok')
	// through two halves: that KNOWN_OFFENDERS no longer waved the literal through, and that the SEL
	// entry resolved against real source. The readiness chip row was deleted, so both halves now name
	// markup nothing renders — they cannot hold, and lowering them to a `null` check would leave the
	// test looking authoritative while asserting nothing.
	//
	// What must NOT rot with them is the RESOLVER EXTENSION they were built on: modelling a `tag.class`
	// compound part — a bare tag anchored by a class, mid-selector — which no other test exercises. A
	// surviving real instance of that shape is `.showall-row button.chip`, the way back out of a
	// non-matching search, so the positive arm re-anchors there and the negatives are unchanged.
	const sources = guardSources();
	expect(selectorResolves('.showall-row button.chip', sources)).toBe(true);

	// The resolver extension must be REAL, not a widening that accepts any `tag.class` shape:
	//   • a wrong CLASS must still fail — no source renders a `button.nope-not-a-class`;
	//   • a wrong TAG must still fail — no component renders a `<marquee`, so `marquee.chip` fails;
	//   • the bare-tag part is load-bearing — a class-only handle would match a SongRow's own
	//     `<span class="chip state">` too, which is why the shape keeps the `button` anchor.
	expect(selectorResolves('.showall-row button.nope-not-a-class', sources)).toBe(false);
	expect(selectorResolves('.showall-row marquee.chip', sources)).toBe(false);
});

test('Group D — p11-dashboards card/tile/chart selectors moved from KNOWN_OFFENDERS into SEL', () => {
	// Half 1: all four selectors are no longer quarantined for p11-dashboards. On base they sat in
	// KNOWN_OFFENDERS (the probe spelled them out); after the migration the only honest place they may
	// live is SEL, so KNOWN_OFFENDERS must no longer wave any of them through. The bare tags the driver
	// also reads (body/h1/h2, table th) are NOT selectors and legitimately stay quarantined.
	const p11 = KNOWN_OFFENDERS['probes/p11-dashboards.mjs'] ?? [];
	expect(p11).not.toContain('.card');
	expect(p11).not.toContain('.card table');
	expect(p11).not.toContain('.tile .n');
	expect(p11).not.toContain('.card h2 + .bars, .card h2 + :not(table):not(.note):not(.scroller)');

	// Half 2: the four now live in SEL with their exact values, and the resolver — extended here to
	// model the `+` adjacent-sibling combinator AND a `:not()` exclusion chain (this is the engine-heavy
	// group) — resolves each against real source. Anchors on routes/stats/+page.svelte: `<div class="card">`
	// / `<div class="card tile">`, a `<table>` inside a card, `<span class="n">` inside a `.tile`, and the
	// <Bars> chart's `<ol class="bars">` following a card `<h2>`. A green false/null would mean the SEL
	// entry points at markup no component renders.
	expect(SEL.dashCard).toBe('.card');
	expect(SEL.dashCardTable).toBe('.card table');
	expect(SEL.dashTileNumber).toBe('.tile .n');
	expect(SEL.dashChartOrBody).toBe('.card h2 + .bars, .card h2 + :not(table):not(.note):not(.scroller)');
	const sources = guardSources();
	expect(selectorResolves(SEL.dashCard, sources)).toBe(true);
	expect(selectorResolves(SEL.dashCardTable, sources)).toBe(true);
	expect(selectorResolves(SEL.dashTileNumber, sources)).toBe(true);
	// The union resolves because its FIRST branch (`.card h2 + .bars`) does — every part (`.card`, the
	// `h2` tag, the `.bars` chart class) is rendered; the `+` sibling combinator splits like `>`.
	expect(selectorResolves(SEL.dashChartOrBody, sources)).toBe(true);
	// Prove the `+` sibling combinator alone resolves as its own selector, not only inside the union.
	expect(selectorResolves('.card h2 + .bars', sources)).toBe(true);
	// Prove the `:not()` branch alone resolves too: the `:not(...)` chain is an exclusion that carries no
	// positive anchor, so the sibling parts (`.card`, `h2`) carry the resolution.
	expect(selectorResolves('.card h2 + :not(table):not(.note):not(.scroller)', sources)).toBe(true);

	// The resolver extension must be REAL, not a widening that accepts any `+`/`:not()` shape:
	//   • a `+`-sibling naming a dropped CLASS must still fail — no source renders a `.nope-not-a-class`;
	//   • a `+`-sibling naming an unrendered TAG must still fail — no component renders a `<marquee>`;
	//   • a class BEFORE the sibling that no component renders must still fail — no `.nope-card` exists;
	//   • a `:not()` chain whose BASE anchor is a dropped class must still fail (`.nope-base:not(table)`),
	//     proving the base part is genuinely resolved rather than the whole chain waved through.
	//   • BUT the `:not()` ARGUMENTS themselves are exclusions and need NOT exist — `.card h2 + :not(marquee)`
	//     still resolves even though no `<marquee>` renders, because excluding an absent element is a
	//     harmless over-specification, not a broken anchor.
	expect(selectorResolves('.card h2 + .nope-not-a-class', sources)).toBe(false);
	expect(selectorResolves('.card h2 + marquee', sources)).toBe(false);
	expect(selectorResolves('.nope-card h2 + .bars', sources)).toBe(false);
	expect(selectorResolves('.card .nope-base:not(table)', sources)).toBe(false);
	expect(selectorResolves('.card h2 + :not(marquee)', sources)).toBe(true);
});

test('Group E — p10-scaling data-array selectors moved from KNOWN_OFFENDERS into SEL', () => {
	// Half 1: the ten resolvable selectors this driver used to spell out are no longer quarantined for
	// p10-scaling. On base they sat in KNOWN_OFFENDERS (the probe spelled them out in its contrast
	// targets/data arrays); after the migration the only honest place they may live is SEL, so
	// KNOWN_OFFENDERS must no longer wave them through.
	const p10 = KNOWN_OFFENDERS['probes/p10-scaling.mjs'] ?? [];
	for (const gone of [
		'.attract',
		'.card',
		'.chip',
		'.badqr-t',
		'.badqr-b',
		'.badqr-fix',
		'.lower-third .ls-name',
		'.lower-third .ls-song',
		'.up-label',
		'.up-song'
	]) {
		expect(p10).not.toContain(gone);
	}

	// Half 2: the ten now come from SEL. Four reuse entries the SEL migration already added (attract/dashCard/
	// scoped lower-third/up lines); four are new Group E entries (chip + the three badqr notice lines).
	// Each resolves against real source — a green false/null would mean the SEL entry points at markup
	// no component renders.
	expect(SEL.attract).toBe('.attract');
	expect(SEL.dashCard).toBe('.card');
	expect(SEL.chip).toBe('.chip');
	expect(SEL.badQrTitle).toBe('.badqr-t');
	expect(SEL.badQrBody).toBe('.badqr-b');
	expect(SEL.badQrFix).toBe('.badqr-fix');
	expect(SEL.nowNameScoped).toBe('.lower-third .ls-name');
	expect(SEL.nowSongScoped).toBe('.lower-third .ls-song');
	expect(SEL.upLabel).toBe('.up-label');
	expect(SEL.upSong).toBe('.up-song');
	const sources = guardSources();
	for (const key of [
		'attract',
		'dashCard',
		'chip',
		'badQrTitle',
		'badQrBody',
		'badQrFix',
		'nowNameScoped',
		'nowSongScoped',
		'upLabel',
		'upSong'
	] as const) {
		expect(selectorResolves(SEL[key] as string, sources), key).toBe(true);
	}

	// Half 3: only '.badqr *' stays quarantined. A follow-up pass completed Group E's deferred cleanup — the three
	// DEAD reads ('.b', '.filter-chip', '.roster') were removed from p10's contrast targets outright,
	// so they no longer need — and no longer have — a quarantine entry here.
	for (const kept of ['.badqr *']) {
		expect(p10).toContain(kept);
	}
	for (const gone of ['.b', '.filter-chip', '.roster']) {
		expect(p10).not.toContain(gone);
	}
	// '.badqr *' is UNMODELLABLE: the universal-child token has no source anchor, so the resolver
	// returns null (not true, not false) — putting it in SEL would fail the every-SEL-resolves guard.
	expect(selectorResolves('.badqr *', sources)).toBeNull();
	// The three former offenders all resolve FALSE now: '.filter-chip' and '.roster' name classes no
	// component renders, and '.b' — which the resolver used to wave through by matching a word-boundary
	// `b` inside the `badqr-b` fragment — is rejected after classPresent was tightened to exact-token
	// matching. A dead read that reds instead of silently resolving is the whole point of §2.
	expect(selectorResolves('.filter-chip', sources)).toBe(false);
	expect(selectorResolves('.roster', sources)).toBe(false);
	expect(selectorResolves('.b', sources)).toBe(false);
});

/*
 * — G1: every string-literal contrast target in p10-scaling.mjs must resolve to a real source
 * anchor. The two `targets` arrays live inside `page.evaluate(`…`)` template literals in the driver,
 * which is outside `bun test` and so never runs here; nothing catches a target that names a class no
 * component declares (the loops skip a null querySelector, and p10 always exits 0). Five did exactly
 * that — `.attract .idle-title`, `.roster`, `.row .a`, `.filter-chip`, `.b` — so this pins the
 * invariant in the always-on suite, reusing the same `selectorResolves`/`guardSources`/`stripComments`
 * the SEL-resolution guard uses. Interpolated entries (`${JSON.stringify(SEL.x)}`) are covered by the
 * every-SEL-resolves guard, so only the raw string literals are checked here.
 */
function p10TargetLiterals(): { arrays: string[]; lits: string[] } {
	// Blank comments so a `// '.roster' stays a literal` note cannot leak a literal into the scan; the
	// stripping is load-bearing on the p10 side because these literals also appear raw in prose above
	// the arrays (`.roster` 3× raw / 1× stripped).
	const src = stripComments(readFileSync(join(E2E, 'probes/p10-scaling.mjs'), 'utf8'));
	const arrays: string[] = [];
	for (const m of src.matchAll(/const targets = \[/g)) {
		let depth = 0;
		let i = m.index! + m[0].length - 1; // sit on the opening '['
		const start = i;
		for (; i < src.length; i++) {
			if (src[i] === '[') depth++;
			else if (src[i] === ']') {
				depth--;
				if (depth === 0) break;
			}
		}
		arrays.push(src.slice(start, i + 1));
	}
	const lits: string[] = [];
	for (const body of arrays) {
		// Drop `${…}` interpolations (SEL entries — checked by the SEL guard) before pulling literals.
		const stripped = body.replace(/\$\{[^}]*\}/g, ' ');
		for (const lm of stripped.matchAll(/'([^']*)'/g)) lits.push(lm[1]);
	}
	return { arrays, lits };
}

test('G1 — every literal p10-scaling contrast target resolves to a real anchor', () => {
	const { arrays, lits } = p10TargetLiterals();
	const sources = guardSources();

	// Sentinel A: both target arrays were actually found and their literals extracted. Replacing the
	// arrays with `[]` (or a rename that hides them from the scan) makes the main arm pass vacuously —
	// this floor reds instead. 19 distinct live literals across the two arrays at the time of writing.
	expect(arrays.length).toBe(2);
	expect(lits.length).toBeGreaterThanOrEqual(19); // @nvf-floor lits.length

	// Sentinel B: known-live anchors the arrays name must resolve, so a resolver that rejects
	// everything (or a broken guardSources) fails here rather than passing the main arm vacuously.
	for (const live of [
		'.badqr-b b',
		'.lower-third .ls-artist',
		'.attract .brand',
		'.row .byline',
		'.qrow .t',
		'body',
		'h1',
		'a'
	]) {
		expect(selectorResolves(live, sources), live).toBe(true);
	}

	// Sentinel C: at least six of the literals resolve as CLASS selectors specifically (not just as
	// bare tags), so a class-blind resolver that only ever checked tags cannot pass this.
	const classLits = [
		'.badqr-b b',
		'.lower-third .ls-key',
		'.attract .jt-url',
		'.row .t',
		'.row .byline',
		'.searchbox input'
	];
	for (const c of classLits) expect(selectorResolves(c, sources), c).toBe(true);

	// Main arm: EVERY literal target resolves. A `false` means the target names a class/tag no
	// component declares (the §1 defect); a `null` means an unmodelled shape slipped into the arrays.
	const dead = lits.filter((l) => selectorResolves(l, sources) !== true);
	expect(dead).toEqual([]);
});

/*
 * — G2: classPresent must reject a token that only appears as a fragment of a longer class or as
 * an interpolated JS identifier. The old `class="[^"]*\b${t}\b[^"]*"` arm treated `-` as a word
 * boundary, so `class="badqr-b"` resolved the bare token `b`, and `class="pill {a.outcome}"` resolved
 * the variable `a`. Both are dead classes no element carries, yet the guard whose job is to red on a
 * vanished anchor waved them through. Each assertion is red on base and pinned against a real anchor
 * in the SAME source so the arm cannot be "fixed" by rejecting everything.
 */
test('G2 — classPresent rejects a hyphen-fragment or interpolated-identifier token', () => {
	const joinBadge = readFileSync(join(CORE, 'src/lib/tv/JoinBadge.svelte'), 'utf8');
	const auditPage = readFileSync(join(CORE, 'src/routes/metrics/[mediaId]/+page.svelte'), 'utf8');

	// `b` only ever appears as the `-b` tail of `badqr-b` — not a class any element carries.
	expect(classPresent(joinBadge, 'b')).toBe(false);
	// but the real class `badqr-b` still resolves (non-vacuity: the arm did not just start rejecting all).
	expect(classPresent(joinBadge, 'badqr-b')).toBe(true);

	// `a` only appears as the JS identifier inside `class="pill {a.outcome ?? 'running'}"`.
	expect(classPresent(auditPage, 'a')).toBe(false);
	// but the real static class `pill` on that same element still resolves.
	expect(classPresent(auditPage, 'pill')).toBe(true);
});
