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

test('every bottom-docked sheet caps its height in dvh, not vh', () => {
	// `.sheet-surface` in app.css deliberately does NOT default a max-height, because the two sheets
	// genuinely want different caps (88dvh modal, 82dvh dock) and a default neither uses is dead code
	// pretending to be a policy. But the UNIT is not a preference: on iOS `vh` resolves to the LARGE
	// viewport, so a sheet capped in vh overflows the visible area whenever the URL bar is showing and
	// hides its own footer -- the Save button on one, the rotation's last row on the other. So the cap
	// stays with each sheet and the unit is asserted here.
	for (const f of ['lib/components/QueueSheet.svelte', 'lib/components/ProfileSheet.svelte']) {
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
