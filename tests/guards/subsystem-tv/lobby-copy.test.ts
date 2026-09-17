// The lobby's wording, pinned.
//
// THE BUG. `/tv` told a room "Waiting for someone to pick a song…" while somebody's song was actively
// separating — and while that person's phone was simultaneously saying "You're next once it's ready".
// Two surfaces of the same app contradicting each other about the same fact.
//
// The cause was not the precedence in tvScreen(). It was that `lobby` covers TWO situations and the
// copy only described one: nothing picked at all, and something picked that cannot play yet. A queued
// but unplayable entry routes to `lobby`, because tvScreen's `waiting` means the narrower "the PLAYER
// is actively holding", not "something queued is not ready".
//
// These assertions are about MEANING rather than exact strings, so a copy edit is free but reintroducing
// the contradiction is not.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

// Both subjects named explicitly. This guard used to sit in src/lib/tv, so TvLobby.svelte was
// "the component next to me" and the route was two levels up; neither is inferable from tests/.
const LOBBY = read('src/lib/tv/TvLobby.svelte');
const TV_ROUTE = read('src/routes/tv/+page.svelte');

test('the lobby distinguishes "nothing picked" from "picked but still processing"', () => {
	// A single unconditional headline is the shape the bug had.
	expect(LOBBY).toContain('pendingCount');
	expect(LOBBY).toMatch(/headline\s*=\s*\$derived/);
});

test('the "pick a song" prompt is conditional, never shown while something is processing', () => {
	// The exact sentence that was wrong. It must be reachable only on the not-processing branch.
	const idx = LOBBY.indexOf('Waiting for someone to pick a song');
	expect(idx).toBeGreaterThan(-1);
	// the ternary that guards it has to mention the processing condition before that string
	expect(LOBBY.slice(0, idx)).toMatch(/processing/);
});

test('the processing copy explains the wait rather than asking for another pick', () => {
	const processingCopy = /processing\s*\?([\s\S]*?)'Waiting for someone to pick a song/.exec(LOBBY)?.[1] ?? '';
	expect(processingCopy.length).toBeGreaterThan(0);
	// naming the actual cause is the point — "karaoke"/"vocals", not "pick". The headline now sources
	// that wording from the shared `processStageLabel` (process-phrasing.ts) — the ONE guest-facing process
	// vocabulary, shared with the phone — instead of a hand-written "Making the karaoke…" literal, so
	// this accepts the helper call as well as the literal word. Rendered text is still "Making karaoke…";
	// what changed is the TV no longer speaks its own dialect. (It used to require the literal string,
	// which pinned the exact divergence FIX 4 removed.)
	expect(/karaoke|vocals|processStageLabel/i.test(processingCopy)).toBe(true);
	/*
	 * RE-POINTED from `/tap Turn/`, which this arm could no longer fail.
	 *
	 * "tap Turn" named a control that no longer exists anywhere: SongRow's actions are icon-only and
	 * "Add a turn" survives only as an `aria-label`, so the lobby's prompt now reads "pick a song". Once
	 * the old string was gone from the file, asserting its ABSENCE from one branch was satisfied by every
	 * possible edit — the vacuity XR-VER-07 rejects. The claim was never about those two words; it is that
	 * the processing branch must not ask for ANOTHER pick while the last one is still cooking. So this
	 * pins the prompt's actual verb, which is also what the not-processing branch is asserted to carry.
	 */
	expect(/pick a song|tap Turn/.test(processingCopy)).toBe(false);
	// …and it is a real prohibition rather than a typo: the prompt exists, just not on this branch.
	expect(LOBBY).toContain('pick a song');
});

test('the route computes pendingCount from real playability, not a guess', () => {
	expect(TV_ROUTE).toMatch(/pendingCount\s*=\s*\$derived/);
	// isPlayable is the same question the player asks; anything looser could claim a startable song
	// is still processing
	expect(/pendingCount[\s\S]{0,400}isPlayable/.test(TV_ROUTE)).toBe(true);
	// and it must actually be handed to the lobby
	expect(TV_ROUTE).toMatch(/\{pendingCount\}/);
});
