// guard: every song change opens the new turn with the lyrics reel parked on the old
// song's last lines and the progress bar two-thirds full, for ~260ms, and for one frame the reel
// renders the PREVIOUS song's lyrics under the new song's title.
//
// Root cause: the TV page's drawn-position anchor (`positionSec`) and its `durationSec` are never
// reset when the current entry changes. Both have exactly two writers — the active slot's
// `onposition` — and neither runs until the NEW <audio> fires its first `timeupdate` (~250ms in
// Chromium). Until then `drawPosition` extrapolates FORWARD from the previous song's anchor. The fix
// resets both to 0 in `applyNowPlaying` (the `nowplaying:changed` handler, the exact entry-change
// event), and clears the overlay's cached doc on a ref CHANGE so a stale doc is not shown.
//
// Source scans over the TV route + LyricsOverlay, in the same shape as tv-ratified-states.test.ts /
// stage-scale.test.ts: a green unit suite cannot see a client-only timing window a CDP round trip is
// too slow to resolve, so these pin the structural preconditions and mutation-red on each hunk.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', '..');
const ROUTE = readFileSync(join(SRC, 'routes', 'tv', '+page.svelte'), 'utf8');
const OVERLAY = readFileSync(join(SRC, 'lib', 'tv', 'LyricsOverlay.svelte'), 'utf8');

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
}

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
	const clean = stripComments(ROUTE);

	// Sentinel 1 (not vacuous): applyNowPlaying is the nowplaying:changed handler. If this dispatch
	// moves, the reset would be in the wrong place and this whole guard would be meaningless.
	expect(clean).toContain("if (e.type === 'nowplaying:changed') applyNowPlaying");

	// Sentinel 2 (not vacuous): `positionSec` is the reactive anchor, handed to the overlay, and has
	// EXACTLY two authoritative writers (the active slot's onposition). If a third writer appears the
	// reset story changes and this test should be revisited.
	expect(/let\s+positionSec\s*=\s*\$state\(0\)/.test(clean)).toBe(true);
	expect(clean).toContain('positionSec={positionSec}');
	const anchorWrites = clean.match(/\bpositionSec\s*=\s*s\b/g) ?? [];
	expect(anchorWrites.length, 'positionSec must have exactly two telemetry writers').toBe(2);

	// The invariant: applyNowPlaying's own body resets BOTH the position anchor and the duration to 0,
	// so the reel and progress bar open the new turn at the song's start rather than extrapolating
	// forward from the previous song's playhead. Reverting either assignment reds one arm.
	const body = functionBody(clean, 'applyNowPlaying');
	expect(body, 'applyNowPlaying body must be found').not.toBe('');
	expect(/\bpositionSec\s*=\s*0\b/.test(body)).toBe(true);
	expect(/\bdurationSec\s*=\s*0\b/.test(body)).toBe(true);
});

test('F3: LyricsOverlay clears the cached doc on a ref change, not only when the ref goes falsy', () => {
	const clean = stripComments(OVERLAY);

	// Sentinel (not vacuous): the fetch effect keys on a ref change via `loadedRef`, and the derived
	// doc falls back to the fetched doc — so a stale `fetched` is what would render the wrong lyrics.
	expect(/if\s*\(ref\s*===\s*loadedRef\)\s*return;/.test(clean)).toBe(true);
	expect(/const\s+doc\s*=\s*\$derived\(docProp\s*\?\?\s*fetched\)/.test(clean)).toBe(true);

	// The invariant: on the change path (after `loadedRef = ref`, before the async fetch is issued)
	// the previous song's doc is cleared, so the overlay renders nothing rather than the old song's
	// lyrics for the frame before the fetch resolves. Reverting this hunk removes the clear and reds.
	const change = /loadedRef\s*=\s*ref;([\s\S]*?)fetch\(/.exec(clean)?.[1] ?? '';
	expect(change, 'the ref-change path between loadedRef assignment and fetch must be found').not.toBe('');
	expect(/\bfetched\s*=\s*null\b/.test(change)).toBe(true);
});
