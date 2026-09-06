// guard: the design system's own rules, enforced against the components rather than the token file.
//
// THE BUG THIS EXISTS FOR. `contrast.test.ts` proves the TOKENS are sound, but it only ever reads
// app.css — so every violation written INSIDE a component was invisible to it. SongRow shipped
// `background: #14322a` while `--ok-bg` held that exact value; a `--warn-bg` that had never been
// defined silently painted a "no worker connected" banner transparent; and a `#2f2440` sat one shade
// off `--card-tint2`, which is precisely how a theme swap breaks. Ten audits and 1100 green tests did
// not catch any of it, because nothing scanned the components.
//
// WHY NOT "no colour literals at all": several are legitimate and must stay. Pure white lyric text
// over video is contrast-critical (a token would LOWER it), a QR code's cells must be true white and
// true black to scan, mask-image stops are opacity ramps rather than colours, and a colour picker
// necessarily computes in raw hue values. A blanket ban would force those into fake tokens, or force
// an allowlist that every new file silently escapes -- the maintenance model the audit criticised.
//
// So this asserts the DECIDABLE thing instead: a literal must not duplicate a value that already has
// a token. That names the real defect ("you hard-coded something the palette already owns"), permits
// genuinely token-less colour, and needs no hand-maintained list -- add a token and the guard starts
// enforcing it everywhere by itself.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..');
const css = readFileSync(join(SRC, 'app.css'), 'utf8');

/** Every .svelte under src, recursively. */
function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...svelteFiles(p));
		else if (e.name.endsWith('.svelte')) out.push(p);
	}
	return out;
}

/**
 * Strip comments before scanning. A comment explaining WHY a literal was kept must not itself trip
 * the guard -- that would punish the documentation the rest of this codebase relies on.
 */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
}

function lineOf(src: string, index: number): number {
	return src.slice(0, index).split('\n').length;
}

/** #abc and #AABBCC normalise to the same key so a shade match cannot hide behind formatting. */
function normaliseHex(hex: string): string {
	let h = hex.replace('#', '').toLowerCase();
	if (h.length === 3) h = h.split('').map((c) => c + c).join('');
	return `#${h}`;
}

/** The palette as value -> token name, built from app.css so it can never go stale. */
function palette(): Map<string, string> {
	const m = new Map<string, string>();
	for (const t of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
		m.set(normaliseHex(t[2]!), t[1]!);
	}
	return m;
}

test('no component hard-codes a colour the palette already owns', () => {
	const known = palette();
	expect(known.size).toBeGreaterThan(10); // the parser still works if app.css is reformatted
	const offences: string[] = [];

	// Pure white and pure black are UNIVERSAL, not owned by any token. `--on-accent` happens to equal
	// #ffffff, but it means "the ink that may sit on --accent-strong" -- so demanding it for a QR cell,
	// a letterbox bar, or contrast-critical lyric text over video would assert a relationship that is
	// not there, and would break the moment --on-accent stopped being white.
	const UNIVERSAL = new Set(['#ffffff', '#000000']);

	// A colour inside an SVG paint attribute is markup built as a STRING (a data: URI), and a CSS
	// custom property cannot resolve in one. Nothing to convert it to.
	const SVG_PAINT = /(fill|stroke|stop-color)=["']$/;

	for (const f of svelteFiles(SRC)) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
			const hex = normaliseHex(m[0]);
			if (UNIVERSAL.has(hex)) continue;
			if (SVG_PAINT.test(src.slice(Math.max(0, m.index! - 14), m.index!))) continue;
			const tokenName = known.get(hex);
			if (!tokenName) continue;
			offences.push(
				`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: ${m[0]} is var(--${tokenName})`
			);
		}
	}

	expect(offences).toEqual([]);
});

test('every token a component references is actually defined', () => {
	// A typo resolves to nothing and paints transparent rather than erroring, which is how /metrics'
	// worker-down banner -- the one state that invalidates every number under it -- rendered as bare
	// text. An explicit `var(--x, fallback)` is a deliberate default and is allowed.
	const defined = new Set([...css.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]!));
	const missing: string[] = [];

	for (const f of svelteFiles(SRC)) {
		const src = stripComments(readFileSync(f, 'utf8'));
		// Locally-scoped custom properties (set via style= or a parent rule) are legitimate; collect
		// what this file declares so they are not reported as typos.
		const local = new Set([...src.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
		for (const m of src.matchAll(/var\(\s*--([a-z0-9-]+)\s*\)/g)) {
			const name = m[1]!;
			if (defined.has(name) || local.has(name)) continue;
			missing.push(`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: var(--${name}) is never defined`);
		}
	}

	expect(missing).toEqual([]);
});

test('the colour picker has exactly one name per shared preset colour', () => {
	// THE BUG THIS BOUNDS. The picker names its swatches BY POSITION: PRESET_NAMES[i] is the announced
	// name of SINGER_COLORS[i], and that is the only thing tying a screen-reader label to a hex. The
	// existing e2e contract compares PRESET_NAMES against its own copy of the names, so a RENAME is
	// caught -- but nothing noticed if the two arrays stopped being the same LENGTH, which is how a
	// preset ends up announced as `undefined`, or a name ends up describing no colour at all.
	//
	// What this cannot decide: whether the ORDER still corresponds. Nothing in a hex says "violet", so
	// reordering both arrays consistently is indistinguishable from reordering one. (The trailing
	// comments in colors.ts are not a contract either -- index 4 reads `// sky` while the picker
	// announces `blue`.) Length parity plus the contract's name check bound the blast radius to a
	// same-length reorder, which a human reading either file can still see.
	const picker = readFileSync(join(SRC, 'lib/components/ColourPicker.svelte'), 'utf8');
	const shared = readFileSync(join(SRC, '../../../packages/shared/src/colors.ts'), 'utf8');

	const names = /PRESET_NAMES\s*=\s*\[([^\]]*)\]/.exec(picker)?.[1];
	expect(names).toBeDefined();
	const nameCount = names!.split(',').filter((s) => s.trim()).length;

	const colours = /SINGER_COLORS\s*=\s*\[([^\]]*)\]/.exec(shared)?.[1];
	expect(colours).toBeDefined();
	const colourCount = [...colours!.matchAll(/#[0-9a-fA-F]{3,8}/g)].length;

	expect(nameCount).toBe(colourCount);
});

test('the colour picker wires its swatch tabindex to presetTabStopIndex', () => {
	// THE BUG THIS BOUNDS (#88, pr-bot BLOCKED verdict on the first cut). The tab-stop DECISION was
	// extracted to the pure, unit-tested presetTabStopIndex in @encore/shared so a guard could exercise
	// production logic instead of a reconstructed predicate -- but that closed only the *reconstruction*
	// hazard. It left the *reversion* hazard open: the one line that actually READS the function is a
	// Svelte template expression, and reverting it to the pre-fix `tabindex={value === c ? 0 : -1}`
	// (issue #88's exact bug -- after any wheel pick no swatch is tabbable and the presets fall out of
	// the tab order for good) leaves every gate green, because the three presetTabStopIndex unit tests
	// never touch the caller. This pins the call site itself, mirroring the sibling roving group's guard
	// at settings-scopes.test.ts (`tabindex={tab === t.id ? 0 : -1}`), so the wiring cannot silently
	// regress while the helper stays correct.
	const picker = readFileSync(join(SRC, 'lib/components/ColourPicker.svelte'), 'utf8');
	expect(picker).toContain('tabindex={i === presetTabStopIndex(value) ? 0 : -1}');
});

test('every bottom-docked sheet caps its height in dvh, not vh', () => {
	// `.sheet-surface` in app.css deliberately does NOT default a max-height, because a sheet's cap is
	// its own business. But the UNIT is not a preference: on iOS `vh` resolves to the LARGE viewport, so
	// a sheet capped in vh overflows the visible area whenever the URL bar is showing and hides its own
	// footer -- which was the rotation's last row here, and the Save button on the profile sheet before
	// identity moved to /settings and that sheet was retired. The cap stays with each sheet and the unit
	// is asserted here. One entry in this list today; it is a list because the next sheet must comply.
	for (const f of ['lib/components/QueueSheet.svelte']) {
		const src = stripComments(readFileSync(join(SRC, f), 'utf8'));
		const caps = [...src.matchAll(/max-height:\s*([0-9.]+)(dvh|svh|vh)\b/g)];
		expect(caps.length).toBeGreaterThan(0);
		for (const c of caps) {
			expect(c[2], `${f}: max-height ${c[1]}${c[2]} must be dvh/svh, not vh`).not.toBe('vh');
		}
	}
});

test('no component leaks a stray comment terminator into the page', () => {
	// THE BUG THIS EXISTS FOR. A rebase auto-merge left a bare `-->` in the phone route with no `<!--`
	// opening it. Svelte treats an unmatched terminator as ordinary TEXT, so it rendered "-->" on
	// screen between the key controls and the rotation -- and nothing caught it: svelte-check reports
	// 0 errors, every unit test passed, and the e2e drove straight past it because no selector cares.
	// Only looking at the running app found it, which is exactly the class of defect a cheap source
	// scan should own instead.
	const offences: string[] = [];

	for (const f of svelteFiles(SRC)) {
		const src = readFileSync(f, 'utf8');
		let depth = 0;
		let line = 1;
		for (let i = 0; i < src.length; ) {
			if (src.startsWith('<!--', i)) {
				depth++;
				i += 4;
				continue;
			}
			if (src.startsWith('-->', i)) {
				if (depth === 0) offences.push(`${f.replace(SRC, 'src')}:${line}: stray --> renders as text`);
				else depth--;
				i += 3;
				continue;
			}
			if (src[i] === '\n') line++;
			i++;
		}
		if (depth > 0) offences.push(`${f.replace(SRC, 'src')}: ${depth} unclosed <!-- comment(s)`);
	}

	expect(offences).toEqual([]);
});

test('form controls never sit below the 16px iOS zoom threshold', () => {
	// THE BUG: iOS Safari zooms the page in when a focused input computes under 16px, and does not
	// zoom back out. The settings page shipped `select, .text { font-size: 0.9rem }` (14.4px) and a
	// 0.86rem LAN-address field, so tapping either left the whole surface zoomed and off-centre.
	const offences: string[] = [];
	const CONTROL = /(^|[\s,>])(input|select|textarea)\b/;

	for (const f of svelteFiles(SRC)) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
			const [sel, body] = [m[1]!, m[2]!];
			if (!CONTROL.test(sel)) continue;
			// A range slider has no text, so the zoom rule cannot apply to it.
			if (/type=['"]?range/.test(sel)) continue;
			const fs = body.match(/font-size:\s*([0-9.]+)(rem|px|em)/);
			if (!fs) continue;
			const [n, unit] = [Number(fs[1]), fs[2]];
			const px = unit === 'px' ? n : n * 16;
			if (px < 16) {
				offences.push(
					`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: ${sel.trim()} is ${fs[1]}${unit} (${px}px)`
				);
			}
		}
	}

	expect(offences).toEqual([]);
});

test('the phone shell keeps its dynamic viewport and its safe-area insets', () => {
	// Both are load-bearing on the devices this PWA actually targets and neither is expressible as a
	// component test: `100vh` on iOS resolves to the LARGE viewport, so a full-height shell runs under
	// the browser chrome, and without the insets content sits under the notch and the home indicator.
	// They were correct but unguarded, so a tidy-up could have silently removed either.
	expect(css).toContain('100dvh');
	expect(css).toMatch(/env\(safe-area-inset-/);
});

test('a bottom-docked sheet clears the home indicator', () => {
	// THE BUG: the queue sheet is `position: fixed; bottom: 0` and collapses to show only its peek, so
	// the peek is the band sitting at the very bottom of the screen. Its inset landed on the sheet's
	// separate scroll body instead, which only helps once EXPANDED -- so in the default collapsed state
	// the transport controls and the "when am I up?" line rendered under the home indicator.
	//
	// The peek is also what --peek-h measures (it is bound to that element's clientHeight, which
	// includes padding), and every other docked control offsets from --peek-h with no env() of its own.
	// So the inset belonging to the peek is a contract, not a detail: move it and the toasts silently
	// stop clearing the indicator too.
	const sheet = readFileSync(join(SRC, 'lib/components/QueueSheet.svelte'), 'utf8');
	const peek = sheet.match(/\.peek\s*\{[^}]*\}/s);
	expect(peek).not.toBeNull();
	expect(peek![0]).toMatch(/env\(safe-area-inset-bottom/);
});

test('the phone header truncates a long display name instead of growing the row (#109)', () => {
	// THE BUG (#109): the header is a nowrap flex row and the ONE child whose width is user-supplied --
	// the display name -- rendered raw with no truncation. A single unbroken token has a min-content
	// width equal to its full rendered width, so with CSS automatic minimum sizing flex-shrink cannot
	// take it below that: the row grows the document instead, and the settings gear -- the only entry
	// point to /settings from the home screen -- is carried off the viewport. Measured live: 23 chars
	// already overflowed at 390px; a 31-char name pushed the gear fully off screen.
	//
	// The fix is the same treatment QueueRow's `.who` carries: min-width:0 up the whole chain so the
	// item can shrink, plus overflow:hidden/text-overflow:ellipsis/white-space:nowrap on the name. And
	// text-overflow only fires on a BLOCK box, not on an anonymous flex item -- so the name must be a
	// styled block span. This guard is a source scan (no layout engine in bun:test), but each clause
	// below is exactly what a reverted fix drops, so it fails red on the pre-fix source.
	const page = stripComments(readFileSync(join(SRC, 'routes/+page.svelte'), 'utf8'));

	// The name is a styled block span (not a bare <span>), so text-overflow can act on it.
	expect(page).toMatch(/<span class="me-name">\{me\.displayName\}<\/span>/);

	const meName = page.match(/\.me-name\s*\{([^}]*)\}/);
	expect(meName).not.toBeNull();
	const nameBody = meName![1]!;
	expect(nameBody).toMatch(/display:\s*block/); // text-overflow needs a block box
	expect(nameBody).toMatch(/min-width:\s*0/); // so it can shrink below content width
	expect(nameBody).toMatch(/overflow:\s*hidden/);
	expect(nameBody).toMatch(/text-overflow:\s*ellipsis/);
	expect(nameBody).toMatch(/white-space:\s*nowrap/);

	// min-width:0 must exist all the way up the flex chain or the name never gets the chance to shrink.
	const cluster = page.match(/\.me-cluster\s*\{([^}]*)\}/);
	expect(cluster).not.toBeNull();
	expect(cluster![1]!).toMatch(/min-width:\s*0/);
	const btn = page.match(/\.me-btn\s*\{([^}]*)\}/);
	expect(btn).not.toBeNull();
	expect(btn![1]!).toMatch(/min-width:\s*0/);

	// The dot and the gear must stay unshrinkable so the 44px target and the colour dot survive.
	const dot = page.match(/\.me-dot\s*\{([^}]*)\}/);
	expect(dot![1]!).toMatch(/flex:\s*0 0 auto/);
	const gear = page.match(/\.gear\s*\{([^}]*)\}/);
	expect(gear![1]!).toMatch(/min-width:\s*44px/);
});

test('every identity-dot rule declares a non-shrinking flex basis', () => {
	// THE BUG THIS EXISTS FOR (issue #89). The singer identity dot (`.who i`) lives inside `.who`, a
	// flex container that QueueRow deliberately makes overflowable (nowrap + overflow:hidden so a long
	// name plus an away/adding badge can't wrap and change the row's height). A dot is an empty element,
	// whose automatic minimum size is 0, so as a shrinkable flex item it collapsed to 0px under a
	// 32-char name (32 is exactly the profile-name maxlength) — the singer's colour vanished from their
	// OWN row, the one place the truncated name is least able to disambiguate them. colors.ts:12-14
	// states that dot is "the only thing telling two singers apart besides the name", so this is a
	// functional loss, not cosmetic. The fix is the same `flex: 0 0 auto` that `.seq`/`.actions` carry;
	// this guard pins it for every identity-dot rule so a future edit can't drop it. ProcessingCard's
	// `.who i` is byte-identical by design, so it must satisfy the same rule.
	const offences: string[] = [];
	for (const f of svelteFiles(SRC)) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/\.who\s+i\s*\{([^}]*)\}/g)) {
			const body = m[1]!;
			const flexShorthand = body.match(/(^|[;{\s])flex:\s*0\s+0\b/);
			const flexShrink0 = body.match(/flex-shrink:\s*0\b/);
			if (!flexShorthand && !flexShrink0) {
				offences.push(
					`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: .who i must declare flex:0 0 <basis> (or flex-shrink:0) so the identity dot cannot collapse to 0px`
				);
			}
		}
	}
	// The rule must actually match something, or a selector rename would silently disarm it.
	// QueueRow + ProcessingCard both carry a .who i rule.
	let seen = 0;
	for (const f of svelteFiles(SRC)) {
		seen += [...stripComments(readFileSync(f, 'utf8')).matchAll(/\.who\s+i\s*\{/g)].length;
	}
	expect(seen).toBeGreaterThanOrEqual(2);
	expect(offences).toEqual([]);
});

test('a route page block that caps its width also centres it under the app-shell', () => {
	// THE BUG THIS EXISTS FOR (issue #145). The layout mounts each route's page block as a direct child
	// of `.app-shell` (routes/+layout.svelte:12), which is a `display:flex; flex-direction:column;
	// margin:0 auto` centred column. A flex item that sets a `max-width` but no inline auto margin is
	// laid out at the cross-axis START, so the cap takes width off the RIGHT only and the block hangs to
	// the LEFT of a shell whose whole job is to centre. /stats sat 187px left of centre at 1440px with a
	// 360px void beside it; /metrics and /metrics/[mediaId] the same. The repo had already decided this
	// twice — settings `main` and join `.join-main` both cap AND `margin:0 auto` — so this pins the rule
	// for every route root: cap your width if you like, but re-centre it. `width:100%` matters alongside
	// the margin because on a flex item a bare auto inline margin removes the stretch and collapses the
	// block to content width; the guard requires the auto margin (the placement fix) and the presence of
	// the cap is what arms it.
	const ROUTES = join(SRC, 'routes');
	const offences: string[] = [];
	let checked = 0;
	for (const f of svelteFiles(ROUTES)) {
		if (!f.endsWith('+page.svelte')) continue;
		const raw = readFileSync(f, 'utf8');
		// The route's page block is the first top-level element in the template that carries a class —
		// it becomes the direct .app-shell child. Look only at markup BEFORE the <style> block.
		const styleAt = raw.indexOf('<style');
		const markup = styleAt === -1 ? raw : raw.slice(0, styleAt);
		const rootClassMatch = markup.match(/<(?:section|main|div|article)\b[^>]*\sclass="([a-z][a-z0-9-]*)/i);
		if (!rootClassMatch) continue; // a route with no single classed root block (e.g. plain <slot>) is out of scope
		const rootClass = rootClassMatch[1]!;
		const css = stripComments(raw);
		// The rule for that class, at any nesting; take the FIRST base declaration block for the selector.
		const rule = css.match(new RegExp(`\\.${rootClass}\\s*\\{([^}]*)\\}`));
		if (!rule) continue;
		const body = rule[1]!;
		const capsWidth = /(^|[;{\s])max-width:\s*\d/.test(body);
		if (!capsWidth) continue; // no cap -> nothing to re-centre; this page fills the shell
		checked++;
		const autoMargin =
			/margin(-inline)?:\s*[^;]*\bauto\b/.test(body) ||
			/margin-inline-(start|end):\s*auto/.test(body) ||
			/margin-(left|right):\s*auto/.test(body);
		if (!autoMargin) {
			offences.push(
				`${f.replace(SRC, 'src')}: .${rootClass} caps its width (max-width) but sets no inline auto margin, so it hangs left of the centred .app-shell — add margin-inline:auto (with width:100% to keep the stretch)`
			);
		}
	}
	// The rule must actually be exercising something, or a refactor of the routes would silently disarm it.
	// The three dashboards plus the two precedents (settings, join) all cap-and-centre.
	expect(checked).toBeGreaterThanOrEqual(3);
	expect(offences).toEqual([]);
});
