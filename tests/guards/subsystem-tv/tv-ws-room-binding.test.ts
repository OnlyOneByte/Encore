// one-TV-per-room, the CLIENT half: the TV must pass its resolved room code on the WS URL so the server can
// bind the socket to that room (tvRoomId).
//
// The client WS-URL line is the one hunk whose reversion breaks the feature SILENTLY: the loader still
// resolves the room and the server still binds `?room`, but a client connecting with a bare `?role=tv` makes
// the server fall back to the SERVED room, so the TV can no longer be pointed at a specific party.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

const SRC = read('src/routes/tv/+page.svelte');

test('the TV opens its WS as role=tv (the room-identity work keeps the TV role)', () => {
	expect(SRC).toMatch(/\/ws\?role=tv/);
});

test('the TV WS URL binds to the resolved room by passing its code as ?room=<code>', () => {
	// The room the loader resolved rides on data.roomCode; the client forwards it, url-encoded, on the same URL.
	expect(SRC).toMatch(/data\.roomCode/);
	expect(SRC).toMatch(/role=tv\$\{[^}]*room=\$\{encodeURIComponent\(data\.roomCode\)\}/);
});
