// guard: room isolation is only real once it is WIRED into the WS layer, and server.ts is the
// process entrypoint — it calls Bun.serve and process.exit, so it cannot be imported into bun:test
// without terminating the runner and this repo has no socket harness. The isolation decisions are
// unit-tested purely in room-scope.test.ts; THIS scan pins that server.ts actually routes the wire
// through them, so reverting any single seam back to the pre-isolation shared-topic/no-scope behaviour reds
// here even though every pure test stays green. Same pattern as room-identity-wiring / graceful-shutdown.
//
// The four seams, each of which alone reopens the isolation gap:
//   1. the WS UPGRADE captures the singer's roomId onto the socket (not just the id) — the scope key;
//   2. websocket.open SUBSCRIBES via subscribeTopicFor(roomId, activeRoomId), not one shared topic;
//   3. the broadcast sink PUBLISHES via broadcastTopicFor(activeRoomId), not a single ROOM_TOPIC;
//   4. the client message switch REFUSES a foreign-room socket via isForeignRoom before hello/mutate.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// import.meta.dir === apps/core/src/server/realtime; three up is apps/core, where server.ts lives.
const SERVER_PATH = join(import.meta.dir, '..', '..', '..', 'server.ts');

// Blank block and line comments, preserving newlines, so a commented-out wiring line cannot satisfy a match.
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1 + '');
}

const SERVER = stripComments(readFileSync(SERVER_PATH, 'utf8'));

// The RAW (un-stripped) source, for the parse check below — stripComments blanks comments but a
// SyntaxError is in the code, so parse the real bytes.
const SERVER_RAW = readFileSync(SERVER_PATH, 'utf8');

test('server.ts actually PARSES — a source scan is blind to a SyntaxError in the prod entrypoint', () => {
	// server.ts is the standalone prod entry (`bun run server.ts`) and cannot be imported into bun:test
	// (it calls Bun.serve + process.exit), so the wiring assertions read it as TEXT — which passes
	// happily on a file that does not compile. That is exactly how a `break` illegally crossing the
	// message-handler function boundary (TS1107) shipped to review with 1964 green tests: `bun test`
	// never parses this file, `bun run build` is the SvelteKit app not this entry, and apps/core's
	// svelte-check tsconfig excludes it. Feed the source we already read to the transpiler so every
	// edit to server.ts gets a parse check from `bun test`, closing the whole class cheaply.
	expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(SERVER_RAW)).not.toThrow();
});

test('server.ts imports the room-scope isolation helpers and the TV-room resolver', () => {
	expect(SERVER).toMatch(
		/import\s*\{[^}]*\bisForeignRoom\b[^}]*\bsubscribeTopicFor\b[^}]*\bbroadcastTopicFor\b[^}]*\}\s*from\s*['"]\.\/src\/server\/realtime\/room-scope['"]/
	);
	// the TV-room resolver is imported too — dropping it (while the usage stays) fails to
	// compile, which a source scan is blind to, so pin the import here alongside the room-scope helpers.
	expect(SERVER).toMatch(/import\s*\{[^}]*\btvRoomId\b[^}]*\}\s*from\s*['"]\.\/src\/server\/rooms\/tv-room['"]/);
});

test('the WS upgrade captures a roomId scope onto the socket, not just the id (re-anchored for the TV branch)', () => {
	// The scope key: every socket carries a roomId on SocketData. Dropping the roomId capture would
	// leave every socket unscoped, so isForeignRoom could never fire. The TV-room resolver changed where the value
	// comes from — a phone still gets it from its session token (me?.roomId), but a TV (no cookie)
	// resolves it from ?room=<code> via tvRoomId — so the value is now a resolved `roomId` local
	// rather than `me?.roomId` inline. This still pins the scope capture: the upgrade must put a
	// roomId onto the socket data (shorthand or explicit), and a room-less socket cannot exist.
	expect(SERVER).toMatch(/roomId\?:\s*string/); // SocketData carries the scope
	// role + singerId are set, and roomId is on the data object (property shorthand `roomId` or an
	// explicit `roomId: <expr>`). The old inline `roomId: me?.roomId` shape is subsumed by this.
	expect(SERVER).toMatch(/data:\s*\{\s*role,\s*singerId:\s*[\w.?]+,\s*roomId(\s*:\s*[\w.?]+)?\s*\}/);
	// seam: the roomId the socket binds to is computed, and the TV branch resolves it via
	// tvRoomId(...) rather than leaving a TV an unscoped spectator. Reverting the TV branch back to a
	// bare `me?.roomId` (so a TV is always unscoped again) reds here.
	expect(SERVER).toMatch(/const\s+roomId\s*=/);
	expect(SERVER).toMatch(/role\s*===\s*'tv'[\s\S]{0,120}tvRoomId\(/);
});

test('websocket.open subscribes to the socket own room topic via subscribeTopicFor', () => {
	// A per-room subscribe, keyed on the socket's roomId + the served room — NOT a single shared topic.
	expect(SERVER).toMatch(/ws\.subscribe\(\s*subscribeTopicFor\(\s*ws\.data\.roomId\s*,\s*app\.activeRoomId\s*\)\s*\)/);
	// and the old single-shared-topic subscribe is gone (the exact pre-isolation shape).
	expect(SERVER).not.toMatch(/ws\.subscribe\(\s*ROOM_TOPIC\s*\)/);
});

test('the broadcast sink publishes to the served room topic via broadcastTopicFor', () => {
	// The delivery half: one publish reaches only the served room's subscribers.
	expect(SERVER).toMatch(/server\.publish\(\s*broadcastTopicFor\(\s*app\.activeRoomId\s*\)/);
	// and no live publish routes through the single legacy ROOM_TOPIC anymore (crossing the boundary).
	expect(SERVER).not.toMatch(/server\.publish\(\s*ROOM_TOPIC\b/);
});

test('the client message switch refuses a foreign-room socket before it reads or mutates', () => {
	// The gate must sit BEFORE `switch (evt.type)` so hello/queue/player/telemetry are all covered by it.
	const gate = SERVER.indexOf('isForeignRoom(ws.data.roomId, app.activeRoomId)');
	expect(gate, 'foreign-room gate not found').toBeGreaterThan(-1);
	// It is an early-RETURN refusal (the message handler is a function — a `break` here is an illegal
	// cross-function jump, TS1107, and would stop the prod entrypoint parsing), not a log-and-continue.
	expect(SERVER).toMatch(/if\s*\(\s*isForeignRoom\(ws\.data\.roomId,\s*app\.activeRoomId\)\s*\)\s*return;/);
	// and it precedes the client `switch (evt.type)` that dispatches every read/mutation frame.
	const clientSwitch = SERVER.indexOf('switch (evt.type)');
	expect(clientSwitch, 'client switch not found').toBeGreaterThan(-1);
	expect(gate).toBeLessThan(clientSwitch);
});
