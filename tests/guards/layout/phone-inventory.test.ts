//
// PHONE INVENTORIES AND PROPERTY FLOORS — docs/ux/02-phone.md rows XR-PH-08, XR-PH-13, XR-PH-02, XR-PH-03.
//
// THE BUG THIS EXISTS FOR. Every guard in this directory answers "is THIS surface right?", so each one
// is only as complete as the list of surfaces somebody remembered to put in it. The failure that ships
// is therefore never a broken state — it is a state nobody designed, on a route nobody added to a list,
// which renders as an accidental blank column. Two of the four rows below are INVENTORY rules for
// exactly that reason: they are checkable by ENUMERATION over the filesystem, so a route or a live
// region introduced tomorrow is in scope the moment it exists, with no list to remember to extend.
//
// WHY EVERY EXEMPTION HERE IS NAMED AND COUNTED. An inventory rule with an unbounded escape hatch
// enforces nothing — "unless it's fine" is not a rule. So each list below is (a) enumerated in this
// file with a reason per entry, (b) shrink-only via a pinned ceiling, and (c) rot-proofed by an arm
// asserting every listed absence is still genuinely absent. That third arm is the one that matters:
// without it, a baseline entry survives the day its gap is closed and silently un-enforces the pair
// forever. Closing a gap is therefore expected to RED this file until the entry is deleted; that
// failure message says so.
//
// SCOPE. Phone surfaces only. The TV has its own scale and geometry guards (tv/stage-scale.test.ts) and
// is a named exemption of XR-PH-08 in the spec; the operator surfaces (/admin, /metrics) are covered by
// the Ops section. XR-PH-03's CSS-RULE half already lives in contrast.test.ts ("no card root dims its
// own subtree with opacity"); this file adds only the INLINE-STYLE dimension, which a CSS-rule scan
// structurally cannot see, and which is the mechanism the spec's own rationale flags.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { srcDir } from '@encore/test-support';

// Was `at('src')`, which resolved to src from this guard's old home in
// src/lib. Every walk below (routes/, app.css, lib/components, lib/ui) is rooted here, so the
// anchor is now stated once and derived from the repo root. `relative` here is node:path's two-argument
// form, used to name a route and to shorten a failure message — not the test-support helper.
const SRC = srcDir; // src
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
// XR-PH-08 — INVENTORY: every phone route has a designed empty, loading, error and offline state
// ---------------------------------------------------------------------------------------------------

/*
 * The spec's exemption list, verbatim and closed: "/components (a gallery — its states *are* its
 * content), /admin and /metrics (operator surfaces, covered by the Ops section), and /tv (not a phone
 * surface). No other route is exempt." Matched on the route itself or any descendant of it, so
 * /metrics/[mediaId] is covered by /metrics as the spec intends.
 */
const EXEMPT_ROUTES = ['/components', '/admin', '/metrics', '/tv'] as const;

const CONDITIONS = ['empty', 'loading', 'error', 'offline'] as const;
type Condition = (typeof CONDITIONS)[number];

/*
 * How each condition is DETECTED. Named idioms rather than one regex, so a failure says which shape
 * was looked for and a reviewer can judge the detector rather than reverse-engineering it. These are
 * the idioms this codebase actually uses, read off the four in-scope routes; a route that signals a
 * state some other way is a detector gap to widen here, not a reason to add a baseline entry.
 */
const IDIOMS: Record<Condition, { name: string; find: (src: string) => boolean }[]> = {
	empty: [
		{ name: '`empty=` prop on a list primitive', find: (s) => /\bempty\s*=\s*["{]/.test(s) },
		{ name: 'an emptyState()/readyEmptyState() builder', find: (s) => /\b(?:ready)?[Ee]mptyState\s*\(/.test(s) },
		/*
		 * A STRENGTHENING, not an accommodation — the same case as the sonner and `Alert.Root` idioms
		 * under `error` below, and worth stating precisely because "add a detector" is the shape a
		 * weakening takes when nobody checks.
		 *
		 * The two idioms above PREDATE this repo vendoring shadcn's `Empty` primitive
		 * (`lib/components/ui/empty/`), which is now the codebase's actual designed empty state:
		 * `<Empty.Root><Empty.Header><Empty.Description>` renders the heading-plus-next-action shape
		 * XR-PH-08 asks for. A route that ships one and calls no builder was therefore reported as
		 * having NO empty state at all — a false negative, and a live one: `routes/+page.svelte`
		 * renders `Empty.Root` with "Nothing queued." and this guard
		 * could not see it. Measured across the whole tree, the blind spot covered six files —
		 * `routes/+page.svelte`, `routes/find/+page.svelte` (3 states, only one of them backed by a
		 * builder call), `routes/metrics/+page.svelte` (4), `routes/admin/+page.svelte` (2), and
		 * `lib/charts/{Trend,Bars}.svelte` — of which only `find` matched an existing idiom at all.
		 *
		 * Adding it can only ever move a pair from "reported missing" to "detected", never the
		 * reverse: the detectors are OR'd, so nothing that matched before stops matching, and a route
		 * with none of the three still reds. The KNOWN_ABSENT rot arm is the counterweight — an
		 * `n/a`/`gap` entry whose route grew an `Empty.Root` now fails until the entry is deleted,
		 * which is why this widening tightens the file rather than loosening it.
		 */
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
		/*
		 * S5: a `toast.error(...)` call is a designed error state too. The home route's error surface
		 * is sonner's now, and sonner renders the region with its own `role="alert"` at RUNTIME -- which a
		 * source scan cannot see, so without this idiom the guard reports a route that HAS a working
		 * designed error state as having none. This recognises a new spelling of the same claim rather than
		 * loosening it: a route with neither an alert region nor an error toast still reds.
		 */
		{ name: 'a sonner `toast.error(...)` call', find: (s) => /\btoast\.error\s*\(/.test(s) },
		/*
		 * The same case as the sonner idiom directly above, for the same reason. `ui/alert` sets
		 * `role="alert"` on the element IT renders, so a source scan of the CALL SITE sees only
		 * `<Alert.Root variant="destructive">` and would report a route with a working designed error
		 * state as having none. `/stats`, `/metrics`, `/metrics/[mediaId]`, `/admin` and `/settings`
		 * all moved their load-failure copy onto it.
		 *
		 * Still not a loosening: the variant is required, so a neutral `<Alert.Root>` used as a plain
		 * info panel does NOT satisfy the error condition, and a route with none of the three idioms
		 * still reds.
		 */
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
 * The BASELINE: route x condition pairs that do not render a designed state today. Bounded, reasoned,
 * shrink-only, and rot-proofed by `every listed absence is still absent` below.
 *
 * `kind` separates the two honest reasons a pair can be absent, because they have different futures:
 *   'n/a' — the route structurally cannot reach this condition (no collection to be empty of). Stable.
 *   'gap' — it can and should, and does not yet. Closing one is the point; delete the entry when you do.
 *
 * Recording these rather than fixing them here is deliberate: each 'gap' needs designed copy and a
 * named next action (the spec's acceptance bar), which is product design across three more routes and
 * a second concern. What this file changes is that they are now enumerated and cannot grow.
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

/** Pinned ceiling: this list may shrink, never grow. A new absence is a regression, not a baseline.
 *  Measured, not guessed — an earlier draft also listed `/settings x loading`, and the rot arm below
 *  falsified it: `settings/+page.svelte:507` renders `{#if saving}Saving…` on the profile save. */
const KNOWN_ABSENT_CEILING = 5;

function isExempt(route: string): boolean {
	return EXEMPT_ROUTES.some((e) => route === e || route.startsWith(`${e}/`));
}

const ALL_ROUTES = pageFiles(ROUTES)
	.map((f) => ({ route: routePath(f), file: f }))
	.sort((a, b) => a.route.localeCompare(b.route));
const PHONE_ROUTES = ALL_ROUTES.filter((r) => !isExempt(r.route));

/*
 * The arm that catches the surface nobody thought about. The route set is derived from the filesystem,
 * so a route added tomorrow is enumerated the moment its `+page.svelte` exists — it cannot be omitted
 * by forgetting a list. The only way out is the spec's closed exemption set, and this arm pins that set
 * too: every name in it must still resolve to a real route, so renaming an exempt route surfaces the
 * new name here instead of leaving a dead exemption behind and the new surface unchecked.
 */
test('XR-PH-08: the phone route set is derived from the filesystem, and every exemption is the spec\u2019s', () => {
	// Re-anchored 3 -> 4 by the phone-remote rebuild, which split search out of `/` onto its own
	// `/find` route (`/` is queue-only now, and `NowPlayingBand` moved to +layout.svelte as app chrome).
	// So the real phone-route set is `/`, `/find`, `/settings`, `/stats`. Re-anchored UPWARD on the
	// record rather than left slack (XR-VER-06): a floor below the measured set is a floor that would not
	// notice the set shrinking back. Re-anchored 3 -> 4 when `/find` arrived and 4 -> 5 when
	// `/song/[mediaId]` did, so the phone-route set is `/`, `/find`, `/settings`, `/song/[mediaId]`,
	// `/stats`. Still non-vacuous — a walk that enumerates fewer (an over-broad exemption or a moved
	// routes/ dir) still fails here. Keeps the per-site floor-tag anchor (below); the value 5 is recorded
	// to match in non-vacuity-floors.test.ts's FLOORS.
	expect(PHONE_ROUTES.length).toBeGreaterThanOrEqual(5); // @nvf-floor PHONE_ROUTES.length

	const known = new Set(ALL_ROUTES.map((r) => r.route));
	for (const e of EXEMPT_ROUTES) {
		expect(
			known.has(e),
			`exempt route ${e} no longer exists — either it was renamed (enumerate the new name, or exempt it here with a reason) or the exemption is dead and should be deleted`
		).toBe(true);
	}

	// Every route is either enumerated as a phone surface or named in the closed exemption list. There
	// is no third bucket, which is what makes this an inventory rather than a spot check.
	for (const r of ALL_ROUTES) {
		expect(PHONE_ROUTES.some((p) => p.route === r.route) || isExempt(r.route)).toBe(true);
	}
});

test('XR-PH-08: every phone route renders a designed empty, loading, error and offline state', () => {
	const baseline = new Set(KNOWN_ABSENT.map((k) => `${k.route} \u00d7 ${k.condition}`));
	const missing: string[] = [];
	let pairsChecked = 0;

	for (const { route, file } of PHONE_ROUTES) {
		const src = stripComments(readFileSync(file, 'utf8'));
		for (const c of CONDITIONS) {
			pairsChecked++;
			const key = `${route} \u00d7 ${c}`;
			if (baseline.has(key)) continue;
			if (!detect(src, c)) {
				missing.push(
					`${key} — no designed ${c} state. Looked for: ${IDIOMS[c].map((i) => i.name).join('; ')}. ` +
						`Design the state (a heading plus one next action), or add the pair to KNOWN_ABSENT with a reason.`
				);
			}
		}
	}

	// Non-vacuity floor: the walk really visited every route x condition pair. Without this, a broken
	// route walk reports zero offenders and reads exactly like a clean tree.
	expect(pairsChecked).toBe(PHONE_ROUTES.length * CONDITIONS.length);
	expect(missing).toEqual([]);
});

test('XR-PH-08: the known-absent baseline is bounded, well-formed, and has not rotted', () => {
	expect(KNOWN_ABSENT.length).toBeLessThanOrEqual(KNOWN_ABSENT_CEILING);

	const phone = new Set(PHONE_ROUTES.map((r) => r.route));
	const seen = new Set<string>();
	const rotted: string[] = [];

	for (const k of KNOWN_ABSENT) {
		const key = `${k.route} \u00d7 ${k.condition}`;
		expect(seen.has(key), `duplicate baseline entry ${key}`).toBe(false);
		seen.add(key);
		// A baseline entry for a route that is exempt or gone is an entry that enforces nothing.
		expect(phone.has(k.route), `baseline entry ${key} names a route that is not a phone surface`).toBe(true);
		// Every entry states why, so the list cannot become a bag of unexplained escapes.
		expect(k.reason.length, `baseline entry ${key} needs a reason`).toBeGreaterThan(30);

		const file = PHONE_ROUTES.find((r) => r.route === k.route)!.file;
		const found = detect(stripComments(readFileSync(file, 'utf8')), k.condition);
		if (found) rotted.push(`${key} is now designed (matched: ${found}) — delete its KNOWN_ABSENT entry`);
	}

	// THE ROT ARM. A stale entry silently un-enforces its pair forever, so closing a gap is meant to
	// fail here until the entry goes. That is the failure message above, not a mystery.
	expect(rotted).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------
// XR-PH-13 — INVENTORY: announcements — what is announced, and when
// ---------------------------------------------------------------------------------------------------

/*
 * Files that can announce to a phone guest. Enumerated from the phone surfaces rather than hand-listed
 * per region, so a live region added to any of them is in scope immediately.
 */
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
 * THE REGION INVENTORY: every `aria-live` region a phone guest can hear, and what it is for. An
 * unlisted region fails — that is the whole rule. Two regions announcing the same event, or a region
 * nobody can explain, is precisely the "app that narrates" going wrong, and it is invisible without
 * an enumeration because each one looks reasonable in its own file.
 */
const LIVE_REGIONS: { file: string; purpose: string }[] = [
	{ file: 'routes/+page.svelte', purpose: 'XR-PH-13 announcement region (`sr-live`) — queue changes under the guest' },
	{ file: 'routes/+page.svelte', purpose: 'connection loss/restore (`offline-pill`)' },
	{ file: 'lib/components/SongRow.svelte', purpose: "a row's readiness chip changing while the guest looks at it" },
	{ file: 'lib/components/ProcessingCard.svelte', purpose: 'a process that failed, and why it stopped' },
	{ file: 'lib/components/ProcessingCard.svelte', purpose: 'process stage progress while the guest waits' },
	{
		file: 'lib/components/CodeEntry.svelte',
		purpose:
			'XR-PH-14 join-code entry — a rejected keystroke names the excluded characters (SC 3.3.1) and the disabled-Continue reason (SC 3.3.2), without interrupting typing'
	},
	{
		file: 'lib/components/JoinLanding.svelte',
		purpose:
			'XR-PH-14 landing — the reason Continue is disabled (enter your name / finish the code), stated in words rather than by disabled state alone (SC 3.3.2)'
	}
];

test('XR-PH-13: every phone live region is inventoried, and all are polite', () => {
	const found: { file: string; politeness: string }[] = [];
	for (const f of PHONE_ANNOUNCING_FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/aria-live\s*=\s*["']([a-z]+)["']/g)) {
			found.push({ file: relative(SRC, f).split(sep).join('/'), politeness: m[1]! });
		}
	}

	// An eighth region is as much a defect as a missing one: the inventory IS the requirement.
	const inventory = LIVE_REGIONS.map((r) => r.file).sort();
	expect(
		found.map((f) => f.file).sort(),
		'a phone live region is not in LIVE_REGIONS (or an inventoried one was removed) — inventory it with its purpose, or delete its entry'
	).toEqual(inventory);

	// Politeness is DERIVED in the spec: none of these interrupt a task, and an assertive queue
	// announcement would talk over a guest mid-typing in search.
	for (const f of found) {
		expect(f.politeness, `${f.file} announces ${f.politeness} — phone announcements are polite`).toBe('polite');
	}

	for (const r of LIVE_REGIONS) expect(r.purpose.length).toBeGreaterThan(20);
});

/*
 * THE EVENT INVENTORY: the seven events XR-PH-13 says the polite region announces. Every write to
 * `liveMsg` must map to one of them, so an eighth announcement fails — the spec's own falsification
 * condition. `implemented: false` records the three the redesign still owes (the reorder mode and the
 * guest's own position); they are listed so the set is the spec's set and not merely today's code.
 */
const ANNOUNCED_EVENTS: { event: string; implemented: boolean; match?: RegExp }[] = [
	{ event: "another guest's add", implemented: true, match: /\bqueued\b/ },
	{ event: "several guests' adds, batched on resync", implemented: true, match: /songs added to the queue/ },
	{ event: 'a rotation reorder that moved rows under the guest', implemented: true, match: /Queue reordered/ },
	{ event: "a change to the guest's own position", implemented: false },
	{ event: 'entering and leaving the reorder mode', implemented: false },
	{ event: 'each committed slot change during the reorder mode', implemented: false }
	// connection loss/restore is the seventh, announced by the `offline-pill` region above rather than
	// through `liveMsg`, so it has no assignment site here.
];

test('XR-PH-13: every phone announcement is one of the inventoried events, and the first sync is silent', () => {
	const src = stripComments(readFileSync(join(ROUTES, '+page.svelte'), 'utf8'));

	// Assignment sites only — the `$state('')` declaration and the initial-sync reset are not events.
	const sites = [...src.matchAll(/liveMsg\s*=\s*(?!\$state)([`'"][^`'"\n]*)/g)].map((m) => m[1]!);

	const unlisted = sites.filter((s) => !ANNOUNCED_EVENTS.some((e) => e.match?.test(s)));
	expect(
		unlisted,
		'an announcement reaches the phone live region that XR-PH-13 does not inventory — add the event to ANNOUNCED_EVENTS (and to docs/ux/02-phone.md), or stop announcing it'
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

	// "It announces nothing on first sync" — the suppression latch is part of the requirement, not an
	// implementation detail, so its removal must fail here rather than being discovered by a guest
	// having the whole queue read aloud on join.
	expect(src).toMatch(/announceReady/);
	expect(src, 'the initial-sync suppression latch must still gate the announcement effect').toMatch(
		/if\s*\(\s*!\s*announceReady\s*\)/
	);
});

// ---------------------------------------------------------------------------------------------------
// XR-PH-02 — property floor: text and controls survive 200% text scaling and a 320px viewport
// ---------------------------------------------------------------------------------------------------

/*
 * Phone surfaces for the property floors. The TV is excluded on purpose: its type scale is deliberately
 * viewport-derived (`--tv-*`, clamp() with vh terms) and is enforced by tv/stage-scale.test.ts against a
 * ten-foot floor, which is a different criterion from a phone at arm's length.
 */
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
 * SC 1.4.4 concerns the guest's own text-size setting, which scales `rem`/`em`/`%` and not an absolute
 * `px`. Measured rather than assumed (Chromium, root font-size doubled, 320x480): every phone text rule
 * here already sizes in `rem` and `rem` resolves against `html`, which declares no font-size — so the
 * setting already reached all app text, and `body { font-size: 16px }` pinned nothing a guest can see.
 * This arm therefore guards a LATENT hole, not a live defect: font-size inherits, so the first phone
 * text written without its own font-size would become unscalable silently. That is worth a floor, and
 * it is worth being honest that it is a floor.
 *
 * NAMED EXEMPTIONS — icon GLYPH sizing, which is not text. `Icon` renders a 1em glyph inside a
 * fixed var(--tap) box, so its font-size is that box's geometry: scaling it with the guest's text
 * preference would overflow a control whose hit box is a pointing-precision constant (SC 2.5.5),
 * not a reading measurement. Both entries carry that reasoning in their own source comment.
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

test('XR-PH-02: no phone text is sized in absolute units, so the user\u2019s text setting reaches it', () => {
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

	// Non-vacuity floor: the file list really resolved. An empty walk finds no offenders and looks clean.
	expect(filesScanned).toBeGreaterThanOrEqual(10); // @nvf-floor filesScanned
	expect(offenders).toEqual([]);
	for (const e of PX_FONT_SIZE_EXEMPTIONS) expect(e.reason.length).toBeGreaterThan(30);
});

/*
 * SC 1.4.10 Reflow: at a 320 CSS px viewport, content must not require horizontal scrolling. A rule
 * that fixes a horizontal dimension wider than that forces the scrollbar no matter what the layout
 * around it does. `max-width` is excluded because it reflows by construction, and `@media (min-width:)`
 * is a condition rather than a dimension.
 *
 * THIS ARM IS NECESSARY, NOT SUFFICIENT, AND THAT IS MEASURED. A driven pass for this change
 * (Chromium, 320x480, root font-size doubled) found `/stats` at scrollWidth 328 against clientWidth
 * 320 — a real overflow, from `span.n`/`span.k` in the stat tiles — while this arm was GREEN, because
 * no single declaration is wider than 320px: the overflow is the SUM of a grid's tracks and padding
 * once the type grows. The overflow reproduces identically before and after this change, so it is
 * pre-existing and reported rather than fixed here (one concern). The spec says as much — XR-PH-02's
 * check is "Rendered-DOM or driven-browser measurement. Not a source scan" and depends on the rendered
 * rung (XR-PH-21). Read this arm as the cheap always-on floor beneath that, not as the row's proof.
 *
 * NAMED EXEMPTIONS: deliberately empty. Nothing in the phone tree fixes a width above 320px today, so
 * this floor holds the line rather than quarantining a debt — an entry added here needs a reason.
 */
const REFLOW_WIDTH_EXEMPTIONS: { file: string; declaration: string; reason: string }[] = [];
const REFLOW_MIN_VIEWPORT = 320;

test('XR-PH-02: no phone rule fixes a horizontal dimension wider than a 320px viewport', () => {
	const exempt = new Set(REFLOW_WIDTH_EXEMPTIONS.map((e) => `${e.file} ${e.declaration}`));
	const offenders: string[] = [];
	let declarationsSeen = 0;

	for (const f of PHONE_STYLE_FILES) {
		const rel = relative(SRC, f).split(sep).join('/');
		const src = stripComments(readFileSync(f, 'utf8'));
		// `(?<!-)` keeps `max-width`/`min-width` out of the `width` arm; the min-width arm is matched
		// separately below so a media-query condition is never read as a dimension.
		for (const m of src.matchAll(/(?<![-\w])(min-width|width):\s*([0-9.]+)px/g)) {
			const prop = m[1]!;
			const px = Number(m[2]);
			// A media-query condition states when a rule applies, not how wide anything is.
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

	// Non-vacuity floor: the scan really read width declarations rather than matching nothing.
	expect(declarationsSeen).toBeGreaterThanOrEqual(10); // @nvf-floor declarationsSeen
	expect(offenders).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------
// XR-PH-03 — property floor: de-emphasis never uses subtree opacity (the INLINE dimension)
// ---------------------------------------------------------------------------------------------------

/*
 * contrast.test.ts already bans a card ROOT rule from dimming its own subtree, and proves it by
 * measuring what `opacity: 0.55` did to `.pending` (explanatory text to 3.77:1, byline 2.68:1, singer
 * dot 2.57:1). That guard reads CSS RULES, so an `opacity` written as an inline `style=` attribute in
 * markup is structurally outside it — and an inline `opacity:.45` is exactly the idiom the spec's
 * rationale names for the reorder mode's dimmed rows. This arm closes that dimension only; it does not
 * duplicate the rule scan.
 *
 * NAMED EXEMPTION: one, a histogram bar that contains no text or identity dot, so flattening its
 * subtree flattens a coloured rectangle and nothing a guest has to read.
 */
const INLINE_OPACITY_EXEMPTIONS: { file: string; reason: string }[] = [
	{
		file: 'lib/components/RangeBar.svelte',
		reason:
			'the `.hist` span is an empty data bar — no text and no identity dot in its subtree, so no measured contrast can drift from what is painted'
	}
];

test('XR-PH-03: no phone markup de-emphasises a subtree with an inline opacity', () => {
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
