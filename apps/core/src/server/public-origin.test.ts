// The scheme in the TV's join QR.
//
// REGRESSION: adapter-node computes the protocol as `PROTOCOL_HEADER && header || "https"`, so with no
// proxy header configured it reports **https** for a plain HTTP request. `url.origin` was therefore
// `https://192.168.1.20:3000` on the deployment the README documents, and the QR encoded a URL no phone
// on the LAN could open. Invisible in normal testing because the usual path is an https tunnel.
import { test, expect } from 'bun:test';
import { publicOrigin } from './public-origin';

const req = (headers: Record<string, string> = {}) => new Request('https://ignored.example/tv', { headers });
const url = new URL('https://ignored.example/tv');

test('a bare LAN request is http, whatever the adapter claims', () => {
	expect(publicOrigin(req({ host: '192.168.1.20:3000' }), url)).toBe('http://192.168.1.20:3000');
});

test('a proxy that reports https is believed — the tunnel case', () => {
	const o = publicOrigin(
		req({ host: 'angryang-encore.v.tunnels.lab.aws.dev', 'x-forwarded-proto': 'https' }),
		url
	);
	expect(o).toBe('https://angryang-encore.v.tunnels.lab.aws.dev');
});

test('a chain of proxies uses the CLIENT-facing scheme, which is the first entry', () => {
	expect(publicOrigin(req({ host: 'h', 'x-forwarded-proto': 'https, http' }), url)).toBe('https://h');
});

test('x-forwarded-host wins over host, so a tunnel hostname survives the hop', () => {
	const o = publicOrigin(req({ host: '127.0.0.1:5180', 'x-forwarded-host': 'party.example', 'x-forwarded-proto': 'https' }), url);
	expect(o).toBe('https://party.example');
});

test('a junk scheme falls back to http rather than being echoed into the QR', () => {
	expect(publicOrigin(req({ host: 'h', 'x-forwarded-proto': 'javascript' }), url)).toBe('http://h');
	expect(publicOrigin(req({ host: 'h', 'x-forwarded-proto': '' }), url)).toBe('http://h');
});

test('with no Host header at all it falls back to the request URL host', () => {
	expect(publicOrigin(new Request('http://fallback.example:9/tv'), new URL('http://fallback.example:9/tv'))).toBe(
		'http://fallback.example:9'
	);
});
