import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

// The per-song ephemeral reset (positionSec/keyShift/background/guideLevel) must be named in ONE
// place — the EPHEMERAL_RESET const — and spread at every reset site, not re-typed as a literal at
// each setPlayback call. issue #402: re-typing it at N sites let 7 of 16 (field × site) pairs drop
// silently, and keyShift already shipped missing from one site once. A behaviour-preserving refactor
// has no behavioural test that can red (the suite is green before and after), so this is a source
// scan. Comments are STRIPPED first so the prose that describes the old shape (or the historical
// keyShift leak) can neither satisfy nor trip the assertions.
const strip = (s: string): string =>
	s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const playerSrc = strip(
	readFileSync(new URL('./player.ts', import.meta.url), 'utf8')
);

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

	// Every reset site SPREADS the const. There are four song-start/idle-clear sites; each must
	// carry the spread.
	const spreads = playerSrc.match(/\.\.\.EPHEMERAL_RESET\b/g) ?? [];
	expect(spreads.length).toBeGreaterThanOrEqual(4);

	// And the four ephemeral fields must NOT be re-typed as literals inside a setPlayback call
	// anywhere else. The only `keyShift: 0` / `background: null` / `guideLevel: null` literals
	// allowed are the ones INSIDE the const body; a re-typed reset object at a call site would push
	// each count above 1. (positionSec: 0 is excluded — it legitimately appears in the seek/restart
	// handler `setPlayback({ positionSec: 0, isPlaying: true })`, which is NOT a full ephemeral
	// reset.)
	const keyShiftLiterals = playerSrc.match(/keyShift:\s*0\b/g) ?? [];
	const backgroundNulls = playerSrc.match(/background:\s*null\b/g) ?? [];
	const guideLevelNulls = playerSrc.match(/guideLevel:\s*null\b/g) ?? [];
	expect(keyShiftLiterals.length).toBe(1);
	expect(backgroundNulls.length).toBe(1);
	expect(guideLevelNulls.length).toBe(1);
});
