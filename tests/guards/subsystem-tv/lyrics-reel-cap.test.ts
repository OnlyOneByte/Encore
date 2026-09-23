// Guard: the lyrics reel's max-height cap must NOT double-charge the safe-area inset.
//
// Caught: `.lyrics` already reserves the bottom chrome band via `top: 0; bottom: var(--tv-chrome-h)`, so the
// reel box is already `100vh - --tv-chrome-h` tall — and the `.viewport` cap then subtracted a FURTHER
// `- var(--tv-safe-y)` from `100vh`. Because that box is `justify-content: center`, the extra subtraction
// bought only `--tv-safe-y / 2` of top inset while removing a full `--tv-safe-y` of reel height, and
// `--tv-chrome-h` is itself `calc(--tv-safe-y + …)` in app.css, so the top mirror it paid for was already
// inside the band. The second lookahead row was hard-masked mid-glyph with unused height beneath it.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '@encore/test-support';

const OVERLAY = at('src/lib/tv/LyricsOverlay.svelte');

/** Blank comments out, keeping newlines so reported line numbers stay true (matches lyrics-clamp). */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/(^|[^:'"\\`])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
}

const raw = readFileSync(OVERLAY, 'utf8');
const src = stripComments(raw);

test('the .viewport max-height cap equals the parent chrome band, with no extra safe-y subtraction', () => {
	// One max-height on the reel viewport; capture its calc() expression.
	const caps = [...src.matchAll(/max-height:\s*(calc\([^;]*\))\s*;/g)].map((m) => m[1]!.trim());
	expect(caps.length).toBe(1);
	const cap = caps[0]!.replace(/\s+/g, ' ');

	expect(cap).toContain('100vh');
	expect(cap).toContain('var(--tv-chrome-h)');
	// The band already contains one `--tv-safe-y`; a second one here clips the reel.
	expect(cap).not.toContain('--tv-safe-y');
	// Pinned exactly: the band and nothing more.
	expect(cap).toBe('calc(100vh - var(--tv-chrome-h))');
});

test('the corrected comment no longer claims the cap is inactive at the defaults', () => {
	// The false clause (the reel is "unaffected" at the default five rows) is what misleads the next editor,
	// so it must be gone — and asserting only its absence would let the prose degrade to saying nothing, so
	// the accurate claim is required too. Matched on the SHORT form rather than a sentence, so rewording the
	// comment does not red this for a reason unrelated to the claim.
	expect(raw).not.toContain('so the reel is unaffected');
	expect(raw).not.toMatch(/well under this cap/);
	expect(raw, 'the cap comment must still say the cap applies at the default row count').toMatch(
		/(active|bites?|applies|clips)\b[^.\n]{0,40}default/i
	);
});

test('the --lyrics-scale render folds in LYRICS_SCALE_BASE (the 80-is-the-new-100 rebase)', () => {
	// `--lyrics-scale` must be (scalePct / 100) * the shared base factor, not the bare division. Read the
	// ACTUAL expression from production source, with no helper indirection, so reverting the fold reds here.
	// The neutral-point numbers themselves are pinned in $lib/contract.
	const m = src.match(/--lyrics-scale:\s*\$\{([^}]*)\}/);
	expect(m).not.toBeNull();
	const expr = m![1]!.replace(/\s+/g, ' ').trim();
	expect(expr).toContain('LYRICS_SCALE_BASE');
	expect(expr).toContain('scalePct / 100');
	expect(expr).toContain('*');
	expect(expr).not.toBe('scalePct / 100');
	// The constant is actually imported, so the fold is live rather than a dangling reference.
	expect(src).toMatch(/import[\s\S]*?LYRICS_SCALE_BASE[\s\S]*?from '\$lib\/contract'/);
});
