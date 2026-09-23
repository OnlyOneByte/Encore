// Room identity is only real once it is WIRED at seams with no pure function to exercise: `getApp()`
// mints the active room at boot and exposes `app.activeRoomId`, and JoinLanding forwards the `?room=`
// code the QR encoded to /api/join. `getApp()` stands the whole app up over a real DB and has no unit
// harness, so reverting either leaves every other test green while a scanned QR joins the wrong party.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

/** Blank comments, so a commented-out wiring line cannot satisfy a match. */
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// `read` throws on a miss, so a moved subject reds as a path failure rather than letting these scans
// pass over an empty string.
const APP = stripComments(read('src/lib/server/app.ts'));
const JOIN_PAGE = stripComments(read('src/lib/components/JoinLanding.svelte'));
const ME_ROUTE = stripComments(read('src/routes/api/me/+server.ts'));

test('app.ts mints the active room at boot and exposes its id', () => {
	expect(APP).toMatch(/const\s+activeRoomId\s*=\s*rooms\.ensureActive\([^;]*\)\.id/);
	// On the app object, not minted and dropped…
	expect(APP).toMatch(/\n\s+activeRoomId,/m);
	// …and declared on the EncoreApp contract, so every consumer can read it.
	expect(APP).toMatch(/activeRoomId:\s*string;/);
});

test('the phone landing page reads the ?room= code and forwards it to /api/join', () => {
	expect(JOIN_PAGE).toMatch(/page\.url\.searchParams\.get\('room'\)/);
	// Drop the forward and a scanned QR joins the DEFAULT room. `joinCode` is the scanned code when it
	// resolved, else the typed one.
	expect(JOIN_PAGE).toMatch(/code:\s*joinCode/);
});

test('app.ts binds the playback store + boot-hydrate to the ACTIVE room, not a constant', () => {
	// The db/state unit tests each construct their own persistence/hydrate against a fixed test room, so
	// nothing else exercises getApp() binding the single authoritative store to the room the box minted.
	// A constant sink room could shadow another's writes; a constant hydrate seeds the wrong room's state.
	expect(APP).toMatch(/sqlitePersistence\(db,\s*activeRoomId\)/);
	expect(APP).toMatch(/hydrate\(db,\s*activeRoomId\)/);
});

test('app.ts binds the singer roster read to the ACTIVE room, not an unscoped call', () => {
	// An omitted argument is already a type error, so the subtler regression is the one pinned here: EVERY
	// roster read in app.ts must name the active room, never a hard-coded or foreign room id.
	const calls = [...APP.matchAll(/listPublic\(([^)]*)\)/g)].map((m) => m[1].trim());
	expect(calls.length).toBeGreaterThan(0); // app.ts really does read the roster
	for (const arg of calls) expect(arg).toMatch(/^(app\.)?activeRoomId$/);
});

test('the /api/me rename scopes the name check to the singer own room', () => {
	// Unscoped, a rename is checked deployment-wide and collides across rooms.
	expect(ME_ROUTE).toMatch(/assertNameFree\(app,\s*me\.roomId,/);
});
