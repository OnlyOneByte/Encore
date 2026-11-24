// The CSRF and cross-site WebSocket guard. docs/SERVER.md#requests-from-other-sites
import { test, expect, afterEach } from 'bun:test';
import { fromOurOrigin, isJsonBody } from '$lib/server/http/same-origin';

const URL_ = new URL('http://192.168.1.20:3000/api/settings');
function req(headers: Record<string, string>, body?: string): Request {
	return new Request(URL_, { method: 'POST', headers: { host: '192.168.1.20:3000', ...headers }, body });
}

afterEach(() => {
	delete process.env.ENCORE_PUBLIC_ORIGIN;
});

test('a page of ours passes, by Origin or, failing that, Referer', () => {
	expect(fromOurOrigin(req({ origin: 'http://192.168.1.20:3000' }), URL_)).toBe(true);
	expect(fromOurOrigin(req({ referer: 'http://192.168.1.20:3000/settings' }), URL_)).toBe(true);
});

test('another site on the LAN is refused, including another port on this same machine', () => {
	expect(fromOurOrigin(req({ origin: 'http://192.168.1.99' }), URL_)).toBe(false);
	expect(fromOurOrigin(req({ origin: 'http://192.168.1.20:8080' }), URL_)).toBe(false);
	expect(fromOurOrigin(req({ referer: 'https://evil.example/x' }), URL_)).toBe(false);
	// A sandboxed iframe says "null": a browser that will not name the sender is refused.
	expect(fromOurOrigin(req({ origin: 'null' }), URL_)).toBe(false);
});

test('a non-browser client sends neither header and carries no borrowed cookie, so it passes', () => {
	expect(fromOurOrigin(req({}), URL_)).toBe(true);
});

test('the configured public origin passes behind a proxy that rewrites Host', () => {
	process.env.ENCORE_PUBLIC_ORIGIN = 'https://karaoke.example';
	expect(fromOurOrigin(req({ origin: 'https://karaoke.example' }), URL_)).toBe(true);
	expect(fromOurOrigin(req({ origin: 'https://other.example' }), URL_)).toBe(false);
});

test('only JSON bodies pass; a cross-site form can send none of what is accepted', () => {
	expect(isJsonBody(req({ 'content-type': 'application/json' }, '{}'))).toBe(true);
	expect(isJsonBody(req({ 'content-type': 'application/json; charset=utf-8' }, '{}'))).toBe(true);
	for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])
		expect(isJsonBody(req({ 'content-type': type }, '{}'))).toBe(false);
	// No body at all (POST /api/leave) is not a body of the wrong type.
	expect(isJsonBody(req({}))).toBe(true);
});
