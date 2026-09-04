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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOBBY = readFileSync(join(import.meta.dir, 'TvLobby.svelte'), 'utf8');
const TV_ROUTE = readFileSync(join(import.meta.dir, '..', '..', 'routes', 'tv', '+page.svelte'), 'utf8');

test('the lobby distinguishes "nothing picked" from "picked but still cooking"', () => {
	// A single unconditional headline is the shape the bug had.
	expect(LOBBY).toContain('pendingCount');
	expect(LOBBY).toMatch(/headline\s*=\s*\$derived/);
});

test('the "pick a song" prompt is conditional, never shown while something is cooking', () => {
	// The exact sentence that was wrong. It must be reachable only on the not-cooking branch.
	const idx = LOBBY.indexOf('Waiting for someone to pick a song');
	expect(idx).toBeGreaterThan(-1);
	// the ternary that guards it has to mention the cooking condition before that string
	expect(LOBBY.slice(0, idx)).toMatch(/cooking/);
});

test('the cooking copy explains the wait rather than asking for another pick', () => {
	const cookingCopy = /cooking\s*\?([\s\S]*?)'Waiting for someone to pick a song/.exec(LOBBY)?.[1] ?? '';
	expect(cookingCopy.length).toBeGreaterThan(0);
	// naming the actual cause is the point — "karaoke"/"vocals", not "pick"
	expect(/karaoke|vocals/i.test(cookingCopy)).toBe(true);
	expect(/tap Turn/.test(cookingCopy)).toBe(false);
});

test('the route computes pendingCount from real playability, not a guess', () => {
	expect(TV_ROUTE).toMatch(/pendingCount\s*=\s*\$derived/);
	// isPlayable is the same question the player asks; anything looser could claim a startable song
	// is still cooking
	expect(/pendingCount[\s\S]{0,400}isPlayable/.test(TV_ROUTE)).toBe(true);
	// and it must actually be handed to the lobby
	expect(TV_ROUTE).toMatch(/\{pendingCount\}/);
});
