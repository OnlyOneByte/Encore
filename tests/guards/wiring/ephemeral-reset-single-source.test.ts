import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

// The per-song ephemeral reset (positionSec/keyShift/background/guideLevel) must be named in ONE
// place — the EPHEMERAL_RESET const — and spread at EVERY song-start reset site, not re-typed as a
// literal at each setPlayback call. THE DEFECT: re-typing it at N sites let 7 of 16 (field × site)
// pairs drop silently, and keyShift already shipped missing from one site once. A behaviour-
// preserving refactor has no behavioural test that can red (the suite is green before and after),
// so this is a source scan. Comments are STRIPPED first so the prose that describes the old shape
// (or the historical keyShift leak) can neither satisfy nor trip the assertions.
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// Was a sibling read of the module this guard sat beside in src/lib/server/realtime — the
// realtime player, named from the repo root now that the guard no longer sits next to it.
const playerSrc = strip(read('src/lib/server/realtime/player.ts'));

// Extract the object-literal argument of every `state.setPlayback({ ... })` call, matched by
// balanced braces so nested objects do not truncate the slice. A LATER FINDING: pinning a FLOOR on the
// spread count (`>= 4`) is blind to a NEW un-spread song-start site — the four existing spreads keep
// the floor satisfied while the fifth site leaks. Deriving the site set from the code instead means
// a sixth, seventh, ... is caught for free.
const setPlaybackArgs = (src: string): string[] => {
	const args: string[] = [];
	const marker = 'setPlayback({';
	let from = 0;
	for (;;) {
		const call = src.indexOf(marker, from);
		if (call === -1) break;
		// Start scanning at the opening brace of the object literal.
		let depth = 0;
		let i = call + marker.length - 1; // position of the `{`
		const start = i + 1;
		for (; i < src.length; i++) {
			const ch = src[i];
			if (ch === '{') depth++;
			else if (ch === '}') {
				depth--;
				if (depth === 0) break;
			}
		}
		args.push(src.slice(start, i));
		from = i + 1;
	}
	return args;
};

test('player.ts is the file under test and still has its reset call sites (not-vacuous)', () => {
	// If player.ts is moved/renamed/emptied, these sentinels fail loudly rather than the scan
	// passing on an absent file.
	expect(playerSrc.length).toBeGreaterThan(500);
	expect(playerSrc).toContain('setPlayback');
	expect(playerSrc).toContain('reconcileOnReady');
});

test('the per-song ephemeral reset set is named in exactly ONE const, not re-typed per site', () => {
	// The extracted const, checked against the state type.
	expect(playerSrc).toMatch(/const\s+EPHEMERAL_RESET\s*=/);
	expect(playerSrc).toMatch(/satisfies\s+Partial<\s*PlaybackState\s*>/);

	// Every setPlayback call that CHANGES currentEntryId is a song-start / idle-clear reset site and
	// MUST spread the const. The site set is derived from the code (not a hardcoded floor), so a
	// NEWLY-ADDED currentEntryId-changing site that forgets the spread reds this test — the floor's
	// hole. `>= 4` is kept ONLY as a not-vacuous sentinel (the scan must have found the four known
	// sites), never as the enumeration itself. Anchoring on `setPlayback({` excludes store.ts's
	// hydrate heal by construction (it assigns #playback directly, not via setPlayback), which is
	// intentionally NOT a full ephemeral reset.
	const resetSites = setPlaybackArgs(playerSrc).filter((a) => /\bcurrentEntryId:/.test(a));
	expect(resetSites.length).toBeGreaterThanOrEqual(4);
	const unspread = resetSites.filter((a) => !/\.\.\.EPHEMERAL_RESET\b/.test(a));
	expect(unspread).toEqual([]);

	// And the four ephemeral fields must NOT be re-typed as literals inside a setPlayback call
	// anywhere else. The only `keyShift: 0` / `background: null` / `guideLevel: null` literals
	// allowed are the ones INSIDE the const body; a re-typed reset object at a call site would push
	// each count above 1. (positionSec: 0 is excluded — `restart` legitimately writes it alone,
	// `setPlayback({ positionSec: 0, isPlaying: !!state.playback.currentEntryId })` at player.ts:189,
	// which is a rewind, not a song start.)
	const keyShiftLiterals = playerSrc.match(/keyShift:\s*0\b/g) ?? [];
	const backgroundNulls = playerSrc.match(/background:\s*null\b/g) ?? [];
	const guideLevelNulls = playerSrc.match(/guideLevel:\s*null\b/g) ?? [];
	expect(keyShiftLiterals.length).toBe(1);
	expect(backgroundNulls.length).toBe(1);
	expect(guideLevelNulls.length).toBe(1);
});
