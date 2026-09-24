// guard: the singer session cookie's security attributes live on the ONE writer the browser sees. Caught
// `sessionCookie(token, secure)` in repository.ts — a hand-rolled Set-Cookie serializer with zero production
// callers, whose HttpOnly/SameSite/Secure WERE unit-tested, while the live writers (`cookies.set` in
// routes/api/join, `cookies.delete` in routes/api/leave) had no assertion on any attribute. Hardening the cookie at
// the obvious, documented, tested function would ship green and change nothing the browser receives. A source scan
// because `cookies.set`'s serialization only runs in a live SvelteKit request.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

// Blank comments first, so an attribute cannot be satisfied by text in a comment while the live options object has
// lost it.
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const ROUTES = 'src/routes/api';
const JOIN = stripComments(read(ROUTES, 'join', '+server.ts'));
const LEAVE = stripComments(read(ROUTES, 'leave', '+server.ts'));

test('the join route sets the session cookie via SvelteKit cookies.set (the live writer)', () => {
	// It must be the framework writer, not a hand-rolled Set-Cookie string, so SvelteKit owns serialization.
	expect(JOIN).toMatch(/cookies\.set\(\s*SESSION_COOKIE/);
});

test('the live join cookie carries all five session-cookie attributes', () => {
	expect(JOIN).toMatch(/path:\s*'\/'/); // Path=/
	expect(JOIN).toMatch(/httpOnly:\s*true/); // HttpOnly
	expect(JOIN).toMatch(/sameSite:\s*'lax'/); // SameSite=Lax
	expect(JOIN).toMatch(/maxAge:\s*60\s*\*\s*60\s*\*\s*24\s*\*\s*30/); // Max-Age = 30 days
	// Secure is derived from the real forwarded scheme, NOT url.protocol: adapter-node reports https for every request,
	// which marked the cookie Secure on a plain-HTTP LAN party and the phone discarded it.
	expect(JOIN).toMatch(/secure:\s*publicOriginIsHttps\(/);
});

test('the leave route clears the cookie with a matching Path so the delete applies', () => {
	// A delete only clears a cookie whose Path matches the set, so this must stay in step with the join above.
	expect(LEAVE).toMatch(/cookies\.delete\(\s*SESSION_COOKIE\s*,\s*\{\s*path:\s*'\/'\s*\}/);
});
