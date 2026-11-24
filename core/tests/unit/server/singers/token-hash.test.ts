// Session tokens are stored hashed, old rows migrate in place, and Leave revokes on the server (#1119).
import { test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { migratedDb } from '$lib/server/db/test-db';
import { SingerRepository, hashToken } from '$lib/server/singers/repository';
import { singers } from '$lib/server/db/schema';

const NOW = 1_700_000_000_000;

test('the row holds the hash, never the cookie, and only the cookie resolves', () => {
	const db = migratedDb();
	const repo = new SingerRepository(db);
	const ana = repo.create('Ana', '#ff0000', NOW, 'room-1');
	const row = db.select().from(singers).where(eq(singers.id, ana.id)).all()[0]!;
	expect(row.sessionToken).toBe(hashToken(ana.sessionToken));
	expect(row.sessionToken).not.toContain(ana.sessionToken);
	expect(repo.bySessionToken(ana.sessionToken)?.id).toBe(ana.id);
	// A copied DB file is not a set of logins: the stored value presented as a cookie resolves to no one.
	expect(repo.bySessionToken(row.sessionToken)).toBeNull();
});

test('a token stored before hashing is migrated, so the phone holding it stays joined; a second pass does nothing', () => {
	const db = migratedDb();
	const repo = new SingerRepository(db);
	const legacy = 'Zt75rT7xrn40lNqy83AxZVA_PHtPCDge';
	db.insert(singers)
		.values({ id: 'old', displayName: 'Theo', color: '#00ff00', sessionToken: legacy, joinedAt: NOW, roomId: 'room-1' })
		.run();
	const fresh = repo.create('Ana', '#ff0000', NOW, 'room-1');

	expect(repo.hashLegacyTokens()).toBe(1);
	expect(repo.bySessionToken(legacy)?.id).toBe('old');
	expect(repo.bySessionToken(fresh.sessionToken)?.id).toBe(fresh.id);
	expect(repo.hashLegacyTokens()).toBe(0);
	expect(repo.bySessionToken(legacy)?.id).toBe('old');
});

test('the roster every queue:sync and TV payload is built from carries neither the token nor its hash', () => {
	const repo = new SingerRepository(migratedDb());
	const ana = repo.create('Ana', '#ff0000', NOW, 'room-1');
	const wire = JSON.stringify(repo.listPublic('room-1'));
	expect(wire).not.toContain('sessionToken');
	expect(wire).not.toContain(ana.sessionToken);
	expect(wire).not.toContain(hashToken(ana.sessionToken));
});

test('ending a session revokes the token on the server and keeps the row', () => {
	const repo = new SingerRepository(migratedDb());
	const ana = repo.create('Ana', '#ff0000', NOW, 'room-1');
	repo.endSession(ana.id);
	expect(repo.bySessionToken(ana.sessionToken)).toBeNull();
	expect(repo.byId(ana.id)?.displayName).toBe('Ana');
});
