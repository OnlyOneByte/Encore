// guard: phone inventories and property floors. See docs/GUARDS.md#phone-inventories-and-reflow.
//
// Every other guard here answers "is THIS surface right?", so each is only as complete as the list of
// surfaces somebody remembered to put in it: the failure that ships is a state nobody designed, on a route
// nobody added to a list, rendering as an accidental blank column. Two rules below are therefore INVENTORY
// rules, checkable by ENUMERATION over the filesystem so a route or live region introduced tomorrow is in
// scope the moment it exists.
//
// Every exemption is named, counted, shrink-only, and rot-proofed by an arm asserting each listed absence is
// still genuinely absent. That third property is the one that matters: without it a baseline entry survives
// the day its gap is closed and silently un-enforces the pair forever.
//
// SCOPE. Phone surfaces only. The CSS-RULE half of the no-subtree-opacity rule lives in
// a11y/contrast.test.ts; this file adds only the INLINE-STYLE dimension, which a rule scan cannot see.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { srcDir } from '@encore/test-support';

// `relative` is node:path's two-argument form here, not the test-support helper.
const SRC = srcDir;
const ROUTES = join(SRC, 'routes');

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

/** Recursively collect every `+page.svelte` under `dir` (absolute paths). */
function pageFiles(dir: string): string[] {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, ent.name);
		if (ent.isDirectory()) out.push(...pageFiles(p));
		else if (ent.name === '+page.svelte') out.push(p);
	}
	return out;
}

/** `routes/settings/+page.svelte` -> `/settings`; `routes/+page.svelte` -> `/`. */
function routePath(file: string): string {
	const segs = relative(ROUTES, file).split(sep).slice(0, -1);
	return segs.length ? `/${segs.join('/')}` : '/';
}

// ---------------------------------------------------------------------------------------------------
// INVENTORY: every phone route has a designed empty, loading, error and offline state
// ---------------------------------------------------------------------------------------------------

// The closed exemption set: a gallery whose states ARE its content, two operator surfaces with their own
// guards, and the TV. Matched on the route or any descendant, so /metrics/[mediaId] is covered by /metrics.
const EXEMPT_ROUTES = ['/components', '/admin', '/metrics', '/tv'] as const;

const CONDITIONS = ['empty', 'loading', 'error', 'offline'] as const;
type Condition = (typeof CONDITIONS)[number];

/*
 * How each condition is DETECTED. Named idioms rather than one regex, so a failure says which shape was
 * looked for; a route that signals a state some other way is a detector gap to widen here, not a reason to
 * add a baseline entry. Widening only tightens the file: the detectors are OR'd, so nothing that matched
 * stops matching, and the rot arm fails an entry whose route now matches one.
 *
 * Three entries exist because a vendored primitive sets the attribute on the element IT renders, so a scan
 * of the CALL SITE saw nothing. The destructive VARIANT is required, so a neutral `<Alert.Root>` info panel
 * does not satisfy `error`.
 */
const IDIOMS: Record<Condition, { name: string; find: (src: string) => boolean }[]> = {
	empty: [
		{ name: '`empty=` prop on a list primitive', find: (s) => /\bempty\s*=\s*["{]/.test(s) },
		{ name: 'an emptyState()/readyEmptyState() builder', find: (s) => /\b(?:ready)?[Ee]mptyState\s*\(/.test(s) },
		{ name: 'a vendored `<Empty.Root>` state', find: (s) => /<Empty\.Root\b/.test(s) }
	],
	loading: [
		{ name: 'an `aria-busy` region', find: (s) => /aria-busy\s*=\s*["{]?\s*(?:true|\{true)/.test(s) },
		{
			name: 'a `role="status"` region whose copy names the wait',
			find: (s) =>
				[...s.matchAll(/role\s*=\s*["']status["']/g)].some((m) =>
					/Loading|Searching|Joining|Saving|Waiting|…/i.test(s.slice(m.index, m.index + 120))
				)
		},
		{
			name: 'an in-flight branch on a request flag',
			find: (s) => /\{#if\s+!?\s*(?:submitting|loading|saving|sending|pending|busy)\b/.test(s)
		}
	],
	error: [
		{ name: 'a `role="alert"` region', find: (s) => /role\s*=\s*["']alert["']/.test(s) },
		{ name: 'a sonner `toast.error(...)` call', find: (s) => /\btoast\.error\s*\(/.test(s) },
		{
			name: 'an `<Alert.Root variant="destructive">` region',
			find: (s) => /<Alert\.Root[^>]*variant\s*=\s*["']destructive["']/.test(s)
		}
	],
	offline: [
		{
			name: 'a branch on the connection flag',
			find: (s) => /\{#if[^}]*(?:!\s*connected\b|\bconnected\s*===|\boffline\b|\bdisconnected\b)/.test(s)
		}
	]
};

function detect(src: string, c: Condition): string | null {
	for (const i of IDIOMS[c]) if (i.find(src)) return i.name;
	return null;
}

/*
 * The BASELINE: route × condition pairs with no designed state today. `kind` separates the two honest
 * reasons, because they have different futures — 'n/a' means the route structurally cannot reach the
 * condition (no collection to be empty of) and is stable; 'gap' means it can and should and does not yet, so
 * delete the entry when you close one. Recording rather than fixing here is deliberate: each gap needs
 * designed copy and a named next action. What changes is that they cannot grow.
 */
const KNOWN_ABSENT: { route: string; condition: Condition; kind: 'n/a' | 'gap'; reason: string }[] = [
	{
		route: '/settings',
		condition: 'empty',
		kind: 'n/a',
		reason: 'every settings control is always present; no collection here can be empty'
	},
	{
		route: '/settings',
		condition: 'offline',
		kind: 'gap',
		reason: 'the page holds no socket and never says that a change could not reach the server'
	},
	{
		route: '/stats',
		condition: 'offline',
		kind: 'gap',
		reason: 'a failed fetch renders "Could not load stats." and does not distinguish off-network from a server error'
	}
];

/** Pinned ceiling: the list may shrink, never grow. A new absence is a regression, not a baseline. */
const KNOWN_ABSENT_CEILING = 5;

function isExempt(route: string): boolean {
	return EXEMPT_ROUTES.some((e) => route === e || route.startsWith(`${e}/`));
}

const ALL_ROUTES = pageFiles(ROUTES)
	.map((f) => ({ route: routePath(f), file: f }))
	.sort((a, b) => a.route.localeCompare(b.route));
const PHONE_ROUTES = ALL_ROUTES.filter((r) => !isExempt(r.route));

test('the phone route set is derived from the filesystem, and every exemption is the spec’s', () => {
	// An over-broad exemption or a moved routes/ dir enumerates fewer than four and fails here.
	expect(PHONE_ROUTES.length).toBeGreaterThanOrEqual(4); // @nvf-floor PHONE_ROUTES.length

	// Every exempt name must still resolve to a real route, so a rename surfaces the new name here instead of
	// leaving a dead exemption and the new surface unchecked.
	const known = new Set(ALL_ROUTES.map((r) => r.route));
	for (const e of EXEMPT_ROUTES) {
		expect(
			known.has(e),
			`exempt route ${e} no longer exists — either it was renamed (enumerate the new name, or exempt it here with a reason) or the exemption is dead and should be deleted`
		).toBe(true);
	}

	// No third bucket, which is what makes this an inventory rather than a spot check.
	for (const r of ALL_ROUTES) {
		expect(PHONE_ROUTES.some((p) => p.route === r.route) || isExempt(r.route)).toBe(true);
	}
});

test('every phone route renders a designed empty, loading, error and offline state', () => {
	const baseline = new Set(KNOWN_ABSENT.map((k) => `${k.route} × ${k.condition}`));
	const missing: string[] = [];
	let pairsChecked = 0;

	for (const { route, file } of PHONE_ROUTES) {
		const src = stripComments(readFileSync(file, 'utf8'));
		for (const c of CONDITIONS) {
			pairsChecked++;
			const key = `${route} × ${c}`;
			if (baseline.has(key)) continue;
			if (!detect(src, c)) {
				missing.push(
					`${key} — no designed ${c} state. Looked for: ${IDIOMS[c].map((i) => i.name).join('; ')}. ` +
						`Design the state (a heading plus one next action), or add the pair to KNOWN_ABSENT with a reason.`
				);
			}
		}
	}

	// Without this, a broken route walk reports zero offenders and reads exactly like a clean tree.
	expect(pairsChecked).toBe(PHONE_ROUTES.length * CONDITIONS.length);
	expect(missing).toEqual([]);
});

test('the known-absent baseline is bounded, well-formed, and has not rotted', () => {
	expect(KNOWN_ABSENT.length).toBeLessThanOrEqual(KNOWN_ABSENT_CEILING);

	const phone = new Set(PHONE_ROUTES.map((r) => r.route));
	const seen = new Set<string>();
	const rotted: string[] = [];

	for (const k of KNOWN_ABSENT) {
		const key = `${k.route} × ${k.condition}`;
		expect(seen.has(key), `duplicate baseline entry ${key}`).toBe(false);
		seen.add(key);
		// A baseline entry for a route that is exempt or gone enforces nothing.
		expect(phone.has(k.route), `baseline entry ${key} names a route that is not a phone surface`).toBe(true);
		// Every entry states why, so the list cannot become a bag of unexplained escapes.
		expect(k.reason.length, `baseline entry ${key} needs a reason`).toBeGreaterThan(30);

		const file = PHONE_ROUTES.find((r) => r.route === k.route)!.file;
		const found = detect(stripComments(readFileSync(file, 'utf8')), k.condition);
		if (found) rotted.push(`${key} is now designed (matched: ${found}) — delete its KNOWN_ABSENT entry`);
	}

	// THE ROT ARM: a stale entry silently un-enforces its pair forever, so closing a gap fails here.
	expect(rotted).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------
// INVENTORY: announcements — what is announced, and when
// ---------------------------------------------------------------------------------------------------

/** Files that can announce to a phone guest, enumerated from the phone surfaces. */
const PHONE_ANNOUNCING_FILES = [
	join(ROUTES, '+page.svelte'),
	join(ROUTES, 'settings', '+page.svelte'),
	join(ROUTES, 'stats', '+page.svelte'),
	join(SRC, 'lib', 'components', 'SongRow.svelte'),
	join(SRC, 'lib', 'components', 'ProcessingCard.svelte'),
	join(SRC, 'lib', 'components', 'QueueRow.svelte'),
	join(SRC, 'lib', 'components', 'JoinLanding.svelte'),
	join(SRC, 'lib', 'components', 'CodeEntry.svelte'),
	join(SRC, 'lib', 'ui', 'PageHeader.svelte')
];

/*
 * THE REGION INVENTORY: every `aria-live` region a phone guest can hear, and what it is for. An unlisted
 * region fails — that is the whole rule. Two regions announcing the same event, or one nobody can explain,
 * is invisible without an enumeration, because each looks reasonable in its own file.
 */
const LIVE_REGIONS: { file: string; purpose: string }[] = [
	{ file: 'routes/+page.svelte', purpose: 'the announcement region (`sr-live`) — queue changes under the guest' },
	{ file: 'routes/+page.svelte', purpose: 'connection loss/restore (`offline-pill`)' },
	{ file: 'lib/components/SongRow.svelte', purpose: "a row's readiness chip changing while the guest looks at it" },
	{ file: 'lib/components/ProcessingCard.svelte', purpose: 'a process that failed, and why it stopped' },
	{ file: 'lib/components/ProcessingCard.svelte', purpose: 'process stage progress while the guest waits' },
	{
		file: 'lib/components/CodeEntry.svelte',
		purpose:
			'join-code entry — a rejected keystroke names the excluded characters (SC 3.3.1) and the disabled-Continue reason (SC 3.3.2), without interrupting typing'
	},
	{
		file: 'lib/components/JoinLanding.svelte',
		purpose:
			'landing — the reason Continue is disabled (enter your name / finish the code), stated in words rather than by disabled state alone (SC 3.3.2)'
	}
];

test('every phone live region is inventoried, and all are polite', () => {
	const found: { file: string; politeness: string }[] = [];
	for (const f of PHONE_ANNOUNCING_FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/aria-live\s*=\s*["']([a-z]+)["']/g)) {
			found.push({ file: relative(SRC, f).split(sep).join('/'), politeness: m[1]! });
		}
	}

	const inventory = LIVE_REGIONS.map((r) => r.file).sort();
	expect(
		found.map((f) => f.file).sort(),
		'a phone live region is not in LIVE_REGIONS (or an inventoried one was removed) — inventory it with its purpose, or delete its entry'
	).toEqual(inventory);

	// An assertive queue announcement would talk over a guest mid-typing in search.
	for (const f of found) {
		expect(f.politeness, `${f.file} announces ${f.politeness} — phone announcements are polite`).toBe('polite');
	}

	for (const r of LIVE_REGIONS) expect(r.purpose.length).toBeGreaterThan(20);
});

/*
 * THE EVENT INVENTORY: every write to `liveMsg` must map to an inventoried event, so an eighth announcement fails.
 * `implemented: false` records one the redesign still owes, so the set is the SPECIFIED set rather than today's code.
 *
 * Two events are deliberately absent. Connection loss/restore is announced by the `offline-pill` region
 * rather than through `liveMsg`. A drag that dissolves mid-flight IS announced, but its strings reach the
 * region as a VARIABLE from `$lib/reorder-mode`, so the literal-site regex below cannot see them either to
 * list or to floor; reorder-mode.test.ts pins them where they are declared.
 */
const ANNOUNCED_EVENTS: { event: string; implemented: boolean; match?: RegExp }[] = [
	{ event: "another guest's add", implemented: true, match: /\bqueued\b/ },
	{ event: "several guests' adds, batched on resync", implemented: true, match: /songs added to the queue/ },
	{ event: 'a rotation reorder that moved rows under the guest', implemented: true, match: /Queue reordered/ },
	{ event: "a change to the guest's own position", implemented: false },
	// The keyboard step must be announced: the row moves under the guest's own focus, so a reader is
	// otherwise told only that the list changed, not that THEIR row is where they put it.
	{ event: 'a keyboard reorder step from the grip', implemented: true, match: /Moved to \$\{ordinal/ }
];

test('every phone announcement is one of the inventoried events, and the first sync is silent', () => {
	const src = stripComments(readFileSync(join(ROUTES, '+page.svelte'), 'utf8'));

	// Assignment sites only — the `$state('')` declaration and the initial-sync reset are not events.
	const sites = [...src.matchAll(/liveMsg\s*=\s*(?!\$state)([`'"][^`'"\n]*)/g)].map((m) => m[1]!);

	const unlisted = sites.filter((s) => !ANNOUNCED_EVENTS.some((e) => e.match?.test(s)));
	expect(
		unlisted,
		'an announcement reaches the phone live region that this file does not inventory — add the event to ANNOUNCED_EVENTS, or stop announcing it'
	).toEqual([]);

	// Floor: the implemented events really are wired. Without this, deleting an announcement passes.
	const implemented = ANNOUNCED_EVENTS.filter((e) => e.implemented);
	for (const e of implemented) {
		expect(
			sites.some((s) => e.match!.test(s)),
			`inventoried event "${e.event}" has no announcement site`
		).toBe(true);
	}
	expect(sites.length).toBeGreaterThanOrEqual(implemented.length);

	// The first-sync suppression latch is part of the requirement, so its removal must fail here rather than
	// be discovered by a guest having the whole queue read aloud on join.
	expect(src).toMatch(/announceReady/);
	expect(src, 'the initial-sync suppression latch must still gate the announcement effect').toMatch(
		/if\s*\(\s*!\s*announceReady\s*\)/
	);
});

// ---------------------------------------------------------------------------------------------------
// property floor: text and controls survive 200% text scaling and a 320px viewport
// ---------------------------------------------------------------------------------------------------

/** Phone surfaces for the property floors. The TV's type scale is viewport-derived and guarded there. */
const PHONE_STYLE_FILES = [
	join(SRC, 'app.css'),
	join(ROUTES, '+page.svelte'),
	join(ROUTES, 'settings', '+page.svelte'),
	join(ROUTES, 'stats', '+page.svelte'),
	...readdirSync(join(SRC, 'lib', 'components'))
		.filter((n) => n.endsWith('.svelte'))
		.map((n) => join(SRC, 'lib', 'components', n)),
	...readdirSync(join(SRC, 'lib', 'ui'))
		.filter((n) => n.endsWith('.svelte'))
		.map((n) => join(SRC, 'lib', 'ui', n))
];

/*
 * SC 1.4.4 concerns the guest's own text-size setting, which scales `rem`/`em`/`%` and not an absolute `px`.
 * Measured (Chromium, root font-size doubled, 320x480): every phone text rule already sizes in `rem` against
 * an `html` that declares no font-size, so this arm guards a LATENT hole — font-size inherits, so the first
 * phone text written without its own would become unscalable silently.
 *
 * NAMED EXEMPTIONS — icon GLYPH sizing, which is not text: `Icon` renders a 1em glyph inside a fixed
 * var(--tap) box, so scaling it with a reading preference would overflow a control whose hit box is a
 * pointing-precision constant (SC 2.5.5).
 */
const PX_FONT_SIZE_EXEMPTIONS: { file: string; declaration: string; reason: string }[] = [
	{
		file: 'app.css',
		declaration: 'font-size: 20px',
		reason: 'the shared icon-button glyph inside a fixed var(--tap) box — geometry of a control, not text'
	},
	{
		file: 'lib/components/SongRow.svelte',
		declaration: 'font-size: 20px',
		reason: 'the row action glyph; Icon defaults to 1em, so this sizes the mark rather than any reading text'
	}
];

test('no phone text is sized in absolute units, so the user’s text setting reaches it', () => {
	const exempt = new Set(PX_FONT_SIZE_EXEMPTIONS.map((e) => `${e.file} ${e.declaration}`));
	const offenders: string[] = [];
	let filesScanned = 0;

	for (const f of PHONE_STYLE_FILES) {
		filesScanned++;
		const rel = relative(SRC, f).split(sep).join('/');
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/font-size:\s*([0-9.]+)(px|pt)/g)) {
			const decl = `font-size: ${m[1]}${m[2]}`;
			if (exempt.has(`${rel} ${decl}`)) continue;
			offenders.push(
				`${rel}: ${decl} — absolute font sizes ignore the user's text-size setting (SC 1.4.4). ` +
					`Use a rem/em/%/clamp() value, or add it to PX_FONT_SIZE_EXEMPTIONS with a reason if it sizes a glyph rather than text.`
			);
		}
	}

	// An empty walk finds no offenders and looks clean.
	expect(filesScanned).toBeGreaterThanOrEqual(10); // @nvf-floor filesScanned
	expect(offenders).toEqual([]);
	for (const e of PX_FONT_SIZE_EXEMPTIONS) expect(e.reason.length).toBeGreaterThan(30);
});

/*
 * SC 1.4.10 Reflow: at a 320 CSS px viewport, content must not require horizontal scrolling, and a rule
 * fixing a horizontal dimension wider than that forces the scrollbar whatever the layout does. `max-width`
 * is excluded because it reflows by construction, and `@media (min-width:)` is a condition.
 *
 * NECESSARY, NOT SUFFICIENT, and measured: a driven pass found `/stats` at scrollWidth 328 against
 * clientWidth 320 while this arm was GREEN, because no single declaration is wider than 320px — the overflow
 * is the SUM of a grid's tracks and padding once the type grows. The rendered guard is
 * layout/phone-reflow-rung-l.test.ts; read this as the cheap always-on floor beneath it.
 *
 * NAMED EXEMPTIONS: deliberately empty. Nothing in the phone tree fixes a width above 320px today.
 */
const REFLOW_WIDTH_EXEMPTIONS: { file: string; declaration: string; reason: string }[] = [];
const REFLOW_MIN_VIEWPORT = 320;

test('no phone rule fixes a horizontal dimension wider than a 320px viewport', () => {
	const exempt = new Set(REFLOW_WIDTH_EXEMPTIONS.map((e) => `${e.file} ${e.declaration}`));
	const offenders: string[] = [];
	let declarationsSeen = 0;

	for (const f of PHONE_STYLE_FILES) {
		const rel = relative(SRC, f).split(sep).join('/');
		const src = stripComments(readFileSync(f, 'utf8'));
		// `(?<!-)` keeps `max-width`/`min-width` out of the `width` arm; the min-width arm is matched
		// separately, so a media-query condition is never read as a dimension.
		for (const m of src.matchAll(/(?<![-\w])(min-width|width):\s*([0-9.]+)px/g)) {
			const prop = m[1]!;
			const px = Number(m[2]);
			const before = src.slice(Math.max(0, m.index - 40), m.index);
			if (/@media[^{]*\(\s*$/.test(before) || /@media[^{]*and\s*\(\s*$/.test(before)) continue;
			declarationsSeen++;
			if (px <= REFLOW_MIN_VIEWPORT) continue;
			const decl = `${prop}: ${m[2]}px`;
			if (exempt.has(`${rel} ${decl}`)) continue;
			offenders.push(
				`${rel}: ${decl} — wider than the ${REFLOW_MIN_VIEWPORT}px reflow viewport, so it forces horizontal scrolling (SC 1.4.10). ` +
					`Use a relative width or a max-width, or add it to REFLOW_WIDTH_EXEMPTIONS with a reason.`
			);
		}
	}

	// A regex that stopped matching would make this trivially clean.
	expect(declarationsSeen).toBeGreaterThanOrEqual(10); // @nvf-floor declarationsSeen
	expect(offenders).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------
// property floor: de-emphasis never uses subtree opacity (the INLINE dimension)
// ---------------------------------------------------------------------------------------------------

/*
 * a11y/contrast.test.ts bans a card ROOT rule from dimming its own subtree and measures what `opacity: 0.55`
 * did (explanatory text to 3.77:1, byline 2.68:1, singer dot 2.57:1). It reads CSS RULES, so an `opacity` in
 * an inline `style=` attribute is structurally outside it — and an inline `opacity:.45` is exactly the idiom
 * reached for when dimming rows.
 *
 * NAMED EXEMPTION: a histogram bar with no text or identity dot in its subtree.
 */
const INLINE_OPACITY_EXEMPTIONS: { file: string; reason: string }[] = [
	{
		file: 'lib/components/RangeBar.svelte',
		reason:
			'the `.hist` span is an empty data bar — no text and no identity dot in its subtree, so no measured contrast can drift from what is painted'
	}
];

test('no phone markup de-emphasises a subtree with an inline opacity', () => {
	const exempt = new Set(INLINE_OPACITY_EXEMPTIONS.map((e) => e.file));
	const offenders: string[] = [];
	let filesScanned = 0;

	for (const f of PHONE_STYLE_FILES) {
		const rel = relative(SRC, f).split(sep).join('/');
		filesScanned++;
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/style\s*=\s*"([^"]*)"/g)) {
			if (!/(?:^|[;\s])opacity\s*:/.test(m[1]!)) continue;
			if (exempt.has(rel)) continue;
			offenders.push(
				`${rel}: inline style sets opacity (${m[1]!.trim()}) — a subtree opacity dims text and its background together, ` +
					`so every contrast guard keeps passing while the guest sees worse (SC 1.4.3). Dim by choosing a dimmer token, ` +
					`or add the file to INLINE_OPACITY_EXEMPTIONS with a reason if the subtree carries no text.`
			);
		}
	}

	expect(filesScanned).toBeGreaterThanOrEqual(10); // @nvf-floor filesScanned
	expect(offenders).toEqual([]);
	for (const e of INLINE_OPACITY_EXEMPTIONS) expect(e.reason.length).toBeGreaterThan(30);
});
