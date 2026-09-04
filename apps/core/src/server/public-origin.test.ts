// The scheme in the TV's join QR.
//
// REGRESSION: adapter-node computes the protocol as `PROTOCOL_HEADER && header || "https"`, so with no
// proxy header configured it reports **https** for a plain HTTP request. `url.origin` was therefore
// `https://192.168.1.20:3000` on the deployment the README documents, and the QR encoded a URL no phone
// on the LAN could open. Invisible in normal testing because the usual path is an https tunnel.
import { test, expect } from 'bun:test';
import { publicOrigin, publicOriginIsHttps, joinOrigin, fallbackJoinOrigin, resolveOrigin } from './public-origin';

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

// ── publicOriginIsHttps: the session cookie's Secure attribute ───────────────────
// REGRESSION this locks out: /api/join used `url.protocol === 'https:'`, and adapter-node reports
// https for every request unless PROTOCOL_HEADER is set. The session cookie was therefore marked
// Secure on a plain-HTTP LAN party, so the phone's browser discarded it — /join returned 200 and
// /api/me then returned 401 with no cookie to read. Invisible on the host box, because browsers accept
// Secure over http://localhost (a trustworthy origin), so it only ever broke actual phones.

test('a plain-HTTP LAN request is NOT https, so the cookie is not marked Secure', () => {
	expect(publicOriginIsHttps(req({ host: '10.69.1.169:3000' }), url)).toBe(false);
});

test('a request through an https proxy IS https, so the cookie stays Secure on a tunnel', () => {
	expect(publicOriginIsHttps(req({ host: 'party.example', 'x-forwarded-proto': 'https' }), url)).toBe(true);
});

test('an explicit https origin marks the cookie Secure', () => {
	expect(withOrigin('https://party.example', () => publicOriginIsHttps(req({ host: 'h' }), url))).toBe(true);
});

test('an explicit http origin does NOT, even when a proxy claims https', () => {
	// The override is authoritative for the QR, so it must be authoritative for the cookie too —
	// otherwise the two disagree about the scheme and the cookie is dropped.
	const secure = withOrigin('http://10.69.1.169:3000', () =>
		publicOriginIsHttps(req({ host: 'h', 'x-forwarded-proto': 'https' }), url)
	);
	expect(secure).toBe(false);
});

test('the cookie flag and the per-request origin can never disagree about the scheme', () => {
	// One derivation, two callers: assert they agree rather than trusting that they do. NOTE this is the
	// PER-REQUEST origin, not the advertised join address — see the joinOrigin block below for why those
	// two are allowed to differ.
	const cases: Record<string, string>[] = [
		{ host: '10.69.1.169:3000' },
		{ host: 'h', 'x-forwarded-proto': 'https' },
		{ host: 'h', 'x-forwarded-proto': 'http' }
	];
	for (const headers of cases) {
		const r = req(headers);
		expect(publicOriginIsHttps(r, url)).toBe(publicOrigin(r, url).startsWith('https:'));
	}
});

// ── joinOrigin: the address the TV advertises ────────────────────────────────────
// Same problem as ENCORE_PUBLIC_ORIGIN, one layer up: the person who can fix a QR that says
// `localhost` is standing in the room, not restarting the container. So the address is also a stored
// GLOBAL SETTING, which wins over the env var, which wins over the request.
//
// `resolveOrigin` is the rule with the source of the declared value factored out, so the precedence is
// testable without standing up an app singleton (which is what holds the settings repository).

test('a declared origin wins over every header — the localhost-TV case, from the settings page', () => {
	const o = resolveOrigin(
		req({ host: 'localhost:3000', 'x-forwarded-host': 'proxy.example', 'x-forwarded-proto': 'https' }),
		new URL('http://localhost:3000/tv'),
		'http://10.69.1.169:3000'
	);
	expect(o).toBe('http://10.69.1.169:3000');
});

test('an empty or absent declaration falls through to the request, so clearing the field auto-detects', () => {
	for (const declared of ['', null, undefined]) {
		expect(resolveOrigin(req({ host: '192.168.1.20:3000' }), url, declared)).toBe('http://192.168.1.20:3000');
	}
});

test('with no app singleton the join address is the env var, then the request', () => {
	// The settings repository lives on the app, which is absent under unit load and during prerender.
	// That must degrade to the boot-time declaration rather than throwing and blanking the TV.
	expect(withOrigin('http://10.69.1.169:3000', () => joinOrigin(req({ host: 'localhost:3000' }), url))).toBe(
		'http://10.69.1.169:3000'
	);
	expect(withOrigin(undefined, () => joinOrigin(req({ host: '192.168.1.20:3000' }), url))).toBe(
		'http://192.168.1.20:3000'
	);
});

test('fallbackJoinOrigin is what an empty setting resolves to, so the UI can show it', () => {
	// The settings page prints this as the field's placeholder; if it disagreed with what joinOrigin
	// actually falls back to, the UI would advertise an address the TV does not use.
	const r = req({ host: '192.168.1.20:3000' });
	expect(withOrigin(undefined, () => fallbackJoinOrigin(r, url))).toBe(
		withOrigin(undefined, () => joinOrigin(r, url))
	);
	expect(withOrigin('http://10.0.0.5:3000', () => fallbackJoinOrigin(r, url))).toBe('http://10.0.0.5:3000');
});
