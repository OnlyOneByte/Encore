// guard: the ratified TV states hold their load-bearing invariants — the ones a green suite otherwise
// cannot see and that a still screenshot cannot prove. The rendered-geometry claims (identical left-column
// bounds across phrases, 12-guest no-overflow) live in the measured gate; these pin the structural
// preconditions that make those claims true.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { srcDir } from '@encore/test-support';

const SRC = srcDir;
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
	// The code is what a guest transcribes, so it MUST out-size everything else on that screen.
	const code = tvRem('--tv-code');
	expect(code, '--tv-code must be a rem token').not.toBeNull();
	// Exactly the tiers the attract panel ACTUALLY renders: the wordmark, phrase label and typed join URL
	// all use --tv-name, the rotating phrase --tv-phrase, the step lines --tv-body / --tv-small. NOT
	// --tv-joinurl (nothing on attract renders it) and NOT --tv-hero / --tv-takeover-name (takeover only).
	for (const other of ['--tv-phrase', '--tv-name', '--tv-body', '--tv-small']) {
		const v = tvRem(other);
		expect(v, `${other} must be a rem token`).not.toBeNull();
		expect(code!, `--tv-code (${code}) must exceed ${other} (${v})`).toBeGreaterThan(v!);
	}
	// The markup must actually render the code in that tier, or the token ordering guards nothing.
	const clean = stripComments(ROUTE);
	const jtCode = /\.jt-code\s*\{([^}]*)\}/.exec(clean)?.[1] ?? '';
	expect(jtCode).not.toBe('');
	expect(jtCode).toContain('font-size: var(--tv-code)');
	expect(clean).toContain('class="jt-code"');
	// The join URL renders in the 44px --tv-name tier, not the 88px --tv-joinurl one that broke it
	// mid-token. Ordering alone cannot see this — both are smaller than the code — so the RENDERED tier is
	// pinned here.
	const jtUrl = /\.jt-url\s*\{([^}]*)\}/.exec(clean)?.[1] ?? '';
	expect(jtUrl).not.toBe('');
	expect(jtUrl).toContain('font-size: var(--tv-name)');
	// And no viewport/overflow-wrap escape hatch: an address is one unbreakable token, so shrinking is the
	// only lever, never wrapping.
	expect(jtUrl).not.toContain('overflow-wrap');
	expect(clean).toContain('class="jt-url"');
});

test('the attract phrase system is wired to the pure phrase module, not a hand-written cycle', () => {
	const clean = stripComments(ROUTE);
	// The set and the bag come from the guarded pure module, so the ≤24-char rule and the no-repeat bag are
	// enforced at the data layer rather than re-implemented in the component.
	expect(clean).toContain("from '$lib/tv/phrases'");
	expect(clean).toContain('makePhraseBag');
	expect(clean).toContain('reducedMotionPhrase');
});

test('the phrase crossfade is a CSS animation gated on prefers-reduced-motion, never a Svelte transition', () => {
	const clean = stripComments(ROUTE);
	expect(/@keyframes\s+phrase-fade\s*\{[^}]*opacity/.test(clean)).toBe(true);
	// Applied ONLY under (prefers-reduced-motion: no-preference), so reduce holds still.
	const noPref = /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{([\s\S]*?)\n\t\}/.exec(clean)?.[1] ?? '';
	expect(noPref, 'a no-preference @media block gating the phrase animation must exist').not.toBe('');
	expect(/\.phrase-line\s*\{[^}]*animation:\s*phrase-fade/.test(noPref)).toBe(true);
	// And it must NOT also sit outside that gate, which would run it under reduce.
	const outsideMedia = clean.replace(/@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{[\s\S]*?\n\t\}/g, '');
	expect(/animation:\s*phrase-fade/.test(outsideMedia)).toBe(false);
	// The JS clock gates on the preference too: under reduce it holds one phrase, with no setInterval.
	expect(clean).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
	expect(/if\s*\(prefersReducedMotion\)\s*\{[\s\S]*?reducedMotionPhrase/.test(clean)).toBe(true);
});

test('no Svelte transition/in/out/animate directive drives the phrase (motion.test.ts also bans these globally)', () => {
	// A targeted restatement scoped to the attract markup: the Svelte transition runtime ignores
	// prefers-reduced-motion, so the phrase must remount via {#key} + CSS instead.
	const clean = stripComments(ROUTE);
	expect(/\{#key\s+attractPhrase\}/.test(clean)).toBe(true);
	expect(/transition:[a-z]/.test(clean)).toBe(false);
	expect(/\b(in|out|animate):(fade|fly|slide|scale|blur)/.test(clean)).toBe(false);
});

test('the join block survives every takeover, dimmed to 72%, in the bottom-right slot', () => {
	const clean = stripComments(ROUTE);
	// It wraps the SAME corner JoinBadge the playing state uses, so the slot does not move.
	expect(/\{#if transient\}[\s\S]*?class="takeover-join"[\s\S]*?<JoinBadge[^>]*placement="corner"/.test(clean)).toBe(
		true
	);
	const joinBlock = /\.takeover-join\s*\{([^}]*)\}/.exec(clean)?.[1] ?? '';
	expect(joinBlock).not.toBe('');
	expect(/opacity:\s*0\.72/.test(joinBlock)).toBe(true);
});

test('each takeover owns one colour family, drawn as a family-coloured left border', () => {
	const clean = stripComments(ROUTE);
	// The border colour is the carrier, and it must differ per state so the three cannot be confused.
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
	expect(seen.size).toBe(3); // three distinct families, so colour is a real discriminator
	expect(clean).not.toContain('--accent-strong'); // the retired token must not creep back in
	expect(/border-left:\s*var\(--tv-takeover-border\)\s*solid/.test(clean)).toBe(true); // one shared width token
});

test('XR-TV: the next-up takeover makes the singer the 132px hero', () => {
	const clean = stripComments(ROUTE);
	// The singer name outsizes the ordinary takeover hero, and the markup applies it to that name.
	expect(/\.hero-name\s*\{[^}]*font-size:\s*var\(--tv-takeover-name\)/.test(clean)).toBe(true);
	expect(tvRem('--tv-takeover-name')).toBeGreaterThan(tvRem('--tv-hero')!);
	expect(/class="up-name hero-name"/.test(clean)).toBe(true);
});
