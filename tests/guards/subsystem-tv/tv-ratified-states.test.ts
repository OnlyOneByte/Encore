// guard: the ratified TV states hold their load-bearing invariants — the ones a green
// suite otherwise cannot see and that a still screenshot cannot prove.
//
// Source scans over the TV route + app.css, in the same shape as stage-scale.test.ts / motion.test.ts.
// The RENDERED-geometry claims (identical left-column bounds across phrases, 12-guest no-overflow) are
// XR-TV-19's job and live in the measured gate; these pin the structural preconditions that make those
// claims true, and mutation-red on the specific hunk each names.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appSrc } from '@encore/test-support';

// `src`, named rather than counted: this was `at('src')`,
// which is only that directory from inside routes/tv/. Both reads below hang off it.
const SRC = appSrc;
const ROUTE = readFileSync(join(SRC, 'routes', 'tv', '+page.svelte'), 'utf8');
const APP_CSS = readFileSync(join(SRC, 'app.css'), 'utf8');

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

/** The numeric rem value of a `--tv-*` type token declared in app.css, or null if absent/not rem. */
function tvRem(token: string): number | null {
	const decl = new RegExp(`${token}:\\s*([^;]+);`).exec(stripComments(APP_CSS));
	if (!decl) return null;
	const rem = /^([0-9.]+)rem$/.exec(decl[1]!.trim());
	return rem ? Number(rem[1]) : null;
}

test('XR-TV: the room code is the largest type element on the attract screen', () => {
	// The code is what a guest transcribes, so it MUST out-size everything else on that screen. Compare
	// the actual token values: --tv-code against every other type tier the attract panel renders.
	const code = tvRem('--tv-code');
	expect(code, '--tv-code must be a rem token').not.toBeNull();
	// The other type tokens ACTUALLY rendered on the attract screen: the wordmark + phrase label AND the
	// typed join URL all use --tv-name (the URL sits at the mockup's 44px budget so it never breaks
	// mid-token — XR-TV-19), the rotating phrase is --tv-phrase, the "Go to"/"or scan" steps are
	// --tv-body / --tv-small. NOT --tv-joinurl (nothing on the attract renders it any more — see the
	// jt-url assertion below), and NOT --tv-hero / --tv-takeover-name (those are the takeover screens,
	// which the attract never renders).
	for (const other of ['--tv-phrase', '--tv-name', '--tv-body', '--tv-small']) {
		const v = tvRem(other);
		expect(v, `${other} must be a rem token`).not.toBeNull();
		expect(code!, `--tv-code (${code}) must exceed ${other} (${v})`).toBeGreaterThan(v!);
	}
	// And the markup must actually render the code in the --tv-code tier (jt-code), or the token
	// ordering guards nothing.
	const clean = stripComments(ROUTE);
	const jtCode = /\.jt-code\s*\{([^}]*)\}/.exec(clean)?.[1] ?? '';
	expect(jtCode).not.toBe('');
	expect(jtCode).toContain('font-size: var(--tv-code)');
	expect(clean).toContain('class="jt-code"');
	// And the join URL must actually render in the --tv-name (44px) tier, NOT the 88px --tv-joinurl one
	// (XR-TV-19). Ordering alone cannot see this — both 44px and 88px are smaller than the code — so pin
	// the RENDERED tier here: reverting `.jt-url` back to var(--tv-joinurl) (the mid-token-break
	// regression) reds this assertion. Mirrors the jt-code shape above: "the markup must actually render
	// … or the token ordering guards nothing."
	const jtUrl = /\.jt-url\s*\{([^}]*)\}/.exec(clean)?.[1] ?? '';
	expect(jtUrl).not.toBe('');
	expect(jtUrl).toContain('font-size: var(--tv-name)');
	// …and it carries NO viewport/overflow-wrap escape hatch that would let a long address break: an
	// address is one unbreakable token, so shrinking (44px) is the only lever, not wrapping.
	expect(jtUrl).not.toContain('overflow-wrap');
	expect(clean).toContain('class="jt-url"');
});

test('XR-TV-16: the attract phrase system is wired to the pure phrase module, not a hand-written cycle', () => {
	const clean = stripComments(ROUTE);
	// The set and the bag come from the guarded pure module (phrases.ts), so the ≤24-char rule and the
	// no-repeat bag are enforced at the data layer rather than re-implemented in the component.
	expect(clean).toContain("from '$lib/tv/phrases'");
	expect(clean).toContain('makePhraseBag');
	expect(clean).toContain('reducedMotionPhrase');
});

test('XR-TV-05/17: the phrase crossfade is a CSS animation gated on prefers-reduced-motion, never a Svelte transition', () => {
	const clean = stripComments(ROUTE);
	// The crossfade must be a CSS @keyframes on OPACITY, applied only inside a no-preference @media.
	expect(/@keyframes\s+phrase-fade\s*\{[^}]*opacity/.test(clean)).toBe(true);
	// The animation is applied ONLY under (prefers-reduced-motion: no-preference), so reduce holds still.
	const noPref = /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{([\s\S]*?)\n\t\}/.exec(clean)?.[1] ?? '';
	expect(noPref, 'a no-preference @media block gating the phrase animation must exist').not.toBe('');
	expect(/\.phrase-line\s*\{[^}]*animation:\s*phrase-fade/.test(noPref)).toBe(true);
	// And the animation must NOT sit outside that gate (which would run it under reduce).
	const outsideMedia = clean.replace(/@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{[\s\S]*?\n\t\}/g, '');
	expect(/animation:\s*phrase-fade/.test(outsideMedia)).toBe(false);
	// The JS clock must also gate on the preference: under reduce it holds one phrase (no setInterval).
	expect(clean).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
	expect(/if\s*\(prefersReducedMotion\)\s*\{[\s\S]*?reducedMotionPhrase/.test(clean)).toBe(true);
});

test('XR-TV-05/17: no Svelte transition/in/out/animate directive drives the phrase (motion.test.ts also bans these globally)', () => {
	// A targeted restatement scoped to the attract markup: the phrase must remount via {#key} + CSS,
	// never a Svelte transition directive, because that runtime ignores prefers-reduced-motion.
	const clean = stripComments(ROUTE);
	// The {#key} remount is what replays the CSS animation on each tick.
	expect(/\{#key\s+attractPhrase\}/.test(clean)).toBe(true);
	// No motion directive anywhere near the phrase line.
	expect(/transition:[a-z]/.test(clean)).toBe(false);
	expect(/\b(in|out|animate):(fade|fly|slide|scale|blur)/.test(clean)).toBe(false);
});

test('XR-TV-13: the join block survives every takeover, dimmed to 72%, in the bottom-right slot', () => {
	const clean = stripComments(ROUTE);
	// The takeover join block renders whenever a transient is up, wrapping the SAME corner JoinBadge the
	// playing state uses (so the slot does not move), dimmed to 0.72.
	expect(/\{#if transient\}[\s\S]*?class="takeover-join"[\s\S]*?<JoinBadge[^>]*placement="corner"/.test(clean)).toBe(
		true
	);
	const joinBlock = /\.takeover-join\s*\{([^}]*)\}/.exec(clean)?.[1] ?? '';
	expect(joinBlock).not.toBe('');
	expect(/opacity:\s*0\.72/.test(joinBlock)).toBe(true);
});

test('XR-TV-11: each takeover owns one colour family, drawn as a family-coloured left border', () => {
	const clean = stripComments(ROUTE);
	// One family each: accent (next), warn (processing), danger (skip) — the border colour is the carrier,
	// and it differs per state so the three cannot be confused.
	const families = {
		'.state-next.takeover': 'var(--accent)',
		'.state-waiting.takeover': 'var(--warn)',
		'.state-error.takeover': 'var(--danger)'
	} as const;
	const seen = new Set<string>();
	for (const [sel, family] of Object.entries(families)) {
		const block = new RegExp(`${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`).exec(clean)?.[1] ?? '';
		expect(block, `${sel} rule`).not.toBe('');
		expect(block).toContain(`border-left-color: ${family}`);
		seen.add(family);
	}
	// three distinct families, so colour is a real discriminator
	expect(seen.size).toBe(3);
	// the retired --accent-strong (XR-COL-11) must not have crept back in
	expect(clean).not.toContain('--accent-strong');
	// the takeover border width is one shared token
	expect(/border-left:\s*var\(--tv-takeover-border\)\s*solid/.test(clean)).toBe(true);
});

test('XR-TV: the next-up takeover makes the singer the 132px hero', () => {
	const clean = stripComments(ROUTE);
	// The singer name is the hero (--tv-takeover-name, 132px), above the ordinary takeover hero.
	expect(/\.hero-name\s*\{[^}]*font-size:\s*var\(--tv-takeover-name\)/.test(clean)).toBe(true);
	expect(tvRem('--tv-takeover-name')).toBeGreaterThan(tvRem('--tv-hero')!);
	// and the markup applies it to the singer name on the next-up takeover
	expect(/class="up-name hero-name"/.test(clean)).toBe(true);
});
