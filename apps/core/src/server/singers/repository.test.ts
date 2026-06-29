// M2-C1 done-when: create singer -> token set -> resolve from cookie.
import { test, expect } from 'bun:test';
import { SingerRepository, sessionCookie, readSessionToken, mintSessionToken, SESSION_COOKIE } from './repository';
import { openDb } from '../db/index';
import { runMigrations } from '../db/migrate';

function repo() {
	const { db } = openDb(':memory:');
	runMigrations(db, './drizzle');
	return new SingerRepository(db);
}

test('create mints id + session token and persists', () => {
	const r = repo();
	const s = r.create('Maya', '#ff5cae', 1_700_000_000_000);
	expect(s.id).toBeTruthy();
	expect(s.sessionToken).toBeTruthy();
	expect(s.displayName).toBe('Maya');
	expect(s.color).toBe('#ff5cae');
});

test('resolve singer from session token (the cookie round-trip)', () => {
	const r = repo();
	const s = r.create('Sam', '#33d6a6', 1);
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
	expect(r.create('   ', '#fff', 1).displayName).toBe('Guest');
	expect(r.create('x'.repeat(50), '#fff', 2).displayName).toHaveLength(32);
});

test('session tokens are unique + URL-safe', () => {
	const tokens = new Set(Array.from({ length: 1000 }, () => mintSessionToken()));
	expect(tokens.size).toBe(1000);
	for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
});

test('cookie helpers: build Set-Cookie and parse it back', () => {
	const token = 'abc123';
	const setCookie = sessionCookie(token, true);
	expect(setCookie).toContain(`${SESSION_COOKIE}=abc123`);
	expect(setCookie).toContain('HttpOnly');
	expect(setCookie).toContain('SameSite=Lax');
	expect(setCookie).toContain('Secure');
	// round-trip parse from a Cookie header
	expect(readSessionToken(`foo=bar; ${SESSION_COOKIE}=abc123; baz=qux`)).toBe('abc123');
	expect(readSessionToken(null)).toBeUndefined();
});

test('non-secure cookie omits Secure (for http dev)', () => {
	expect(sessionCookie('t', false)).not.toContain('Secure');
});
