// The "Join QR unavailable" card, pinned so it stays prose and not a QR-shaped column (#62).
//
// THE BUG. This is the first-run failure message (role="alert"), read across a room by an operator who
// is already confused, so its legibility carries more weight than a normal layout nit. It rendered as
// a column roughly two words wide: `.badqr.hero` was capped at `max-width: 34ch`, and `ch` resolves
// against the ELEMENT's own font-size, which inherits from :root at 16px — so the card stayed ~346px
// on a 4K wall while the type inside scaled via the vh/vmin-based --tv-* clamps. Prose was being forced
// into a QR square. Inside that column the advertised address (a long unbreakable-ish token) then
// filled its line and the trailing ", which phones can't reach." clause started a new line with a
// leading comma — an orphaned comma the issue title names directly.
//
// THE FIX, pinned here:
//   1. The hero card is sized on the same vmin axis the TV type rides (a clamp with a viewport term),
//      never a fixed `ch`/`px` column, so it grows with the wall.
//   2. The advertised address is a BLOCK on its own line, so the sentence never wraps around it and no
//      trailing clause can orphan its comma.
//
// No DOM in bun test (see contract.test.ts) — this is a source scan over the component's own CSS/markup.
// The rendered proof (before/after frames at 1920x1080) is in the PR body.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(import.meta.dir, 'JoinBadge.svelte'), 'utf8');

/** Blank comments so a commented-out declaration cannot satisfy an assertion. */
function stripComments(s: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return s.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

/** The declarations inside one scoped rule `.sel { ... }` (no nested braces in this file's rules). */
function ruleBody(css: string, sel: string): string {
	const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`);
	return re.exec(css)?.[1] ?? '';
}

const CSS = stripComments(SRC);

test('the unreachable hero card is sized on a viewport axis, never a fixed ch/px column', () => {
	const body = ruleBody(CSS, '.badqr.hero');
	expect(body).not.toBe('');
	const mw = /max-width:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? '';
	// The old two-words-wide column was `34ch` — a fixed width that never grew with the TV type.
	expect(mw).not.toMatch(/\bch\b/); // no ch-resolved-against-16px column
	// Must scale with the wall: a clamp carrying a viewport unit (vmin/vw/vh).
	expect(mw).toMatch(/clamp\(/);
	expect(mw).toMatch(/\d\s*(vmin|vw|vh)/);
});

test('the advertised address is a block on its own line so the sentence cannot orphan its comma', () => {
	// Markup: the address sits in its own element, not inline mid-sentence.
	expect(SRC).toMatch(/class="badqr-addr"/);
	// CSS: that element is block-level, which is what forces it onto its own line.
	const addr = ruleBody(CSS, '.badqr-addr');
	expect(addr).toMatch(/display:\s*block/);
	// A long address still has to fit the card rather than push it wide.
	expect(addr).toMatch(/overflow-wrap:\s*anywhere/);
});

test('the unreachable sentence no longer wraps a clause around the address (no orphan-comma shape)', () => {
	// The failure shape was `<b>{shortUrl}</b>, which phones can't reach.` — the address inline, a comma
	// immediately after the closing tag. Pin that that exact inline shape is gone.
	expect(SRC).not.toMatch(/<\/b>\s*,\s*which/);
});
