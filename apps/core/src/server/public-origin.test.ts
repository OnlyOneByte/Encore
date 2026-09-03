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

// ── ENCORE_PUBLIC_ORIGIN ────────────────────────────────────────────────────────
// The request is the right source for a PHONE (it reached us, so its route works) and the wrong one
// for the TV: on a Windows/WSL2 box the server often cannot reach its own LAN address, so the only
// URL that opens /tv there is localhost — which puts `localhost` in the QR and points every phone at
// itself. An operator that knows the public address must be able to say so.

const withOrigin = <T>(value: string | undefined, fn: () => T): T => {
	const prior = process.env.ENCORE_PUBLIC_ORIGIN;
	if (value === undefined) delete process.env.ENCORE_PUBLIC_ORIGIN;
	else process.env.ENCORE_PUBLIC_ORIGIN = value;
	try {
		return fn();
	} finally {
		if (prior === undefined) delete process.env.ENCORE_PUBLIC_ORIGIN;
		else process.env.ENCORE_PUBLIC_ORIGIN = prior;
	}
};

test('an explicit origin wins over the request — the localhost-TV case', () => {
	// This is the whole point: the TV is loaded on localhost, and the QR must still say the LAN IP.
	const o = withOrigin('http://10.69.1.169:3000', () =>
		publicOrigin(req({ host: 'localhost:3000' }), new URL('http://localhost:3000/tv'))
	);
	expect(o).toBe('http://10.69.1.169:3000');
});

test('an explicit origin also overrides forwarding headers, so one setting is authoritative', () => {
	const o = withOrigin('https://party.example', () =>
		publicOrigin(req({ host: 'h', 'x-forwarded-host': 'proxy.example', 'x-forwarded-proto': 'http' }), url)
	);
	expect(o).toBe('https://party.example');
});

test('a path, query or trailing slash is normalised away — a pasted address bar value works', () => {
	expect(withOrigin('http://10.0.0.5:3000/tv?x=1', () => publicOrigin(req({ host: 'h' }), url))).toBe(
		'http://10.0.0.5:3000'
	);
	expect(withOrigin('http://10.0.0.5:3000/', () => publicOrigin(req({ host: 'h' }), url))).toBe('http://10.0.0.5:3000');
});

test('a malformed or non-http override is IGNORED, not fatal — the TV must still render', () => {
	// A typo here would otherwise take the whole TV screen down; the request-derived value still works
	// for phones, which is the majority case.
	for (const bad of ['not a url', 'ftp://10.0.0.5', 'javascript:alert(1)', '   ']) {
		expect(withOrigin(bad, () => publicOrigin(req({ host: '192.168.1.20:3000' }), url))).toBe(
			'http://192.168.1.20:3000'
		);
	}
});

test('unset falls back to the request, so existing deployments are unchanged', () => {
	expect(withOrigin(undefined, () => publicOrigin(req({ host: '192.168.1.20:3000' }), url))).toBe(
		'http://192.168.1.20:3000'
	);
});
