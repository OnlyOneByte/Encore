// guard: the lobby's wording. Caught: `/tv` told a room "Waiting for someone to pick a song…" while
// somebody's song was actively separating, and while that person's phone said "You're next once it's
// ready". The cause was not tvScreen()'s precedence: `lobby` covers TWO situations and the copy described
// only one, because a queued-but-unplayable entry routes to `lobby` while tvScreen's `waiting` means the
// narrower "the PLAYER is actively holding". These assertions are about MEANING rather than exact strings,
// so a copy edit is free but reintroducing the contradiction is not.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

const LOBBY = read('src/lib/tv/TvLobby.svelte');
const TV_ROUTE = read('src/routes/tv/+page.svelte');

test('the lobby distinguishes "nothing picked" from "picked but still processing"', () => {
	// A single unconditional headline is the shape the bug had.
	expect(LOBBY).toContain('pendingCount');
	expect(LOBBY).toMatch(/headline\s*=\s*\$derived/);
});

test('the "pick a song" prompt is conditional, never shown while something is processing', () => {
	const idx = LOBBY.indexOf('Waiting for someone to pick a song');
	expect(idx).toBeGreaterThan(-1);
	// The ternary guarding it has to mention the processing condition before that string.
	expect(LOBBY.slice(0, idx)).toMatch(/processing/);
});

test('the processing copy explains the wait rather than asking for another pick', () => {
	const processingCopy = /processing\s*\?([\s\S]*?)'Waiting for someone to pick a song/.exec(LOBBY)?.[1] ?? '';
	expect(processingCopy.length).toBeGreaterThan(0);
	// Naming the actual cause is the point. The headline sources that wording from the shared
	// `processStageLabel` — the ONE guest-facing process vocabulary, shared with the phone — so the helper call
	// is accepted alongside the literal word; requiring the literal pinned the very divergence that removed.
	expect(/karaoke|vocals|processStageLabel/i.test(processingCopy)).toBe(true);
	// The prohibition is on the VERB, not on two particular words: this arm used to ban `/tap Turn/`, a
	// control that no longer exists anywhere, so asserting its absence from one branch was satisfied by every
	// possible edit. The claim is that the processing branch must not ask for ANOTHER pick while the last one
	// is still cooking, so it pins the prompt's actual verb — the same one the other branch must carry.
	expect(/pick a song|tap Turn/.test(processingCopy)).toBe(false);
	expect(LOBBY).toContain('pick a song');
});

test('the route computes pendingCount from real playability, not a guess', () => {
	expect(TV_ROUTE).toMatch(/pendingCount\s*=\s*\$derived/);
	// isPlayable is the same question the player asks; anything looser could claim a startable song is still
	// processing.
	expect(/pendingCount[\s\S]{0,400}isPlayable/.test(TV_ROUTE)).toBe(true);
	expect(TV_ROUTE).toMatch(/\{pendingCount\}/);
});
