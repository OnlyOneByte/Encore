// Guard: the lyrics reel's max-height cap must NOT double-charge the safe-area inset.
//
// THE DEFECT (issue #99). `.lyrics` already reserves the bottom chrome band via
// `top: 0; bottom: var(--tv-chrome-h)`, so the reel box is already `100vh - --tv-chrome-h` tall.
// The `.viewport` cap then subtracted a FURTHER `- var(--tv-safe-y)` from `100vh`. Because that box
// is `justify-content: center`, the extra subtraction bought only `--tv-safe-y / 2` of top inset
// while removing a full `--tv-safe-y` of reel height — and `--tv-chrome-h` is itself
// `calc(--tv-safe-y + …)` (app.css), so the top mirror it paid for was already inside the band.
// Measured in a real headless Chromium at the DEFAULT five rows, the second lookahead row was cut:
// 24.2% visible at 1280×720, 66.6% at 1920×1080, hard-masked mid-glyph with unused height beneath
// it. Dropping the redundant `- var(--tv-safe-y)` restores that row to 100% at 1080p and 4K (the
// remaining 720p shortfall is the type-budget overflow — the ladder-vs-clamp choice the roadmap
// reserves for the owner — and is out of scope here).
// The rendered A/B was captured with the CDP driver and lives in the PR body + docs/shots/99/.
//
// WHY A SOURCE SCAN AND NOT A RENDER TEST. bun test has no Svelte compiler and no browser, so the
// computed cap cannot be read at runtime here — the rendered half is proven by the committed CDP
// measurement, not by this file. What this file pins is the arithmetic in the component source, and
// it is NOT mutation-blind: it reads LyricsOverlay.svelte itself, so the production declaration IS
// what it asserts — reverting the cap line to reintroduce `- var(--tv-safe-y)` fails this directly,
// with no helper indirection to be blind through. Verified both ways: with the fix this passes, with
// the `- var(--tv-safe-y)` restored it reds on the first assertion.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OVERLAY = join(import.meta.dir, 'LyricsOverlay.svelte');

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

	// It must reserve the chrome band…
	expect(cap).toContain('100vh');
	expect(cap).toContain('var(--tv-chrome-h)');

	// …and must NOT subtract a second safe-area inset — that is the double-charge issue #99 removed.
	// The band `--tv-chrome-h` already contains one `--tv-safe-y`; a second one here clips the reel.
	expect(cap).not.toContain('--tv-safe-y');

	// Pinned exactly: the band and nothing more.
	expect(cap).toBe('calc(100vh - var(--tv-chrome-h))');
});

test('the corrected comment no longer claims the cap is inactive at the defaults', () => {
	// The false clause (the reel is "unaffected" at the default five rows) is what misleads the next
	// editor. It must be gone; asserting only its absence would let the prose degrade to saying
	// nothing, so also require the accurate statement that the cap IS active at the defaults on short
	// panels. (Assert against the COMMENT text, i.e. the raw source minus the stripped body.)
	expect(raw).not.toContain('so the reel is unaffected');
	expect(raw).not.toMatch(/well under this cap/);
	expect(raw.toLowerCase()).toContain('active at the defaults');
});

test('the --lyrics-scale render folds in LYRICS_SCALE_BASE (the 80-is-the-new-100 rebase)', () => {
	// The rebase lives in the render arithmetic: --lyrics-scale must be (scalePct / 100) * the base
	// factor, not the bare scalePct / 100 it was before. Read the ACTUAL expression from production
	// source (no helper indirection), so reverting the fold reds this directly. The neutral-point
	// numbers themselves are pinned in @encore/shared (separators.test.ts).
	const m = src.match(/--lyrics-scale:\s*\$\{([^}]*)\}/);
	expect(m).not.toBeNull();
	const expr = m![1]!.replace(/\s+/g, ' ').trim();
	// It multiplies the percent by the shared base constant …
	expect(expr).toContain('LYRICS_SCALE_BASE');
	expect(expr).toContain('scalePct / 100');
	expect(expr).toContain('*');
	// … and is NOT the un-rebased bare division on its own.
	expect(expr).not.toBe('scalePct / 100');
	// The constant is actually imported, so the fold is live rather than a dangling reference.
	expect(src).toMatch(/import[\s\S]*?LYRICS_SCALE_BASE[\s\S]*?from '@encore\/shared'/);
});
