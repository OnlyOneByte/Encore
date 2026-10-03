import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { at } from '$test';
import { contrastRatio } from '$lib/contract';

/*
 * guard: ONE queueing verb has ONE visual identity, and `--ok` states the ready STATE rather than an action.
 * A SongRow used to draw the same verb two ways — an `--accent` fill for "make karaoke" and an `iconReady`
 * `--ok` outline for "add a turn" — so a guest learned it twice and the primary action wore the row's own
 * status colour. `--ok` was additionally stated three times per ready card (card border, "Karaoke ready" pill,
 * button ring) and `/library` hard-codes `readiness="ready"` on every row, so all three were lit in 100% of
 * them. The fix collapses the action onto `iconPrimary` and leaves the row exactly one path to `--ok`, the
 * worded pill. Assertion 3 is the one that forbids the WRONG way to dim the confirmed state.
 */

const appCss = readFileSync(at('src/app.css'), 'utf8');
const songRow = readFileSync(at('src/lib/components/SongRow.svelte'), 'utf8');
const button = readFileSync(at('src/lib/components/ui/button/button.svelte'), 'utf8');

/** Pull a `--name: #hex;` declaration out of `app.css`. Throws rather than defaulting, so a renamed token
 *  reds instead of leaving the suite measuring a value nothing declares. */
function token(name: string): string {
	const m = appCss.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
	if (!m) throw new Error(`token --${name} not found in src/app.css (renamed? then update this guard)`);
	return m[1]!;
}

/** sRGB alpha compositing, the one operation `opacity` performs and `contrastRatio` cannot model: it is how
 *  assertion 3 shows that dimming the fill would have broken the boundary the fill provides. */
function over(fg: string, bg: string, alpha: number): string {
	const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
	const [f, b] = [rgb(fg), rgb(bg)];
	return (
		'#' +
		f
			.map((v, i) => Math.round(v * alpha + b[i]! * (1 - alpha)))
			.map((v) => v.toString(16).padStart(2, '0'))
			.join('')
	);
}

/** SC 1.4.11 non-text contrast, and SC 1.4.3's floor for the glyph that sits inside the fill. */
const NON_TEXT = 3;
const TEXT = 4.5;

test('the one action identity clears SC 1.4.11 on every row surface it is drawn on', () => {
	const accent = token('accent');
	// `--card` is the resting row, `--card-tint` the second stop of the processing row's gradient — the darkest
	// surface the fill is ever drawn on, so it is the binding one.
	expect(contrastRatio(accent, token('card'))).toBeGreaterThanOrEqual(NON_TEXT);
	expect(contrastRatio(accent, token('card-tint'))).toBeGreaterThanOrEqual(NON_TEXT);
	// The glyph inside the fill is TEXT-equivalent, and `--on-accent` is this stop's certified `on_fill`.
	expect(contrastRatio(token('on-accent'), accent)).toBeGreaterThanOrEqual(TEXT);
});

test('a song row reaches --ok through exactly one path, and neither the row nor the button is it', () => {
	// The pill is `Badge variant="ok"` → `encore-chip-ok` in badge.svelte, which is the one permitted statement.
	// If either of these reds, the ready state is being stated more than once again.
	expect(songRow).not.toContain('var(--ok');
	expect(button).not.toContain('var(--ok');
	// The variant itself is gone, not merely unused: a second identity left in the table gets picked up again.
	expect(button).not.toMatch(/^\s*iconReady:/m);
	expect(songRow).not.toContain('variant="iconReady"');
	// `official` is the NEUTRAL kind. Toned green it put a second --ok pill beside "Karaoke ready" in the same
	// chips row, meaning something else entirely, which defeats the pill that is now the only readiness mark.
	expect(songRow).not.toMatch(/kind === 'official'/);
	// The state hook stays on the element even though no rule reads it — see the comment in SongRow's <style>.
	expect(songRow).toContain("ready: readiness === 'ready'");
});

test('the queued confirmation is a surface swap, because dimming the fill drops it under 3:1', () => {
	const [accent, card] = [token('accent'), token('card')];
	// THE ASSERTION THAT FORBIDS THE WRONG FIX. `opacity: 0.7` is what this rule used to carry, and over an
	// --ok OUTLINE it cost nothing. Over the shared --accent FILL it composites to a colour that no longer
	// identifies the control, while every token-level contrast check keeps passing.
	expect(contrastRatio(over(accent, card, 0.7), card)).toBeLessThan(NON_TEXT);
	expect(songRow).not.toMatch(/opacity:\s*0\.7;/);
	// What it carries instead: the accent family's own certified pair, outlined rather than filled.
	expect(songRow).toMatch(
		/\[data-row-state='queued'\]\)\s*\{[\s\S]*?background:\s*var\(--card2\);[\s\S]*?border-color:\s*var\(--accent\);[\s\S]*?color:\s*var\(--accent-ink\);/
	);
	// The border is what carries visibility now, on the row and on its own fill.
	expect(contrastRatio(accent, card)).toBeGreaterThanOrEqual(NON_TEXT);
	expect(contrastRatio(accent, token('card2'))).toBeGreaterThanOrEqual(NON_TEXT);
	expect(contrastRatio(token('accent-ink'), token('card2'))).toBeGreaterThanOrEqual(TEXT);
});

test('the unavailable row neutralises the FILL too, or an unsingable row wears the live action', () => {
	// This rule predates the shared variant and used to neutralise only the border and the ink, which was
	// enough while the branch rendered `iconReady`'s --card2 base. On an accent fill it would leave a
	// full-strength purple circle.
	expect(songRow).toMatch(
		/\[data-row-state='unavailable'\]\)\s*\{[\s\S]*?background:\s*var\(--card2\);[\s\S]*?border-color:\s*var\(--line\);[\s\S]*?color:\s*var\(--ink-dim\);/
	);
	// And the separation from `queued` is the BORDER, not the ink: --accent-ink vs --ink-dim is 1.37:1, so the
	// number that does the work is --line's near-absence of a boundary against --accent's 3.38:1.
	expect(contrastRatio(token('line'), token('card'))).toBeLessThan(NON_TEXT);
	expect(contrastRatio(token('accent-ink'), token('ink-dim'))).toBeLessThan(NON_TEXT);
});
