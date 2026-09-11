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
import { read } from '@encore/test-support';

const SRC = read('apps/core/src/lib/tv/JoinBadge.svelte');

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

// The CORNER placement, the one that renders mid-song while somebody is singing.
//
// THE SECOND BUG. `.corner` (`:118`) was written for the QR treatment — a QR tile beside a text block —
// and declares `display: flex; align-items: center; gap: 14px`. The unreachable ALERT reuses the
// `corner` class ONLY for its bottom-right pin (`.badqr.corner` re-declares the same
// position/right/bottom/z-index), and neither `.badqr` nor `.badqr.corner` declares a `display`. So the
// flex context leaked onto the alert and its three BLOCK children (.badqr-t / .badqr-b / .badqr-fix)
// became side-by-side flex COLUMNS in a row, squeezed by `max-width: 30vw` with no `overflow`, and the
// fix instruction — the only sentence that says how to fix the problem — was pushed outside the card and
// clipped off the screen by `.tv { overflow: hidden }`. #62's own mid-token address break reappeared here.
//
// THE FIX, pinned here: scope the QR treatment's flex rule to `.corner:not(.badqr)` so it cannot reach
// the alert, which then falls back to the default block flow and stacks its children on their own lines.
// The rendered proof (before/after A/B frames at 720p/1080p/4K, overflow 175px -> 0, fix sentence
// 55.4% -> 100% visible at 720p) is in the PR body.
test('the QR-treatment flex layout is scoped away from the unreachable alert', () => {
	// The `.corner` flex row (display:flex + align-items:center + gap) must be scoped :not(.badqr) so it
	// applies only to the QR wrapper, never to the alert that reuses the `corner` class for its pin.
	// LOAD-BEARING: no `.corner` rule that is NOT scoped `:not(.badqr)` may declare flex — an unscoped
	// `.corner { display:flex }` is exactly what leaked the row layout onto the alert. Checked first so a
	// reversion reds on THIS, the assertion that maps to the shipped defect.
	const unscopedFlex = /\.corner(?!\s*:not\()(?![\w-])[^{}]*\{[^{}]*display:\s*flex[^{}]*\}/;
	expect(CSS).not.toMatch(unscopedFlex);
	// And the scoped QR rule must still carry the flex row it needs for the QR-beside-text treatment.
	const qrCorner = ruleBody(CSS, '.corner:not(.badqr)');
	expect(qrCorner).toMatch(/display:\s*flex/);
});

test('the unreachable corner alert declares no row layout, so its parts stack', () => {
	// The alert card itself must not turn into a flex/grid ROW; block flow is what stacks the three parts.
	const badqr = ruleBody(CSS, '.badqr');
	const badqrCorner = ruleBody(CSS, '.badqr.corner');
	// If either declares a display at all it must not be flex/grid/inline-flex (any of which rows the parts).
	for (const body of [badqr, badqrCorner]) {
		const disp = /display:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? '';
		if (disp) expect(disp).not.toMatch(/flex|grid|inline-flex/);
	}
});

test('the unreachable sentence no longer wraps a clause around the address (no orphan-comma shape)', () => {
	// The failure shape was `<b>{shortUrl}</b>, which phones can't reach.` — the address inline, a comma
	// immediately after the closing tag. Pin that that exact inline shape is gone.
	expect(SRC).not.toMatch(/<\/b>\s*,\s*which/);
});
