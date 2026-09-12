// guard: the singer session cookie's security attributes live on the ONE writer the browser sees.
//
// THE DEFECT. `sessionCookie(token, secure)` in repository.ts was a hand-rolled Set-Cookie
// serializer that built Path/HttpOnly/SameSite=Lax/Max-Age/Secure — and NOTHING in production called
// it. A whole-repo search for `sessionCookie(` returned exactly three sites: the definition and two
// tests. The real cookie is written by SvelteKit's `cookies.set` at routes/api/join/+server.ts and
// cleared by `cookies.delete` at routes/api/leave/+server.ts; those own serialization on every live
// path. So the copy that was UNIT-TESTED (repository.test.ts asserted HttpOnly/SameSite/Secure against
// it) was the copy that was DEAD, while the live writer had no assertion on any attribute. Hardening the
// cookie (SameSite=Strict, Partitioned, a shorter Max-Age) at the obvious, documented, tested function
// would ship green and change nothing the browser receives. This is the repo's most-repeated defect
// class (a mechanism built, tested, and never wired to the path that needs it).
//
// THE FIX. sessionCookie() and its two dead assertions are deleted; this guard moves the coverage onto
// the live writer. WHY A SOURCE SCAN: the join handler calls SvelteKit's `cookies.set`, whose real
// serialization only runs inside a live SvelteKit request — there is no pure function left to unit-test.
// The attributes are a decidable property of the handler source, so the guard reads +server.ts and
// requires the five attributes on the set, and a matching Path on the delete (a delete must match the
// set to apply). Change an attribute at the live writer and this guard is the assertion that moves with
// it; there is no dead copy to edit instead.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

// Blank out comments before scanning so an attribute cannot be satisfied by text living in a
// comment (e.g. `// was httpOnly: true,`) while the live options object has lost it. Matches the
// repo's stripComments convention (icon-centring.test.ts et al.), extended to // line comments since
// these are .ts sources. Blanks rather than deletes so any reported offset still lines up.
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// The two API routes that write and clear the session cookie, named from the repo root.
const ROUTES = 'src/routes/api';
const JOIN = stripComments(read(ROUTES, 'join', '+server.ts'));
const LEAVE = stripComments(read(ROUTES, 'leave', '+server.ts'));

test('the join route sets the session cookie via SvelteKit cookies.set (the live writer)', () => {
	// It must be the framework writer, not a hand-rolled Set-Cookie string, so SvelteKit owns
	// serialization. sessionCookie() was deleted precisely because it duplicated this.
	expect(JOIN).toMatch(/cookies\.set\(\s*SESSION_COOKIE/);
});

test('the live join cookie carries all five session-cookie attributes', () => {
	// The attributes the dead sessionCookie() used to assert, now pinned on the path the browser sees.
	expect(JOIN).toMatch(/path:\s*'\/'/); // Path=/
	expect(JOIN).toMatch(/httpOnly:\s*true/); // HttpOnly
	expect(JOIN).toMatch(/sameSite:\s*'lax'/); // SameSite=Lax
	expect(JOIN).toMatch(/maxAge:\s*60\s*\*\s*60\s*\*\s*24\s*\*\s*30/); // Max-Age = 30 days
	// Secure is derived from the real forwarded scheme, NOT url.protocol (adapter-node reports https
	// for every request, which marked the cookie Secure on a plain-HTTP LAN party and the phone
	// discarded it). This derivation is exactly what a hand-rolled `secure: boolean` serializer could
	// not express, so it must stay on the live writer.
	expect(JOIN).toMatch(/secure:\s*publicOriginIsHttps\(/);
});

test('the leave route clears the cookie with a matching Path so the delete applies', () => {
	// A cookie delete only clears a cookie whose Path matches the set; the leave route notes this and
	// must keep Path=/ in step with the join set above.
	expect(LEAVE).toMatch(/cookies\.delete\(\s*SESSION_COOKIE\s*,\s*\{\s*path:\s*'\/'\s*\}/);
});
