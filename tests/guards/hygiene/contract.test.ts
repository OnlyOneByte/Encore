// guard: the e2e flow stays aimed at the app it claims to test. No browser and no server, so it cannot
// rot by skipping — a permanently-skipped browser test is indistinguishable from the silent rot it was
// meant to prevent. See docs/GUARDS.md#the-hygiene-and-meta-guards.
import { test, expect } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { e2eDir, repoRoot } from '@encore/test-support';
import { HOOKS, PRESET_COLOUR_NAMES, SEL } from '$e2e/contract';
import { classPresent, svelteFiles } from '@encore/test-support/scan';

const CORE = repoRoot;
const E2E = e2eDir;

test('every file the e2e depends on still exists', () => {
	const missing = HOOKS.filter((h) => !existsSync(join(CORE, h.file))).map((h) => `${h.id}: ${h.file}`);
	expect(missing).toEqual([]);
});

test('every selector the e2e drives still has an anchor in the source', () => {
	// Comments stripped: an anchor satisfied by comment PROSE is no anchor. Two hooks (`<NowPlayingBand`,
	// `handleOnly`) would have stayed green with the element deleted, because the prose named it.
	const broken: string[] = [];
	for (const h of HOOKS) {
		const p = join(CORE, h.file);
		if (!existsSync(p)) continue; // reported by the test above
		if (!stripComments(readFileSync(p, 'utf8')).includes(h.anchor)) {
			broken.push(`${h.id} — "${h.anchor}" is gone from ${h.file}\n    (the flow needs it: ${h.why})`);
		}
	}
	expect(broken).toEqual([]);
});

/** The exact rot that happened, named as its own case so a reader meets the defect, not just the rule. */
test('the e2e does not reference UI that was removed', () => {
	// Comments first: this file's own header names the dead selectors.
	const flow = stripComments(readFileSync(join(E2E, 'party.mjs'), 'utf8'));

	// Each of these three spellings rotted in place: the Library tab (deleted), a `color #hex` swatch label
	// (now the bare colour name), and `.result` rows (now `.row`).
	expect(flow).not.toContain("name: 'Library'");
	expect(flow).not.toMatch(/name: `color #/);
	expect(flow).not.toContain('.result');
});

/**
 * Blank comments out, keeping newlines so reported line numbers stay true. Covers JS block/line AND
 * Svelte `<!-- -->` comments: a selector appearing only in prose of either kind is not a rendered anchor.
 */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/(^|[^:'"\\`])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
}

/**
 * The source array the SEL resolver runs over. The comment-stripping regression test below consumes THIS
 * builder rather than a private copy, so the two cannot disagree about what counts as source.
 */
function guardSources(): string[] {
	return svelteFiles(join(CORE, 'src')).map((f) => stripComments(readFileSync(f, 'utf8')));
}

test('the flow imports the contract instead of hard-coding selectors', () => {
	// A private copy of the selectors in the flow means the guard checks one thing and the browser another.
	const flow = readFileSync(join(E2E, 'party.mjs'), 'utf8');
	expect(flow).toMatch(/from '\.\/contract(\.ts)?'/);
});

test('the colour names in the contract match the ones the picker announces', () => {
	// PRESET_COLOUR_NAMES is what the flow queries by; a renamed colour must fail here, not in a browser.
	const picker = readFileSync(join(CORE, 'src/lib/components/ColourPicker.svelte'), 'utf8');
	const declared = /PRESET_NAMES\s*=\s*\[([^\]]*)\]/.exec(picker)?.[1] ?? '';
	const names = [...declared.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
	expect(names).toEqual([...PRESET_COLOUR_NAMES]);
});

test('the swatch selector asks for the accessible name the picker actually renders', () => {
	// THE BUG THIS EXISTS FOR: the two name LISTS agreeing is not the SELECTOR being right. SEL.swatch wraps
	// each name in a format, and that wrapper drifted twice (`color #ff5cae`, then `violet swatch`) while
	// both lists stayed correct. So assert the format against the component's own expression.
	const picker = readFileSync(join(CORE, 'src/lib/components/ColourPicker.svelte'), 'utf8');

	expect(picker).toMatch(/aria-label=\{colorName\(c\)\}/);

	// colorName returns a PRESET_NAMES entry unmodified; a template literal is how the stale wrapper got in.
	const body = /export function colorName\([^)]*\)[^{]*\{([\s\S]*?)\n\t\}/.exec(picker)?.[1] ?? '';
	expect(body).not.toBe('');
	expect(body).not.toMatch(/`/);

	// And the selector helper must not re-add one on its side either.
	expect(SEL.swatch('pink').name).toBe('pink');
});

test('the contract exposes a hook for each surface the flow has to reach', () => {
	// The flow spans join, remote and TV, so all three must be represented. Join is JoinLanding.svelte.
	const files = new Set(HOOKS.map((h) => h.file));
	expect([...files].some((f) => /join/i.test(f))).toBe(true);
	expect([...files].some((f) => f.endsWith('routes/+page.svelte'))).toBe(true);
	expect([...files].some((f) => f.includes('routes/tv'))).toBe(true);
	// and the selector map must not have gone empty through a bad refactor
	expect(Object.keys(SEL).length).toBeGreaterThan(10);
});

/*
 * SEL — the map the drivers actually query the DOM with — is a second hand-kept copy of the same truth as
 * HOOKS, and only HOOKS was ever checked: pointing SEL.songRow at a class that exists nowhere left the
 * whole suite green. Everything below resolves every concrete SEL selector against the whole src tree.
 */

/** Does a bare TAG appear in source? `body`/`html` are guaranteed by HTML itself and appear in no component. */
function tagResolves(tag: string, sources: string[]): boolean {
	if (tag === 'body' || tag === 'html') return true;
	return sources.some((s) => new RegExp(`<${tag}\\b`).test(s));
}

/**
 * Resolve one SEL selector against source. Returns null for a shape this resolver does not model, so the
 * caller flags it rather than silently passing it.
 */
function selectorResolves(selector: string, sources: string[]): boolean | null {
	/*
	 * A comma list is a UNION — one branch is enough. `video, audio` is deliberately both: the TV plays an
	 * instrumental through an <audio>, and pinning the read to a bare `video` returned -1 forever.
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
		// `^=` and `=` share the source anchor `name="value`, so `prefix` only documents intent.
		void prefix;
		const anchor = `${name}="${value}`;
		return sources.some((s) => s.includes(anchor));
	}
	// A class selector, possibly compound and structured. Descendant whitespace, `>` and `+` all split
	// identically: a combinator changes only WHERE parts sit, which no source scan can see. EVERY part must
	// resolve — a compound naming a dropped descendant or sibling is still broken.
	if (selector.startsWith('.')) {
		const parts = selector.split(/\s*>\s*|\s*\+\s*|\s+/).filter(Boolean);
		if (parts.length === 0) return null;
		const partResults = parts.map((part): boolean | null => {
			// A `:not(...)` chain, checked first because it can prefix any other part shape. Its arguments
			// filter elements OUT, so they name nothing that HAS to be rendered; the positive anchor is the
			// BASE written before the chain, and a bare chain with no base lets sibling parts carry resolution.
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
				// A class-compound may carry a trailing attribute selector (`.err[role=alert]`, unquoted in the
				// p8 probe). Require BOTH the class token(s) and the attribute's source anchor `name="value` —
				// accepting the shape alone would wave a `.err[role=nope]` through. Either quoting spells the same.
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
			// A bare-tag part inside a descendant/child selector (the `audio` in `.slot.visible audio`).
			if (/^[a-z][a-z0-9]*$/.test(part)) return tagResolves(part, sources);
			// A `tag.class` compound part. Require BOTH: `button.nope` must fail on the class and `marquee.ok`
			// on the tag. The tag is load-bearing wherever a `<span>` carries the same class.
			const tagClass = /^([a-z][a-z0-9]*)((?:\.[A-Za-z][\w-]*)+)$/.exec(part);
			if (tagClass) {
				const [, tag, classPortion] = tagClass;
				if (!tagResolves(tag, sources)) return false;
				const classTokens = classPortion.split('.').filter(Boolean);
				return classTokens.every((tok) => sources.some((s) => classPresent(s, tok)));
			}
			// A shape this resolver does not model — surface it rather than silently pass.
			return null;
		});
		if (partResults.some((r) => r === false)) return false;
		if (partResults.some((r) => r === null)) return null;
		return true;
	}
	// A bare TAG selector: it must be rendered somewhere, or the read is aimed at an element the app never produces.
	if (/^[a-z][a-z0-9]*$/.test(selector)) {
		return tagResolves(selector, sources);
	}
	return null;
}

test('every SEL selector resolves to an anchor in the source (the guard, non-vacuous)', () => {
	// Comments stripped: the flow resolves against RENDERED source, so prose is not an anchor.
	const sources = guardSources();

	// Non-vacuity floor on the SCANNED POPULATION: both arrays below are asserted EMPTY, which is also what
	// a guard reading nothing produces. 27 `.svelte` files under src today.
	expect(sources.length).toBeGreaterThanOrEqual(20); // @nvf-floor sources.length

	/*
	 * Explicit exemptions, each stating why it cannot be resolved by source scan. An unexplained exemption
	 * is how a real regression gets waved through.
	 */
	const EXEMPT: Record<string, string> = {
		// FUNCTIONS — they build a selector from a runtime argument; their real anchors are covered elsewhere.
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
			// A regex selector: the flow matches element TEXT against it. Only a literal pattern is a source
			// anchor, so require the driver's regexes to stay literal.
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
			// Neither a string, a role/name object, nor an exempt function — a shape this guard was not written for.
			unmodelled.push(`${key}: ${JSON.stringify(value)} — unhandled SEL shape`);
		}
	}

	// An unmodelled shape is a hole in the guard, not a pass: extend the resolver rather than skip the selector.
	expect(unmodelled).toEqual([]);
	expect(unresolved).toEqual([]);
});

test('a selector whose only occurrence is a comment does not resolve (the guard strips comments)', () => {
	// `<video` lives ONLY in comments in TvPlayer.svelte (the rendered element is `<audio>`), so if comments
	// counted as source the `video` branch of SEL.mediaEl would resolve against prose over a read that can
	// never land. `stripped` is the guard's OWN builder, so reverting stripComments inside it reds this test.
	const stripped = guardSources();
	const raw = svelteFiles(join(CORE, 'src')).map((f) => readFileSync(f, 'utf8'));

	// Precondition: `<video` really is in raw source, but never as a rendered element.
	expect(
		raw.some((s) => /<video\b/.test(s)),
		'this guard depends on `<video` living only in comment prose (TvPlayer.svelte / routes/tv/+page.svelte); if that note is removed, update this test rather than deleting the assertion'
	).toBe(true);

	// Masked over RAW source, honest over the stripped source the guard feeds — the asymmetry is the point.
	expect(selectorResolves('video', raw)).toBe(true);
	expect(selectorResolves('video', stripped)).toBe(false);

	// And a genuinely-rendered tag still resolves after stripping, so the fix does not over-tighten.
	expect(selectorResolves('audio', stripped)).toBe(true);
});

test('the retired hero family stays retired — `.hero` resolves, but only against TV markup', () => {
	/*
	 * `.hero` STILL RESOLVES — lib/tv/JoinBadge.svelte renders `class="hero"` on the attract screen — so
	 * re-adding `hero: '.hero'` to SEL passes the every-SEL-resolves guard with the PHONE flow aimed at the
	 * TELEVISION. A selector resolving against the wrong surface is worse than one that reds, and only an
	 * absence assertion catches it.
	 */
	const sources = guardSources();
	// The resolution is REAL, which is exactly why the absence has to be asserted rather than assumed.
	// assumed. If this ever goes false the class has left the TV as well, and this test can go with it.
	expect(selectorResolves('.hero', sources)).toBe(true);

	// ...and every source still carrying it is the TV's: `lib/tv/` and `routes/tv/` both count.
	const carriers = svelteFiles(join(CORE, 'src')).filter((f) =>
		classPresent(stripComments(readFileSync(f, 'utf8')), 'hero')
	);
	expect(carriers.length).toBeGreaterThan(0); // non-vacuity: `every` over [] is true
	expect(
		carriers.every((f) => /\/tv\//.test(f)),
		`non-TV sources carry class="hero": ${carriers.join(', ')}`
	).toBe(true);

	// So no SEL entry may point at it, nor at the two disclosure classes the drawer replaced. Pinning them by
	// VALUE matters because a dead name gets revived against a class that has returned on another surface.
	const values = Object.values(SEL);
	for (const dead of ['.hero', '.hero .song', '.tools-toggle', '.tools-peek']) {
		expect(values, `${dead} is retired and must not return to SEL`).not.toContain(dead);
	}

	// And no HOOK may name the deleted component. The file-existence test reports this too, but only while
	// the path stays dead: a future component reusing the name would silence it, where this does not.
	expect(HOOKS.filter((h) => h.file.includes('NowPlayingHero')).map((h) => h.id)).toEqual([]);

	// The successors resolve, so the retirement handed each claim on rather than dropping it. `bandExpand` and
	// `npSong` left this loop with their SEL entries — `selectorResolves(undefined)` throws rather than
	// asserting; `bandTitle` carries the title claim, and the test below pins the retirements.
	for (const key of ['bandTitle', 'npDrawer', 'drawerHandle'] as const) {
		expect(selectorResolves(SEL[key] as string, sources), key).toBe(true);
	}
});

test('the band pull handle is gone, and the expand claim came back as a real button', () => {
	/*
	 * The band's `<button class="handle">` is deleted — the bar a thumb pulls is vaul's, rendered inside
	 * `.band-slot` — and an `onexpand` is wired again deliberately: `drawerHandle` is an aria-hidden div with
	 * no tabindex, so while it was the only affordance the sheet could not be raised by keyboard at all.
	 */
	const sources = guardSources();
	const bandFile = join(CORE, 'src/lib/components/NowPlayingBand.svelte');
	const band = stripComments(readFileSync(bandFile, 'utf8'));

	// The retired selector is gone from source entirely, which is the state the old record hoped for.
	expect(selectorResolves('.band .handle', sources), '`.band .handle` is retired — the button was deleted').toBe(false);
	expect(band, 'the deleted handle button must not come back in the band').not.toMatch(/class="handle"/);

	// The successor is a REAL button, not a div with a click handler, and it is still gated on the prop so
	// the gallery's five bare bands stay inert rather than offering a press that goes nowhere.
	expect(band, 'the band must still declare the onexpand prop the expand control is gated on').toMatch(
		/onexpand\?:\s*\(\)\s*=>\s*void;/
	);
	expect(band, 'the expand control must still be gated on {#if onexpand}').toMatch(/\{#if onexpand\}/);
	expect(band, 'the expand control must be a <button>, so it is focusable and announced').toMatch(
		/<button[^>]*class="meta meta-btn"/
	);
	// A name a screen reader can read, and one that CONTAINS the visible title (SC 2.5.3).
	expect(band, 'the expand button must carry an accessible name').toMatch(/aria-label={expandLabel}/);
	expect(band, 'and that name must contain the visible title').toMatch(/expandLabel\s*=\s*\$derived(\.by)?\(/);

	// ...and SOMETHING hands it one: without a call site the button cannot render, however well declared.
	const wired = svelteFiles(join(CORE, 'src'))
		.filter((f) => f !== bandFile)
		.filter((f) => /\bonexpand\s*=/.test(stripComments(readFileSync(f, 'utf8'))))
		.map((f) => f.replace(CORE + '/', ''));
	expect(
		wired,
		'nothing passes the band an onexpand, so its expand button cannot render and the sheet is pointer-only again — see the bandExpand retirement record in contract.ts'
	).not.toEqual([]);

	// The retired NAMES stay retired, whatever they might be pointed at next.
	expect(Object.values(SEL), '.band .handle is retired and must not return to SEL').not.toContain('.band .handle');
	expect(Object.keys(SEL), 'the bandExpand KEY is retired, whatever value it is given').not.toContain('bandExpand');
	const hookIds = HOOKS.map((h) => h.id);
	for (const dead of ['bandExpand', 'bandExpandWired']) {
		expect(hookIds, `the ${dead} hook is retired and must not return`).not.toContain(dead);
	}

	// The successor pair both resolve: the press and the wiring that makes it real.
	expect(selectorResolves(SEL.bandOpen, sources), 'bandOpen').toBe(true);
	expect(hookIds).toContain('bandOpen');
	expect(hookIds).toContain('bandOpenWired');

	/*
	 * The drag surface widened to the whole band row, so `data-vaul-no-drag` on `.np-fit` is what keeps the
	 * body of sliders off it. Both directions are asserted: leaving `handleOnly` in place alongside the
	 * attribute would make one of them dead code that still reads as the live mechanism.
	 */
	expect(selectorResolves(SEL.drawerHandle, sources)).toBe(true);
	expect(hookIds).toContain('drawerBodyNoDrag');
	expect(hookIds, 'the handleOnly hook is retired and must not return').not.toContain('drawerHandleOnly');
	const drawer = stripComments(readFileSync(join(CORE, 'src/lib/components/NowPlayingDrawer.svelte'), 'utf8'));
	expect(drawer, 'handleOnly must be gone, not merely shadowed by the attribute').not.toMatch(/^\s*handleOnly\s*$/m);

	/*
	 * EXACTLY ONE PULL BAR. shadcn's copy-in rendered a decorative div at the top of the content box while the
	 * drawer also rendered a real Drawer.Handle, and the phone drew two stacked pull-up lines.
	 */
	expect((drawer.match(/<Drawer\.Handle/g) ?? []).length, 'the sheet renders exactly one pull bar').toBe(1);
});

test('every settings id the flow drives exists as an element id', () => {
	// SETTING_IDS is raw data, exempt from the resolver above; this is where each id is resolved. The flow
	// queries `#<id>`, so RENDERED source must carry `id="<id>"`.
	const sources = guardSources();
	// Non-vacuity: filtering an empty SETTING_IDS yields [] and resolves not one id.
	expect(SEL.SETTING_IDS.length).toBeGreaterThan(0);
	const missing = SEL.SETTING_IDS.filter((id) => !sources.some((s) => s.includes(`id="${id}"`)));
	expect(missing).toEqual([]);
});

test('the scope-tab selector matches the id the settings page actually interpolates', () => {
	// SEL.settingsTab builds `#tab-<id>` while the page writes `id="tab-{t.id}"`, so no grep can resolve the
	// id — this is a FORMAT assertion. settings-scopes.test.ts pins the ids themselves to the TABS registry.
	const src = readFileSync(join(CORE, 'src/routes/settings/+page.svelte'), 'utf8');
	const interpolated = /id="tab-\{([a-zA-Z.]+)\}"/.exec(src);
	expect(interpolated, 'the settings page no longer interpolates a tab id into id="tab-{...}"').not.toBeNull();
	// The helper must produce exactly that prefix and append nothing else.
	expect(SEL.settingsTab('you')).toBe('#tab-you');
});

/*
 * THE LITERAL BAN. A selector a driver spells out for itself is invisible to everything above: not in SEL,
 * so the resolver never sees it; not in HOOKS, so the anchor check never sees it. That is how party.mjs
 * came to wait on `.url` — the LOBBY's address — as its test for an EMPTY room, and blame the guests.
 */
/**
 * Every driver under `e2e/`, enumerated rather than hand-listed: a hand-kept list of 2 left the other 22
 * spelling selectors out unwatched. `driver.mjs` is excluded because it is the driver LIBRARY — it forwards
 * `JSON.stringify(selector)`, a variable, and has no hand-written selector of its own.
 */
function allDrivers(): string[] {
	const out: string[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (ent.isDirectory()) walk(join(dir, ent.name), `${prefix}${ent.name}/`);
			else if (ent.name.endsWith('.mjs') && ent.name !== 'driver.mjs') out.push(`${prefix}${ent.name}`);
		}
	};
	walk(E2E, '');
	return out.sort();
}
const DRIVERS = allDrivers();

/**
 * KNOWN OFFENDERS — the quarantined debt baseline. The ban covers every driver, and only the exact
 * `(file, literal)` pairs below are waved through, so a new literal in ANY driver — including a brand-new
 * file — reds. Each entry says why it is not a selector. Do NOT add to this map to silence a new literal:
 * put the selector in SEL.
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
		// A hex colour caught by the shape rule, and the bare media-element liveness union.
		'#ff5cae',
		'audio,video'
	],
	'probes/p10-scaling.mjs': [
		// STAYS - a bare tag query, not a UI hook.
		'button',
		// `.badqr *` STAYS: the universal-child token has no source anchor, so the resolver cannot model it and
		// putting it in SEL would fail the every-SEL-resolves guard. p10 reads it only to enumerate the notice
		// card's descendants for an overflow check.
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
	],
	'probes/p12-search.mjs': [
		// Hex swatch colour (shape rule), not a selector.
		'#ff5cae'
	],
	'probes/p13-tap-to-start.mjs': [
		' + JSON.stringify(SEL.queueRow) + ',
		' + JSON.stringify(SEL.search) + ',
		' + JSON.stringify(SEL.songRow) + ',
		'video,audio'
	],
	'probes/p14-playhead-vs-process.mjs': ['#ff5cae', 'audio'],
	// A CAPTURE script rather than a driver — it asserts nothing, but the walk enumerates every file.
	'shoot.mjs': [
		// A swatch VALUE, not a selector (shape rule).
		'#ff5cae',
		// The join control, found by accessible text: it sits on the vendored <Button>.
		'button',
		// A file extension — this is the only script here that writes files.
		'.png'
	],
	'probes/p16-hero-live-controls.mjs': [
		// A swatch VALUE and the join submit control found by accessible text — both non-selectors, as in p2.
		'#ff5cae',
		'button'
	],
	'probes/p15-reload-resume.mjs': [
		// The same two non-selectors p14 carries: a swatch hex, and a bare-tag media query (cf. SEL.mediaEl).
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
	],
	'probes/p6-lyrics.mjs': [
		// Bare tag-union existence checks for a media element, not UI selectors (cf. SEL.mediaEl).
		'video, audio',
		'video,audio'
	],
	'probes/p8-presence-resilience.mjs': [
		// Tag-only / attribute-fragment reads, deliberately NOT selectors moved to SEL:
		'[aria-label=', // a truncated attribute-selector fragment built by string concat, not a whole selector
		'button' // a bare tag query for "any button", not a UI-specific hook
	],
	'probes/tv-audiocontext-resume.mjs': ['audio,video']
};

/**
 * Selector-SHAPED literals that are not selectors. Only the shape rule consults this map, and only for a
 * literal with no interpolation: head-stripping `` `.png${i}` `` to `.png` would swallow a real selector.
 */
const NOT_A_SELECTOR: Record<string, string> = {
	'.cache': 'a filesystem path segment — join(homedir(), ".cache", "ms-playwright") finds Chromium'
};

/**
 * Functions whose first argument IS a selector. A CALL-SITE rule rather than a syntax rule, because a shape
 * rule has to guess: the first version required a literal to start with `.` or `#`, which left
 * `querySelectorAll('video, audio')` — already rotted once from a bare `video` — unguarded, and compound
 * descendants (`.row .t`) would have escaped too. Deliberately absent: clickByText and clickByLabel, whose
 * argument is visible text or an accessible name.
 */
const SELECTOR_TAKING = [
	'querySelector',
	'querySelectorAll',
	// The getElement* family takes an id/class/tag/name as its only argument, which is a selector by
	// The getElement* family takes an id/class/tag/name — a selector by another name, and invisible to both
	// the shape rule and a querySelector-only call-site rule.
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

	// A `(file, literal)` pair in KNOWN_OFFENDERS is tracked debt; anything else is a fresh literal.
	const quarantined = (name: string, token: string) => (KNOWN_OFFENDERS[name] ?? []).includes(token);

	for (const name of DRIVERS) {
		const src = stripComments(readFileSync(join(E2E, name), 'utf8'));
		src.split('\n').forEach((line, i) => {
			/*
			 * RULE 1 — shape. A quoted string starting `.`/`#` plus an identifier character, or an attribute
			 * selector. Template placeholders count: a `#tab-${id}` in backticks is exactly as unguarded.
			 */
			for (const m of line.matchAll(/(['"`])((?:[.#][A-Za-z][\w$.{}-]*)|(?:\[[a-zA-Z-]+\^?=[^'"`\]]*\]))\1/g)) {
				const literal = m[2]!;
				const interpolated = /\$\{/.test(literal);
				if (!interpolated && literal in NOT_A_SELECTOR) continue;
				if (quarantined(name, literal)) continue;
				offenders.push(`${name}:${i + 1} — ${m[0]} (selector-shaped literal)`);
			}
			/*
			 * RULE 2 — call site. Any selector-taking function invoked with a string LITERAL, whatever its shape.
			 * This is what catches a tag-led or compound selector, which rule 1 cannot see.
			 */
			for (const m of line.matchAll(callSite)) {
				const fn = m[1]!;
				const literal = m[3]!;
				if (/\$\{/.test(literal)) {
					if (quarantined(name, `INTERP:${literal}`)) continue;
					// An interpolated argument's static head is not the whole selector, so report the call.
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
	// A hand-kept DRIVERS array could silently empty (or shrink back to 2) while the ban above guards nothing.
	expect(DRIVERS.length).toBeGreaterThan(20); // @nvf-floor DRIVERS.length
	// The two the old list named must still be found, so a walk matching nothing cannot pass either.
	expect(DRIVERS).toContain('party.mjs');
	expect(DRIVERS).toContain('capture.mjs');
	// And a spot-check that the walk reaches into probes/, the subtree the old list never covered.
	expect(DRIVERS.some((d) => d.startsWith('probes/'))).toBe(true);
});

test('Group A — p4-transport combinator/descendant selectors moved from KNOWN_OFFENDERS into SEL', () => {
	// Half 1: no longer quarantined for p4-transport — after the migration the only honest home is SEL.
	const p4 = KNOWN_OFFENDERS['probes/p4-transport.mjs'] ?? [];
	expect(p4).not.toContain('.slot.visible audio');
	expect(p4).not.toContain('.seekrow .track > i');

	// Half 2: they live in SEL and resolve against real source (a null/false would mean the SEL entry points
	// at markup no component renders).
	expect(SEL.slotVisibleAudio).toBe('.slot.visible audio');
	expect(SEL.seekFill).toBe('.seekrow .track > i');
	const sources = guardSources();
	expect(selectorResolves(SEL.slotVisibleAudio, sources)).toBe(true);
	expect(selectorResolves(SEL.seekFill, sources)).toBe(true);

	// The extension must be REAL, not a widening that passes anything: a dropped tag or class still fails.
	expect(selectorResolves('.slot.visible marquee', sources)).toBe(false);
	expect(selectorResolves('.seekrow .track > blink', sources)).toBe(false);
	expect(selectorResolves('.nope-not-a-class audio', sources)).toBe(false);
});

test('Group B — p8-presence .err[role=alert] moved from KNOWN_OFFENDERS into SEL', () => {
	// Half 1: the class + UNQUOTED-attribute compound is no longer quarantined for p8-presence.
	const p8 = KNOWN_OFFENDERS['probes/p8-presence-resilience.mjs'] ?? [];
	expect(p8).not.toContain('.err[role=alert]');

	// Half 2: it lives in SEL and resolves — the anchor is `<div class="err" role="alert">` in JoinLanding.svelte.
	expect(SEL.joinError).toBe('.err[role=alert]');
	const sources = guardSources();
	expect(selectorResolves(SEL.joinError, sources)).toBe(true);
	// The QUOTED spelling of the same selector resolves too — the source anchor `role="alert` is shared.
	expect(selectorResolves('.err[role="alert"]', sources)).toBe(true);

	// REAL, not a widening that accepts any `.class[attr=val]`: a wrong value, class or attribute name each fails.
	expect(selectorResolves('.err[role=nope]', sources)).toBe(false);
	expect(selectorResolves('.nope-not-a-class[role=alert]', sources)).toBe(false);
	expect(selectorResolves('.err[data-x=alert]', sources)).toBe(false);
});

test('Group C — the resolver still models a `tag.class` compound part (re-anchored after the readiness chip row was deleted)', () => {
	// The subject of this arm is the RESOLVER's `tag.class` compound part, which no other test exercises. It
	// runs against SYNTHETIC source deliberately: every real instance became a <Button>, and the last
	// re-anchor passed vacuously off `ids.add(m.id)` — JavaScript text, not markup.
	const synthetic = ['<div class="row"><button class="add">＋</button></div>'];
	expect(selectorResolves('.row button.add', synthetic)).toBe(true);

	// REAL, not a widening: a wrong class fails, a wrong tag fails, and the bare-tag part is load-bearing —
	// a class-only handle would match a `<span class="add">` too.
	expect(selectorResolves('.row button.nope-not-a-class', synthetic)).toBe(false);
	expect(selectorResolves('.row marquee.add', synthetic)).toBe(false);
	expect(selectorResolves('.row button.add', ['<div class="row"><span class="add">＋</span></div>'])).toBe(false);
});

test('Group D — p11-dashboards card/tile/chart selectors moved from KNOWN_OFFENDERS into SEL', () => {
	// Half 1: all four are no longer quarantined for p11-dashboards. The bare tags the driver also reads
	// (body/h1/h2, table th) are NOT selectors and legitimately stay quarantined.
	const p11 = KNOWN_OFFENDERS['probes/p11-dashboards.mjs'] ?? [];
	expect(p11).not.toContain('.card');
	expect(p11).not.toContain('.card table');
	expect(p11).not.toContain('.tile .n');
	expect(p11).not.toContain('.card h2 + .bars, .card h2 + :not(table):not(.note):not(.scroller)');

	// Half 2: the four live in SEL and resolve against routes/stats/+page.svelte — `.card`, a `<table>` in a
	// card, `<span class="n">` in a `.tile`, and the <Bars> chart's `<ol class="bars">` after a card `<h2>`.
	expect(SEL.dashCard).toBe('.card');
	expect(SEL.dashCardTable).toBe('.card table');
	expect(SEL.dashTileNumber).toBe('.tile .n');
	expect(SEL.dashChartOrBody).toBe('.card h2 + .bars, .card h2 + :not(table):not(.note):not(.scroller)');
	const sources = guardSources();
	expect(selectorResolves(SEL.dashCard, sources)).toBe(true);
	expect(selectorResolves(SEL.dashCardTable, sources)).toBe(true);
	expect(selectorResolves(SEL.dashTileNumber, sources)).toBe(true);
	// The union resolves because its first branch does; the `+` sibling combinator splits like `>`.
	expect(selectorResolves(SEL.dashChartOrBody, sources)).toBe(true);
	// Prove the `+` sibling combinator alone resolves as its own selector, not only inside the union.
	expect(selectorResolves('.card h2 + .bars', sources)).toBe(true);
	// The `:not()` branch alone resolves too: the chain carries no positive anchor, so its siblings do.
	expect(selectorResolves('.card h2 + :not(table):not(.note):not(.scroller)', sources)).toBe(true);

	// REAL, not a widening: a dropped class, an unrendered tag, or a `:not()` chain whose BASE names a dropped
	// class must each fail — but the `:not()` ARGUMENTS need not exist, since excluding an absent element is a
	// harmless over-specification rather than a broken anchor.
	expect(selectorResolves('.card h2 + .nope-not-a-class', sources)).toBe(false);
	expect(selectorResolves('.card h2 + marquee', sources)).toBe(false);
	expect(selectorResolves('.nope-card h2 + .bars', sources)).toBe(false);
	expect(selectorResolves('.card .nope-base:not(table)', sources)).toBe(false);
	expect(selectorResolves('.card h2 + :not(marquee)', sources)).toBe(true);
});

test('Group E — p10-scaling data-array selectors moved from KNOWN_OFFENDERS into SEL', () => {
	// Half 1: the ten resolvable selectors this driver spelled out in its data arrays are no longer quarantined.
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

	// Half 2: the ten now come from SEL, and each resolves against real source.
	expect(SEL.attract).toBe('.attract');
	expect(SEL.dashCard).toBe('.card');
	// `.encore-chip`, not `.chip`: Badge's base class — `.chip` had stopped naming a SongRow chip.
	expect(SEL.chip).toBe('.encore-chip');
	expect(SEL.badQrTitle).toBe('.badqr-t');
	expect(SEL.badQrFix).toBe('.badqr-fix');
	expect(SEL, 'badQrBody is retired with the card it named').not.toHaveProperty('badQrBody');
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
		'badQrFix',
		'nowNameScoped',
		'nowSongScoped',
		'upLabel',
		'upSong'
	] as const) {
		expect(selectorResolves(SEL[key] as string, sources), key).toBe(true);
	}

	// Half 3: only '.badqr *' stays quarantined; the three dead reads were removed from p10's targets outright.
	for (const kept of ['.badqr *']) {
		expect(p10).toContain(kept);
	}
	for (const gone of ['.b', '.filter-chip', '.roster']) {
		expect(p10).not.toContain(gone);
	}
	// '.badqr *' is UNMODELLABLE — the universal-child token has no anchor, so the resolver returns null.
	expect(selectorResolves('.badqr *', sources)).toBeNull();
	// The three former offenders resolve FALSE: two name classes nothing renders, and `.b` is rejected now
	// that classPresent matches exact tokens rather than a word-boundary `b` inside `badqr-b`.
	expect(selectorResolves('.filter-chip', sources)).toBe(false);
	expect(selectorResolves('.roster', sources)).toBe(false);
	expect(selectorResolves('.b', sources)).toBe(false);
});

/*
 * G1: the `targets` arrays live inside `page.evaluate(`…`)` template literals, which never run under `bun
 * test`, so nothing caught a target naming a class no component declares — five did exactly that, and p10
 * always exits 0. Interpolated entries come from SEL and are covered above; only raw literals are checked.
 */
function p10TargetLiterals(): { arrays: string[]; lits: string[] } {
	// Blank comments so a `// '.roster' stays a literal` note cannot leak a literal into the scan.
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

	// Sentinel A: every target array was found and its literals extracted. Replacing an array with `[]`
	// Sentinel A: every target array was found. Replacing one with `[]`, or renaming it out of the scan, would
	// make the main arm pass vacuously. Three arrays: search lives on `/find`, so the remote pass measures two
	// surfaces. Raising this tracks a probe that covers MORE; it must never be lowered.
	expect(arrays.length).toBe(3);
	expect(lits.length).toBeGreaterThanOrEqual(19); // @nvf-floor lits.length

	// Sentinel B: known-live anchors must resolve, so a resolver that rejects everything reds here instead.
	for (const live of [
		'.badqr-t',
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

	// Sentinel C: at least six literals resolve as CLASS selectors, so a tag-only resolver cannot pass. The
	// `.findbox input` entry is the remote's one TEXT-ENTRY control — the class the touch guard found at 22px.
	const classLits = [
		'.badqr-fix',
		'.lower-third .ls-key',
		'.attract .jt-url',
		'.row .t',
		'.row .byline',
		'.findbox input'
	];
	for (const c of classLits) expect(selectorResolves(c, sources), c).toBe(true);

	// Main arm: a `false` names a class/tag no component declares; a `null` is an unmodelled shape in the arrays.
	const dead = lits.filter((l) => selectorResolves(l, sources) !== true);
	expect(dead).toEqual([]);
});

/*
 * G2: classPresent must reject a token that is only a fragment of a longer class, or an interpolated JS
 * identifier. A `\b${t}\b` match treats `-` as a boundary, so `class="badqr-b"` resolved the bare token `b`
 * and `class="pill {a.outcome}"` resolved the variable `a`. Each arm below is pinned against a real anchor
 * in the SAME source, so it cannot be "fixed" by rejecting everything.
 */
test('G2 — classPresent rejects a hyphen-fragment or interpolated-identifier token', () => {
	const joinBadge = readFileSync(join(CORE, 'src/lib/tv/JoinBadge.svelte'), 'utf8');

	// The hyphen-fragment case against real markup: `fix` only ever appears as the tail of `badqr-fix`…
	expect(classPresent(joinBadge, 'fix')).toBe(false);
	// …while the real class does resolve, which is this arm's non-vacuity half.
	expect(classPresent(joinBadge, 'badqr-fix')).toBe(true);

	/*
	 * The interpolated-identifier case against a FIXTURE: the matcher is a pure function, and tying it to
	 * whichever page happens to interpolate a class today is how this arm once passed off a comment.
	 */
	const interpolated = `<span class="pill {a.outcome ?? 'running'}">x</span>`;
	expect(classPresent(interpolated, 'a')).toBe(false);
	expect(classPresent(interpolated, 'pill')).toBe(true);
});
