// guard: the TV route must hand the PLAYING SONG's granularity to the lyrics clamp.
// `resolveLyricsPresentation` has full branch coverage as a pure function, which says nothing about whether
// anything CALLS it with a song — and its unknown case is deliberately PERMISSIVE, so dropping the argument
// silently restores the pre-fix behaviour and breaks not one existing test.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { stripComments } from '@encore/test-support/scan';

const PAGE = 'src/routes/tv/+page.svelte';

/**
 * STRIPPED IS LOAD-BEARING, and measured rather than asserted: leaving the correct call in a comment — the
 * shape a disable actually takes — makes the scan below pass on its own documentation.
 */
const src = stripComments(read(PAGE), { markup: true });

test('resolveLyricsPresentation is called with a SECOND argument, not settings alone', () => {
	// The resolver's second parameter is optional by design (the Settings page legitimately has no song), so
	// the type checker cannot catch a single-argument call and only this can.
	const calls = [...src.matchAll(/resolveLyricsPresentation\(([^)]*)\)/g)].map((m) => m[1]!.trim());
	expect(calls.length).toBe(1); // one clamp on this route; two would be two answers to one question
	expect(calls[0]).not.toBe('settings');
	expect(calls[0]!.split(',').length).toBe(2);
});

test('the second argument is the CHOSEN CANDIDATE\u2019s timing — the per-song datum', () => {
	// `chosenCandidate(media).timing` is the one field the worker records per song. Not
	// `settings.global.syncMode` (the fleet bound, already applied inside) and not a hand-rolled granularity,
	// either of which would be a second vocabulary for the same fact.
	const arg = /resolveLyricsPresentation\(\s*settings\s*,\s*([^)]*)\)/.exec(src)?.[1]?.trim();
	expect(arg).toBe('lyricsProvenance?.timing');
	// And `lyricsProvenance` must still BE the chosen candidate rather than a local re-derivation, or the
	// name above would be true while pointing at something else.
	expect(src).toMatch(/lyricsProvenance\s*=\s*\$derived[\s\S]{0,160}chosenCandidate\(/);
});

test('the clamp result is what the overlay is handed — no second path around it', () => {
	// A clamp nothing renders from is the same defect one step later.
	for (const prop of ['ball', 'highlight', 'leadSec']) {
		expect(src).toContain(`${prop}={lyricsStyle.${prop}}`);
	}
});
