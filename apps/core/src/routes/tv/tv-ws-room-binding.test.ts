// one-TV-per-room, the CLIENT half: the TV must pass its resolved room code on the WS URL so the
// server can bind the socket to that room (tvRoomId). This is a source scan because the TV WsClient
// wiring cannot be exercised headlessly in the bun runner (no socket/DOM harness) — same pattern as
// this dir's style-no-duplicate-selectors.test.ts and the room-scope-wiring guard on server.ts.
//
// Without this guard the client WS-URL line is the one hunk whose reversion breaks the feature
// SILENTLY: the loader still resolves room B and the server still binds ?room, but the client would
// connect ?role=tv with no room param, so the server falls back to the served room and the TV can no
// longer be pointed at a specific party. On BASE the URL is a bare ?role=tv with no room param at all.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(import.meta.dir, '+page.svelte'), 'utf8');

test('the TV opens its WS as role=tv (the room-identity work keeps the TV role)', () => {
	expect(SRC).toMatch(/\/ws\?role=tv/);
});

test('the TV WS URL binds to the resolved room by passing its code as ?room=<code>', () => {
	// The room the loader resolved rides on data.roomCode; the client must forward it as a room param
	// on the same WS URL, url-encoded. Reverting the binding back to a bare role=tv reds here.
	expect(SRC).toMatch(/data\.roomCode/);
	expect(SRC).toMatch(/role=tv\$\{[^}]*room=\$\{encodeURIComponent\(data\.roomCode\)\}/);
});
