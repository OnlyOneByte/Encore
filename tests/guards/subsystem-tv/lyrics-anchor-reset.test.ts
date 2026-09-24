// guard: every song change opened the new turn with the lyrics reel parked on the old song's last lines and
// the progress bar two-thirds full for ~260ms, and for one frame the reel rendered the PREVIOUS song's
// lyrics under the new song's title. The drawn-position anchor (`positionSec`) and its `durationSec` were
// never reset on an entry change, and their only writer is the active slot's `onposition`, which does not
// run until the NEW <audio> fires its first `timeupdate` (~250ms in Chromium) — until then `drawPosition`
// extrapolates FORWARD from the previous song's anchor.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { stripComments } from '@encore/test-support/scan';

const ROUTE = read('src/routes/tv/+page.svelte');
const OVERLAY = read('src/lib/tv/LyricsOverlay.svelte');

/** The brace-matched body of a top-level `function <name>(...) { ... }` in `src`, or '' if absent. */
function functionBody(src: string, name: string): string {
	const sig = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
	if (!sig) return '';
	const open = src.indexOf('{', sig.index);
	if (open < 0) return '';
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
	}
	return '';
}

test('F1/F2: applyNowPlaying resets the drawn-position anchor on the entry change', () => {
	const clean = stripComments(ROUTE, { markup: true, keepLine: true });

	// Not vacuous: applyNowPlaying must still BE the nowplaying:changed handler, or the reset is in the wrong
	// place and this whole guard is meaningless.
	expect(clean).toContain("if (e.type === 'nowplaying:changed') applyNowPlaying");

	// Not vacuous: `positionSec` is the reactive anchor handed to the overlay, with EXACTLY two authoritative
	// telemetry writers — a third changes the reset story and this test should be revisited.
	expect(/let\s+positionSec\s*=\s*\$state\(0\)/.test(clean)).toBe(true);
	expect(clean).toContain('positionSec={positionSec}');
	const anchorWrites = clean.match(/\bpositionSec\s*=\s*s\b/g) ?? [];
	expect(anchorWrites.length, 'positionSec must have exactly two telemetry writers').toBe(2);

	// Both the anchor and the duration reset to 0, so the reel and progress bar open the new turn at the
	// song's start rather than extrapolating forward. Reverting either assignment reds one arm.
	const body = functionBody(clean, 'applyNowPlaying');
	expect(body, 'applyNowPlaying body must be found').not.toBe('');
	expect(/\bpositionSec\s*=\s*0\b/.test(body)).toBe(true);
	expect(/\bdurationSec\s*=\s*0\b/.test(body)).toBe(true);
});

test('F1/F2: the reset fires ONLY on a real entry change, never on every playback command', () => {
	// The other half, and it was missing — which is why this guard stayed green through a real defect. The
	// server calls `emitNowPlaying` at the tail of EVERY player command, so an unguarded reset ran on every
	// pause, resume, restart, key press and guide nudge: `positionSec = 0` snaps the reel to the FIRST line and
	// empties the bar, and under the guide slider's ~8 commands/second it is re-pinned faster than telemetry
	// recovers. Asserting the reset EXISTS is compatible with the bug; asserting it is CONDITIONAL closes it.
	const clean = stripComments(ROUTE, { markup: true, keepLine: true });
	const body = functionBody(clean, 'applyNowPlaying');
	expect(body, 'applyNowPlaying body must be found').not.toBe('');

	// Compared on the ENTRY id, because a song queued twice is two entries over one media record and the
	// media id would miss a real advance — and taken BEFORE the assignment that makes the comparison vacuous.
	const decl = /const\s+entryChanged\s*=\s*([^\n;]+);/.exec(body);
	expect(decl, 'applyNowPlaying must derive an entryChanged flag').not.toBeNull();
	expect(decl?.[1]).toContain('cur?.id');
	expect(decl?.[1]).toContain('current?.id');
	expect(body.indexOf('entryChanged')).toBeLessThan(body.indexOf('current = cur'));

	// Both resets sit inside that condition, not at the function's top level.
	const guarded = /if\s*\(entryChanged\)\s*\{([\s\S]*?)\}/.exec(body)?.[1] ?? '';
	expect(guarded, 'the resets must live inside an if (entryChanged) block').not.toBe('');
	expect(/\bpositionSec\s*=\s*0\b/.test(guarded)).toBe(true);
	expect(/\bdurationSec\s*=\s*0\b/.test(guarded)).toBe(true);
});

test('F3: LyricsOverlay clears the cached doc on a ref change, not only when the ref goes falsy', () => {
	const clean = stripComments(OVERLAY, { markup: true, keepLine: true });

	// Not vacuous: the fetch effect keys on a ref change via `loadedRef` and the derived doc falls back to
	// the fetched one, so a stale `fetched` is what would render the wrong lyrics.
	expect(/if\s*\(ref\s*===\s*loadedRef\)\s*return;/.test(clean)).toBe(true);
	expect(/const\s+doc\s*=\s*\$derived\(docProp\s*\?\?\s*fetched\)/.test(clean)).toBe(true);

	// On the change path — after `loadedRef = ref`, before the async fetch is issued — the previous song's doc is
	// cleared, so the overlay renders nothing rather than the old lyrics for the frame before the fetch resolves.
	const change = /loadedRef\s*=\s*ref;([\s\S]*?)fetch\(/.exec(clean)?.[1] ?? '';
	expect(change, 'the ref-change path between loadedRef assignment and fetch must be found').not.toBe('');
	expect(/\bfetched\s*=\s*null\b/.test(change)).toBe(true);
});
