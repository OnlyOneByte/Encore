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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { svelteFiles } from './test-helpers';

const SRC = join(import.meta.dir, '..');
// Read app.css comment-stripped: the `defined`-token set and the palette are built from this text and
// compared against comment-stripped component source, so a token or colour that exists only inside a
// comment in app.css must NOT count as real (issue #453 -- the asymmetric-stripping hole).
const css = stripComments(readFileSync(join(SRC, 'app.css'), 'utf8'));

/** Every .svelte under src, recursively. */

/**
 * Strip comments before scanning. A comment explaining WHY a literal was kept must not itself trip
 * the guard -- that would punish the documentation the rest of this codebase relies on.
 *
 * BLANK comments (replace their non-newline characters with spaces) rather than DELETE them, so the
 * byte offsets lineOf reports stay true -- a delete shifted every reported file:line after the first
 * comment. Also strip // line comments, sparing https://: without it a `// var(--x)` line was read
 * as live source, so a token that existed only inside a comment satisfied "is defined" and a
 * commented-out declaration could hide the --warn-bg transparent-banner defect this file's own header
 * names. Mirrors ui/icons.test.ts, stage-scale.test.ts, gates.test.ts, contract.test.ts.
 */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank) // markup comments
		.replace(/\/\*[\s\S]*?\*\//g, blank) // block comments, in <script> and <style>
		.replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length))); // line comments, sparing https://
}

function lineOf(src: string, index: number): number {
	return src.slice(0, index).split('\n').length;
}

/** #abc and #AABBCC normalise to the same key so a shade match cannot hide behind formatting. */
function normaliseHex(hex: string): string {
	let h = hex.replace('#', '').toLowerCase();
	if (h.length === 3)
		h = h
			.split('')
			.map((c) => c + c)
			.join('');
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

/**
 * The full guest-visible .svelte surface, computed ONCE. Every scan below iterates it; a
 * `.filter(bad).toEqual([])` / `missing.toEqual([])` scan passes vacuously if the walk returns
 * nothing, so pin a floor here (issue #453). If a refactor moves files out of src/, this reds
 * loudly instead of silently guarding nothing. 25 files today; floor well below that.
 */
const FILES = svelteFiles(SRC);
test('the design-system scan actually reads the component surface', () => {
	expect(FILES.length).toBeGreaterThan(15);
});

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

	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
			const hex = normaliseHex(m[0]);
			if (UNIVERSAL.has(hex)) continue;
			if (SVG_PAINT.test(src.slice(Math.max(0, m.index! - 14), m.index!))) continue;
			const tokenName = known.get(hex);
			if (!tokenName) continue;
			offences.push(`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: ${m[0]} is var(--${tokenName})`);
		}
	}

	expect(offences).toEqual([]);
});

test('no component hard-codes an rgb()/rgba() colour the palette already owns', () => {
	// SIBLING of the #hex scan above, for the rgb()/rgba() FORM. The hex scan is blind to functional
	// notation, which is exactly how the attract-screen fade drifted: `linear-gradient(..., rgba(3,3,8,
	// 0.9), ...)` in tv/+page.svelte duplicates `--bg` (#0b0b12 fades to a different black than its twin
	// TvLobby fade, which was converted to color-mix(var(--bg)) for this reason) while the #hex guard
	// never sees it. This scan owns the rgb()/rgba() form: a literal whose R,G,B equals a palette
	// token's is an offence regardless of its alpha (the alpha is a fade depth, the RGB is the colour
	// that must track the theme). Comment-stripped source only, same as the hex scan.
	const byRgb = new Map<string, string>();
	for (const [hex, name] of palette()) {
		const h = hex.slice(1);
		const r = parseInt(h.slice(0, 2), 16);
		const g = parseInt(h.slice(2, 4), 16);
		const b = parseInt(h.slice(4, 6), 16);
		byRgb.set(`${r},${g},${b}`, name);
	}
	expect(byRgb.size).toBeGreaterThan(10);
	// #ffffff / #000000 are universal (see the hex scan); rgb(255,255,255)/rgb(0,0,0) are not owned.
	const UNIVERSAL_RGB = new Set(['255,255,255', '0,0,0']);
	const offences: string[] = [];
	const RGB_RE = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,[^)]*)?\)/g;
	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		for (const m of src.matchAll(RGB_RE)) {
			const key = `${Number(m[1])},${Number(m[2])},${Number(m[3])}`;
			if (UNIVERSAL_RGB.has(key)) continue;
			const tokenName = byRgb.get(key);
			if (!tokenName) continue;
			offences.push(
				`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: ${m[0]} duplicates var(--${tokenName}); use color-mix(in srgb, var(--${tokenName}) ...) so it tracks the theme`
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

	for (const f of FILES) {
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

test('the colour picker anchors arrow movement on nextSwatchIndex, not a bare indexOf', () => {
	// THE BUG THIS BOUNDS (#215). The tab stop reads presetTabStopIndex (falls back to swatch 0 for a
	// wheel value), but the arrow-key handler used to compute its base from a bare
	// `(SINGER_COLORS as ...).indexOf(value)`, which is -1 for any wheel hex. After a hue pick the two
	// disagreed: focus sat on swatch 0 while movement started from -1, so the first ArrowRight did not
	// move and ArrowLeft skipped mint. nextSwatchIndex in @encore/shared shares presetTabStopIndex's
	// anchor and is unit-tested there -- but that closes only the helper; the handler is a Svelte
	// script line the helper tests never exercise. This pins the call site so it cannot revert to the
	// bare-indexOf base while the helper stays correct, mirroring the tab-stop wiring guard above.
	const picker = stripComments(readFileSync(join(SRC, 'lib/components/ColourPicker.svelte'), 'utf8'));
	// It must IMPORT the shared helper (reverting the import alone leaves a call to an unimported
	// symbol — a build break bun test does not see, so the import must be pinned here too)...
	expect(picker).toMatch(/import \{[^}]*\bnextSwatchIndex\b[^}]*\} from '@encore\/shared';/);
	// ...and the arrow handler must derive `next` from that helper...
	expect(picker).toMatch(/const next = nextSwatchIndex\(value, step\);/);
	// ...and must NOT reintroduce the divergent bare-indexOf arrow base (the #215 defect). Comments are
	// stripped first, so the rationale prose above cannot satisfy or trip this.
	expect(picker).not.toMatch(/indexOf\(value\)/);
});

test('every bottom-docked sheet caps its height in dvh, not vh', () => {
	/*
	 * RECORDED RULING FOR THE QUEUESHEET DRAWER PORT (#827)
	 *
	 * This assertion and the `.peek` env() one below are the two guards a vaul/shadcn drawer port takes
	 * out of scope, and the ruling was made BEFORE the port rather than in the review that meets the red.
	 *
	 * Why they go: shadcn's drawer copies 12 files with zero `<style>` blocks, so a ported QueueSheet has
	 * no scoped `<style>` for either scan to read — the real CSS is a `<style global>` inside
	 * `node_modules/vaul-svelte`, which `test-helpers.ts`'s SKIP_DIRS skips by name, and the sheet's
	 * offset is an inline `transform` written from JS (`use-snap-points.svelte.js:44-54`) that outranks
	 * any rule either way. Both assertions fail LOUDLY, which is the good case: `caps.length > 0` here and
	 * the non-null `.peek` match below cannot pass vacuously.
	 *
	 * RULING: RE-ANCHOR, DO NOT DELETE. The #827 spike measured all four incumbent numbers holding on the
	 * port — 82dvh = 692.08px at 844, `.peek` 44/10 and `.body` 54/20 across a 34px inset, `--peek-h` the
	 * measured inline write beating `@media (max-height: 480px)` — so the values are still true and still
	 * worth pinning; only their ADDRESS changes. Re-point both at whatever file the port's CSS lives in
	 * (its own `:global` block, or the copied `ui/drawer/` component), and keep the loop's list shape so
	 * the next sheet still has to comply. Deleting either one launders a real design floor away under
	 * cover of a refactor. Do not use RETIRED for this: nothing here is being given up.
	 */
	// `.sheet-surface` in app.css deliberately does NOT default a max-height, because a sheet's cap is
	// its own business. But the UNIT is not a preference: on iOS `vh` resolves to the LARGE viewport, so
	// a sheet capped in vh overflows the visible area whenever the URL bar is showing and hides its own
	// footer -- which was the rotation's last row here, and the Save button on the profile sheet before
	// identity moved to /settings and that sheet was retired. The cap stays with each sheet and the unit
	// is asserted here. One entry in this list today; it is a list because the next sheet must comply.
	for (const f of ['lib/components/QueueSheet.svelte', 'lib/components/QueueSheetDrawer.svelte']) {
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

	for (const f of FILES) {
		const src = readFileSync(f, 'utf8');
		let depth = 0;
		let line = 1;
		for (let i = 0; i < src.length;) {
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

	for (const f of FILES) {
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
				offences.push(`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: ${sel.trim()} is ${fs[1]}${unit} (${px}px)`);
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

test('both documentElement custom-property writes (--peek-h, --undo-h) tear down on unmount (#460 §14/§17)', () => {
	// THE BUG THIS EXISTS FOR (#460 sec.14). QueueSheet writes `--peek-h` onto documentElement in an
	// $effect but returned no cleanup, so the inline property OUTLIVED the component on the root element
	// and kept beating the `@media (height <= 480px)` rule after the sheet unmounted. A documentElement
	// custom-property write is app-global mutable state; leaving it set is a leak. Source scan because
	// bun:test has no DOM to mount-and-unmount; comments stripped so the rationale prose cannot satisfy
	// or trip it. Reverting the $effect teardown reds this.
	//
	// SCOPE: both documentElement custom-property writes the audit named. QueueSheet's --peek-h was
	// fixed in #598; routes/+page.svelte's --undo-h carried the SAME leak shape (a setProperty $effect
	// with no cleanup, skewing the --error-dock stack after the route unmounts) and is fixed + pinned
	// here in the #460 tail (§17). Each site must both WRITE its property and RETURN a cleanup that
	// removeProperty's it; reverting either teardown reds this.
	const sites: Array<{ file: string; prop: string }> = [
		{ file: 'lib/components/QueueSheet.svelte', prop: '--peek-h' },
		{ file: 'routes/+page.svelte', prop: '--undo-h' },
		// #832: the docked primary button's measured band height, the same leak shape on a third site.
		{ file: 'routes/+page.svelte', prop: '--dock-h' }
	];
	for (const { file, prop } of sites) {
		const src = stripComments(readFileSync(join(SRC, file), 'utf8'));
		const setRe = new RegExp(`documentElement\\.style\\.setProperty\\(\\s*['"]${prop}['"]`);
		const removeRe = new RegExp(`removeProperty\\(\\s*['"]${prop}['"]\\s*\\)`);
		expect(src.match(setRe), `${file} must still be the writer of ${prop}`).not.toBeNull();
		expect(src, `the ${prop} $effect in ${file} must return a cleanup that removeProperty(${prop}) on unmount`).toMatch(
			removeRe
		);
	}
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

	// The dot and the gear must stay unshrinkable so the tap target and the colour dot survive.
	const dot = page.match(/\.me-dot\s*\{([^}]*)\}/);
	expect(dot![1]!).toMatch(/flex:\s*0 0 auto/);
	const gear = page.match(/\.gear\s*\{([^}]*)\}/);
	// var(--tap), not the number: touch-targets.test.ts owns the spelling rule (#831) and this pin must
	// not be the one place a bare literal still satisfies a guard.
	expect(gear![1]!).toMatch(/min-width:\s*var\(--tap\)/);
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
	for (const f of FILES) {
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
	for (const f of FILES) {
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

test('a keydown handler that preventDefault()s on a snippet host early-returns on foreign targets (#301)', () => {
	// THE BUG THIS EXISTS FOR (#301). QueueSheet's `.peek` is `role="button"` + `tabindex="0"` and
	// RENDERS the transport snippet (`controls`) inside itself — the three real <button>s (restart /
	// play-pause / skip) are the app's only transport. The peek's onkeydown handled Enter/Space/arrows
	// with an unconditional `e.preventDefault()`, so a keypress that BUBBLED UP from a focused transport
	// button was cancelled and toggled the sheet instead of activating the button. A keyboard, switch,
	// or Bluetooth-keyboard guest could reach the transport but never fire it.
	//
	// The pointer path already guards its target at onPointerDown (`closest('button.no-drag')`); the
	// keydown path had no equivalent. The fix mirrors it with an IDENTITY test — `if (e.target !==
	// e.currentTarget) return;` — which the issue prescribes over a class test because the peek only
	// ever wants keys it originated itself, and an identity check cannot rot when a caller forgets a
	// class. This is a source scan: bun:test has no layout/event engine, the e2e probes are unwired
	// live scripts, and the issue's own mutation signal is "restore :109-112 to the unconditional form
	// → red". Comments are stripped first so the rationale prose above/below cannot satisfy or trip it.
	const offences: string[] = [];
	let scanned = 0;

	for (const f of FILES) {
		const src = stripComments(readFileSync(f, 'utf8'));
		// Only the risky shape is in scope: a keydown handler whose body calls preventDefault(). A
		// handler that never cancels the event cannot swallow a nested control's activation.
		for (const m of src.matchAll(/onkeydown=\{\(?\s*(\w+)\s*\)?\s*=>\s*\{/g)) {
			const evName = m[1]!; // the event parameter's local name (e, ev, …)
			// Capture the arrow-body via a brace-depth walk from the `{` after `=>`.
			const open = src.indexOf('{', m.index! + m[0].length - 1);
			let depth = 0;
			let end = -1;
			for (let i = open; i < src.length; i++) {
				if (src[i] === '{') depth++;
				else if (src[i] === '}') {
					depth--;
					if (depth === 0) {
						end = i;
						break;
					}
				}
			}
			if (end === -1) {
				offences.push(`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: unbalanced onkeydown body`);
				continue;
			}
			// Strip // line comments from the body too: the rationale comment on the fixed handler
			// mentions preventDefault()/e.target in prose, which would otherwise skew the index checks
			// below. (design-system's stripComments only removes /* */ and <!-- -->.)
			const body = src.slice(open + 1, end).replace(/\/\/[^\n]*/g, '');
			if (!body.includes('preventDefault(')) continue; // this handler never cancels — not in scope
			scanned++;
			// The guard clause must be a target-identity early-return, and it must sit BEFORE the first
			// preventDefault() so a foreign target is dropped before anything is cancelled.
			const guardRe = new RegExp(
				`if\\s*\\(\\s*${evName}\\.target\\s*!==\\s*${evName}\\.currentTarget\\s*\\)\\s*return\\b`
			);
			const guardIdx = body.search(guardRe);
			const pdIdx = body.indexOf('preventDefault(');
			if (guardIdx === -1) {
				offences.push(
					`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: onkeydown preventDefault()s but never early-returns on ${evName}.target !== ${evName}.currentTarget — a nested control's Enter/Space is swallowed (#301)`
				);
			} else if (guardIdx > pdIdx) {
				offences.push(
					`${f.replace(SRC, 'src')}:${lineOf(src, m.index!)}: the ${evName}.target identity guard sits AFTER preventDefault() — move it first so a foreign target is dropped before the event is cancelled (#301)`
				);
			}
		}
	}

	// Non-vacuous: the QueueSheet peek is exactly such a handler, so the scan must have examined at
	// least one. If a refactor removes the last preventDefault()ing keydown this drops to 0 and the
	// assertion below fails loudly rather than passing on an empty set.
	expect(scanned).toBeGreaterThanOrEqual(1);
	expect(offences).toEqual([]);
});
