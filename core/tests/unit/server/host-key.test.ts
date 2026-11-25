// The host key: what unlocks it, what it stores, and what ends it. docs/SERVER.md#the-host-key
import { test, expect } from 'bun:test';
import { migratedDb } from '$lib/server/db/test-db';
import { HostKey, HOST_SESSION_MS, adminTokenProblem, readHostToken } from '$lib/server/host-key';
import { hostSessions } from '$lib/server/db/schema';

const NOW = 1_700_000_000_000;
const LONG = 'a-fixed-host-key-of-plenty-length';

// #1249: a /tv socket's host cookie, read from the upgrade's header, means something only to a live session.
test('readHostToken finds encore_host in a Cookie header, and only a live session makes it the host', () => {
	expect(readHostToken(null)).toBeUndefined();
	expect(readHostToken('encore_tv=abc; other=1')).toBeUndefined();
	expect(readHostToken('encore_host=')).toBeUndefined();
	const key = new HostKey(migratedDb(), LONG);
	const token = key.open(NOW);
	expect(readHostToken(`encore_tv=abc; encore_host=${token}`)).toBe(token);
	expect(key.isHost(readHostToken(`encore_host=${token}`), NOW)).toBe(true);
	expect(key.isHost(readHostToken(`encore_host=${'x'.repeat(43)}`), NOW)).toBe(false);
	expect(key.isHost(readHostToken(`encore_host=${token}`), NOW + HOST_SESSION_MS)).toBe(false);
});

test('a fixed key under 24 characters is refused outright, and unset or long enough is fine', () => {
	expect(adminTokenProblem('abc')).toContain('at least 24');
	expect(adminTokenProblem('x'.repeat(23))).not.toBeNull();
	expect(adminTokenProblem('x'.repeat(24))).toBeNull();
	expect(adminTokenProblem(undefined)).toBeNull();
	expect(adminTokenProblem('   ')).toBeNull();
	expect(() => new HostKey(migratedDb(), 'abc')).toThrow('at least 24');
});

test('a minted key is handed out once, for the boot banner, and then only its hash is held', () => {
	const key = new HostKey(migratedDb(), undefined);
	const minted = key.takeBootKey();
	expect(minted).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(key.takeBootKey()).toBeNull();
	expect(key.matches(minted)).toBe(true);
});

test('ENCORE_ADMIN_TOKEN fixes the key and is never handed back for printing', () => {
	const key = new HostKey(migratedDb(), '  correct-horse-battery-staple  ');
	expect(key.takeBootKey()).toBeNull();
	expect(key.matches('correct-horse-battery-staple')).toBe(true);
});

test('anything but the key is refused, including the wrong type and a prefix', () => {
	const key = new HostKey(migratedDb(), 'correct-horse-battery-staple');
	for (const wrong of ['', 'correct-horse', 'correct-horse-battery-staplex', null, undefined, 42, ['x'], {}])
		expect(key.matches(wrong)).toBe(false);
});

test('a session is stored as a hash, resolves until it expires, and a guessed or planted cookie never does', () => {
	const db = migratedDb();
	const key = new HostKey(db, LONG);
	const token = key.open(NOW);
	const rows = db.select().from(hostSessions).all();
	expect(rows).toHaveLength(1);
	expect(rows[0]!.tokenHash).not.toBe(token);
	expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);

	expect(key.isHost(token, NOW + 1)).toBe(true);
	expect(key.isHost(token, NOW + HOST_SESSION_MS)).toBe(false);
	// The stored hash is not itself a credential: a copied DB cannot be replayed as a cookie.
	expect(key.isHost(rows[0]!.tokenHash, NOW + 1)).toBe(false);
	expect(key.isHost('planted-from-another-port', NOW)).toBe(false);
	expect(key.isHost(undefined, NOW)).toBe(false);
});

test('signing out every host phone ends every session, and pruning drops only the expired', () => {
	const db = migratedDb();
	const key = new HostKey(db, LONG);
	const old = key.open(NOW - HOST_SESSION_MS);
	const fresh = key.open(NOW);
	key.pruneExpired(NOW);
	expect(db.select().from(hostSessions).all()).toHaveLength(1);
	expect(key.isHost(old, NOW)).toBe(false);
	expect(key.isHost(fresh, NOW)).toBe(true);
	key.revokeAll();
	expect(key.isHost(fresh, NOW)).toBe(false);
});
