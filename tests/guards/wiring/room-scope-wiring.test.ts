// Room isolation is only real once it is WIRED into the WS layer. `server.ts` calls Bun.serve and
// process.exit, so importing it into bun:test would terminate the runner; the isolation decisions are unit
// tested in room-scope.test.ts and this scan pins that the wire routes through them. Four seams, each of
// which alone reopens the gap: the WS UPGRADE captures the roomId scope onto the socket; `websocket.open`
// subscribes via `subscribeTopicFor`; the broadcast sink publishes via `broadcastTopicFor`; and the client
// message switch refuses a foreign-room socket before hello/mutate. See docs/GUARDS.md#wiring
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

// `read` throws when the file is missing, which matters because several assertions below are absence
// checks an empty string would satisfy.
const SERVER_RAW = read('server.ts');

/** Blank comments, preserving newlines, so a commented-out wiring line cannot satisfy a match. */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + '');
}

const SERVER = stripComments(SERVER_RAW);

test('server.ts actually PARSES — a source scan is blind to a SyntaxError in the prod entrypoint', () => {
	// Caught: a `break` illegally crossing the message-handler function boundary (TS1107) shipped green,
	// because `bun test` never parses this file, `bun run build` covers the SvelteKit app rather than this
	// entry, and svelte-check's tsconfig excludes it. Parsed from the RAW bytes, since the defect is code.
	expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(SERVER_RAW)).not.toThrow();
});

test('server.ts imports the room-scope isolation helpers and the TV-room resolver', () => {
	expect(SERVER).toMatch(
		/import\s*\{[^}]*\bisForeignRoom\b[^}]*\bsubscribeTopicFor\b[^}]*\bbroadcastTopicFor\b[^}]*\}\s*from\s*['"]\.\/src\/lib\/server\/realtime\/room-scope['"]/
	);
	// The resolver import is pinned too: dropping it while the usage stays is a compile error a source
	// scan is blind to.
	expect(SERVER).toMatch(/import\s*\{[^}]*\btvRoomId\b[^}]*\}\s*from\s*['"]\.\/src\/lib\/server\/rooms\/tv-room['"]/);
});

test('the WS upgrade captures a roomId scope onto the socket, not just the id (re-anchored for the TV branch)', () => {
	// The scope key: without a roomId on SocketData every socket is unscoped and `isForeignRoom` can never
	// fire. Matched as shorthand OR explicit, because a phone reads it from its session token while a TV
	// has no cookie and resolves it from `?room=<code>` through `tvRoomId`.
	expect(SERVER).toMatch(/roomId\?:\s*string/);
	expect(SERVER).toMatch(/data:\s*\{\s*role,\s*singerId:\s*[\w.?]+,\s*roomId(\s*:\s*[\w.?]+)?\s*\}/);
	// Reverting the TV branch to a bare `me?.roomId`, leaving every TV an unscoped spectator, reds here.
	expect(SERVER).toMatch(/const\s+roomId\s*=/);
	expect(SERVER).toMatch(/role\s*===\s*'tv'[\s\S]{0,120}tvRoomId\(/);
});

test('websocket.open subscribes to the socket own room topic via subscribeTopicFor', () => {
	expect(SERVER).toMatch(/ws\.subscribe\(\s*subscribeTopicFor\(\s*ws\.data\.roomId\s*,\s*app\.activeRoomId\s*\)\s*\)/);
	// The single-shared-topic subscribe is the pre-isolation shape and must stay gone.
	expect(SERVER).not.toMatch(/ws\.subscribe\(\s*ROOM_TOPIC\s*\)/);
});

test('the broadcast sink publishes to the served room topic via broadcastTopicFor', () => {
	expect(SERVER).toMatch(/server\.publish\(\s*broadcastTopicFor\(\s*app\.activeRoomId\s*\)/);
	// A publish through the legacy single topic crosses the room boundary.
	expect(SERVER).not.toMatch(/server\.publish\(\s*ROOM_TOPIC\b/);
});

test('the client message switch refuses a foreign-room socket before it reads or mutates', () => {
	const gate = SERVER.indexOf('isForeignRoom(ws.data.roomId, app.activeRoomId)');
	expect(gate, 'foreign-room gate not found').toBeGreaterThan(-1);
	// An early RETURN, not a log-and-continue — and not a `break`, which here is an illegal cross-function
	// jump (TS1107) that stops the prod entrypoint parsing at all.
	expect(SERVER).toMatch(/if\s*\(\s*isForeignRoom\(ws\.data\.roomId,\s*app\.activeRoomId\)\s*\)\s*return;/);
	// ORDERING: it must precede `switch (evt.type)`, which dispatches every read and mutation frame.
	const clientSwitch = SERVER.indexOf('switch (evt.type)');
	expect(clientSwitch, 'client switch not found').toBeGreaterThan(-1);
	expect(gate).toBeLessThan(clientSwitch);
});
