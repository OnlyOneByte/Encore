// guard: the room-identity fix (#654) is only real once it is WIRED at three seams that have no
// pure function to exercise, so each is pinned by source scan (same pattern as the *-wiring
// guards):
//   1. app.ts's getApp() MINTS the active room at boot and exposes its id as app.activeRoomId.
//      getApp() stands up the whole app over a file/memory DB and has no unit harness, so reverting
//      the boot mint or the literal wiring leaves every other test green.
//   2. the phone landing page (JoinLanding) reads the ?room= code the QR encoded and FORWARDS it to
//      /api/join. `/join` was retired (#834 Q2-A); the join UI is now JoinLanding.svelte, rendered in
//      the unjoined branch of `/`. There is no Svelte-component render harness in this repo, so this
//      scan is the only thing that reds if the forwarding is dropped and a scanned QR silently joins
//      the wrong party.
//
// Comments are blanked so a commented-out wiring cannot satisfy any match.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server/rooms → up two to src/server, and to src/routes.
const APP = stripComments(readFileSync(join(import.meta.dir, '..', 'app.ts'), 'utf8'));
const JOIN_PAGE = stripComments(
	readFileSync(join(import.meta.dir, '..', '..', 'lib', 'components', 'JoinLanding.svelte'), 'utf8')
);
// import.meta.dir === apps/core/src/server/rooms → up two to src, then into routes/api/me.
const ME_ROUTE = stripComments(
	readFileSync(join(import.meta.dir, '..', '..', 'routes', 'api', 'me', '+server.ts'), 'utf8')
);

test('app.ts mints the active room at boot and exposes its id (#654)', () => {
	// boot mint: activeRoomId comes from rooms.ensureActive(...).id.
	expect(APP).toMatch(/const\s+activeRoomId\s*=\s*rooms\.ensureActive\([^;]*\)\.id/);
	// and it is actually put on the app object, not minted and dropped.
	expect(APP).toMatch(/\n\s+activeRoomId,/m);
	// and declared on the EncoreApp contract so every consumer can read it.
	expect(APP).toMatch(/activeRoomId:\s*string;/);
});

test('the phone landing page reads the ?room= code and forwards it to /api/join (#654, #834)', () => {
	// reads the code the QR encoded out of the URL.
	expect(JOIN_PAGE).toMatch(/page\.url\.searchParams\.get\('room'\)/);
	// and forwards it in the /api/join body as `code` — drop this and a scanned QR joins the default
	// room. JoinLanding sends `code: joinCode` (the scanned code when it resolved, else the typed code).
	expect(JOIN_PAGE).toMatch(/code:\s*joinCode/);
});

test('app.ts binds the playback store + boot-hydrate to the ACTIVE room, not a constant (#655)', () => {
	// #655 advisory 1: this is the one seam the db/state unit tests cannot cover — they each construct
	// their own sqlitePersistence(db, TEST_ROOM) / hydrate(db, 'room1'), so nothing exercises getApp()
	// binding the single authoritative store to the room the box actually minted. Replacing both
	// arguments with a literal leaves every other test green; this scan reds instead.
	// The write-behind sink is keyed to activeRoomId (drop it -> a constant room could shadow another).
	expect(APP).toMatch(/sqlitePersistence\(db,\s*activeRoomId\)/);
	// Boot-hydrate reads THAT room's playback row (drop it -> boot could seed the wrong room's state).
	expect(APP).toMatch(/hydrate\(db,\s*activeRoomId\)/);
});

test('app.ts binds the singer roster read to the ACTIVE room, not an unscoped call (#656)', () => {
	// #656: listPublic is room-scoped now — it feeds the ordering input and the roster. app.ts is the
	// deployment seam that must pass the active room into every roster read; a unit harness cannot cover
	// it because getApp() has none. Reverting a `listPublic(activeRoomId)` back to a bare `listPublic()`
	// is a TYPE error (the arg is required), so this scan's job is the subtler regression: pinning that
	// every roster read in app.ts is scoped to the ACTIVE room, never a hard-coded or foreign room id.
	// Match every listPublic call and assert each names activeRoomId (bare or via app.).
	const calls = [...APP.matchAll(/listPublic\(([^)]*)\)/g)].map((m) => m[1].trim());
	expect(calls.length).toBeGreaterThan(0); // not vacuous — app.ts really does read the roster
	for (const arg of calls) expect(arg).toMatch(/^(app\.)?activeRoomId$/);
});

test('the /api/me rename scopes the name check to the singer own room (#656)', () => {
	// The PATCH /api/me rename runs assertNameFree, which is room-scoped now (#656). The route has no
	// unit harness, so reverting `me.roomId` back to the old unscoped 3-arg call is invisible to every
	// other test — a rename would then be checked deployment-wide and collide across rooms. Pin that
	// the route passes me.roomId as the room argument.
	expect(ME_ROUTE).toMatch(/assertNameFree\(app,\s*me\.roomId,/);
});
