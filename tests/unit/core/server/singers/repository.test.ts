// Create singer -> token set -> resolve from cookie.
import { test, expect } from 'bun:test';
import { migratedDb } from '$server/db/test-db';
import { SingerRepository, readSessionToken, mintSessionToken, SESSION_COOKIE } from '$server/singers/repository';

// A singer is created IN a room now. These tests exercise a single room, and the FK is not
// enforced on this bun:sqlite DB, so a fixed literal room id is enough — no `rooms` row required.
const ROOM = 'test-room';

function repo() {
	const db = migratedDb();
	return new SingerRepository(db);
}

test('create mints id + session token and persists', () => {
	const r = repo();
	const s = r.create('Maya', '#ff5cae', 1_700_000_000_000, ROOM);
	expect(s.id).toBeTruthy();
	expect(s.sessionToken).toBeTruthy();
	expect(s.displayName).toBe('Maya');
	expect(s.color).toBe('#ff5cae');
});

test('resolve singer from session token (the cookie round-trip)', () => {
	const r = repo();
	const s = r.create('Sam', '#33d6a6', 1, ROOM);
	const resolved = r.bySessionToken(s.sessionToken);
	expect(resolved?.id).toBe(s.id);
	expect(resolved?.displayName).toBe('Sam');
});

test('unknown / missing token resolves to null', () => {
	const r = repo();
	expect(r.bySessionToken('nope')).toBeNull();
	expect(r.bySessionToken(undefined)).toBeNull();
	expect(r.bySessionToken(null)).toBeNull();
});

test('blank display name falls back to Guest; long names truncated', () => {
	const r = repo();
	expect(r.create('   ', '#fff', 1, ROOM).displayName).toBe('Guest');
	expect(r.create('x'.repeat(50), '#fff', 2, ROOM).displayName).toHaveLength(32);
});

test('session tokens are unique + URL-safe', () => {
	const tokens = new Set(Array.from({ length: 1000 }, () => mintSessionToken()));
	expect(tokens.size).toBe(1000);
	for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
});

test('readSessionToken parses our token out of a Cookie header', () => {
	// The LIVE half of the old cookie-helpers test. sessionCookie() was deleted: it was a
	// hand-rolled Set-Cookie serializer with no production caller — SvelteKit's cookies.set/.delete
	// own serialization on every real path (join/leave +server.ts), so its attribute assertions were
	// testing a dead copy. The live path's attributes are guarded in session-cookie-attributes.test.ts.
	expect(readSessionToken(`foo=bar; ${SESSION_COOKIE}=abc123; baz=qux`)).toBe('abc123');
	expect(readSessionToken(null)).toBeUndefined();
});

// the roster is scoped to a room — listPublic returns only THIS room's singers, and strips the
// server-side room_id key alongside the session token so the public shape is unchanged.
test('listPublic is scoped by room and strips the room key', () => {
	const r = repo();
	const a = r.create('Ana', '#f00', 1, 'roomA');
	r.create('Ben', '#0f0', 2, 'roomB');
	const rosterA = r.listPublic('roomA');
	expect(rosterA.map((x) => x.id)).toEqual([a.id]); // Ben (roomB) is not in roomA's roster
	// room_id is a server-side scoping key, never broadcast: the public shape carries neither it nor the token
	expect(rosterA[0]).not.toHaveProperty('roomId');
	expect(rosterA[0]).not.toHaveProperty('sessionToken');
	expect(r.listPublic('roomB').map((x) => x.displayName)).toEqual(['Ben']);
});
