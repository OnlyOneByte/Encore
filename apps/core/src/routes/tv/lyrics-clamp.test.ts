// Guard: the TV route must hand the PLAYING SONG's granularity to the lyrics clamp.
//
// NB filename: SvelteKit reserves `+`-prefixed names inside routes/, so this cannot be
// `+page.test.ts`; it colocates with the page it guards without being treated as a route.
//
// WHY A SOURCE SCAN AND NOT A UNIT TEST. `resolveLyricsPresentation`'s per-song bound is a pure
// function with full branch coverage in packages/shared/src/lyrics/separators.test.ts. That coverage says
// nothing about whether anything CALLS it with a song — and a bound nobody passes an argument to is
// this repo's single most repeated defect: a mechanism built, unit-tested in isolation, and never
// wired to the path that needs it, with the passing test standing in for the wiring. The clamp is
// especially exposed to it because its unknown case is deliberately permissive: drop the argument and
// every song silently reads as "granularity unknown", which resolves to exactly the pre-fix
// behaviour and breaks NOT ONE existing test.
//
// +page.svelte cannot be imported here (no Svelte compiler in bun test, and the component needs a
// browser), so the call site is asserted against the source. That is a real limit and it is stated
// rather than papered over: this pins that the argument is passed and where it comes from, not that
// the value is correct at runtime — the resolver's own tests do that half, and the rendered result
// was verified eyes-on in a browser.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE = join(import.meta.dir, '+page.svelte');

/**
 * Blank comments out, keeping newlines so reported line numbers stay true.
 *
 * LOAD-BEARING, and measured rather than asserted. Reverting the wiring while leaving the correct call
 * in a comment — `// const lyricsStyle = $derived(resolveLyricsPresentation(settings, ...))`, the
 * shape a disable actually takes — makes the scan below pass on its own documentation. Checked both
 * ways against that mutant: with this pass the guard fails, without it the identical assertion passes
 * vacuously. Nothing in the page's CURRENT prose matches these patterns, so this catches the next
 * edit, not today's.
 */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		.replace(/(^|[^:'"\\`])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length)));
}

const src = stripComments(readFileSync(PAGE, 'utf8'));

test('resolveLyricsPresentation is called with a SECOND argument, not settings alone', () => {
	// The pre-fix call was `resolveLyricsPresentation(settings)`. A single-argument call is the defect
	// restored, because the resolver's second parameter is optional by design (the Settings page
	// legitimately has no song) — so the type checker cannot catch this and only this can.
	const calls = [...src.matchAll(/resolveLyricsPresentation\(([^)]*)\)/g)].map((m) => m[1]!.trim());
	expect(calls.length).toBe(1); // one clamp on this route; two would be two answers to one question
	expect(calls[0]).not.toBe('settings');
	expect(calls[0]!.split(',').length).toBe(2);
});

test('the second argument is the CHOSEN CANDIDATE\u2019s timing — the per-song datum', () => {
	// Not `settings.global.syncMode` (the fleet bound, already applied inside), and not a hand-rolled
	// granularity of its own. `chosenCandidate(media).timing` is the one field the worker records per
	// song, so reading anything else here would be a second vocabulary for the same fact.
	const arg = /resolveLyricsPresentation\(\s*settings\s*,\s*([^)]*)\)/.exec(src)?.[1]?.trim();
	expect(arg).toBe('lyricsProvenance?.timing');
	// And `lyricsProvenance` must still be the chosen candidate rather than a local re-derivation, or
	// the name above would be true while pointing at something else.
	expect(src).toMatch(/lyricsProvenance\s*=\s*\$derived[\s\S]{0,160}chosenCandidate\(/);
});

test('the clamp result is what the overlay is handed — no second path around it', () => {
	// A clamp nothing renders from is the same defect one step later. All three presentation props on
	// <LyricsOverlay> must come from the resolved value.
	for (const prop of ['ball', 'highlight', 'leadSec']) {
		expect(src).toContain(`${prop}={lyricsStyle.${prop}}`);
	}
});
